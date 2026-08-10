-- ============================================================================
-- Symmetric to 12_delete_liability_with_account.sql, for the asset side of
-- accounts.linked_asset_id (08_account_asset_link.sql). An account's linked
-- asset (Cash's Cash asset, a Checking account's bank asset) only exists to
-- track that specific account's balance - deleting the account should take
-- the asset with it instead of leaving an orphaned value nothing points at.
-- Deleting an asset directly is no longer offered in the UI for anything
-- account-linked; this is the backend half of that.
-- ============================================================================
create or replace function delete_linked_asset_on_account_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.linked_asset_id is not null then
    delete from assets where id = old.linked_asset_id;
  end if;
  return old;
end;
$$;

drop trigger if exists accounts_delete_linked_asset on accounts;
create trigger accounts_delete_linked_asset
  after delete on accounts
  for each row
  execute function delete_linked_asset_on_account_delete();
