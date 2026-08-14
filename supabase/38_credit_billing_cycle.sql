-- ============================================================================
-- Credit-card billing cycle: statement close day, payment due day, and the
-- last statement balance, so the app can tell the three genuinely different
-- end-of-cycle outcomes apart.
--
-- The distinction this exists to capture (and which the app got wrong by
-- omission before): a credit card does NOT only charge interest when a
-- payment is late. Interest is governed by the GRACE PERIOD - pay the
-- statement balance in full by the due date and purchases accrue no
-- interest at all; carry any part of it and interest accrues on the
-- remainder even if every payment was made on time. Paying only the minimum
-- keeps the account current (no late fee, no delinquency mark) but does
-- nothing to stop interest. So the three outcomes are:
--
--   paid statement balance in full   -> no interest, no late fee
--   paid >= minimum but < full       -> interest on the remainder, no fee
--   paid < minimum                   -> interest AND a late fee
--
-- statement_day / due_day are DAYS OF THE MONTH (1-31), not dates - a card's
-- cycle repeats monthly, so storing a single date would go stale after one
-- cycle. Both nullable: a card with neither set simply shows no cycle
-- status, exactly like interest_rate/minimum_payment already behave.
-- Deliberately not a full statement-history table - one row per liability
-- tracking the current cycle is enough for "are you about to be charged
-- interest," and a real statement archive is a much bigger feature that
-- nothing in the app needs yet.
--
-- last_statement_balance is what the grace-period test measures a payment
-- against. Null means "no statement recorded yet," which the app treats as
-- "cannot judge this cycle" rather than guessing from the live balance -
-- the live balance moves with every new charge, so comparing payments
-- against it would call a fully-paid card underpaid the moment anything new
-- was charged.
-- ============================================================================
alter table liabilities add column if not exists statement_day integer
  check (statement_day is null or (statement_day >= 1 and statement_day <= 31));
alter table liabilities add column if not exists due_day integer
  check (due_day is null or (due_day >= 1 and due_day <= 31));
alter table liabilities add column if not exists last_statement_balance numeric(12,2)
  check (last_statement_balance is null or last_statement_balance >= 0);
alter table liabilities add column if not exists last_statement_date date;
