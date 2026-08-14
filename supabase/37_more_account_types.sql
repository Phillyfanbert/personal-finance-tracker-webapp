-- ============================================================================
-- Second expansion of the account/asset/liability type enums, extending
-- 17_expand_account_types.sql. Driven by the retirement side being far too
-- coarse: a single 'ira' value could not tell a Traditional IRA from a Roth
-- IRA, and 'retirement_employer' lumped 401(k), 403(b) and 457(b) together.
-- That is not a labelling nicety - a traditional (pre-tax) balance still
-- owes income tax on withdrawal while a Roth (post-tax) balance does not, so
-- two accounts showing the same dollar figure are worth materially
-- different amounts. Splitting them is what makes that distinction
-- recordable at all.
--
-- 'ira' and 'retirement_employer' are deliberately KEPT as valid values -
-- rows already exist against them and this migration does not rewrite user
-- data. app.js hides them from the new-account pickers instead
-- (LEGACY_ACCOUNT_TYPES), so they stay readable without being chosen again.
--
-- accounts.type and expenses.payment_type stay an identical list, for the
-- same reason 15_add_savings_type.sql and 17_expand_account_types.sql
-- already established: payment_type is read straight off the selected
-- account's type in app.js, so the two must never drift apart.
-- ============================================================================
alter table accounts drop constraint accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type in (
    -- existing
    'checking','debit','credit','cash','other','savings',
    -- deposit accounts
    'money_market','cash_management','cd',
    -- credit accounts
    'charge_card','secured_credit_card','store_card','personal_line_of_credit','heloc','overdraft_line','bnpl',
    'medical_credit_card',
    -- loans
    'personal_loan','auto_loan','mortgage','home_equity_loan','student_loan','payday_loan','title_loan',
    'credit_builder_loan','retirement_plan_loan',
    -- retirement & investment (legacy coarse buckets kept for existing rows)
    'retirement_employer','ira',
    'traditional_401k','roth_401k','plan_403b','plan_457b',
    'traditional_ira','roth_ira','sep_ira','simple_ira',
    'brokerage','espp','pension','custodial_utma',
    'plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    -- specialty
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value','trust_account'
  ));

alter table expenses drop constraint expenses_payment_type_check;
alter table expenses add constraint expenses_payment_type_check
  check (payment_type in (
    'checking','debit','credit','cash','other','savings',
    'money_market','cash_management','cd',
    'charge_card','secured_credit_card','store_card','personal_line_of_credit','heloc','overdraft_line','bnpl',
    'medical_credit_card',
    'personal_loan','auto_loan','mortgage','home_equity_loan','student_loan','payday_loan','title_loan',
    'credit_builder_loan','retirement_plan_loan',
    'retirement_employer','ira',
    'traditional_401k','roth_401k','plan_403b','plan_457b',
    'traditional_ira','roth_ira','sep_ira','simple_ira',
    'brokerage','espp','pension','custodial_utma',
    'plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value','trust_account'
  ));

alter table assets drop constraint assets_type_check;
alter table assets add constraint assets_type_check
  check (type in (
    -- existing
    'cash','bank','investment','property','vehicle','other','savings',
    -- deposit accounts
    'money_market','cash_management','cd',
    -- retirement & investment
    'retirement_employer','ira',
    'traditional_401k','roth_401k','plan_403b','plan_457b',
    'traditional_ira','roth_ira','sep_ira','simple_ira',
    'brokerage','espp','pension','custodial_utma',
    'plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    -- specialty
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value','trust_account'
  ));

alter table liabilities drop constraint liabilities_type_check;
alter table liabilities add constraint liabilities_type_check
  check (type in (
    -- existing
    'credit_card','loan','mortgage','other',
    -- credit accounts
    'charge_card','secured_credit_card','store_card','personal_line_of_credit','heloc','overdraft_line','bnpl',
    'medical_credit_card',
    -- loans
    'personal_loan','auto_loan','home_equity_loan','student_loan','payday_loan','title_loan',
    'credit_builder_loan','retirement_plan_loan'
  ));
