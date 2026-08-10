-- assets.updated_at / liabilities.updated_at have had a default of now()
-- since 07_assets_liabilities.sql, but nothing ever actually bumped them
-- on UPDATE - both columns have silently just stayed pinned to creation
-- time forever. Needed correctly now for the Assets card's staleness
-- nudge, which measures "how long since this value was last touched" -
-- a DB trigger, not app-code, so it holds regardless of which client
-- makes the change, same reasoning behind the account/asset/liability
-- delete-cascade triggers elsewhere in this schema.
create or replace function touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assets_touch_updated_at on assets;
create trigger assets_touch_updated_at
  before update on assets
  for each row execute function touch_updated_at();

drop trigger if exists liabilities_touch_updated_at on liabilities;
create trigger liabilities_touch_updated_at
  before update on liabilities
  for each row execute function touch_updated_at();
