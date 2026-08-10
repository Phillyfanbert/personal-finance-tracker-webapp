-- ============================================================================
-- Cash is a special account: exactly one per user, auto-created client-side
-- (app.js's ensureCashAccount()) rather than manually added. This partial
-- unique index is the backstop that guarantees "at most one" even under a
-- race (e.g. two tabs both deciding no cash account exists yet).
-- ============================================================================
create unique index if not exists accounts_one_cash_per_user
  on accounts (user_id)
  where type = 'cash';
