-- ============================================================================
-- Expand `profiles` beyond the student-only eligibility check it started
-- with, into two groups of fields (per user decision, not guessed):
--
-- Deal-eligibility fields - extend discounts.js's isEligible() past the
-- single student check to also recognize military, first responder/
-- healthcare, and (approximate) senior discount plan types in
-- subscription_catalog (plan_type has no CHECK constraint - it's
-- reference data seeded by hand, so new plan_type values need no schema
-- change there, just matching logic on this side).
--
-- Financial-context fields - not used for deal matching at all, instead
-- folded into the Gemma Q&A context (insights.js buildQaContext) so
-- "should I pay down debt or save?" has something to actually reason
-- about, and available for a future recommendations feature.
-- ============================================================================
alter table profiles add column if not exists is_military boolean not null default false;
alter table profiles add column if not exists is_first_responder_healthcare boolean not null default false;
alter table profiles add column if not exists birth_year int;
alter table profiles add column if not exists employer text;
alter table profiles add column if not exists occupation text;
alter table profiles add column if not exists housing_status text check (housing_status in ('own', 'rent', 'other'));
alter table profiles add column if not exists employment_status text check (employment_status in ('employed', 'self_employed', 'retired', 'unemployed', 'other'));
alter table profiles add column if not exists household_size int;
alter table profiles add column if not exists dependents int;
alter table profiles add column if not exists financial_goals text;
