-- Investments tab. investment_bucket is a
-- user-assigned free-text label ("Stocks", "Bonds", "Cash", ...) used by
-- the target-allocation calculator to group holdings - free text + a
-- <datalist> of suggestions in the UI, same pattern accounts.bank_name/
-- subscriptions.category already use, deliberately no CHECK constraint
-- since there's no fixed list of valid buckets.
alter table assets add column if not exists investment_bucket text;

-- explanation is a best-effort "why did this move" summary written by the
-- extended tools/price-agent.js (one more SearXNG+Gemma step after a price
-- is found) - nullable and best-effort by design: a failed news search or
-- Gemma call never blocks the price write itself.
alter table asset_price_findings add column if not exists explanation text;
