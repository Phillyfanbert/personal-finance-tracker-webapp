-- ============================================================================
-- Credit limit for revolving liability types. Motivated by wanting to show
-- credit utilization (balance / limit), the single largest factor in a real
-- credit score after payment history, which the app previously had no way
-- to compute - it tracked balance but never the limit that balance is
-- against.
--
-- Nullable, like interest_rate/minimum_payment already are: only shown/
-- editable for the liability types where "credit limit" is a real concept
-- (app.js's CREDIT_LIMIT_LIABILITY_TYPES) - a HELOC or personal line of
-- credit has one, a mortgage or auto loan does not (a fixed original loan
-- amount is a different concept, not a revolving ceiling you utilize
-- against). A true charge card ("no preset spending limit") is
-- deliberately excluded from that set too, for the same reason app.js
-- already excludes it from the grace-period math for a different
-- attribute - see CREDIT_LIMIT_LIABILITY_TYPES's own comment.
-- ============================================================================
alter table liabilities add column if not exists credit_limit numeric(12,2)
  check (credit_limit is null or credit_limit >= 0);
