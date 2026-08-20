-- CD maturity date (a gap flagged during
-- account-type research). Lives on `assets`, not
-- `accounts` - a CD's maturity is a property of the financial instrument
-- itself, and assets is the table that tracks it long-term (the same
-- table already used for every other manually-valued asset type). No
-- CHECK tying it to type = 'cd' - nothing stops setting it on another
-- asset type, same lack of enforcement subscriptions.next_renewal has for
-- its own billing_cycle.
alter table assets add column if not exists maturity_date date;
