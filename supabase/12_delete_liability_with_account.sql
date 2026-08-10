-- ============================================================================
-- A credit account's linked liability (11_account_liability_link.sql) only
-- exists to track that specific account's running balance - it's not a debt
-- a user tracks independently of the account. Deleting the account should
-- take the liability with it instead of leaving an orphaned balance nothing
-- points at anymore. This is backend-only cascade behavior, not something
-- the app has to remember to do on every delete path.
-- ============================================================================
create or replace function delete_linked_liability_on_account_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.linked_liability_id is not null then
    delete from liabilities where id = old.linked_liability_id;
  end if;
  return old;
end;
$$;

drop trigger if exists accounts_delete_linked_liability on accounts;
create trigger accounts_delete_linked_liability
  after delete on accounts
  for each row
  execute function delete_linked_liability_on_account_delete();
