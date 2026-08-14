#!/usr/bin/env node
// ============================================================================
// Expense embeddings for RAG retrieval (Reports page's "Ask about your
// spending" Q&A, docs/... see supabase/45_expense_embeddings.sql). Same
// architecture as tools/price-agent.js, reused rather than duplicated - runs
// on the SERVER MACHINE ONLY, alongside Ollama. Never runs in the browser,
// never ships in the PWA, needs the Supabase SERVICE_ROLE key - keep that
// out of the repo (env var only).
//
// What it does, across every user's expenses (an embedding is derived
// entirely from one user's own row, but this script runs with the
// service_role key and sees everyone in one pass - same "one shared
// background job" pattern price-agent.js already uses for pricing):
//   1. Fetch every expense, and every already-embedded expense_id + its
//      stored content_hash.
//   2. For each expense, build a canonical embeddable string and hash it.
//      If the hash matches what's already stored, skip. This is a
//      content-hash delta-detection pattern (mirrors mini_rag.py's own
//      file_hash/indexed_state approach, just keyed by expense_id instead
//      of a file path) rather than an updated_at comparison, since
//      `expenses` has no edit-tracking column at all.
//   3. Otherwise, call Ollama's /api/embeddings for the new/changed text
//      and upsert the vector into expense_embeddings (on expense_id, which
//      has a unique constraint).
//   4. Deletes are NOT handled here - expense_embeddings.expense_id has
//      `on delete cascade` (see the migration), so a deleted expense's
//      embedding disappears automatically at the database level. No
//      manual "purge stale rows" step needed the way mini_rag.py needs one
//      for files it no longer sees.
//
// Setup (on the server machine, next to Ollama):
//   Shares tools/.env.deal-agent (same env vars as price-agent.js/
//   deal-agent.js, see that file's header) - no separate env file. No
//   SearXNG involved at all - this script never searches the web, only
//   talks to Ollama and Supabase.
//   node tools/embed-expenses.js            # writes embeddings
//   DRY_RUN=1 node tools/embed-expenses.js  # still calls Ollama for real
//                                            # (to preview real output),
//                                            # skips the Supabase write
//   Or via tools/run-embed-expenses.sh.
//
// Scheduling: much cheaper to run often than price-agent.js/deal-agent.js -
// the content-hash check means an unchanged expense costs one string
// comparison, not a search+fetch+Gemma-extraction round trip, so this can
// run hourly (see tools/setup-server-machine.sh) rather than weekly - new
// expenses should become searchable soon after they're added, unlike
// deal/price data which only genuinely needs to be fresh weekly.
// ============================================================================
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMMA_ENDPOINT = process.env.GEMMA_ENDPOINT;
const DRY_RUN = !!process.env.DRY_RUN;

// GEMMA_ENDPOINT in tools/.env.deal-agent is the full /api/generate URL.
// Derived here by replacing the path rather than a second env var, since
// the embeddings endpoint is mechanically the same host/port, not a
// genuinely separate configuration value - confirmed live (a real POST to
// http://<host>/api/embeddings with {model:"nomic-embed-text", prompt}
// returned {embedding: [768 floats]}, see the migration's header comment
// for how that was verified, not assumed).
const GEMMA_EMBED_ENDPOINT = (GEMMA_ENDPOINT || "").replace(/\/api\/generate$/, "/api/embeddings");
const EMBED_MODEL = process.env.GEMMA_EMBED_MODEL || "nomic-embed-text";

const FETCH_TIMEOUT_MS = 8000;
const GEMMA_TIMEOUT_MS = 30000;

function requireEnv() {
  const missing = ["SUPABASE_URL", "GEMMA_ENDPOINT"].filter((k) => !process.env[k]);
  if (!DRY_RUN) missing.push(...(!SERVICE_ROLE_KEY ? ["SUPABASE_SERVICE_ROLE_KEY"] : []));
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Supabase REST helpers (PostgREST, no SDK dependency) - sbGet is the
// same shape as price-agent.js's. sbUpsert is new: price-agent.js's
// sbInsert is a plain append-only insert with no on_conflict handling,
// which doesn't fit here since a changed expense needs to overwrite its
// existing embedding row, not accumulate a second one.
async function sbGet(path) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function sbUpsert(table, rows, conflictColumn) {
  if (DRY_RUN) {
    console.log(`[dry-run] would upsert ${rows.length} row(s) into ${table} on ${conflictColumn}`);
    return;
  }
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} -> HTTP ${res.status}: ${await res.text()}`);
}

// ---- Content hashing (delta detection) -------------------------------------
// Same fields app/insights.js's buildQaContext already surfaces per
// transaction - kept in sync by hand, same category as MARKET_INDEXES
// between app.js/price-agent.js, since there's no shared import between
// this Node script and the browser modules.
function embeddableText(expense) {
  const parts = [
    expense.occurred_at,
    expense.merchant || expense.description || "",
    `$${expense.amount}`,
    expense.category || "",
    expense.payment_type || "",
  ];
  return parts.filter(Boolean).join(" ");
}

function contentHash(expense) {
  return crypto.createHash("sha256").update(embeddableText(expense)).digest("hex");
}

// ---- Ollama embeddings ------------------------------------------------
async function embed(text) {
  const res = await fetchWithTimeout(GEMMA_EMBED_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma embeddings HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error("Gemma returned no embedding");
  return data.embedding;
}

// ---- Main ----------------------------------------------------------------
async function main() {
  requireEnv();
  if (!GEMMA_EMBED_ENDPOINT) {
    console.error("Could not derive an embeddings endpoint from GEMMA_ENDPOINT.");
    process.exit(1);
  }

  const expenses = await sbGet(
    "expenses?select=id,user_id,amount,description,merchant,category,payment_type,occurred_at"
  );
  console.log(`Fetched ${expenses.length} expense(s) across all users.`);
  if (!expenses.length) {
    console.log("Nothing to embed. Exiting.");
    return;
  }

  const existing = await sbGet("expense_embeddings?select=expense_id,content_hash");
  const existingHashes = new Map(existing.map((r) => [r.expense_id, r.content_hash]));

  let embedded = 0, skipped = 0, failed = 0;
  const rows = [];
  for (const expense of expenses) {
    const hash = contentHash(expense);
    if (existingHashes.get(expense.id) === hash) {
      skipped++;
      continue;
    }
    try {
      const vector = await embed(embeddableText(expense));
      rows.push({
        user_id: expense.user_id,
        expense_id: expense.id,
        content_hash: hash,
        occurred_at: expense.occurred_at,
        embedding: vector,
      });
      embedded++;
    } catch (err) {
      console.warn(`[${expense.id}] embedding failed: ${err.message}`);
      failed++;
    }
  }

  if (rows.length) {
    await sbUpsert("expense_embeddings", rows, "expense_id");
  }
  console.log(`Done. embedded=${embedded} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
