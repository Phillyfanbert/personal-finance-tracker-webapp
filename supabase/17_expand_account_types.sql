-- ============================================================================
-- Expand accounts/assets/liabilities/expenses type enums to cover every
-- documented account type, not just Checking/
-- Savings/Credit/Cash. Deliberately excludes two categories the doc itself
-- flagged as not personal payment-method accounts: business accounts (out
-- of scope for this app's personal-finance focus) and escrow accounts
-- (a sub-ledger belonging to a mortgage servicer, not something an
-- individual opens or selects as a payment method).
--
-- accounts.type and expenses.payment_type are kept as an identical list on
-- purpose - payment_type is always read directly off the selected
-- account's type (app.js), so the two must never be able to drift apart,
-- exactly like 15_add_savings_type.sql already established.
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
    -- loans
    'personal_loan','auto_loan','mortgage','home_equity_loan','student_loan','payday_loan','title_loan',
    -- retirement & investment
    'retirement_employer','ira','brokerage','plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    -- specialty
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value'
  ));

alter table expenses drop constraint expenses_payment_type_check;
alter table expenses add constraint expenses_payment_type_check
  check (payment_type in (
    'checking','debit','credit','cash','other','savings',
    'money_market','cash_management','cd',
    'charge_card','secured_credit_card','store_card','personal_line_of_credit','heloc','overdraft_line','bnpl',
    'personal_loan','auto_loan','mortgage','home_equity_loan','student_loan','payday_loan','title_loan',
    'retirement_employer','ira','brokerage','plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value'
  ));

alter table assets drop constraint assets_type_check;
alter table assets add constraint assets_type_check
  check (type in (
    -- existing
    'cash','bank','investment','property','vehicle','other','savings',
    -- deposit accounts
    'money_market','cash_management','cd',
    -- retirement & investment
    'retirement_employer','ira','brokerage','plan_529','tsp','solo_401k','rollover_inherited_ira','annuity',
    -- specialty
    'hsa','fsa','hra','dependent_care_fsa','coverdell_esa','able_account',
    'prepaid_card','payroll_card','second_chance_checking','digital_wallet','treasury_direct','crypto',
    'multi_currency','life_insurance_cash_value'
  ));

alter table liabilities drop constraint liabilities_type_check;
alter table liabilities add constraint liabilities_type_check
  check (type in (
    -- existing
    'credit_card','loan','mortgage','other',
    -- credit accounts
    'charge_card','secured_credit_card','store_card','personal_line_of_credit','heloc','overdraft_line','bnpl',
    -- loans
    'personal_loan','auto_loan','home_equity_loan','student_loan','payday_loan','title_loan'
  ));
