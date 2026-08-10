-- ============================================================================
-- Savings joins Checking as a second bank-balance account type - the exact
-- case bank_name (14_account_bank_name.sql) was built for: one bank, a
-- Checking and a Savings under it, each with its own linked asset since
-- their balances aren't the same number. 'savings' needs to be a valid
-- value everywhere 'debit'/'checking' already was: the account's own
-- type, its auto-created asset's type (kept distinct from 'bank' so the
-- Assets card can tell a Checking-linked asset apart from a Savings-linked
-- one), and an expense's payment_type (since payment_type is read directly
-- off the selected account's type, not a separate field - app.js saveBtn).
-- ============================================================================
alter table accounts drop constraint accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type in ('checking','credit','debit','cash','other','savings'));

alter table assets drop constraint assets_type_check;
alter table assets add constraint assets_type_check
  check (type in ('cash','bank','investment','property','vehicle','other','savings'));

alter table expenses drop constraint expenses_payment_type_check;
alter table expenses add constraint expenses_payment_type_check
  check (payment_type in ('credit','debit','cash','savings'));
