-- ============================================================================
-- "Bank" as a distinct concept from "account". An account's name is what
-- you call it (Checking, Savings, Credit); bank_name is which institution
-- it's at (Chase, Discover) - purely a display/grouping label, unrelated
-- to linked_asset_id/linked_liability_id (which track the actual dollar
-- value). Multiple accounts - a Checking and a Savings, say - can share
-- the same bank_name; each still gets its own linked asset, since their
-- balances aren't the same number even though they're at the same bank.
--
-- Cash is exempt (no real-world "bank" to name) - everything else is
-- required to have one, enforced below. Existing rows are backfilled
-- first so the constraint doesn't reject them.
-- ============================================================================
alter table accounts add column if not exists bank_name text;

update accounts set bank_name = 'Bank of America', name = 'Checking'
  where type = 'debit' and bank_name is null and name = 'Bank of America';
update accounts set bank_name = 'Discover', name = 'Credit'
  where type = 'credit' and bank_name is null and name = 'Discover Credit';

alter table accounts add constraint accounts_bank_name_required
  check (type = 'cash' or bank_name is not null);
