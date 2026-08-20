-- Extends agent_run_status's allowed agent values to include
-- "price-agent-fast" - the new FAST_ONLY (Finnhub-only) cadence added to
-- tools/price-agent.js alongside its existing weekly "price-agent" run.
-- A fast run writes to a SEPARATE row under this new value specifically
-- so it never clobbers the full weekly run's own status - that row needs
-- to keep accurately reflecting Tavily/Gemini pipeline health (indexes,
-- explanations, news digest), none of which FAST_ONLY ever touches.
--
-- No new grants needed here - a CHECK constraint is a domain restriction,
-- not a privilege, and agent_run_status's existing grants (select to
-- authenticated, full CRUD to service_role, 48_agent_run_status.sql)
-- already cover every role that touches this table.
alter table agent_run_status drop constraint agent_run_status_agent_check;
alter table agent_run_status add constraint agent_run_status_agent_check
  check (agent in ('deal-agent', 'price-agent', 'price-agent-fast'));
