-- RAG retrieval for "Ask about your spending" (Reports page Q&A). Lets the
-- Q&A feature answer questions about history older than the recent 150-
-- transaction/6-month window buildQaContext() already sends - see
-- the app's own code comments for the full design rationale (additive,
-- not a replacement; content-hash delta detection instead of updated_at,
-- since expenses has no edit-tracking column).
--
-- vector extension confirmed available on this project (list_extensions:
-- default_version 0.8.2, was not yet installed). nomic-embed-text
-- (already loaded on the home Ollama instance) confirmed live via a real
-- POST /api/embeddings call to return 768-dim vectors - not assumed.
create extension if not exists vector;

-- One row per expense, not a chunked/multi-row document store (an expense
-- is already the atomic unit - unlike mini-RAG's paragraph-chunked
-- documents, there's nothing to split). expense_id is unique so
-- tools/embed-expenses.js can upsert on re-embed rather than accumulate
-- duplicates. occurred_at is denormalized from expenses (copied at embed
-- time) so match_expense_embeddings() below can filter by date with no
-- join back to expenses.
create table if not exists expense_embeddings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  expense_id   uuid not null references expenses(id) on delete cascade,
  content_hash text not null,
  occurred_at  date not null,
  embedding    vector(768),
  embedded_at  timestamptz default now(),
  unique (expense_id)
);

-- Service-role-write-only, same as asset_price_findings/market_index_findings -
-- select only, no insert/update/delete grant to authenticated. Unlike those
-- two (public market data, no user_id at all), this table IS user-owned
-- data, so it needs a real RLS policy scoping reads to the caller's own
-- rows rather than a status-based one.
grant select on expense_embeddings to authenticated;

alter table expense_embeddings enable row level security;
drop policy if exists "read own expense_embeddings" on expense_embeddings;
create policy "read own expense_embeddings" on expense_embeddings
  for select using (auth.uid() = user_id);

-- security invoker (the default for a plain `language sql` function, no
-- `security definer` here) is deliberate: it runs as the calling
-- authenticated role, so the RLS policy above is what actually scopes
-- results to the caller's own expenses - no user_id parameter needed on
-- the function itself, which would only risk drifting out of sync with
-- the real enforcement happening at the table level.
--
-- search_path is pinned to "public, extensions" rather than just "public" -
-- confirmed live (`show search_path`) that this database's own default is
-- "$user", public, extensions, and the vector extension itself landed in
-- the public schema when installed above (checked via pg_extension, not
-- assumed) - pinning to both keeps this correct regardless of which schema
-- the vector type/operators actually resolve from.
create or replace function match_expense_embeddings(
  query_embedding vector(768),
  match_count int default 10,
  before_date date default null
)
returns table (expense_id uuid, similarity float)
language sql stable
set search_path = public, extensions
as $$
  select expense_id, 1 - (embedding <=> query_embedding) as similarity
  from expense_embeddings
  where before_date is null or occurred_at < before_date
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function match_expense_embeddings to authenticated;
