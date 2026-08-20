-- Essential vs. discretionary flag (Subscriptions/Bills
-- feature) - just
-- the flag itself. The "what could I cut" report it's meant to power
-- doesn't exist yet and isn't part of this change; low value in
-- isolation, higher value once paired with a feature that reads it.
-- Defaults false (not essential) rather than true - a "candidates to
-- cut" framing only works if new entries start as candidates rather than
-- being assumed essential until manually downgraded.
alter table subscriptions add column if not exists is_essential boolean default false;
