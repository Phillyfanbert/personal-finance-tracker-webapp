-- Real, structured per-symbol news headlines from Finnhub's free
-- /company-news endpoint - zero LLM step, strictly more grounded than
-- the existing Gemini-authored asset_price_findings.explanation/
-- market_index_findings.explanation one-sentence paraphrase (real links,
-- no synthesis). Same [{title, url, source}] shape market_news_findings
-- .headlines already established. Populated by tools/price-agent.js's
-- FAST_ONLY loop on the same 15-minute Finnhub-only cadence real ticker
-- prices already use (gated to roughly once/hour per symbol, see
-- shouldFetchNewsThisRun() - this is an insert-only table nothing ever
-- purges, so writing a headlines blob on every 15-min run would multiply
-- storage growth for content that mostly doesn't change that often).
--
-- No new grants needed - both tables' existing grants (authenticated
-- select, service_role full CRUD) already cover every role that touches
-- them; adding a nullable column isn't a privilege change.
alter table asset_price_findings add column if not exists headlines jsonb;
alter table market_index_findings add column if not exists headlines jsonb;
