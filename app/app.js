// ============================================================================
// Expense Tracker - Phase 1 app logic (plain ES modules, no build step).
// Adds: editable expenses, category-correction learning loop (README §3.5),
// richer account management, and monthly charts (README §3.8).
// RLS scopes every query to the signed-in user.
// ============================================================================
import { categorize, quickParse, CATEGORIES } from "./categorize.js";
import {
  monthKey, monthLabel, lastMonths, sumBy, monthlyTotals,
  renderBreakdownBar, renderTrendBar, renderLineChart,
} from "./charts.js";
import { buildBalanceHistory } from "./accountHistory.js";
import { estimateValue, effectiveAssetValue } from "./depreciation.js";
import { payoffProjection } from "./payoff.js";
import { budgetStatus } from "./budgets.js";
import { investmentHoldings, portfolioTotals, allocationVsTarget } from "./investments.js";
import {
  guessColumnMapping, guessSignConvention, normalizeRow, isLikelyDuplicate,
} from "./csvImport.js";
import { buildExpensesCsv } from "./export.js";
import {
  monthlyAmount, totalMonthly, daysUntil, upcomingRenewals, renewalLabel, advanceRenewal,
  detectRecurringExpenses,
} from "./subscriptions.js";
import { findDeals, studentUpsell, eligibilityUpsells, matchService } from "./discounts.js";
import { parseWithGemma, askGemma } from "./gemma.js";
import { buildQaContext } from "./insights.js";
import { computeNetWorth } from "./networth.js";
import { BANK_NAMES } from "./bankNames.js";

const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMMA_ENDPOINT, GEMMA_MODEL, DEAL_FINDINGS_ENABLED, PRICE_FINDINGS_ENABLED } = window.APP_CONFIG || {};
if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR-PROJECT")) {
  alert("Set your Supabase URL and anon key in config.js (see SETUP.md §4).");
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- tiny helpers ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Every innerHTML template string below interpolates *some* user-typed or
// scraped/LLM-derived text (an expense description, an asset name, the
// Investments tab's price-agent-sourced "why" explanation, ...) - wrap
// exactly those interpolations in esc(), never fixed labels/numbers/dates.
// Applied only at render time; the DB always stores the raw, unescaped
// value - escaping here is about what reaches the DOM as markup, not
// about what gets written to Supabase.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}
// Promise-based replacement for window.confirm() on destructive actions -
// resolves true/false, same call shape as confirm() (await it, act on the
// result), but rendered as an in-app modal so it matches the rest of the UI
// instead of the browser's native dialog box.
let confirmModalResolve = null;
function confirmModal(message, { title = "Are you sure?", confirmLabel = "Delete" } = {}) {
  $("confirmModalTitle").textContent = title;
  $("confirmModalMsg").textContent = message;
  $("confirmModalOk").textContent = confirmLabel;
  $("confirmModal").classList.remove("hidden");
  return new Promise((resolve) => { confirmModalResolve = resolve; });
}
function closeConfirmModal(result) {
  $("confirmModal").classList.add("hidden");
  if (confirmModalResolve) { confirmModalResolve(result); confirmModalResolve = null; }
}
$("confirmModalCancel").onclick = () => closeConfirmModal(false);
$("confirmModalOk").onclick = () => closeConfirmModal(true);
// account.name alone is now often generic (Checking, Credit) - bank_name
// is what actually distinguishes two accounts of the same type at
// different banks, so anywhere an account is displayed by itself (not
// already grouped under its bank, like the Accounts card circles are)
// needs both. Cash has no bank_name, so it's unaffected.
const acctLabel = (a) => (a ? (a.bank_name ? `${a.bank_name} ${a.name}` : a.name) : "");
const acctName = (id) => acctLabel(accounts.find((a) => a.id === id));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// A stable keyword to learn from (first meaningful token of merchant/description).
function learnKeyword(row) {
  const src = (row.merchant || row.description || "").toLowerCase().trim();
  const tok = src.split(/\s+/).filter((w) => w.length >= 3)[0];
  return tok || null;
}

let userRules = {};   // keyword -> category
let accounts = [];
let allExpenses = []; // cache for reports (last ~12 months)
let subscriptions = []; // cache of the user's subscriptions
let catalog = [];     // shared subscription_catalog reference data
let dealFindings = []; // shared, machine-found deals (F6 stretch)
let assetPriceFindings = []; // shared, machine-found asset prices
let budgets = []; // per-category monthly limits
let budgetWarnings = []; // this month's budgetStatus() rows at/over WARN_THRESHOLD_PCT
let investmentTargets = []; // per-bucket allocation targets (Investments tab)
let assets = [];      // net-worth assets (Log page)
let debts = [];        // tracked debts, i.e. rows in the `liabilities` table (Log page)
let accountActivity = []; // non-expense money movements (asset adjust, liability pay) - Recent Transactions
let editing = null;   // expense row currently in the edit modal
let editingSub = null; // subscription row currently in the sub form
let userId = null;    // signed-in user's uuid
let userEmail = null; // signed-in user's email, shown read-only in Profile
let profile = null;   // the user's profiles row
let entrySource = "manual"; // 'manual' | 'parsed' - set to 'parsed' when Gemma fills fields
let gemmaTimer = null;      // debounce handle for background parsing

// ---- AUTH ------------------------------------------------------------------
$("signInBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) return toast("Enter your email");
  $("signInBtn").disabled = true;
  $("signInBtn").textContent = "Sending...";
  $("authMsg").textContent = "Sending magic link...";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  $("signInBtn").disabled = false;
  $("signInBtn").textContent = "Send magic link instead";
  $("authMsg").textContent = error ? error.message : "Link sent ✓ - check your email.";
  toast(error ? "Couldn't send link" : "Magic link sent ✓");
};
// Primary sign-in path (see index.html's authView comment) - completes
// entirely in whichever window is open, so it's the only path that keeps
// an installed home-screen icon signed in. Magic link above stays as the
// bootstrap/recovery path for setting or resetting this password.
$("passwordSignInBtn").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email) return toast("Enter your email");
  if (!password) return toast("Enter your password");
  $("passwordSignInBtn").disabled = true;
  $("passwordSignInBtn").textContent = "Signing in...";
  $("passwordAuthMsg").textContent = "Signing in...";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $("passwordSignInBtn").disabled = false;
  $("passwordSignInBtn").textContent = "Sign in";
  $("passwordAuthMsg").textContent = error ? error.message : "";
  if (error) toast("Couldn't sign in");
};
$("signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };

sb.auth.onAuthStateChange((_e, session) => renderAuth(session));
sb.auth.getSession().then(({ data }) => renderAuth(data.session));

function renderAuth(session) {
  const authed = !!session;
  userId = session?.user?.id ?? null;
  userEmail = session?.user?.email ?? null;
  $("authView").classList.toggle("hidden", authed);
  $("nav").classList.toggle("hidden", !authed);
  if (authed) { showView("log"); init(); }
  else { $("logView").classList.add("hidden"); $("subsView").classList.add("hidden"); $("reportsView").classList.add("hidden"); $("investView").classList.add("hidden"); }
}

// ---- NAVIGATION ------------------------------------------------------------
$("navLog").onclick = () => showView("log");
$("navSubs").onclick = () => { showView("subs"); loadSubscriptions(); };
$("navReports").onclick = () => { showView("reports"); loadReports(); };
$("navInvest").onclick = () => { showView("invest"); renderInvestments(); renderInvestmentsTrend(); };
$("backFromSubs").onclick = () => showView("log");
$("backFromReports").onclick = () => showView("log");
$("backFromInvest").onclick = () => showView("log");
function showView(v) {
  $("logView").classList.toggle("hidden", v !== "log");
  $("subsView").classList.toggle("hidden", v !== "subs");
  $("reportsView").classList.toggle("hidden", v !== "reports");
  $("investView").classList.toggle("hidden", v !== "invest");
  $("navLog").classList.toggle("active", v === "log");
  $("navSubs").classList.toggle("active", v === "subs");
  $("navReports").classList.toggle("active", v === "reports");
  $("navInvest").classList.toggle("active", v === "invest");
}

// ---- INIT ------------------------------------------------------------------
async function init() {
  fillCategorySelect($("fCategory"));
  fillCategorySelect($("eCategory"));
  fillCategorySelect($("bulkCategorySelect"));
  fillCategorySelect($("budgetCategory"));
  $("fDate").value = new Date().toISOString().slice(0, 10);
  await ensureCashAccount();
  // loadAccounts before loadDebts: the debts list checks accounts for which
  // liabilities are account-linked (to hide their delete button), so it
  // needs a populated `accounts` to render correctly on first paint.
  await loadAccounts();
  await Promise.all([loadRules(), loadProfile(), loadCatalog(), loadDealFindings(), loadAssetPriceFindings(), loadAssets(), loadDebts(), loadAccountActivity(), loadBudgets(), loadInvestmentTargets()]);
  await Promise.all([loadExpenses(), loadSubscriptions()]);
  await autoLogDueSubscriptions();
  await snapshotNetWorthIfNeeded();
  await snapshotPortfolioIfNeeded();
}

// Every user gets exactly one Cash account + linked Cash asset, auto-created
// on first load rather than manually added (accounts_one_cash_per_user in
// 09_cash_account.sql is the DB-level backstop against duplicates).
async function ensureCashAccount() {
  const { data } = await sb.from("accounts").select("id").eq("type", "cash").limit(1);
  if (data && data.length) return;
  const { data: asset, error: assetErr } = await sb.from("assets")
    .insert({ name: "Cash", type: "cash", value: 0 }).select().single();
  if (assetErr) return; // best-effort - don't block app load on this
  await sb.from("accounts").insert({ name: "Cash", type: "cash", linked_asset_id: asset.id });
}

async function loadCatalog() {
  const { data } = await sb.from("subscription_catalog").select("*");
  catalog = data || [];
}

// F6 stretch - dormant until DEAL_FINDINGS_ENABLED is flipped on (config.js) and
// the home-machine search agent (tools/deal-agent.js) starts writing rows.
async function loadDealFindings() {
  if (!DEAL_FINDINGS_ENABLED) { dealFindings = []; return; }
  const { data } = await sb.from("deal_findings").select("*").gt("expires_at", new Date().toISOString());
  dealFindings = data || [];
}

// Dormant until PRICE_FINDINGS_ENABLED is flipped on (config.js) and
// tools/price-agent.js starts writing rows.
// Loads in parallel with loadAssets() (init()'s Promise.all), so this also
// re-renders on its own completion - whichever of the two finishes second
// is the one that ends up with a correct render, same pattern
// renderRecurringCandidates() already uses for its own two parallel loads.
async function loadAssetPriceFindings() {
  if (!PRICE_FINDINGS_ENABLED) { assetPriceFindings = []; renderAssetPriceFindings(); return; }
  const { data } = await sb.from("asset_price_findings").select("*").gt("expires_at", new Date().toISOString());
  assetPriceFindings = data || [];
  renderAssetPriceFindings();
}
function fillCategorySelect(sel) { sel.innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join(""); }

async function loadRules() {
  const { data } = await sb.from("category_rules").select("keyword,category");
  userRules = {};
  (data || []).forEach((r) => { userRules[r.keyword] = r.category; });
}

// ---- ACCOUNTS --------------------------------------------------------------
// ~42 account types across 5 categories (Deposit accounts, Credit
// accounts, Loans, Retirement & investment, Specialty), as a single
// data-driven config instead of one hardcoded map per concern - adding a
// new type later means adding one entry here, not touching five different
// functions. `kind` decides whether saving this type auto-creates+links a
// row in `assets` (money you have) or `liabilities` (money you owe);
// `linkType` is that row's own `type` value. `category` groups the account
// type picker (see setAcctType/index.html) and decides the bank-name
// validation strictness (see isKnownBank below) - a checking account is
// realistically at an FDIC bank, a brokerage or crypto exchange is not.
// Business accounts and escrow accounts are deliberately excluded - see
// 17_expand_account_types.sql for why.
// 'cash' is deliberately absent - there's exactly one Cash account per
// user, auto-managed by ensureCashAccount(), never created through this
// form, and the only type exempt from needing a bank (accounts_bank_name_
// required, 14_account_bank_name.sql). 'other'/'checking' stay valid at
// the database level for backward compatibility but aren't offered here.
const ACCOUNT_TYPES = {
  debit:                  { label: "Checking",                    category: "Deposit accounts",         kind: "asset",     linkType: "bank" },
  savings:                { label: "Savings",                     category: "Deposit accounts",         kind: "asset",     linkType: "savings" },
  money_market:           { label: "Money Market",                category: "Deposit accounts",         kind: "asset",     linkType: "money_market" },
  cash_management:        { label: "Cash Management",             category: "Deposit accounts",         kind: "asset",     linkType: "cash_management" },
  cd:                     { label: "Certificate of Deposit",      category: "Deposit accounts",         kind: "asset",     linkType: "cd" },

  credit:                 { label: "Credit Card",                 category: "Credit accounts",          kind: "liability", linkType: "credit_card" },
  charge_card:            { label: "Charge Card",                 category: "Credit accounts",          kind: "liability", linkType: "charge_card" },
  secured_credit_card:    { label: "Secured Credit Card",         category: "Credit accounts",          kind: "liability", linkType: "secured_credit_card" },
  store_card:             { label: "Store / Retail Card",         category: "Credit accounts",          kind: "liability", linkType: "store_card" },
  personal_line_of_credit:{ label: "Personal Line of Credit",     category: "Credit accounts",          kind: "liability", linkType: "personal_line_of_credit" },
  heloc:                  { label: "HELOC",                       category: "Credit accounts",          kind: "liability", linkType: "heloc" },
  overdraft_line:         { label: "Overdraft Line of Credit",    category: "Credit accounts",          kind: "liability", linkType: "overdraft_line" },
  bnpl:                   { label: "Buy Now, Pay Later",          category: "Credit accounts",          kind: "liability", linkType: "bnpl" },

  personal_loan:          { label: "Personal Loan",               category: "Loans",                    kind: "liability", linkType: "personal_loan" },
  auto_loan:              { label: "Auto Loan",                   category: "Loans",                    kind: "liability", linkType: "auto_loan" },
  mortgage:               { label: "Mortgage",                    category: "Loans",                    kind: "liability", linkType: "mortgage" },
  home_equity_loan:       { label: "Home Equity Loan",            category: "Loans",                    kind: "liability", linkType: "home_equity_loan" },
  student_loan:           { label: "Student Loan",                category: "Loans",                    kind: "liability", linkType: "student_loan" },
  payday_loan:            { label: "Payday Loan",                 category: "Loans",                    kind: "liability", linkType: "payday_loan" },
  title_loan:             { label: "Title Loan",                  category: "Loans",                    kind: "liability", linkType: "title_loan" },

  retirement_employer:    { label: "401(k) / 403(b) / 457",       category: "Retirement & investment",  kind: "asset",     linkType: "retirement_employer" },
  ira:                    { label: "IRA",                         category: "Retirement & investment",  kind: "asset",     linkType: "ira" },
  brokerage:              { label: "Brokerage",                   category: "Retirement & investment",  kind: "asset",     linkType: "brokerage" },
  plan_529:               { label: "529 Plan",                    category: "Retirement & investment",  kind: "asset",     linkType: "plan_529" },
  tsp:                    { label: "Thrift Savings Plan (TSP)",   category: "Retirement & investment",  kind: "asset",     linkType: "tsp" },
  solo_401k:              { label: "Solo 401(k)",                 category: "Retirement & investment",  kind: "asset",     linkType: "solo_401k" },
  rollover_inherited_ira: { label: "Rollover / Inherited IRA",    category: "Retirement & investment",  kind: "asset",     linkType: "rollover_inherited_ira" },
  annuity:                { label: "Annuity",                     category: "Retirement & investment",  kind: "asset",     linkType: "annuity" },

  hsa:                    { label: "HSA",                         category: "Specialty",                kind: "asset",     linkType: "hsa" },
  fsa:                    { label: "FSA",                         category: "Specialty",                kind: "asset",     linkType: "fsa" },
  hra:                    { label: "HRA",                         category: "Specialty",                kind: "asset",     linkType: "hra" },
  dependent_care_fsa:     { label: "Dependent Care FSA",          category: "Specialty",                kind: "asset",     linkType: "dependent_care_fsa" },
  coverdell_esa:          { label: "Coverdell ESA",               category: "Specialty",                kind: "asset",     linkType: "coverdell_esa" },
  able_account:           { label: "ABLE Account",                category: "Specialty",                kind: "asset",     linkType: "able_account" },
  prepaid_card:           { label: "Prepaid Card",                category: "Specialty",                kind: "asset",     linkType: "prepaid_card" },
  payroll_card:           { label: "Payroll Card",                category: "Specialty",                kind: "asset",     linkType: "payroll_card" },
  second_chance_checking: { label: "Second-Chance Checking",      category: "Specialty",                kind: "asset",     linkType: "second_chance_checking" },
  digital_wallet:         { label: "Digital Wallet",              category: "Specialty",                kind: "asset",     linkType: "digital_wallet" },
  treasury_direct:        { label: "Treasury Direct",             category: "Specialty",                kind: "asset",     linkType: "treasury_direct" },
  crypto:                 { label: "Cryptocurrency",              category: "Specialty",                kind: "asset",     linkType: "crypto" },
  multi_currency:         { label: "Multi-Currency Account",      category: "Specialty",                kind: "asset",     linkType: "multi_currency" },
  life_insurance_cash_value: { label: "Life Insurance Cash Value",category: "Specialty",                kind: "asset",     linkType: "life_insurance_cash_value" },
};
const ACCOUNT_CATEGORIES = ["Deposit accounts", "Credit accounts", "Loans", "Retirement & investment", "Specialty"];
// Per-type, not per-category - "is this realistically an FDIC/NCUA bank or
// credit union" doesn't follow category lines cleanly. Every Deposit
// account is bank-issued, but Credit accounts and Loans are a mix: a
// mortgage or HELOC is bank-issued, but BNPL (Affirm, Klarna) and payday/
// title loans are not, and even ordinary loans are routinely issued by
// non-bank lenders (Sallie Mae for student loans, a dealership's captive
// finance arm for auto loans). Retirement/Specialty institutions
// (brokerages, crypto exchanges, insurers, plan administrators) are never
// banks. Requiring one of ~3,750 real bank names anywhere on this list
// would incorrectly reject real institution names like "Affirm" or
// "Fidelity" - those get a plain non-empty-name check instead.
const BANK_VALIDATED_TYPES = new Set([
  "debit", "savings", "money_market", "cash_management", "cd",
  "credit", "charge_card", "secured_credit_card", "personal_line_of_credit", "heloc", "overdraft_line",
]);
// Derived rather than hand-maintained, so ACCOUNT_TYPES above stays the
// single source of truth - see AUTO_ASSET_TYPE/AUTO_LIABILITY_TYPE below.
function accountTypesOfKind(kind) {
  const out = {};
  for (const [type, cfg] of Object.entries(ACCOUNT_TYPES)) {
    if (cfg.kind === kind) out[type] = cfg.linkType;
  }
  return out;
}
const AUTO_ASSET_TYPE = accountTypesOfKind("asset");
const AUTO_LIABILITY_TYPE = accountTypesOfKind("liability");
// No free-text "account name" field - in practice it was always just the
// type anyway (Checking, Savings, Credit), so the account's name is
// derived from whichever type is selected instead of typed twice.
const ACCOUNT_TYPE_NAME = Object.fromEntries(
  Object.entries(ACCOUNT_TYPES).map(([type, cfg]) => [type, cfg.label])
);
// 'cash' (and legacy DB-only values 'checking'/'other') aren't in
// ACCOUNT_TYPES, so ACCOUNT_TYPE_NAME has no entry for them - cap() is a
// safety net so a raw type ever shown to the user (the type filter, a
// transaction's meta line) reads "Cash", not the lowercase enum value.
const accountTypeLabel = (type) => ACCOUNT_TYPE_NAME[type] || cap(type);
// Every liability-linked account type, in one place - anywhere that used
// to special-case the literal string 'credit' (Monthly liabilities math,
// the "Owed" balance-line prefix) now checks this instead, so a HELOC or
// mortgage account behaves the same way a credit card always has.
const LIABILITY_ACCOUNT_TYPES = new Set(Object.keys(AUTO_LIABILITY_TYPE));
// Every account type CAN be created and its balance manually tracked
// (tap its circle in the Accounts card), but not every type is something
// you'd actually select as "how did you pay for this" - you can't swipe a
// 401(k) at Chipotle. This set is what's excluded from the expense
// payment-method pickers (quick-add, edit modal, subscriptions) - found by
// live-testing (a mock 401(k) account sat in the same dropdown as
// checking, with zero distinction) and confirmed as a real gap, not just
// a bug, so this was an explicit decision, not a default.
//
// Grounded in whether the real-world product actually has a debit card /
// check-writing capability, not category membership - Specialty is a
// deliberate mix (HSA/FSA/ABLE genuinely have cards; Coverdell/Treasury
// Direct/crypto/life insurance cash value do not), same lesson as
// BANK_VALIDATED_TYPES not following category lines cleanly either. All
// of Deposit accounts (except CD, which is locked until maturity) and all
// of Credit accounts remain spendable - a credit card, HELOC, or even
// BNPL is still something you'd genuinely select at checkout.
const NON_SPENDABLE_ACCOUNT_TYPES = new Set([
  "cd",
  "personal_loan", "auto_loan", "mortgage", "home_equity_loan", "student_loan", "payday_loan", "title_loan",
  "retirement_employer", "ira", "brokerage", "plan_529", "tsp", "solo_401k", "rollover_inherited_ira", "annuity",
  "coverdell_esa", "treasury_direct", "crypto", "life_insurance_cash_value",
]);
// Which asset types populate the Investments tab. Derived from
// ACCOUNT_TYPES' own category grouping (every "Retirement & investment"
// type), plus 'crypto' added explicitly - it's category Specialty, not
// Retirement & investment, same "decide per-type, don't assume category
// decides it" rule BANK_VALIDATED_TYPES/NON_SPENDABLE_ACCOUNT_TYPES above
// already document. Broader than "has a price_symbol set" on purpose - a
// plain 401(k) with no individual tickers should still show up as a
// value-only line, just with no gain/loss or day-change math to show.
const INVESTMENT_ASSET_TYPES = new Set([
  ...Object.entries(ACCOUNT_TYPES).filter(([, cfg]) => cfg.category === "Retirement & investment").map(([type]) => type),
  "crypto",
]);
// BANK_NAMES (bankNames.js) is ~3,750 real FDIC-insured banks plus a few
// well-known credit unions/brands FDIC doesn't cover - not a hardcoded
// seed list anymore. isKnownBank() is what actually enforces "type a real
// bank" (saveAcctBtn below); the datalist (loadAccounts()) is just this
// same source made pickable instead of typed blind.
//
// Matching is deliberately loose, not exact-equals: official FDIC names
// are legal-entity names ("JPMorgan Chase Bank, National Association"),
// not brand names ("Chase") - a strict match would reject the name
// everyone actually uses. One direction only, though - "does a real
// bank's name contain what was typed" (catches "Chase" inside the legal
// name, and the full legal name typed verbatim, since a string contains
// itself). The reverse ("does what was typed contain a real bank's
// name") looked equally reasonable but isn't safe: FDIC's data includes
// an institution literally named "BANK", so it matched *any* gibberish
// that happened to contain the word "bank" - which is most made-up bank
// names. Caught by testing actual gibberish input before shipping this,
// not just the happy path.
function isKnownBank(name) {
  const typed = name.trim().toLowerCase();
  if (typed.length < 3) return false; // too short to mean anything either way
  return BANK_NAMES.some((b) => b.toLowerCase().includes(typed));
}

// With ~40 types across 5 categories, a 3-button toggle (the original
// design, chosen specifically so a selection couldn't be glanced past - a
// dropdown's silent default once shipped a real "Credit-named account
// saved as Checking" bug) doesn't fit on screen. A <select> is unavoidable
// at this scale, so the regression is mitigated a different way instead:
// a bold, always-visible "Adding: <type>" label next to it, updated on
// every change, so the current selection stays impossible to miss even
// without three physically separate buttons.
function populateAcctTypeSelect() {
  const sel = $("acctType");
  sel.innerHTML = ACCOUNT_CATEGORIES.map((cat) => {
    const opts = Object.entries(ACCOUNT_TYPES)
      .filter(([, cfg]) => cfg.category === cat)
      .map(([type, cfg]) => `<option value="${type}">${cfg.label}</option>`)
      .join("");
    return `<optgroup label="${cat}">${opts}</optgroup>`;
  }).join("");
}

function setAcctType(type) {
  $("acctType").value = type;
  const cfg = ACCOUNT_TYPES[type];
  $("acctTypeSummary").textContent = `Adding: ${cfg.label}`;
  const isLiability = cfg.kind === "liability";
  $("acctAssetLink").classList.toggle("hidden", isLiability);
  $("acctLiabilityLink").classList.toggle("hidden", !isLiability);
  $("acctBankLabel").textContent = BANK_VALIDATED_TYPES.has(type) ? "Bank" : "Institution";
  $("acctBank").placeholder = BANK_VALIDATED_TYPES.has(type)
    ? "Start typing a bank..."
    : "Institution name (e.g. Fidelity, Affirm, Coinbase)";
}
$("acctType").onchange = () => setAcctType($("acctType").value);
$("addAcctBtn").onclick = () => {
  $("acctForm").classList.toggle("hidden");
  populateAcctTypeSelect();
  setAcctType("debit"); // every fresh open starts from the same visible state
};

// bank_name is separate from linked_asset_id/linked_liability_id - it's
// which institution the account is at (Chase, Discover), purely a
// display/grouping label; the linked asset/liability is what tracks the
// actual dollar value. There's no picker to reuse an existing asset/
// liability anymore (there was, briefly) - every account now always gets
// its own fresh one, named after the bank, since two accounts at the same
// bank (a Checking and a Savings, say) still need separate balances.
$("saveAcctBtn").onclick = async () => {
  const bank_name = $("acctBank").value.trim();
  const type = $("acctType").value;
  const name = ACCOUNT_TYPE_NAME[type];
  const bankLabel = BANK_VALIDATED_TYPES.has(type) ? "Bank" : "Institution";
  if (!bank_name) return toast(`${bankLabel} name required`);
  if (BANK_VALIDATED_TYPES.has(type) && !isKnownBank(bank_name)) {
    return toast("Enter a real bank name, or pick one from the list.");
  }

  let linked_asset_id = null;
  let linked_liability_id = null;
  let autoMsg = null;
  if (AUTO_LIABILITY_TYPE[type]) {
    const { data: newDebt, error: debtErr } = await sb.from("liabilities")
      .insert({ name: bank_name, type: AUTO_LIABILITY_TYPE[type], balance: 0 })
      .select().single();
    if (debtErr) return toast(debtErr.message);
    linked_liability_id = newDebt.id;
    autoMsg = "Account added - linked to a new $0 balance liability";
  } else if (AUTO_ASSET_TYPE[type]) {
    const { data: newAsset, error: assetErr } = await sb.from("assets")
      .insert({ name: bank_name, type: AUTO_ASSET_TYPE[type], value: 0 })
      .select().single();
    if (assetErr) return toast(assetErr.message);
    linked_asset_id = newAsset.id;
    autoMsg = "Account added - linked to a new $0 asset, edit its value below";
  }

  const { error } = await sb.from("accounts").insert({ name, bank_name, type, linked_asset_id, linked_liability_id });
  if (error) return toast(error.message);
  $("acctBank").value = ""; $("acctForm").classList.add("hidden");
  // loadAccounts first - loadDebts reads `accounts` to know which
  // liabilities are now account-linked (hides their delete button).
  await loadAccounts(); await loadAssets(); await loadDebts();
  toast(autoMsg || "Account added");
};

const ACCT_COLORS = ["#0ea5e9", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#f472b6", "#22d3ee", "#fb923c"];

// Renders the account circles from the current accounts/assets/debts globals
// (no fetch) - called after any of the three load, since a circle's balance
// line depends on whichever one of assets/debts is linked to it, and those
// load in parallel with accounts (see init()), not strictly after it.
function renderAccountsList() {
  // Grouped by bank so a Checking and a Savings at the same bank sit next
  // to each other, rather than wherever creation order happened to put
  // them. Cash has no bank_name, so it's pinned first explicitly instead
  // of relying on null/empty-string sorting first. Archived accounts sort
  // last (active-first), same idea as subscriptions' is_active ordering.
  const sorted = [...accounts].sort((a, b) => {
    if (a.type === "cash") return -1;
    if (b.type === "cash") return 1;
    return (!!a.archived_at - !!b.archived_at) ||
      (a.bank_name || "").localeCompare(b.bank_name || "") || a.name.localeCompare(b.name);
  });
  $("acctList").innerHTML = sorted.length
    ? sorted.map((a, i) => {
        // Bank/cash-type accounts link to an asset (tap opens the asset-adjust
        // panel); credit accounts link to a liability instead (tap opens the
        // Pay form - see openDebtBalanceForm below). 'other' accounts with
        // no link get no click affordance. Still tappable when archived -
        // archiving only hides an account from "how did you pay for this"
        // pickers, it stays fully visible/adjustable here, same treatment
        // NON_SPENDABLE_ACCOUNT_TYPES already gets for a different reason.
        const clickAttr = a.linked_asset_id
          ? `data-adjust-acct="${a.id}"`
          : a.linked_liability_id
          ? `data-adjust-liability="${a.linked_liability_id}"`
          : "";
        // Credit shows what's owed (the liability balance); Cash/Checking
        // show what's there (the linked asset's value) - same "amount below
        // the circle" idea, just sourced from whichever table the account
        // actually links to.
        const balance = a.linked_asset_id
          ? assets.find((x) => x.id === a.linked_asset_id)?.value
          : a.linked_liability_id
          ? debts.find((x) => x.id === a.linked_liability_id)?.balance
          : null;
        // Cash has no bank_name, so it plays both roles (matches its
        // existing "Cash" / "Cash" double line, unchanged).
        const bankLabel = a.bank_name || a.name;
        // A single combined style attribute - two `style="..."` attributes
        // on one element isn't valid HTML, and the browser silently drops
        // the second one, so a clickable *and* archived account would
        // otherwise never actually render dimmed.
        const styleParts = [clickAttr ? "cursor:pointer" : "", a.archived_at ? "opacity:.5" : ""].filter(Boolean);
        const styleAttr = styleParts.length ? ` style="${styleParts.join(";")}"` : "";
        return `
      <div class="acct-circle-item" ${clickAttr}${styleAttr}>
        <div class="acct-circle" style="background:${ACCT_COLORS[i % ACCT_COLORS.length]}">${a.type === "cash" ? "💵" : esc((bankLabel.trim()[0] || "?").toUpperCase())}</div>
        ${a.type === "cash" ? "" : `<span class="x" data-del-acct="${a.id}">✕</span>`}
        <div class="name">${esc(bankLabel)}</div>
        <div class="type">${a.name}${a.archived_at ? " (archived)" : ""}</div>
        ${balance != null ? `<div class="balance">${a.linked_liability_id ? "Owed " : ""}${fmt(balance)}</div>` : ""}
        ${a.type === "cash" ? "" : `<div class="muted" data-archive-acct="${a.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-top:2px">${a.archived_at ? "Unarchive" : "Archive"}</div>`}
      </div>`;
      }).join("")
    : `<p class="muted" style="font-size:13px">No accounts yet.</p>`;
  // Archive/unarchive - a reversible toggle, unlike delete below. Leaves
  // the linked asset/liability completely untouched (see
  // 22_account_archive.sql) - archiving never changes net worth.
  document.querySelectorAll("[data-archive-acct]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const acct = accounts.find((a) => a.id === el.dataset.archiveAcct);
      const archiving = !acct.archived_at;
      const { error } = await sb.from("accounts")
        .update({ archived_at: archiving ? new Date().toISOString() : null })
        .eq("id", el.dataset.archiveAcct);
      if (error) return toast(error.message);
      await loadAccounts();
      toast(archiving ? "Account archived" : "Account unarchived");
    };
  });
  // delete handlers - expenses keep their history (account_id -> null on delete, per schema)
  // Cash has no delete affordance - it's auto-managed (ensureCashAccount), use
  // the +/- adjust form instead of removing it.
  document.querySelectorAll("[data-del-acct]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const acct = accounts.find((a) => a.id === el.dataset.delAcct);
      // A linked liability or asset is deleted along with its account (DB
      // triggers, 12_delete_liability_with_account.sql and 13_delete_asset_
      // with_account.sql) - warn about that up front since it's not obvious
      // from "delete this account" alone.
      const msg = acct?.linked_liability_id
        ? "Existing expenses stay but become unassigned. Its linked liability and tracked balance are deleted too. Consider Archive instead if you want to keep its history."
        : acct?.linked_asset_id
        ? "Existing expenses stay but become unassigned. Its linked asset and balance are deleted too. Consider Archive instead if you want to keep its history."
        : "Existing expenses stay but become unassigned.";
      if (!(await confirmModal(msg, { title: "Delete this account?" }))) return;
      const { error } = await sb.from("accounts").delete().eq("id", el.dataset.delAcct);
      if (error) return toast(error.message);
      // loadAssets/loadDebts refresh so a deleted linked asset or liability
      // disappears from its own card too, not just the account from its own.
      await loadAccounts(); await loadExpenses(); await loadAssets(); await loadDebts(); toast("Account deleted");
    };
  });
  document.querySelectorAll("[data-adjust-acct]").forEach((el) => {
    el.onclick = () => openAssetAdjust(el.dataset.adjustAcct);
  });
  document.querySelectorAll("[data-adjust-liability]").forEach((el) => {
    el.onclick = () => openDebtBalanceForm(el.dataset.adjustLiability, "paying");
  });
}

async function loadAccounts() {
  const { data } = await sb.from("accounts").select("*").order("created_at");
  accounts = data || [];
  renderAccountsList();
  // Payment-method pickers (quick-add, edit, subscriptions) only offer
  // accounts you'd actually pay with in real life - see
  // NON_SPENDABLE_ACCOUNT_TYPES. A 401(k) or CD still exists as an
  // account (tap its circle in the Accounts card to adjust its balance),
  // it just never shows up as "how did you pay for this." An archived
  // (closed) account is excluded the same way, for a different reason -
  // see 22_account_archive.sql.
  const spendable = accounts.filter((a) => !NON_SPENDABLE_ACCOUNT_TYPES.has(a.type) && !a.archived_at);
  const opts = `<option value="">None</option>` + spendable.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("");
  $("fAccount").innerHTML = opts;
  $("eAccount").innerHTML = opts;
  $("sAccount").innerHTML = opts;
  const bankNames = [...new Set([...BANK_NAMES, ...accounts.map((a) => a.bank_name).filter(Boolean)])].sort();
  $("bankSuggestions").innerHTML = bankNames.map((b) => `<option value="${esc(b)}"></option>`).join("");
  populateTxnTypeFilter();
  populateTxnAccountFilter();
}

// Shared by all four Recent Transactions filters below - rebuilds a
// <select>'s options and restores whatever was selected before, if it's
// still a valid choice, rather than silently resetting the filter back to
// "All ..." every time the underlying data reloads (e.g. after adding an
// account or logging an expense).
// Escapes both value and label unconditionally - some callers pass a
// fixed label (safe either way), others pass acctLabel()/category text
// that traces back to a free-typed field, so escaping once here is safer
// than trusting every call site to remember to.
function repopulateFilter(sel, allLabel, entries) {
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    entries.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  if (entries.some(([value]) => value === prev)) sel.value = prev;
}

// Options are whatever payment types this user's own accounts actually
// use, not the full ~42-type list from ACCOUNT_TYPES (most people only
// ever touch a handful).
function populateTxnTypeFilter() {
  const types = [...new Set(accounts.map((a) => a.type))];
  repopulateFilter($("txnTypeFilter"), "All", types.map((t) => [t, accountTypeLabel(t)]));
}
$("txnTypeFilter").onchange = renderRecentTransactions;

function populateTxnAccountFilter() {
  repopulateFilter($("txnAccountFilter"), "All", accounts.map((a) => [a.id, acctLabel(a)]));
}
$("txnAccountFilter").onchange = renderRecentTransactions;
$("txnCategoryFilter").onchange = renderRecentTransactions;
$("txnKindFilter").onchange = renderRecentTransactions;
$("txnSearch").oninput = renderRecentTransactions;
$("txnMinAmount").oninput = renderRecentTransactions;
$("txnMaxAmount").oninput = renderRecentTransactions;

// ---- ASSETS ------------------------------------------------------------
// Retirement/investment and specialty account types are almost always
// tracked as a plain value rather than something you'd ever select to pay
// for an expense, so they're offered here too, not just in the Accounts
// card - giving a way to add e.g. a Roth IRA without it cluttering the
// "how did you pay for this" picker. Excludes the handful in Specialty
// that only make sense as a spendable account (prepaid/payroll cards,
// digital wallet, second-chance checking - all just Checking variants).
const STANDALONE_ONLY_ASSET_CATEGORIES = ["Retirement & investment", "Specialty"];
const ACCOUNT_ONLY_SPECIALTY_TYPES = new Set(["prepaid_card", "payroll_card", "second_chance_checking", "digital_wallet"]);
// cap() alone is fine for the original single-word asset types (investment,
// property, cash, bank, savings, vehicle, other) but turns a multi-word
// type like "retirement_employer" into "Retirement_employer" - this maps
// every asset-kind ACCOUNT_TYPES entry's linkType back to its proper label
// so the Assets card shows "401(k) / 403(b) / 457", not a raw enum value.
const ASSET_TYPE_LABEL = {};
for (const cfg of Object.values(ACCOUNT_TYPES)) {
  if (cfg.kind === "asset") ASSET_TYPE_LABEL[cfg.linkType] = cfg.label;
}
const assetTypeLabel = (type) => ASSET_TYPE_LABEL[type] || cap(type);
function populateAssetTypeSelect() {
  const sel = $("assetType");
  if (sel.dataset.populated) return; // static "General" group is in the HTML; only append once
  sel.dataset.populated = "1";
  for (const cat of STANDALONE_ONLY_ASSET_CATEGORIES) {
    const opts = Object.entries(ACCOUNT_TYPES)
      .filter(([type, cfg]) => cfg.category === cat && cfg.kind === "asset" && !ACCOUNT_ONLY_SPECIALTY_TYPES.has(type))
      .map(([type, cfg]) => `<option value="${cfg.linkType}">${cfg.label}</option>`)
      .join("");
    sel.insertAdjacentHTML("beforeend", `<optgroup label="${cat}">${opts}</optgroup>`);
  }
}
// Add-or-edit, same shape as openSubForm/editingSub (subscriptions) -
// standalone assets only (a linked asset's value comes from the account
// circle's assetAdjustForm instead, never from here).
let editingAsset = null;
function openAssetForm(asset) {
  editingAsset = asset || null;
  populateAssetTypeSelect();
  $("assetName").value = asset?.name ?? "";
  $("assetType").value = asset?.type ?? "investment";
  $("assetValue").value = asset?.value ?? "";
  $("assetPurchasePrice").value = asset?.purchase_price ?? "";
  $("assetPurchaseDate").value = asset?.purchase_date ?? "";
  $("assetDepRate").value = asset?.depreciation_rate != null ? Number(asset.depreciation_rate) * 100 : "";
  $("assetPriceSymbol").value = asset?.price_symbol ?? "";
  $("assetQuantity").value = asset?.quantity ?? "";
  $("assetCostBasis").value = asset?.purchase_price ?? "";
  $("assetInvestBucket").value = asset?.investment_bucket ?? "";
  updateAssetTypeUI();
  $("assetForm").classList.remove("hidden");
}
function closeAssetForm() {
  $("assetForm").classList.add("hidden");
  editingAsset = null;
}
$("addAssetBtn").onclick = () => {
  if (editingAsset === null && !$("assetForm").classList.contains("hidden")) { closeAssetForm(); return; }
  openAssetForm(null);
};
$("cancelAssetBtn").onclick = closeAssetForm;

// Depreciation fields only make sense for a vehicle, cost-basis/bucket
// only for an investment - shown/hidden per type, same pattern
// acctLiabilityLink (Accounts card) already uses.
function updateAssetTypeUI() {
  $("assetDepreciationSection").classList.toggle("hidden", $("assetType").value !== "vehicle");
  $("assetInvestmentSection").classList.toggle("hidden", !INVESTMENT_ASSET_TYPES.has($("assetType").value));
  updateAssetDepPreview();
}
$("assetType").onchange = updateAssetTypeUI;

function updateAssetDepPreview() {
  const price = parseFloat($("assetPurchasePrice").value);
  const date = $("assetPurchaseDate").value;
  const ratePct = parseFloat($("assetDepRate").value);
  if (!Number.isFinite(price) || !date || !Number.isFinite(ratePct)) {
    $("assetDepPreview").textContent = "";
    return;
  }
  const est = estimateValue(price, date, ratePct / 100);
  $("assetDepPreview").textContent = est !== null ? `Estimated current value: ${fmt(est)} - used instead of Value above` : "";
}
$("assetPurchasePrice").oninput = updateAssetDepPreview;
$("assetPurchaseDate").oninput = updateAssetDepPreview;
$("assetDepRate").oninput = updateAssetDepPreview;

$("saveAssetBtn").onclick = async () => {
  const name = $("assetName").value.trim();
  const type = $("assetType").value;
  const value = parseFloat($("assetValue").value);
  if (!name) return toast("Asset name required");
  if (!Number.isFinite(value)) return toast("Enter a value");
  if (type === "cash") return toast("Cash is automatic - use the Cash account's +/- panel instead.");
  if (type === "bank") return toast("Bank assets come from a Checking account - add one in the Accounts card instead.");

  const isVehicle = type === "vehicle";
  const isInvestment = INVESTMENT_ASSET_TYPES.has(type);
  // purchase_price doubles as a vehicle's purchase price (depreciation
  // math) and an investment's cost basis (Investments tab gain/loss) -
  // two different form fields writing the same column, mutually exclusive
  // by type, since a holding has no depreciation date/rate to pair with it.
  const purchase_price = isVehicle && $("assetPurchasePrice").value !== "" ? parseFloat($("assetPurchasePrice").value)
    : isInvestment && $("assetCostBasis").value !== "" ? parseFloat($("assetCostBasis").value)
    : null;
  const purchase_date = isVehicle && $("assetPurchaseDate").value ? $("assetPurchaseDate").value : null;
  const depreciation_rate = isVehicle && $("assetDepRate").value !== "" ? parseFloat($("assetDepRate").value) / 100 : null;
  const price_symbol = $("assetPriceSymbol").value.trim() || null;
  const quantity = $("assetQuantity").value !== "" ? parseFloat($("assetQuantity").value) : null;
  const investment_bucket = isInvestment ? ($("assetInvestBucket").value.trim() || null) : null;
  const row = { name, type, value, purchase_price, purchase_date, depreciation_rate, price_symbol, quantity, investment_bucket };

  const q = editingAsset
    ? sb.from("assets").update(row).eq("id", editingAsset.id)
    : sb.from("assets").insert(row);
  const { error } = await q;
  if (error) return toast(error.message);
  const wasEditing = !!editingAsset;
  closeAssetForm();
  await loadAssets(); toast(wasEditing ? "Asset updated" : "Asset added");
};

// CD is the only asset type with a maturity date today - reuses
// subscriptions.js's daysUntil/renewalLabel rather than duplicating date
// math; those two are generic day-delta helpers, not actually
// subscription-specific despite living in that file.
function upcomingMaturities(withinDays = 30, today = new Date()) {
  return assets
    .filter((a) => a.type === "cd" && a.maturity_date)
    .map((a) => ({ ...a, days: daysUntil(a.maturity_date, today) }))
    .filter((a) => a.days !== null && a.days <= withinDays)
    .sort((a, b) => a.days - b.days);
}

// Excludes cash/bank - those get touched by applyAssetDelta on every
// expense against them, so they're never realistically stale - and a
// vehicle with full depreciation info, which is always fresh by
// construction (effectiveAssetValue recomputes it live, so "when was this
// last edited" doesn't mean anything for it). Everything else (investment,
// property, a plain vehicle, retirement/specialty types, other) only ever
// changes when the user manually edits it, which is exactly what this is
// meant to catch. updated_at only reflects real edits as of
// 25_touch_updated_at_trigger.sql - before that migration it was
// permanently stuck at creation time regardless of later edits.
function staleAssets(monthsThreshold = 6, today = new Date()) {
  return assets
    .filter((a) => a.type !== "cash" && a.type !== "bank" && a.updated_at)
    .filter((a) => !(a.type === "vehicle" && estimateValue(a.purchase_price, a.purchase_date, a.depreciation_rate) !== null))
    .map((a) => ({ ...a, monthsSince: Math.floor((today - new Date(a.updated_at)) / (30.44 * 86400000)) }))
    .filter((a) => a.monthsSince >= monthsThreshold)
    .sort((a, b) => b.monthsSince - a.monthsSince);
}

async function loadAssets() {
  const { data } = await sb.from("assets").select("*").order("created_at");
  assets = data || [];
  // An asset a Checking/Cash account points at (linked_asset_id) only
  // exists to track that account's balance - deleting it here would orphan
  // the account (linked_asset_id -> null on delete, per schema), the exact
  // "icon does nothing" bug already fixed once for accounts pointing
  // nowhere. Deleting the account (DB trigger, 13_delete_asset_with_
  // account.sql) is the only way to remove it now; a standalone asset
  // with no account (investment, property, manually added) still can.
  const linkedAssetIds = new Set(accounts.map((a) => a.linked_asset_id).filter(Boolean));
  // Standalone assets (not linked to an account) are click-to-edit here -
  // a linked one is edited from its account circle's assetAdjustForm
  // instead, same split the delete "✕" below already uses. The displayed
  // amount is the live depreciation estimate for a vehicle with full
  // purchase info (effectiveAssetValue, depreciation.js), not the stored
  // value - every other asset type is unaffected.
  $("assetsList").innerHTML = assets.length
    ? assets.map((a) => `
      <div class="exp" ${linkedAssetIds.has(a.id) ? "" : `data-edit-asset="${a.id}" style="cursor:pointer"`}>
        <div>${a.type === "cash" ? "" : `<div class="meta">${assetTypeLabel(a.type)}</div>`}${esc(a.name)}</div>
        <span class="amt">${fmt(effectiveAssetValue(a))}${linkedAssetIds.has(a.id) ? "" : `<span class="x" data-del-asset="${a.id}" style="margin-left:8px">✕</span>`}</span>
      </div>`).join("")
    : `<p class="muted" style="font-size:13px">No assets yet.</p>`;
  document.querySelectorAll("[data-edit-asset]").forEach((el) => {
    el.onclick = () => openAssetForm(assets.find((a) => a.id === el.dataset.editAsset));
  });
  // Paying down a liability must draw from an actual linked account, not
  // any asset value (a standalone Investment/Property/Vehicle/retirement
  // asset with no account behind it) - every transaction links to a
  // specific account, this form included. If that leaves nothing to pick,
  // the Pay button below still catches it with an explicit error.
  const payableAssets = assets.filter((a) => linkedAssetIds.has(a.id));
  $("payFromAsset").innerHTML = payableAssets.length
    ? payableAssets.map((a) => `<option value="${a.id}">${esc(a.name)} (${fmt(a.value)})</option>`).join("")
    : `<option value="">No linked account available</option>`;
  document.querySelectorAll("[data-del-asset]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const target = assets.find((a) => a.id === el.dataset.delAsset);
      if (!(await confirmModal("This can't be undone.", { title: `Delete ${target?.name || "this asset"}?` }))) return;
      const { error } = await sb.from("assets").delete().eq("id", el.dataset.delAsset);
      if (error) return toast(error.message);
      await loadAssets(); toast("Asset deleted"); renderNetWorth();
    };
  });
  const maturing = upcomingMaturities();
  $("assetMaturityNotice").classList.toggle("hidden", !maturing.length);
  $("assetMaturityNotice").textContent = maturing
    .map((a) => `${a.name} matures ${renewalLabel(a.days)}`).join(" · ");
  const stale = staleAssets();
  $("assetStaleNotice").classList.toggle("hidden", !stale.length);
  $("assetStaleNotice").textContent = stale
    .map((a) => `${a.name} last updated ${a.monthsSince} month${a.monthsSince === 1 ? "" : "s"} ago`).join(" · ");
  renderNetWorth();
  renderAccountsList(); // a changed asset value may be a linked account's balance line
  renderAssetPriceFindings();
  renderInvestments();
}

// Matches findings to the user's own assets by symbol, exact
// (case-insensitive) rather than the loose substring matching
// matchService (discounts.js) uses for service names - a ticker should
// match exactly, since a loose match risks a false positive ("A" inside
// "AAPL"). Applying a finding requires quantity to be set first (see
// 27_asset_quantity.sql) - refuses rather than guessing 1, since silently
// setting a multi-share holding's value to a single share's price would
// be a real, wrong financial number.
function renderAssetPriceFindings() {
  const card = $("assetPriceFindingsCard");
  if (!card) return;
  if (!PRICE_FINDINGS_ENABLED) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const bySymbol = new Map();
  for (const a of assets) {
    if (!a.price_symbol) continue;
    const key = a.price_symbol.trim().toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(a);
  }
  const matches = assetPriceFindings.filter((f) => bySymbol.has((f.symbol || "").trim().toUpperCase()));

  if (!matches.length) {
    $("assetPriceFindingsList").innerHTML = `<p class="muted" style="font-size:13px">No live findings yet for your assets.</p>`;
    return;
  }
  $("assetPriceFindingsList").innerHTML = matches.map((f, i) => {
    // f.url/f.symbol/f.currency trace back to tools/price-agent.js, which
    // is server-side and gates outbound fetches through a domain allowlist
    // (hostAllowed) - but the finding text itself is still Gemma output
    // derived from a scraped page, so it's escaped/attribute-safe here too,
    // not trusted just because it didn't come from this app's own users.
    const link = f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:var(--accent)">check source →</a>` : "";
    return `
      <div class="exp" style="cursor:default">
        <div>
          <div>${esc(f.symbol)}</div>
          <div class="meta">${fmt(f.price)} ${esc(f.currency || "USD")} ${link}</div>
        </div>
        <span class="amt" style="font-size:12px;cursor:pointer;text-decoration:underline;color:var(--accent)" data-apply-price-idx="${i}">Apply</span>
      </div>`;
  }).join("");
  document.querySelectorAll("[data-apply-price-idx]").forEach((el) => {
    el.onclick = async () => {
      const finding = matches[Number(el.dataset.applyPriceIdx)];
      const targets = bySymbol.get((finding.symbol || "").trim().toUpperCase()) || [];
      let applied = 0;
      for (const asset of targets) {
        if (!asset.quantity) { toast(`Set a quantity for ${asset.name} first`); continue; }
        const newValue = Math.round(Number(finding.price) * Number(asset.quantity) * 100) / 100;
        const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
        if (error) { toast(error.message); continue; }
        applied++;
      }
      if (applied) { await loadAssets(); toast(`Applied live price to ${applied} asset${applied === 1 ? "" : "s"}`); }
    };
  });
}

// No linked asset (Checking or Cash) may ever go negative, on any path -
// manual adjust panel (see adjustSubtractBtn/adjustSetBtn above) or expense
// logging here. Call this BEFORE writing an expense to find out whether its
// asset-side effect(s) would push a balance below $0; if so, block the
// whole expense (don't insert it) rather than logging it and flooring the
// asset, so the user gets an explicit error instead of a silently
// corrected number. `deltas` lets a caller check multiple effects on the
// same asset together (editSave reverses one expense and applies another
// in the same action - they can land on the same asset or different ones).
//
// Which account types draw down an asset vs. accrue a liability is decided
// purely by whether the account has a linked_asset_id or linked_liability_id
// (never both, see saveAcctBtn), not by comparing `paymentType` against a
// hardcoded string. This is what makes every account type in ACCOUNT_TYPES
// work correctly here automatically, including ones added after this was
// written - `paymentType` is still accepted for signature stability with
// existing call sites but is no longer used for this decision.
function assetDeltaError(deltas) {
  const netByAsset = new Map(); // assetId -> { asset, net }
  for (const { accountId, amount, sign } of deltas) {
    if (!accountId) continue;
    const account = accounts.find((a) => a.id === accountId);
    if (!account || !account.linked_asset_id) continue;
    const asset = assets.find((a) => a.id === account.linked_asset_id);
    if (!asset) continue;
    const entry = netByAsset.get(asset.id) || { asset, net: 0 };
    entry.net += sign * Number(amount);
    netByAsset.set(asset.id, entry);
  }
  for (const { asset, net } of netByAsset.values()) {
    const newValue = Math.round((Number(asset.value) + net) * 100) / 100;
    if (newValue < 0) return `${asset.name} can't go below $0 - not enough to cover this.`;
  }
  return null;
}

// Draws down the linked asset for any account type backed by one (checking,
// savings, money market, HSA, brokerage, ...) so assets stay in sync with
// real spending. An account backed by a liability instead (credit card,
// HELOC, mortgage, ...) has no linked_asset_id, so this is a no-op for it -
// see applyLiabilityDelta below for that side.
// sign: -1 to apply an expense (deduct), +1 to reverse one (edit/delete).
// Callers must run assetDeltaError first and abort on a non-null result -
// this function trusts that check and just writes the new value.
async function applyAssetDelta(accountId, paymentType, amount, sign) {
  if (!accountId) return;
  const account = accounts.find((a) => a.id === accountId);
  if (!account || !account.linked_asset_id) return;
  const asset = assets.find((a) => a.id === account.linked_asset_id);
  if (!asset) return;
  const newValue = Math.round((Number(asset.value) + sign * Number(amount)) * 100) / 100;
  await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
}

// Accumulates onto the linked liability's running balance for any account
// type backed by one (credit card, charge card, HELOC, mortgage, personal
// loan, ...) - a charge is owed the moment it happens and stays owed
// regardless of when (or how irregularly) the balance actually gets paid
// down. Sign is the OPPOSITE of applyAssetDelta's: spending *increases*
// what you owe, so sign: +1 to apply a charge (increase balance), -1 to
// reverse one (edit/delete). Paying a balance down is a separate transfer
// (see payConfirmBtn below), never routed through this function.
async function applyLiabilityDelta(accountId, paymentType, amount, sign) {
  if (!accountId) return;
  const account = accounts.find((a) => a.id === accountId);
  if (!account || !account.linked_liability_id) return;
  const debt = debts.find((d) => d.id === account.linked_liability_id);
  if (!debt) return;
  const newBalance = Math.max(0, Math.round((Number(debt.balance) + sign * Number(amount)) * 100) / 100);
  await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
}

// ---- ACCOUNT ACTIVITY (non-expense money movements) ---------------------
// Expenses already show up in Recent Transactions since they're rows in
// `expenses`. Everything else that moves money around - a manual asset
// balance adjustment, paying down a liability - has no row anywhere, so it
// never appeared there. This is a separate, append-only log just for that,
// merged with `expenses` client-side for display (see recentTransactions
// below); the Reports "Monthly Expense Log" deliberately reads `expenses`
// only and must stay that way. `amount` is a SIGNED delta for asset_adjust
// (positive = balance went up, negative = went down) so undoActivity()
// below can reverse it correctly regardless of whether it was an add, a
// subtract, or a direct "set" - a set's sign used to get discarded
// (always stored positive), which made a "Set balance to $X" row
// impossible to undo correctly. liability_payment's amount is always
// positive - a payment only ever moves money one direction (out of the
// asset, off the liability), so there's no sign to lose there.
const ACTIVITY_LABEL = { asset_adjust: "Balance update", liability_payment: "Debt payment" };

async function loadAccountActivity() {
  const since = lastMonths(12)[0] + "-01";
  const { data } = await sb.from("account_activity").select("*")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false }).order("created_at", { ascending: false });
  accountActivity = data || [];
}

// accountId is the account whose own balance changed (required, so this
// always shows up when filtering Recent Transactions by that account -
// omitting it was a real bug caught live: adjusting Cash's balance didn't
// show up when filtering by the Cash account, since nothing recorded
// which account it was). relatedAccountId is only for a liability_payment
// where the liability itself is account-linked (a credit card), so the
// payment also shows up when filtering by the card, not just the account
// the money came from. liabilityId is the liability actually paid down -
// needed for undoActivity() to find a STANDALONE liability (no linked
// account, so relatedAccountId is null for it) well enough to reverse it.
async function logActivity(kind, description, amount, occurred_at, accountId, relatedAccountId = null, liabilityId = null) {
  const rounded = Math.round(Number(amount) * 100) / 100;
  if (!rounded) return; // no actual change (e.g. "set" to the same value) - nothing to log
  const { error } = await sb.from("account_activity").insert({
    kind, description, amount: rounded, occurred_at: occurred_at || new Date().toISOString().slice(0, 10),
    account_id: accountId, related_account_id: relatedAccountId, liability_id: liabilityId,
  });
  if (!error) await loadAccountActivity();
}

// ---- ADJUST AN ACCOUNT'S LINKED ASSET -----------------------------------
// Tapping any account circle with a linked asset opens this - every type
// (Checking, Cash) gets both a direct "set the full balance" field (look
// up and type the real number) and +/- adjustment (when you know the
// change, not the total). Balances can never go negative here - blocked
// with an error rather than floored, so the user knows the edit didn't
// go through.
let adjustingAssetId = null;
let adjustingAccountId = null; // tracked alongside the asset so logActivity can attribute the change to it

function findLinkedAsset(accountId) {
  const acct = accounts.find((a) => a.id === accountId);
  if (!acct || !acct.linked_asset_id) return null;
  return assets.find((a) => a.id === acct.linked_asset_id) || null;
}

// Closes the panel once a change has actually gone through - a confirmed
// balance change is done, not something to keep tweaking in place, and
// closing it is itself the confirmation to the user that it took effect
// (on top of the toast) rather than leaving the form sitting open as if
// nothing happened.
function closeAssetAdjust() {
  $("assetAdjustForm").classList.add("hidden");
  adjustingAssetId = null;
  adjustingAccountId = null;
}

function openAssetAdjust(accountId) {
  const asset = findLinkedAsset(accountId);
  if (!asset) return;
  const panel = $("assetAdjustForm");
  // Tapping the same account again while its panel is already open closes it.
  if (adjustingAssetId === asset.id && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    adjustingAssetId = null;
    adjustingAccountId = null;
    return;
  }
  adjustingAssetId = asset.id;
  adjustingAccountId = accountId;
  $("adjustAssetLabel").textContent = asset.name;
  $("adjustCurrentValue").textContent = fmt(asset.value);
  $("adjustAmount").value = "";
  $("adjustNewBalance").value = String(asset.value);
  // CD-only - see 23_asset_maturity_date.sql.
  const showMaturity = asset.type === "cd";
  $("adjustMaturitySection").classList.toggle("hidden", !showMaturity);
  if (showMaturity) $("adjustMaturityDate").value = asset.maturity_date ?? "";
  panel.classList.remove("hidden");
}

$("adjustAddBtn").onclick = async () => {
  const amount = parseFloat($("adjustAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  const newValue = Math.round((Number(asset.value) + amount) * 100) / 100;
  const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
  if (error) return toast(error.message);
  $("adjustAmount").value = "";
  await logActivity("asset_adjust", `Added ${fmt(amount)} to ${asset.name}`, amount, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Added");
};

$("adjustSubtractBtn").onclick = async () => {
  const amount = parseFloat($("adjustAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  if (amount > Number(asset.value)) return toast("Balance can't go negative - not enough in " + asset.name);
  const newValue = Math.round((Number(asset.value) - amount) * 100) / 100;
  const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
  if (error) return toast(error.message);
  $("adjustAmount").value = "";
  await logActivity("asset_adjust", `Subtracted ${fmt(amount)} from ${asset.name}`, -amount, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Subtracted");
};

$("adjustSetBtn").onclick = async () => {
  const newValue = parseFloat($("adjustNewBalance").value);
  if (!Number.isFinite(newValue)) return toast("Enter a valid balance");
  if (newValue < 0) return toast("Balance can't go negative");
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  const rounded = Math.round(newValue * 100) / 100;
  const oldValue = Number(asset.value);
  const { error } = await sb.from("assets").update({ value: rounded }).eq("id", asset.id);
  if (error) return toast(error.message);
  await logActivity("asset_adjust", `Set ${asset.name} balance to ${fmt(rounded)}`, rounded - oldValue, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Balance updated");
};

// A date the user sees and acts on manually, not something that auto-
// converts or auto-reminds beyond the notice in loadAssets() below -
// consistent with this app's general preference for explicit user action
// over automatic mutation of financial data.
$("adjustMaturitySaveBtn").onclick = async () => {
  if (!adjustingAssetId) return;
  const maturity_date = $("adjustMaturityDate").value || null;
  const { error } = await sb.from("assets").update({ maturity_date }).eq("id", adjustingAssetId);
  if (error) return toast(error.message);
  await loadAssets();
  toast("Maturity date saved");
};

// ---- LIABILITIES (tracked debts) ---------------------------------------
// The specific loan types (auto, student, personal, home equity) are almost
// always tracked standalone - you don't "spend against" a mortgage the way
// you do a credit card - so they're appended here from ACCOUNT_TYPES' Loans
// category. Credit-category types (credit card, HELOC, BNPL, ...) stay
// Accounts-card-only, matching how 'credit' already worked before this.
function populateDebtTypeSelect() {
  const sel = $("debtType");
  if (sel.dataset.populated) return;
  sel.dataset.populated = "1";
  const opts = Object.entries(ACCOUNT_TYPES)
    .filter(([, cfg]) => cfg.category === "Loans" && cfg.linkType !== "mortgage")
    .map(([, cfg]) => `<option value="${cfg.linkType}">${cfg.label}</option>`)
    .join("");
  sel.insertAdjacentHTML("beforeend", opts);
}
$("addDebtBtn").onclick = () => { $("debtForm").classList.toggle("hidden"); populateDebtTypeSelect(); };
$("saveDebtBtn").onclick = async () => {
  const name = $("debtName").value.trim();
  const type = $("debtType").value;
  const balance = parseFloat($("debtBalance").value);
  if (!name) return toast("Liability name required");
  if (!Number.isFinite(balance)) return toast("Enter a balance");
  const row = {
    name, type, balance,
    interest_rate: $("debtRate").value ? parseFloat($("debtRate").value) : null,
    minimum_payment: $("debtMinPay").value ? parseFloat($("debtMinPay").value) : null,
    due_date: $("debtDue").value || null,
  };
  const { error } = await sb.from("liabilities").insert(row);
  if (error) return toast(error.message);
  $("debtName").value = ""; $("debtBalance").value = ""; $("debtRate").value = "";
  $("debtMinPay").value = ""; $("debtDue").value = ""; $("debtForm").classList.add("hidden");
  await loadDebts(); toast("Liability added");
};

// Derived from ACCOUNT_TYPES (every liability-kind entry's linkType ->
// label) plus the two standalone-only values ('loan', a generic bucket
// predating the more specific loan types; 'other') that have no
// account-type counterpart at all.
const DEBT_TYPE_LABEL = { loan: "Loan", other: "Other" };
for (const cfg of Object.values(ACCOUNT_TYPES)) {
  if (cfg.kind === "liability") DEBT_TYPE_LABEL[cfg.linkType] = cfg.label;
}
DEBT_TYPE_LABEL.credit_card = "Credit"; // shorter than ACCOUNT_TYPES' "Credit Card" - fits the existing card layout better

// The phase is always derived from today vs draw_period_end, never stored
// as its own enum - see 28_heloc_draw_period.sql. null (not a HELOC, or a
// HELOC with no draw_period_end set yet) means "don't show anything."
function helocPhaseInfo(d, today = new Date()) {
  if (d.type !== "heloc" || !d.draw_period_end) return null;
  const todayStr = today.toISOString().slice(0, 10);
  return d.draw_period_end < todayStr
    ? { phase: "repayment", label: `Repayment period (draw ended ${d.draw_period_end})` }
    : { phase: "draw", label: `Draw period (interest-only) - ends ${d.draw_period_end}` };
}

async function loadDebts() {
  const { data } = await sb.from("liabilities").select("*").order("created_at");
  debts = data || [];
  // A liability that a credit account points at (linked_liability_id) is
  // the same row shown on that account's icon - deleting it here would
  // orphan the account (linked_liability_id -> null on delete, per schema),
  // recreating the exact "click does nothing" bug fixed for debit/checking.
  // So it gets no delete affordance; removing it means deleting the account.
  // Split into the Liabilities card's two sections: a credit account's own
  // liability (Pay only) vs. a standalone Loan/Mortgage/Other with no
  // linked account (Pay, +, and delete - the only kind added manually now).
  const linkedDebtIds = new Set(accounts.map((a) => a.linked_liability_id).filter(Boolean));
  // Only shown once both interest_rate and minimum_payment are set - both
  // have always been stored but never used in any calculation until this.
  // Skipped during an active HELOC draw period (see helocPhaseInfo) -
  // projecting a payoff date is misleading there, since a real HELOC
  // doesn't amortize principal during draw regardless of what a minimum
  // payment field says.
  const payoffLine = (d) => {
    if (d.interest_rate == null || d.minimum_payment == null) return "";
    const p = payoffProjection(d.balance, d.interest_rate, d.minimum_payment);
    if (!p) return "";
    if (p.neverPaysOff) return `<div class="meta" style="color:var(--err)">Min payment won't cover interest - balance will grow</div>`;
    if (p.months <= 0) return "";
    return `<div class="meta">Payoff in ${p.months}mo (${p.payoffDate}) · ${fmt(p.totalInterest)} interest</div>`;
  };
  const rowHtml = (d) => {
    const heloc = helocPhaseInfo(d);
    return `
    <div class="exp">
      <div>
        <div class="meta">${DEBT_TYPE_LABEL[d.type] || cap(d.type)}</div>${esc(d.name)}
        ${d.due_date ? `<div class="meta">due ${d.due_date}</div>` : ""}
        ${heloc ? `<div class="meta">${heloc.label}</div>` : ""}
        ${heloc?.phase === "draw" ? "" : payoffLine(d)}
        <div class="muted" data-edit-debt="${d.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-top:2px">Edit details</div>
      </div>
      <span class="amt">
        ${linkedDebtIds.has(d.id) ? "" : `<button class="secondary" data-add-debt="${d.id}" style="width:auto;padding:4px 10px;font-size:12px;margin-right:6px">+</button>`}
        <button class="secondary" data-pay-debt="${d.id}" style="width:auto;padding:4px 10px;font-size:12px;margin-right:8px">Pay</button>
        ${fmt(d.balance)}${linkedDebtIds.has(d.id) ? "" : `<span class="x" data-del-debt="${d.id}" style="margin-left:8px">✕</span>`}
      </span>
    </div>`;
  };
  const creditDebts = debts.filter((d) => linkedDebtIds.has(d.id));
  const otherDebts = debts.filter((d) => !linkedDebtIds.has(d.id));
  $("creditDebtsList").innerHTML = creditDebts.length
    ? creditDebts.map(rowHtml).join("")
    : `<p class="muted" style="font-size:13px">No credit accounts yet.</p>`;
  $("debtsList").innerHTML = otherDebts.length
    ? otherDebts.map(rowHtml).join("")
    : `<p class="muted" style="font-size:13px">No other liabilities.</p>`;
  document.querySelectorAll("[data-del-debt]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const target = debts.find((d) => d.id === el.dataset.delDebt);
      if (!(await confirmModal("This can't be undone.", { title: `Delete ${target?.name || "this liability"}?` }))) return;
      const { error } = await sb.from("liabilities").delete().eq("id", el.dataset.delDebt);
      if (error) return toast(error.message);
      await loadDebts(); toast("Liability deleted"); renderNetWorth();
    };
  });
  document.querySelectorAll("[data-pay-debt]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openDebtBalanceForm(el.dataset.payDebt, "paying"); };
  });
  document.querySelectorAll("[data-add-debt]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openDebtBalanceForm(el.dataset.addDebt, "owed"); };
  });
  document.querySelectorAll("[data-edit-debt]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openDebtDetailsForm(debts.find((d) => d.id === el.dataset.editDebt)); };
  });
  renderNetWorth();
  renderAccountsList(); // a changed liability balance may be a linked account's balance line
}

// Interest rate / minimum payment / due date / draw period end - never
// balance, which stays strictly driven by real expenses/payments against
// the liability regardless of type. Works for both a standalone
// liability and an account-linked one (a
// credit card or HELOC never goes through debtForm above at all, so this
// was previously the only way to set these fields for those).
let editingDebtDetails = null;
function openDebtDetailsForm(debt) {
  if (!debt) return;
  editingDebtDetails = debt;
  $("debtDetailsRate").value = debt.interest_rate ?? "";
  $("debtDetailsMinPay").value = debt.minimum_payment ?? "";
  $("debtDetailsDue").value = debt.due_date ?? "";
  const isHeloc = debt.type === "heloc";
  $("debtDetailsDrawSection").classList.toggle("hidden", !isHeloc);
  if (isHeloc) {
    $("debtDetailsDrawEnd").value = debt.draw_period_end ?? "";
    const phase = helocPhaseInfo(debt);
    $("debtDetailsPhaseInfo").textContent = phase ? phase.label : "No draw-period end date set yet.";
  }
  $("debtDetailsForm").classList.remove("hidden");
  $("debtDetailsForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeDebtDetailsForm() {
  $("debtDetailsForm").classList.add("hidden");
  editingDebtDetails = null;
}
$("debtDetailsCancelBtn").onclick = closeDebtDetailsForm;
$("debtDetailsSaveBtn").onclick = async () => {
  if (!editingDebtDetails) return;
  const patch = {
    interest_rate: $("debtDetailsRate").value !== "" ? parseFloat($("debtDetailsRate").value) : null,
    minimum_payment: $("debtDetailsMinPay").value !== "" ? parseFloat($("debtDetailsMinPay").value) : null,
    due_date: $("debtDetailsDue").value || null,
  };
  if (editingDebtDetails.type === "heloc") {
    patch.draw_period_end = $("debtDetailsDrawEnd").value || null;
  }
  const { error } = await sb.from("liabilities").update(patch).eq("id", editingDebtDetails.id);
  if (error) return toast(error.message);
  closeDebtDetailsForm();
  await loadDebts();
  toast("Liability details saved");
};

// ---- ADJUST A LIABILITY'S BALANCE (owed vs. paying it down) -------------
// "Paying balance" (transfer: asset down, liability down, never a new
// expense) is always available. "Owed" (direct set + add-a-charge) only
// shows for a liability with NO linked credit account - one linked to a
// credit account skips the tabs entirely and opens straight to Paying,
// since its owed amount can now only move through an actual credit
// expense (quick-add/edit, account type credit - applyLiabilityDelta),
// never a typed number. A standalone Loan/Mortgage/Other liability has no
// purchase trail to reconcile against, so it keeps manual Owed editing.
let activeDebtId = null;

function currentDebtTab() {
  return $("debtOwedMode").classList.contains("hidden") ? "paying" : "owed";
}

function setDebtTab(tab) {
  $("debtOwedMode").classList.toggle("hidden", tab !== "owed");
  $("debtPayingMode").classList.toggle("hidden", tab !== "paying");
  $("debtTabOwed").classList.toggle("secondary", tab !== "owed");
  $("debtTabPaying").classList.toggle("secondary", tab !== "paying");
}

function openDebtBalanceForm(debtId, tab) {
  const modal = $("debtBalanceForm");
  const isCreditLinked = accounts.some((a) => a.linked_liability_id === debtId);
  const effectiveTab = isCreditLinked ? "paying" : tab;
  // Tapping the same entry point again (same debt, same tab already showing)
  // while the modal is open closes it; anything else switches to it instead.
  if (activeDebtId === debtId && effectiveTab === currentDebtTab() && !modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    activeDebtId = null;
    return;
  }
  const debt = debts.find((d) => d.id === debtId);
  if (!debt) return;
  activeDebtId = debtId;
  $("debtBalanceLabel").textContent = debt.name;
  $("debtBalanceCurrent").textContent = fmt(debt.balance);
  $("debtTabRow").classList.toggle("hidden", isCreditLinked);
  $("debtOwedSet").value = String(debt.balance);
  $("debtOwedAmount").value = "";
  $("payAmount").value = "";
  setDebtTab(effectiveTab);
  modal.classList.remove("hidden");
}
$("debtTabOwed").onclick = () => setDebtTab("owed");
$("debtTabPaying").onclick = () => setDebtTab("paying");
function closeDebtBalanceForm() {
  $("debtBalanceForm").classList.add("hidden");
  activeDebtId = null;
}
$("debtBalanceClose").onclick = closeDebtBalanceForm;

// Directly overwrites the balance - for fixing a wrong number (typo, a
// charge that was missed or double-logged), not for a new charge (that's
// debtOwedConfirm below, which adds instead of replacing). Only reachable
// for a standalone liability - see openDebtBalanceForm.
$("debtOwedSetConfirm").onclick = async () => {
  const newBalance = parseFloat($("debtOwedSet").value);
  if (!Number.isFinite(newBalance)) return toast("Enter a valid amount");
  if (newBalance < 0) return toast("Amount owed can't be negative");
  const debt = debts.find((d) => d.id === activeDebtId);
  if (!debt) return;
  const { error } = await sb.from("liabilities").update({ balance: Math.round(newBalance * 100) / 100 }).eq("id", debt.id);
  if (error) return toast(error.message);
  await loadDebts();
  closeDebtBalanceForm();
  toast("Amount owed updated");
};

$("debtOwedConfirm").onclick = async () => {
  const amount = parseFloat($("debtOwedAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const debt = debts.find((d) => d.id === activeDebtId);
  if (!debt) return;
  const newBalance = Math.round((Number(debt.balance) + amount) * 100) / 100;
  const { error } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
  if (error) return toast(error.message);
  $("debtOwedAmount").value = "";
  await loadDebts();
  closeDebtBalanceForm();
  toast("Added to balance owed");
};

$("payConfirmBtn").onclick = async () => {
  const amount = parseFloat($("payAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const assetId = $("payFromAsset").value;
  if (!assetId) return toast("Choose an account to pay from - add one in the Accounts card if none are listed.");
  const debt = debts.find((d) => d.id === activeDebtId);
  const asset = assets.find((a) => a.id === assetId);
  if (!debt || !asset) return toast("Pick a valid liability and asset");
  if (amount > Number(asset.value)) return toast(`Not enough in ${asset.name} to pay ${fmt(amount)}`);

  const newAssetValue = Math.round((Number(asset.value) - amount) * 100) / 100;
  const newBalance = Math.max(0, Math.round((Number(debt.balance) - amount) * 100) / 100);

  const { error: assetErr } = await sb.from("assets").update({ value: newAssetValue }).eq("id", asset.id);
  if (assetErr) return toast(assetErr.message);
  const { error: debtErr } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
  if (debtErr) return toast(debtErr.message);

  // account_id = the funding account (money actually left it, same as an
  // expense's account_id); related_account_id = the debt's own account,
  // only if it's credit-linked, so filtering by either side surfaces this
  // payment - a standalone liability (no linked account) leaves it null.
  // liability_id is stored directly too (not just derivable from
  // related_account_id) since a standalone liability has no account side
  // at all - undoActivity() needs a reliable way to find it either way.
  const fundingAccountId = accounts.find((a) => a.linked_asset_id === asset.id)?.id ?? null;
  const debtAccountId = accounts.find((a) => a.linked_liability_id === debt.id)?.id ?? null;
  await logActivity("liability_payment", `Paid ${fmt(amount)} to ${debt.name} from ${asset.name}`, amount, undefined, fundingAccountId, debtAccountId, debt.id);
  $("payAmount").value = "";
  await loadAssets(); await loadDebts(); renderRecentTransactions();
  closeDebtBalanceForm();
  toast("Payment recorded");
};

// ---- NET WORTH (Log page) ----------------------------------------------
// Recomputed from already-loaded state - cheap, no extra queries. Call
// after anything that changes assets, debts, or expenses.
function renderNetWorth() {
  // Depreciation-adjusted at the call site, not inside computeNetWorth -
  // networth.js stays pure aggregation with no idea depreciation exists
  // (see its own header comment on scope).
  const depreciatedAssets = assets.map((a) => ({ ...a, value: effectiveAssetValue(a) }));
  const nw = computeNetWorth(depreciatedAssets, debts);

  $("netWorthTotal").textContent = fmt(nw.netWorth);
  $("assetsTotal").textContent = fmt(nw.assetsTotal);
  $("liabilitiesTotal").textContent = fmt(nw.liabilitiesTotal);

  // Monthly liabilities is just this month's charges against any
  // liability-linked account type (credit card, HELOC, mortgage, ...) - a
  // slice of Total, not a separate pool (Total already includes every such
  // charge ever made, this month's included). Debit/cash/asset-backed
  // spending already reduces an asset directly (applyAssetDelta), so it's
  // never counted here; subscriptions are a recurring cost, not debt, so
  // they don't belong here either - see the Reports page for both instead.
  const ym = monthKey();
  const creditTotal = allExpenses
    .filter((r) => (r.occurred_at || "").startsWith(ym) && LIABILITY_ACCOUNT_TYPES.has(r.payment_type))
    .reduce((s, r) => s + Number(r.amount), 0);
  $("liabilitiesMonthly").textContent = fmt(creditTotal);
}

// Net worth trend - no cron/
// server trigger exists for a static PWA, so a snapshot only ever
// happens because the app was actually opened that day; a day it wasn't
// opened just has no row, an honest gap rather than a fabricated
// backfill. Upsert (not insert) so today's snapshot stays current if net
// worth changes again later the same day, rather than freezing at
// whatever it was on the first load. Called once per init(), not from
// renderNetWorth() (which runs many times per session) - one write per
// day is the point, not one per render.
async function snapshotNetWorthIfNeeded() {
  const depreciatedAssets = assets.map((a) => ({ ...a, value: effectiveAssetValue(a) }));
  const nw = computeNetWorth(depreciatedAssets, debts);
  const snapshot_date = new Date().toISOString().slice(0, 10);
  await sb.from("net_worth_snapshots").upsert(
    { snapshot_date, assets_total: nw.assetsTotal, liabilities_total: nw.liabilitiesTotal, net_worth: nw.netWorth },
    { onConflict: "user_id,snapshot_date" }
  );
}

// ---- QUICK ADD -------------------------------------------------------------
// There's no separate "Payment" field anymore - an expense's payment type
// IS whatever type the chosen Account is (cash/debit/credit values match
// exactly), so there's nothing left to derive it from independently, and
// no way for the two to disagree. A payment-type word in the free text
// (e.g. "debit") still auto-picks the matching account, but only when
// there's exactly one of that type - picking the wrong one silently would
// be worse than leaving it for the user to choose.
function selectAccountByType(type) {
  if (!type) return;
  const matches = accounts.filter((a) => a.type === type);
  if (matches.length === 1) $("fAccount").value = matches[0].id;
}

$("quick").addEventListener("input", (e) => {
  const raw = e.target.value;
  if (!raw.trim()) { $("confirm").classList.add("hidden"); $("parseStatus").textContent = ""; return; }
  $("confirm").classList.remove("hidden");
  // Layer 1: instant keyword parse (always on, README §3.5).
  const p = quickParse(raw);
  $("fAmount").value = p.amount ?? "";
  selectAccountByType(p.payment_type);
  $("fDesc").value = p.rest;
  const guessed = categorize(raw, userRules);
  if (guessed) $("fCategory").value = guessed;
  entrySource = "manual";
  // Layer 2: best-effort Gemma enrichment, debounced (README §3.6).
  scheduleGemma(raw);
});
$("cancelBtn").onclick = () => { $("quick").value = ""; $("confirm").classList.add("hidden"); $("parseStatus").textContent = ""; };

// If the user hand-edits the Amount field after a parse (keyword or Gemma),
// the raw quick-add text still shows the old amount word-for-word - and that
// raw text is exactly what gets saved as both `description` and `raw_input`
// (see saveBtn below), so a stale figure there is misleading, not cosmetic.
// Keep the two in sync. Only fires on real keystrokes here (programmatic
// `.value =` assignments elsewhere don't dispatch `input`), so this can't
// loop with the quick-add parser.
$("fAmount").addEventListener("input", () => {
  const raw = $("quick").value;
  if (!raw.trim()) return;
  const val = $("fAmount").value;
  const replacement = val ? `$${val}` : "";
  const amtRe = /\$?\s*\d+(?:\.\d{1,2})?/;
  $("quick").value = amtRe.test(raw)
    ? raw.replace(amtRe, replacement).trim()
    : [replacement, raw].filter(Boolean).join(" ");
  entrySource = "manual";
});

// Debounced background call to Gemma. Never blocks; silently falls back.
function scheduleGemma(raw) {
  if (!GEMMA_ENDPOINT) return; // feature dormant when unconfigured
  clearTimeout(gemmaTimer);
  $("parseStatus").textContent = "";
  gemmaTimer = setTimeout(async () => {
    const sent = raw;
    $("parseStatus").textContent = "Asking Gemma…";
    try {
      const g = await parseWithGemma(sent, {
        endpoint: GEMMA_ENDPOINT, model: GEMMA_MODEL, today: $("fDate").value,
      });
      // Only apply if the user hasn't typed something new in the meantime.
      if ($("quick").value !== sent) { $("parseStatus").textContent = ""; return; }
      if (g.amount != null) $("fAmount").value = g.amount;
      selectAccountByType(g.payment_type);
      if (g.merchant) $("fDesc").value = g.merchant;
      if (g.category) $("fCategory").value = g.category;
      if (g.occurred_at) $("fDate").value = g.occurred_at;
      entrySource = "parsed";
      $("parseStatus").textContent = "Parsed by Gemma - confirm & save";
    } catch (err) {
      // Home machine asleep / unreachable - keep the keyword guess.
      $("parseStatus").textContent = "Gemma unavailable - using quick parse";
    }
  }, 650);
}

$("saveBtn").onclick = async () => {
  const amount = parseFloat($("fAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const accountId = $("fAccount").value || null;
  if (!accountId) return toast("Select an account");
  const category = $("fCategory").value || null;
  if (!category) return toast("Select a category");
  const occurredAt = $("fDate").value;
  if (!occurredAt) return toast("Select a date");
  // No separate Payment field - the account IS the payment type, since
  // account.type and payment_type share the same values (cash/debit/credit).
  const paymentType = accounts.find((a) => a.id === accountId).type;
  const assetErr = assetDeltaError([{ accountId, paymentType, amount, sign: -1 }]);
  if (assetErr) return toast(assetErr);
  const desc = $("fDesc").value.trim();
  const fullText = $("quick").value.trim();
  const row = {
    amount, description: fullText || desc || null,
    merchant: desc.split(/\s+/)[0] || null,
    category,
    payment_type: paymentType,
    account_id: accountId,
    occurred_at: occurredAt,
    raw_input: fullText, source: entrySource,
  };
  $("saveBtn").disabled = true;
  const { error } = await sb.from("expenses").insert(row);
  $("saveBtn").disabled = false;
  if (error) return toast(error.message);
  await applyAssetDelta(row.account_id, row.payment_type, amount, -1);
  await applyLiabilityDelta(row.account_id, row.payment_type, amount, +1);
  $("quick").value = ""; $("confirm").classList.add("hidden"); $("parseStatus").textContent = "";
  entrySource = "manual";
  await loadAssets(); await loadDebts(); await loadExpenses();
  toast("Saved ✓" + budgetWarningToastSuffix(row.category));
};

// ---- CSV IMPORT (expense-history migration) --------------------------------
// Runs entirely client-side - PapaParse parses the file in the browser,
// csvImport.js normalizes rows, and the only network calls this makes are
// the same RLS-scoped sb.from("expenses").insert() every other expense
// write already uses. The file itself never leaves the browser. See
// index.html's csvImportModal comment for why this deliberately never
// calls applyAssetDelta/applyLiabilityDelta - imported rows are history
// that already happened, not a new money movement to apply.
const CSV_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CSV_MAX_ROWS = 10000;
const CSV_INSERT_CHUNK_SIZE = 500;

let csvHeaders = [];
let csvDataRows = []; // raw string[][], header row excluded
let csvMapping = { dateCol: null, amountCol: null, descCol: null, categoryCol: null };
let csvPreviewRows = []; // { normalized, duplicate }[] - only successfully-normalized rows
let csvSkippedCount = 0; // rows that failed to normalize (bad date/amount)
let csvLastImportedIds = []; // this session's last import - Undo target

function resetCsvImportState() {
  csvHeaders = []; csvDataRows = [];
  csvMapping = { dateCol: null, amountCol: null, descCol: null, categoryCol: null };
  csvPreviewRows = []; csvSkippedCount = 0; csvLastImportedIds = [];
  $("csvFileInput").value = "";
  $("csvFileError").textContent = "";
  $("csvStep1").classList.remove("hidden");
  $("csvStep2").classList.add("hidden");
  $("csvStep3").classList.add("hidden");
  $("csvStep4").classList.add("hidden");
}
$("openCsvImportBtn").onclick = () => {
  resetCsvImportState();
  $("csvImportModal").classList.remove("hidden");
};
$("csvImportClose").onclick = () => $("csvImportModal").classList.add("hidden");
$("csvImportDone").onclick = () => $("csvImportModal").classList.add("hidden");

function csvColumnOptions(selectedIdx) {
  return `<option value="">None</option>` +
    csvHeaders.map((h, i) => `<option value="${i}" ${i === selectedIdx ? "selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("");
}

$("csvFileInput").onchange = () => {
  const file = $("csvFileInput").files[0];
  $("csvFileError").textContent = "";
  if (!file) return;
  if (file.size > CSV_MAX_FILE_BYTES) {
    $("csvFileError").textContent = `File is too large (max ${CSV_MAX_FILE_BYTES / 1024 / 1024}MB).`;
    $("csvFileInput").value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = Papa.parse(String(reader.result), { skipEmptyLines: true });
    const rows = result.data || [];
    if (result.errors?.length && !rows.length) {
      $("csvFileError").textContent = "Couldn't parse this file as CSV.";
      $("csvFileInput").value = "";
      return;
    }
    if (!rows.length) {
      $("csvFileError").textContent = "This file has no rows.";
      $("csvFileInput").value = "";
      return;
    }
    if (rows.length - 1 > CSV_MAX_ROWS) {
      $("csvFileError").textContent = `This file has more than ${CSV_MAX_ROWS.toLocaleString()} rows - split it into smaller files.`;
      $("csvFileInput").value = "";
      return;
    }
    csvHeaders = rows[0];
    csvDataRows = rows.slice(1);
    csvMapping = guessColumnMapping(csvHeaders);
    $("csvMapDate").innerHTML = csvColumnOptions(csvMapping.dateCol);
    $("csvMapAmount").innerHTML = csvColumnOptions(csvMapping.amountCol);
    $("csvMapDesc").innerHTML = csvColumnOptions(csvMapping.descCol);
    $("csvMapCategory").innerHTML = csvColumnOptions(csvMapping.categoryCol);
    $("csvFlipSign").checked = guessSignConvention(csvDataRows, csvMapping);
    const spendable = accounts.filter((a) => !NON_SPENDABLE_ACCOUNT_TYPES.has(a.type) && !a.archived_at);
    $("csvAccount").innerHTML = spendable.length
      ? spendable.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("")
      : `<option value="">No account available - add one first</option>`;
    $("csvStep1").classList.add("hidden");
    $("csvStep2").classList.remove("hidden");
  };
  reader.onerror = () => { $("csvFileError").textContent = "Couldn't read this file."; };
  reader.readAsText(file);
};

$("csvStep2Back").onclick = () => {
  $("csvStep2").classList.add("hidden");
  $("csvStep1").classList.remove("hidden");
};

$("csvStep2Next").onclick = () => {
  const dateCol = $("csvMapDate").value !== "" ? Number($("csvMapDate").value) : null;
  const amountCol = $("csvMapAmount").value !== "" ? Number($("csvMapAmount").value) : null;
  if (dateCol == null || amountCol == null) return toast("Pick a Date and an Amount column");
  if (!$("csvAccount").value) return toast("Pick an account to import into");
  csvMapping = {
    dateCol, amountCol,
    descCol: $("csvMapDesc").value !== "" ? Number($("csvMapDesc").value) : null,
    categoryCol: $("csvMapCategory").value !== "" ? Number($("csvMapCategory").value) : null,
  };
  const flipSign = $("csvFlipSign").checked;

  csvPreviewRows = [];
  csvSkippedCount = 0;
  for (const raw of csvDataRows) {
    const normalized = normalizeRow(raw, csvMapping, { flipSign });
    if (!normalized) { csvSkippedCount++; continue; }
    csvPreviewRows.push({ normalized, duplicate: isLikelyDuplicate(normalized, allExpenses) });
  }

  const dupCount = csvPreviewRows.filter((r) => r.duplicate).length;
  $("csvPreviewSummary").textContent =
    `${csvPreviewRows.length} row${csvPreviewRows.length === 1 ? "" : "s"} ready to import` +
    (dupCount ? `, ${dupCount} flagged as possible duplicates` : "") +
    (csvSkippedCount ? `. ${csvSkippedCount} row${csvSkippedCount === 1 ? "" : "s"} skipped (couldn't read a date/amount).` : ".");

  $("csvPreviewList").innerHTML = csvPreviewRows.length
    ? csvPreviewRows.map((r, i) => `
      <div class="exp" style="cursor:default">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <input type="checkbox" class="csv-row-select" data-csv-idx="${i}" ${r.duplicate ? "" : "checked"} style="flex-shrink:0" />
          <div style="min-width:0">
            <div>${esc(r.normalized.description || "(no description)")}${r.duplicate ? ` <span class="muted" style="font-size:11px">possible duplicate</span>` : ""}</div>
            <div class="meta">${r.normalized.occurred_at}${r.normalized.category ? " · " + esc(r.normalized.category) : ""}</div>
          </div>
        </div>
        <span class="amt">${fmt(r.normalized.amount)}</span>
      </div>`).join("")
    : `<p class="muted" style="font-size:13px">No valid rows found in this file.</p>`;

  $("csvStep2").classList.add("hidden");
  $("csvStep3").classList.remove("hidden");
};

$("csvStep3Back").onclick = () => {
  $("csvStep3").classList.add("hidden");
  $("csvStep2").classList.remove("hidden");
};

$("csvImportConfirm").onclick = async () => {
  const checkedIdx = new Set(
    [...document.querySelectorAll(".csv-row-select:checked")].map((el) => Number(el.dataset.csvIdx))
  );
  const toImport = csvPreviewRows.filter((_, i) => checkedIdx.has(i));
  if (!toImport.length) return toast("Nothing checked to import");

  const accountId = $("csvAccount").value;
  const importAccount = accounts.find((a) => a.id === accountId);
  const paymentType = importAccount.type;

  const rows = toImport.map((r) => ({
    amount: r.normalized.amount,
    description: r.normalized.description,
    merchant: null,
    category: r.normalized.category || categorize(r.normalized.description || "", userRules) || null,
    payment_type: paymentType,
    account_id: accountId,
    occurred_at: r.normalized.occurred_at,
    source: "import",
  }));

  $("csvImportConfirm").disabled = true;
  csvLastImportedIds = [];
  for (let i = 0; i < rows.length; i += CSV_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CSV_INSERT_CHUNK_SIZE);
    const { data, error } = await sb.from("expenses").insert(chunk).select("id");
    if (error) {
      $("csvImportConfirm").disabled = false;
      return toast(`Import failed partway through (${csvLastImportedIds.length} rows written): ${error.message}`);
    }
    csvLastImportedIds.push(...(data || []).map((r) => r.id));
  }
  $("csvImportConfirm").disabled = false;

  await loadExpenses();
  $("csvImportSummary").textContent = `Imported ${csvLastImportedIds.length} expense${csvLastImportedIds.length === 1 ? "" : "s"}.`;
  $("csvStep3").classList.add("hidden");
  $("csvStep4").classList.remove("hidden");
  toast(`Imported ${csvLastImportedIds.length} expense${csvLastImportedIds.length === 1 ? "" : "s"} ✓`);
};

$("csvUndoImportBtn").onclick = async () => {
  if (!csvLastImportedIds.length) return;
  if (!(await confirmModal("This removes every expense from this import.", { title: "Undo this import?" }))) return;
  const { error } = await sb.from("expenses").delete().in("id", csvLastImportedIds);
  if (error) return toast(error.message);
  csvLastImportedIds = [];
  await loadExpenses();
  $("csvImportModal").classList.add("hidden");
  toast("Import undone");
};

// ---- EXPENSE LIST ----------------------------------------------------------
// Shared row template + click-to-edit wiring for any expense/transaction
// list - the Log page's Recent Transactions (expenses + account_activity
// merged, see recentTransactions below) and the Reports page's per-month
// expense log (expenses only) both use this, scoped to their own container
// so the two lists (each with their own `rows` array/index) never cross-wire.
// A row from `account_activity` carries a `kind` field expense rows never
// have (no such column on `expenses`) - that's what tells the two apart
// here, rather than a separate flag threaded through every caller.
// Every row gets an undo icon (↶, not the delete "x" - undoing reverses
// the underlying money movement, it doesn't just remove a line item; and
// not a full-circle arrow like ↺/⟲, which reads as "refresh" rather than
// "undo") so a mistake - a miskeyed expense, a balance adjustment
// fat-fingered, a payment made against the wrong debt - can be corrected
// from the list directly instead of hunting down the right form to
// reverse it by hand. See undoTransaction() below.
// `selectable` (Recent Transactions only, not the Reports month log - see
// callers) adds a checkbox to expense rows for bulkApplyBtn/bulkClearBtn
// below; account_activity rows never get one, since category doesn't
// apply to them. selectedTxnIds is checked, not just set, on render so a
// selection already made survives a re-render from a filter change.
function renderExpenseList(containerId, rows, emptyMsg, { selectable = false } = {}) {
  const el = $(containerId);
  if (!rows.length) { el.innerHTML = `<p class="muted">${emptyMsg}</p>`; return; }
  el.innerHTML = rows.map((r, i) => r.kind ? `
    <div class="exp" data-idx="${i}" style="cursor:default">
      <div>
        <div>${esc(r.description)}</div>
        <div class="meta">${r.occurred_at} · ${ACTIVITY_LABEL[r.kind] || "Account activity"}</div>
      </div>
      <span class="amt">${fmt(Math.abs(r.amount))}<span class="x" data-undo-idx="${i}" style="margin-left:8px;cursor:pointer" title="Undo">↶</span></span>
    </div>` : `
    <div class="exp" data-idx="${i}">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        ${selectable ? `<input type="checkbox" class="txn-select" data-sel-idx="${i}" style="flex-shrink:0" ${selectedTxnIds.has(r.id) ? "checked" : ""} />` : ""}
        <div style="min-width:0">
          <div>${esc(r.description || r.merchant || "(no description)")}</div>
          <div class="meta">${r.occurred_at} · ${esc(r.category || "Uncategorized")}${r.payment_type ? " · " + accountTypeLabel(r.payment_type) : ""}${acctName(r.account_id) ? " · " + esc(acctName(r.account_id)) : ""}</div>
        </div>
      </div>
      <span class="amt">${fmt(r.amount)}<span class="x" data-undo-idx="${i}" style="margin-left:8px;cursor:pointer" title="Undo">↶</span></span>
    </div>`).join("");
  el.querySelectorAll(".exp").forEach((rowEl) => {
    const row = rows[Number(rowEl.dataset.idx)];
    if (row.kind) return; // account activity - informational only, nothing to edit (but still undoable)
    rowEl.onclick = () => openEdit(row);
  });
  el.querySelectorAll("[data-undo-idx]").forEach((undoEl) => {
    undoEl.onclick = (ev) => {
      ev.stopPropagation(); // don't also trigger the row's openEdit click
      undoTransaction(rows[Number(undoEl.dataset.undoIdx)]);
    };
  });
  el.querySelectorAll(".txn-select").forEach((cb) => {
    cb.onclick = (ev) => ev.stopPropagation(); // don't also trigger the row's openEdit click
    cb.onchange = () => {
      const row = rows[Number(cb.dataset.selIdx)];
      if (cb.checked) selectedTxnIds.add(row.id); else selectedTxnIds.delete(row.id);
      updateBulkActionBar();
    };
  });
}

// Selected ids persist across a Recent Transactions re-render (filter
// change, new data) - cleared only by Clear, a successful Apply, or
// signing out. Keyed by expenses.id, so it only ever holds expense rows,
// never account_activity ones (see renderExpenseList above).
let selectedTxnIds = new Set();
function updateBulkActionBar() {
  const n = selectedTxnIds.size;
  $("bulkActionBar").classList.toggle("hidden", n === 0);
  $("bulkSelectedCount").textContent = `${n} selected`;
}
$("bulkClearBtn").onclick = () => { selectedTxnIds.clear(); renderRecentTransactions(); };
$("bulkApplyBtn").onclick = async () => {
  const category = $("bulkCategorySelect").value;
  if (!category || !selectedTxnIds.size) return;
  $("bulkApplyBtn").disabled = true;
  // Category never factors into applyAssetDelta/applyLiabilityDelta (see
  // editSave above) - a plain category update needs no asset/liability
  // recalculation, unlike a full single-row edit.
  const { error } = await sb.from("expenses").update({ category }).in("id", [...selectedTxnIds]);
  $("bulkApplyBtn").disabled = false;
  if (error) return toast(error.message);
  const n = selectedTxnIds.size;
  selectedTxnIds.clear();
  await loadExpenses();
  toast(`Recategorized ${n} expense${n === 1 ? "" : "s"} to ${category}`);
};

// Reverses a transaction picked from Recent Transactions (or the Reports
// monthly log, which shares this same list renderer) - an expense gets
// deleted with its asset/liability effect reversed, exactly like the edit
// modal's Delete button; an account_activity row (a balance adjustment or
// a liability payment) has no edit modal at all, so this is the only way
// to correct one short of manually reversing it by hand. Confirmed first
// via confirmModal, same bar as account deletion - reversing real money
// movement deserves a real confirmation, not a stray-tap accident.
async function undoTransaction(row) {
  const isActivity = !!row.kind;
  const desc = isActivity ? row.description : (row.description || row.merchant || "this expense");
  const ok = await confirmModal(
    `This reverses "${desc}" (${fmt(Math.abs(row.amount))}). This can't be undone.`,
    { title: isActivity ? "Undo this activity?" : "Undo this expense?", confirmLabel: "Undo" }
  );
  if (!ok) return;
  if (isActivity) await undoActivity(row);
  else await undoExpense(row);
}

async function undoExpense(row) {
  const { error } = await sb.from("expenses").delete().eq("id", row.id);
  if (error) return toast(error.message);
  await applyAssetDelta(row.account_id, row.payment_type, Number(row.amount), +1);
  await applyLiabilityDelta(row.account_id, row.payment_type, Number(row.amount), -1);
  await loadAssets(); await loadDebts(); await loadExpenses();
  toast("Expense undone");
}

// account_activity rows carry a SIGNED amount for asset_adjust (see
// logActivity) so reversing one is always "subtract whatever the original
// delta was from the current value" - correct regardless of whether the
// original action was an add, a subtract, or a direct "set", and correct
// regardless of what's happened to the balance since (same reasoning as
// applyAssetDelta's sign param already relies on for expense edit/delete).
// A liability_payment's amount is always positive and always moved money
// the same direction (out of the asset, off the liability), so undoing it
// is just adding that amount back to both.
async function undoActivity(row) {
  if (row.kind === "asset_adjust") {
    const account = accounts.find((a) => a.id === row.account_id);
    const asset = account ? assets.find((a) => a.id === account.linked_asset_id) : null;
    if (!asset) return toast("Can't undo - the linked account no longer exists.");
    const newValue = Math.round((Number(asset.value) - Number(row.amount)) * 100) / 100;
    if (newValue < 0) return toast(`Can't undo - would take ${asset.name} below $0.`);
    const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
    if (error) return toast(error.message);
  } else if (row.kind === "liability_payment") {
    const account = accounts.find((a) => a.id === row.account_id);
    const asset = account ? assets.find((a) => a.id === account.linked_asset_id) : null;
    const debt = row.liability_id ? debts.find((d) => d.id === row.liability_id) : null;
    if (!asset || !debt) return toast("Can't undo - the linked account or liability no longer exists.");
    const newAssetValue = Math.round((Number(asset.value) + Number(row.amount)) * 100) / 100;
    const newBalance = Math.round((Number(debt.balance) + Number(row.amount)) * 100) / 100;
    const { error: assetErr } = await sb.from("assets").update({ value: newAssetValue }).eq("id", asset.id);
    if (assetErr) return toast(assetErr.message);
    const { error: debtErr } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
    if (debtErr) return toast(debtErr.message);
  }
  const { error } = await sb.from("account_activity").delete().eq("id", row.id);
  if (error) return toast(error.message);
  await loadAssets(); await loadDebts(); await loadAccountActivity();
  renderRecentTransactions();
  toast("Undone");
}

// Merges expenses with account_activity for the Log page's Recent
// Transactions list - Reports' Monthly Expense Log intentionally does NOT
// use this, it renders `allExpenses` directly (expenses only). All filters
// AND together and are applied before the limit, not after, so a filtered
// view still shows up to `limit` matches instead of whatever's left over
// from the unfiltered top 50. account_activity rows have no payment_type
// or category at all, so those two filters naturally drop them the moment
// either is set to something other than "All" - `kind` is the only filter
// that can explicitly ask for them back (kind === "activity").
// account_activity DOES carry account_id (and, for a liability_payment
// against a credit-linked debt, related_account_id too), so the account
// filter matches either side - filtering by a credit card shows both its
// charges and the payments made against it. `search` matches description/
// merchant text (case-insensitive substring, either field). Amount range
// compares against the *displayed* magnitude (Math.abs) rather than the
// raw signed value, since a negative asset_adjust still renders as a
// plain positive dollar figure in the list (renderExpenseList) - filtering
// on the signed value would surprise a user searching "around $50".
function recentTransactions(limit = 50, { paymentType = "", accountId = "", category = "", kind = "", search = "", minAmount = null, maxAmount = null } = {}) {
  let rows = [...allExpenses, ...accountActivity];
  if (kind === "expense") rows = rows.filter((r) => !r.kind);
  else if (kind === "activity") rows = rows.filter((r) => !!r.kind);
  if (paymentType) rows = rows.filter((r) => r.payment_type === paymentType);
  if (accountId) rows = rows.filter((r) => r.account_id === accountId || r.related_account_id === accountId);
  if (category) rows = rows.filter((r) => r.category === category);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.description || ""} ${r.merchant || ""}`.toLowerCase().includes(q));
  }
  if (minAmount !== null) rows = rows.filter((r) => Math.abs(Number(r.amount)) >= minAmount);
  if (maxAmount !== null) rows = rows.filter((r) => Math.abs(Number(r.amount)) <= maxAmount);
  return rows
    .sort((a, b) => (b.occurred_at || "").localeCompare(a.occurred_at || "") || (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, limit);
}
function renderRecentTransactions() {
  const minAmount = $("txnMinAmount").value !== "" ? parseFloat($("txnMinAmount").value) : null;
  const maxAmount = $("txnMaxAmount").value !== "" ? parseFloat($("txnMaxAmount").value) : null;
  const filters = {
    paymentType: $("txnTypeFilter").value,
    accountId: $("txnAccountFilter").value,
    category: $("txnCategoryFilter").value,
    kind: $("txnKindFilter").value,
    search: $("txnSearch").value.trim(),
    minAmount, maxAmount,
  };
  const anyFilterActive = Object.values(filters).some((v) => v !== "" && v !== null);
  const emptyMsg = anyFilterActive
    ? "No transactions match these filters."
    : "No transactions yet - add an expense above.";
  renderExpenseList("expList", recentTransactions(50, filters), emptyMsg, { selectable: true });
  updateBulkActionBar();
}

async function loadExpenses() {
  // Pull ~12 months so Reports can aggregate without a second round-trip.
  const since = lastMonths(12)[0] + "-01";
  const { data, error } = await sb.from("expenses")
    .select("*").gte("occurred_at", since)
    .order("occurred_at", { ascending: false }).order("created_at", { ascending: false });
  if (error) { $("expList").innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
  allExpenses = data || [];
  // Drop any selected id a reload no longer has (deleted/undone/out of the
  // 12-month window) so the bulk-action count never overcounts stale ids.
  const liveIds = new Set(allExpenses.map((r) => r.id));
  for (const id of selectedTxnIds) if (!liveIds.has(id)) selectedTxnIds.delete(id);

  const ym = monthKey();
  const monthRows = allExpenses.filter((r) => (r.occurred_at || "").startsWith(ym));
  $("monthTotal").textContent = fmt(monthRows.reduce((s, r) => s + Number(r.amount), 0));
  $("monthCount").textContent = monthRows.length;
  renderNetWorth();
  renderBudgetWarnings();

  populateTxnCategoryFilter();
  renderRecentTransactions();
  renderRecurringCandidates();
}

// Options are whatever categories actually appear on a real expense, not
// the full CATEGORIES list (categorize.js) - no point offering a filter
// for a category nothing has ever been logged under yet.
function populateTxnCategoryFilter() {
  const categories = [...new Set(allExpenses.map((r) => r.category).filter(Boolean))].sort();
  repopulateFilter($("txnCategoryFilter"), "All", categories.map((c) => [c, c]));
}

// ---- EDIT MODAL + LEARNING LOOP -------------------------------------------
function openEdit(row) {
  editing = row;
  $("eAmount").value = row.amount ?? "";
  $("eDesc").value = row.description ?? "";
  $("eCategory").value = row.category ?? CATEGORIES[0];
  $("eAccount").value = row.account_id ?? "";
  $("eDate").value = row.occurred_at ?? new Date().toISOString().slice(0, 10);
  $("eLearn").checked = true;
  $("editModal").classList.remove("hidden");
}
$("editClose").onclick = () => { $("editModal").classList.add("hidden"); editing = null; };

$("editSave").onclick = async () => {
  if (!editing) return;
  const amount = parseFloat($("eAmount").value);
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const accountId = $("eAccount").value;
  if (!accountId) return toast("Select an account");
  const newCategory = $("eCategory").value || null;
  if (!newCategory) return toast("Select a category");
  const occurredAt = $("eDate").value;
  if (!occurredAt) return toast("Select a date");
  // No separate Payment field - same as quick-add, the account IS the
  // payment type. This also removes the only way payment_type and the
  // selected account could ever disagree, so there's no credit-account
  // mismatch left to guard against here.
  const paymentType = accounts.find((a) => a.id === accountId).type;
  const desc = $("eDesc").value.trim();
  const categoryChanged = newCategory !== editing.category;
  const prevAccountId = editing.account_id, prevPaymentType = editing.payment_type, prevAmount = Number(editing.amount);

  const patch = {
    amount, description: desc || null, merchant: desc.split(/\s+/)[0] || editing.merchant,
    category: newCategory, payment_type: paymentType,
    account_id: accountId, occurred_at: occurredAt,
  };

  // Check both the reversal (old effect undone) and the new effect together -
  // they can land on the same asset (e.g. only the amount changed) or two
  // different ones (account changed), assetDeltaError nets each out on its
  // own asset before deciding.
  const assetErr = assetDeltaError([
    { accountId: prevAccountId, paymentType: prevPaymentType, amount: prevAmount, sign: +1 },
    { accountId: patch.account_id, paymentType: patch.payment_type, amount, sign: -1 },
  ]);
  if (assetErr) return toast(assetErr);

  $("editSave").disabled = true;
  const { error } = await sb.from("expenses").update(patch).eq("id", editing.id);
  if (error) { $("editSave").disabled = false; return toast(error.message); }

  // Reverse the old asset/liability effect (if any), then apply the new one -
  // covers amount/account/payment-type all changing in the same edit.
  await applyAssetDelta(prevAccountId, prevPaymentType, prevAmount, +1);
  await applyAssetDelta(patch.account_id, patch.payment_type, amount, -1);
  await applyLiabilityDelta(prevAccountId, prevPaymentType, prevAmount, -1);
  await applyLiabilityDelta(patch.account_id, patch.payment_type, amount, +1);
  await loadAssets(); await loadDebts();

  // Learning loop (README §3.5): on a category correction, remember keyword->category.
  if (categoryChanged && $("eLearn").checked) {
    const kw = learnKeyword(patch);
    if (kw) {
      await sb.from("category_rules").upsert(
        { keyword: kw, category: newCategory },
        { onConflict: "user_id,keyword" }
      );
      userRules[kw] = newCategory;
    }
  }
  $("editSave").disabled = false;
  $("editModal").classList.add("hidden"); editing = null;
  await loadExpenses();
  toast((categoryChanged ? "Saved - I'll remember that" : "Saved ✓") + budgetWarningToastSuffix(newCategory));
};

$("editDelete").onclick = async () => {
  if (!editing) return;
  const desc = editing.description || editing.merchant || "this expense";
  if (!(await confirmModal("This can't be undone.", { title: `Delete ${desc}?` }))) return;
  const { error } = await sb.from("expenses").delete().eq("id", editing.id);
  if (error) return toast(error.message);
  await applyAssetDelta(editing.account_id, editing.payment_type, Number(editing.amount), +1);
  await applyLiabilityDelta(editing.account_id, editing.payment_type, Number(editing.amount), -1);
  await loadAssets(); await loadDebts();
  $("editModal").classList.add("hidden"); editing = null;
  await loadExpenses(); toast("Deleted");
};

// ---- REPORTS ---------------------------------------------------------------
async function loadReports() {
  if (!allExpenses.length) await loadExpenses();
  // Build month selector from the last 12 months.
  const months = lastMonths(12).reverse(); // newest first for the dropdown
  const sel = $("monthSel");
  if (sel.options.length !== months.length) {
    sel.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
    sel.value = monthKey();
    sel.onchange = renderReports;
  }
  renderReports();
  loadInsights();
  populateHistoryAccountSelect();
  renderAccountHistory();
  await renderNetWorthTrend();
}

// Real stored snapshots (net_worth_snapshots), not a live reconstruction
// - see the card's comment in index.html for why. Not scoped to monthSel,
// same as the account balance history chart above.
async function renderNetWorthTrend() {
  const { data } = await sb.from("net_worth_snapshots").select("*").order("snapshot_date", { ascending: true });
  const rows = data || [];
  $("netWorthTrendEmpty").classList.toggle("hidden", rows.length >= 2);
  if (rows.length < 2) return; // a single point isn't a "trend"
  const labels = rows.map((r) => {
    const [y, m, d] = r.snapshot_date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  renderLineChart($("netWorthTrendChart"), labels, rows.map((r) => Number(r.net_worth)));
}

// ---- BUDGETS -----------------------------------------------------------
async function loadBudgets() {
  const { data } = await sb.from("budgets").select("*").order("category");
  budgets = data || [];
}

// Proactive Log-page banner, unlike renderBudgets() (Reports page) which
// only shows anything to a user who's already navigated there - same
// "surface it without being asked" pattern assetMaturityNotice/
// assetStaleNotice already use. Always scoped to the current calendar
// month (monthKey(), no month-selector input) since that's what "am I
// about to go over budget right now" actually means, unlike the Reports
// charts which can look at any past month. Called from loadExpenses()
// (a new expense can change this) and whenever budgets themselves change
// (saveBudgetBtn, the delete handler in renderBudgets).
function renderBudgetWarnings() {
  const byCat = sumBy(allExpenses, "category", monthKey());
  budgetWarnings = budgetStatus(budgets, byCat).filter((s) => s.warn);
  $("budgetWarningNotice").classList.toggle("hidden", !budgetWarnings.length);
  $("budgetWarningList").innerHTML = budgetWarnings.map((s) =>
    `<div>${esc(s.category)}: ${s.over ? "over budget" : `${s.pct}% of budget`} (${fmt(s.spent)} / ${fmt(s.limit)})</div>`
  ).join("");
}

// Appended to a "Saved" toast right after logging/editing an expense, so
// the warning shows up at the moment it becomes true, not just as a
// passive banner the user has to notice on their own. Looks up the
// category in budgetWarnings (set by the renderBudgetWarnings() call that
// already happened via loadExpenses() earlier in the same save handler).
function budgetWarningToastSuffix(category) {
  const w = budgetWarnings.find((s) => s.category === category);
  if (!w) return "";
  return w.over ? ` · ${category} is over budget` : ` · ${category} is at ${w.pct}% of budget`;
}

// Called from renderReports() with that render's own byCat, rather than
// recomputing sumBy() a second time - scoped to whatever month monthSel
// has selected, unlike the account-history/net-worth-trend charts.
function renderBudgets(byCat) {
  const statuses = budgetStatus(budgets, byCat);
  $("budgetsList").innerHTML = statuses.length
    ? statuses.map((s) => {
        const pctClamped = Math.min(100, s.pct);
        const barColor = s.over ? "var(--err)" : s.warn ? "var(--warn)" : "var(--ok)";
        return `
      <div style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between;font-size:13px">
          <span>${esc(s.category)}</span>
          <span>
            ${fmt(s.spent)} / ${fmt(s.limit)} (${s.pct}%)
            <span class="x" data-del-budget="${esc(s.category)}" style="margin-left:8px">✕</span>
          </span>
        </div>
        <div style="background:var(--panel-2);border-radius:6px;height:6px;margin-top:4px;overflow:hidden">
          <div style="background:${barColor};width:${pctClamped}%;height:100%"></div>
        </div>
      </div>`;
      }).join("")
    : `<p class="muted" style="font-size:13px">No budgets set yet.</p>`;
  document.querySelectorAll("[data-del-budget]").forEach((el) => {
    el.onclick = async () => {
      const { error } = await sb.from("budgets").delete().eq("category", el.dataset.delBudget);
      if (error) return toast(error.message);
      await loadBudgets();
      renderReports();
      renderBudgetWarnings(); // a removed budget can also remove a Log-page warning
      toast("Budget removed");
    };
  });
}

$("saveBudgetBtn").onclick = async () => {
  const category = $("budgetCategory").value;
  const monthly_limit = parseFloat($("budgetLimit").value);
  if (!category) return toast("Pick a category");
  if (!Number.isFinite(monthly_limit) || monthly_limit <= 0) return toast("Enter a valid monthly limit");
  const { error } = await sb.from("budgets")
    .upsert({ category, monthly_limit }, { onConflict: "user_id,category" });
  if (error) return toast(error.message);
  $("budgetLimit").value = "";
  await loadBudgets();
  renderReports();
  renderBudgetWarnings(); // a changed limit can newly trigger (or clear) a Log-page warning
  toast("Budget set");
};

// ---- INVESTMENTS TAB --------------------------------------------------------
async function loadInvestmentTargets() {
  const { data } = await sb.from("investment_targets").select("*").order("bucket");
  investmentTargets = data || [];
}

// One snapshot per calendar day the app was actually opened, same
// reasoning and shape as snapshotNetWorthIfNeeded above - no cron/server
// trigger exists for a static PWA.
async function snapshotPortfolioIfNeeded() {
  const investmentAssets = assets.filter((a) => INVESTMENT_ASSET_TYPES.has(a.type));
  const holdings = investmentHoldings(investmentAssets, assetPriceFindings);
  const totals = portfolioTotals(holdings, investmentAssets);
  const snapshot_date = new Date().toISOString().slice(0, 10);
  await sb.from("portfolio_snapshots").upsert(
    { snapshot_date, total_value: totals.totalValue, total_cost_basis: totals.totalCostBasis },
    { onConflict: "user_id,snapshot_date" }
  );
}

async function renderInvestmentsTrend() {
  const { data } = await sb.from("portfolio_snapshots").select("*").order("snapshot_date", { ascending: true });
  const rows = data || [];
  $("investTrendEmpty").classList.toggle("hidden", rows.length >= 2);
  if (rows.length < 2) return; // a single point isn't a "trend"
  const labels = rows.map((r) => {
    const [y, m, d] = r.snapshot_date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  renderLineChart($("investTrendChart"), labels, rows.map((r) => Number(r.total_value)));
}

const gainColor = (n) => (n == null ? "" : n >= 0 ? "var(--ok)" : "var(--err)");
const signedPct = (n) => (n >= 0 ? "+" : "") + n + "%";

function renderInvestments() {
  const investmentAssets = assets.filter((a) => INVESTMENT_ASSET_TYPES.has(a.type));
  const holdings = investmentHoldings(investmentAssets, assetPriceFindings);
  const totals = portfolioTotals(holdings, investmentAssets);

  $("investTotalValue").textContent = fmt(totals.totalValue);
  $("investTotalCostBasis").textContent = fmt(totals.totalCostBasis);
  $("investTotalGainLoss").textContent = totals.totalGainLoss != null
    ? `${fmt(totals.totalGainLoss)} (${signedPct(totals.totalGainLossPct)})` : "—";
  $("investTotalGainLoss").style.color = gainColor(totals.totalGainLoss);
  $("investTodayChangeEmpty").classList.toggle("hidden", totals.todayChange != null);
  $("investTodayChange").textContent = totals.todayChange != null
    ? `${fmt(totals.todayChange)} (${signedPct(totals.todayChangePct)})` : "—";
  $("investTodayChange").style.color = gainColor(totals.todayChange);

  $("investHoldingsList").innerHTML = investmentAssets.length ? investmentAssets.map((a) => {
    const h = holdings.find((x) => x.asset.id === a.id);
    if (!h) {
      // Symbol-less investment asset (a blended 401(k), say) - value only,
      // nothing to compute gain/loss or a day-change against.
      return `
        <div class="exp" style="cursor:default">
          <div>
            <div>${esc(a.name)}</div>
            <div class="meta">${assetTypeLabel(a.type)}</div>
          </div>
          <span class="amt">${fmt(effectiveAssetValue(a))}</span>
        </div>`;
    }
    return `
      <div class="exp" style="cursor:default;flex-direction:column;align-items:stretch;gap:4px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div>
            <div>${esc(h.symbol)} <span class="muted" style="font-size:12px">${esc(a.name)}</span></div>
            <div class="meta">${h.quantity ?? "?"} @ ${h.latestPrice != null ? fmt(h.latestPrice) : "no live price yet"}</div>
          </div>
          <div style="text-align:right">
            <div class="amt">${fmt(h.currentValue)}</div>
            <div style="font-size:12px;color:${gainColor(h.gainLoss)}">${h.gainLoss != null ? `${fmt(h.gainLoss)} (${signedPct(h.gainLossPct)})` : "no cost basis set"}</div>
            ${h.dayChange != null ? `<div style="font-size:12px;color:${gainColor(h.dayChange)}">today ${fmt(h.dayChange)} (${signedPct(h.dayChangePct)})</div>` : ""}
          </div>
        </div>
        ${h.explanation ? `<div class="muted" style="font-size:12px">${esc(h.explanation)}</div>` : ""}
      </div>`;
  }).join("") : `<p class="muted" style="font-size:13px">No investments added yet - add one from the Assets card on the Log page (Brokerage, IRA, 401(k), crypto, ...).</p>`;

  $("investRiskLabel").value = profile?.risk_label ?? "";

  const allocation = allocationVsTarget(investmentAssets, holdings, investmentTargets);
  $("investTargetsList").innerHTML = allocation.length ? allocation.map((a) => {
    const pctClamped = Math.min(100, a.currentPct);
    const barColor = a.currentPct > a.targetPercent ? "var(--err)" : "var(--ok)";
    const gapLabel = a.gapDollars >= 0 ? `${fmt(a.gapDollars)} under target` : `${fmt(Math.abs(a.gapDollars))} over target`;
    return `
      <div style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between;font-size:13px">
          <span>${esc(a.bucket)}</span>
          <span>
            ${a.currentPct}% / ${a.targetPercent}% target (${gapLabel})
            <span class="x" data-del-invest-target="${esc(a.bucket)}" style="margin-left:8px">✕</span>
          </span>
        </div>
        <div style="background:var(--panel-2);border-radius:6px;height:6px;margin-top:4px;overflow:hidden">
          <div style="background:${barColor};width:${pctClamped}%;height:100%"></div>
        </div>
      </div>`;
  }).join("") : `<p class="muted" style="font-size:13px">No targets set yet.</p>`;
  document.querySelectorAll("[data-del-invest-target]").forEach((el) => {
    el.onclick = async () => {
      const { error } = await sb.from("investment_targets").delete().eq("bucket", el.dataset.delInvestTarget);
      if (error) return toast(error.message);
      await loadInvestmentTargets();
      renderInvestments();
      toast("Target removed");
    };
  });
}

$("saveInvestTargetBtn").onclick = async () => {
  const bucket = $("investTargetBucket").value.trim();
  const target_percent = parseFloat($("investTargetPercent").value);
  if (!bucket) return toast("Enter a bucket name");
  if (!Number.isFinite(target_percent) || target_percent < 0 || target_percent > 100) return toast("Enter a valid target percent (0-100)");
  const { error } = await sb.from("investment_targets")
    .upsert({ bucket, target_percent }, { onConflict: "user_id,bucket" });
  if (error) return toast(error.message);
  $("investTargetBucket").value = "";
  $("investTargetPercent").value = "";
  await loadInvestmentTargets();
  renderInvestments();
  toast("Target set");
};

// Saved immediately on change, not behind a Save button - it's a single
// reference-only field (see index.html's Investments-view comment), not
// part of the bigger Profile form. Partial upsert (only id + risk_label in
// the payload) leaves every other profiles column untouched, same as
// budgets'/investment_targets' own partial upserts above.
$("investRiskLabel").onchange = async () => {
  const risk_label = $("investRiskLabel").value || null;
  const { error } = await sb.from("profiles").upsert({ id: userId, risk_label }, { onConflict: "id" });
  if (error) return toast(error.message);
  profile = { ...(profile || {}), risk_label };
  toast("Risk label saved");
};

// Whichever side of accounts.linked_asset_id/linked_liability_id is set is
// where the live balance actually lives - an account row itself never
// stores a dollar value.
function accountCurrentBalance(account) {
  if (account.linked_asset_id) return Number(assets.find((a) => a.id === account.linked_asset_id)?.value ?? 0);
  if (account.linked_liability_id) return Number(debts.find((d) => d.id === account.linked_liability_id)?.balance ?? 0);
  return 0;
}

function populateHistoryAccountSelect() {
  const sel = $("historyAccountSelect");
  const prev = sel.value;
  sel.innerHTML = accounts.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("");
  sel.value = accounts.some((a) => a.id === prev) ? prev : (accounts[0]?.id ?? "");
}
$("historyAccountSelect").onchange = renderAccountHistory;

// Not scoped to monthSel - see the comment on this card in index.html.
// Dates are built from y/m/d parts rather than `new Date(dateString)`,
// same defensive pattern daysUntil/advanceRenewal already use, since a
// bare "YYYY-MM-DD" is parsed as UTC midnight and can render as the wrong
// calendar day depending on the browser's local timezone.
function renderAccountHistory() {
  const account = accounts.find((a) => a.id === $("historyAccountSelect").value);
  if (!account) return;
  const points = buildBalanceHistory(account, accountCurrentBalance(account), allExpenses, accountActivity);
  const labels = points.map((p) => {
    const [y, m, d] = p.date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  renderLineChart($("historyChart"), labels, points.map((p) => p.balance));
}

// Latest monthly report, generated server-side by tools/monthly-report.js.
// RLS-scoped: only the signed-in user's own rows are ever returned.
async function loadInsights() {
  const { data } = await sb.from("spending_insights").select("*").order("created_at", { ascending: false }).limit(1);
  const row = (data || [])[0];
  $("insightsBody").textContent = row ? row.report : "No monthly reports yet.";
  $("insightsBody").classList.toggle("muted", !row);
}

// ---- INTERACTIVE Q&A (Gemma, optional/best-effort like Phase 3) -----------
$("qaAskBtn").onclick = async () => {
  const question = $("qaQuestion").value.trim();
  if (!question) return toast("Type a question first");
  if (!GEMMA_ENDPOINT) {
    $("qaStatus").textContent = "Not configured - set GEMMA_ENDPOINT in config.js (SETUP.md §3.6).";
    return;
  }
  $("qaAskBtn").disabled = true;
  $("qaAnswer").classList.add("hidden");
  $("qaStatus").textContent = "Thinking…";
  try {
    if (!allExpenses.length) await loadExpenses();
    const context = buildQaContext(allExpenses, subscriptions, 6, profile);
    const answer = await askGemma(question, context, { endpoint: GEMMA_ENDPOINT, model: GEMMA_MODEL });
    $("qaAnswer").textContent = answer;
    $("qaAnswer").classList.remove("hidden");
    $("qaStatus").textContent = "";
  } catch (err) {
    $("qaStatus").textContent = "Couldn't get an answer - is Gemma reachable? (" + err.message + ")";
  } finally {
    $("qaAskBtn").disabled = false;
  }
};

async function renderReports() {
  const ym = $("monthSel").value || monthKey();
  const byCat = sumBy(allExpenses, "category", ym);
  const byAcct = sumBy(allExpenses, "account", ym, acctName);
  // sumBy reads e.payment_type raw - fine for the original debit/credit/cash
  // values, but a snake_case type like "retirement_employer" would show up
  // unformatted in the chart. Pre-labels a throwaway copy rather than
  // teaching the generic chart helper about account types.
  const labeledByPayment = allExpenses.map((e) => ({ ...e, payment_type: accountTypeLabel(e.payment_type) }));
  const byPayment = sumBy(labeledByPayment, "payment_type", ym);
  const total = byCat.reduce((s, d) => s + d.value, 0);
  const subs = byCat.filter((d) => d.label === "Subscriptions").reduce((s, d) => s + d.value, 0);

  $("rptTotal").textContent = fmt(total);
  $("rptSubs").textContent = fmt(subs);

  const empty = total === 0;
  $("rptEmpty").classList.toggle("hidden", !empty);

  const monthRows = allExpenses.filter((r) => (r.occurred_at || "").startsWith(ym));
  renderExpenseList("rptExpList", monthRows, "No expenses this month.");
  renderBudgets(byCat);

  renderBreakdownBar($("catChart"), byCat);
  renderBreakdownBar($("acctChart"), byAcct);
  renderBreakdownBar($("payChart"), byPayment);
  const trailing = lastMonths(6, ym);
  renderTrendBar($("trendChart"), trailing, monthlyTotals(allExpenses, trailing));
}

// ---- MONTH REPORT EXPORT ------------------------------------------------
// Recomputes ym/monthRows fresh rather than reading renderReports()'s
// locals - cheap (already-loaded allExpenses, no new query) and avoids
// threading extra state through just for these two buttons.
$("exportCsvBtn").onclick = () => {
  const ym = $("monthSel").value || monthKey();
  const monthRows = allExpenses.filter((r) => (r.occurred_at || "").startsWith(ym));
  const csv = buildExpensesCsv(monthRows, acctName);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `expenses-${ym}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// window.print() against an isolated new-tab document, not a CDN PDF
// library (jsPDF etc.) and not @media print CSS fighting the live app's
// own layout - a clean report built fresh in its own tab is far more
// robust than trying to make the whole SPA shell print sensibly. The
// user picks "Save as PDF" as the print destination themselves; nothing
// here writes a PDF directly.
$("exportPdfBtn").onclick = () => {
  const ym = $("monthSel").value || monthKey();
  const monthRows = allExpenses.filter((r) => (r.occurred_at || "").startsWith(ym));
  const byCat = sumBy(allExpenses, "category", ym);
  const total = byCat.reduce((s, d) => s + d.value, 0);
  const win = window.open("", "_blank");
  if (!win) { toast("Allow pop-ups to print/export a PDF"); return; }
  const rowsHtml = monthRows.map((r) =>
    `<tr><td>${r.occurred_at}</td><td>${r.description || r.merchant || ""}</td><td>${r.category || ""}</td><td style="text-align:right">${fmt(r.amount)}</td></tr>`
  ).join("");
  const catHtml = byCat.map((c) => `<tr><td>${c.label}</td><td style="text-align:right">${fmt(c.value)}</td></tr>`).join("");
  win.document.write(`<!doctype html><html><head><title>${monthLabel(ym)} report</title>
<meta charset="utf-8">
<style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;padding:24px;color:#111}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px}
table{width:100%;border-collapse:collapse}
td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;font-size:13px}
.total{font-size:15px;font-weight:700;margin:8px 0 0}
</style></head><body>
<h1>${monthLabel(ym)}</h1>
<div class="total">Total: ${fmt(total)}</div>
<h2>By category</h2>
<table>${catHtml}</table>
<h2>Expenses</h2>
<table><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th></tr>${rowsHtml}</table>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
};

// ---- SUBSCRIPTIONS (README §3.7 / F5) --------------------------------------
// Suggestions only, not a fixed enum - sCategory (index.html) is a free-text
// input with a <datalist>, the same "pick a suggestion or type your own"
// pattern acctBank already uses for bank_name. Category values in the DB are
// therefore whatever the user actually typed, not one of these fixed
// strings - don't add a CHECK constraint or validate against this list.
// Set drawn from real-world recurring-bill category research (utilities,
// insurance, streaming, memberships, financial fees, ...).
const SUBSCRIPTION_CATEGORY_SUGGESTIONS = [
  "Utilities", "Housing", "Insurance", "Streaming & Media", "Software & Cloud",
  "Memberships & Dues", "Subscription Commerce", "Financial & Fees",
  "Health & Wellness", "Family & Education", "Transportation",
  "Charitable & Dues", "Other",
];

async function loadSubscriptions() {
  const { data, error } = await sb.from("subscriptions").select("*").order("next_renewal", { ascending: true });
  if (error) { $("subList").innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
  subscriptions = data || [];
  renderSubscriptions();
  renderDeals();
  renderDealFindings();
  renderNetWorth();
  renderRecurringCandidates();
  // Merge in every category the user has already typed, same as
  // loadAccounts() does for bankSuggestions - lets a custom category the
  // user invented once show back up as a suggestion next time.
  const cats = [...new Set([...SUBSCRIPTION_CATEGORY_SUGGESTIONS, ...subscriptions.map((s) => s.category).filter(Boolean)])].sort();
  $("subCategorySuggestions").innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

// A subscription's next_renewal reaching today means the real-world charge
// already happened, so - unlike the manual markPaidBtn below, which this
// shares its logic with - this runs unprompted on every app load and logs
// it automatically: same expense insert, same applyAssetDelta/
// applyLiabilityDelta, same assetDeltaError negative-balance guard. Catches
// up on however many cycles were missed since the app was last opened
// (capped at 36, so a stale date can't loop forever), stopping a given
// subscription's catch-up the moment a cycle would push its account
// negative rather than logging a charge with nowhere to come from - the
// remaining missed cycles wait for the next load, a top-up, or manual
// "Mark as paid". Every cycle advanceRenewal defines an interval for
// (monthly/quarterly/semiannual/annual - not 'other') with a linked
// account is eligible; everything else is unchanged here, same as
// before this existed.
//
// assetDeltaError/applyAssetDelta read the live assets/debts arrays, which
// a DB write alone doesn't update - so after each successful cycle, the
// affected asset's value or liability's balance is also patched in place
// here, mirroring the same math, purely so the *next* cycle in this loop
// (or another subscription sharing the same account) sees an accurate
// balance without a full reload per iteration. loadAssets/loadDebts at the
// end resync everything for real.
async function autoLogDueSubscriptions() {
  const today = new Date().toISOString().slice(0, 10);
  let loggedCount = 0;
  const blockedNames = new Set();

  for (const sub of subscriptions) {
    if (!sub.is_active || !sub.next_renewal || !sub.account_id) continue;
    if (!["monthly", "quarterly", "semiannual", "annual"].includes(sub.billing_cycle)) continue;
    const account = accounts.find((a) => a.id === sub.account_id);
    if (!account) continue;
    const paymentType = account.type;
    const amount = Number(sub.amount);

    let renewal = sub.next_renewal;
    let cycles = 0;
    while (renewal <= today && cycles < 36) {
      const assetErr = assetDeltaError([{ accountId: sub.account_id, paymentType, amount, sign: -1 }]);
      if (assetErr) { blockedNames.add(sub.name); break; }

      const { error } = await sb.from("expenses").insert({
        amount, description: sub.name, merchant: sub.name,
        category: "Subscriptions", payment_type: paymentType,
        account_id: sub.account_id, occurred_at: renewal, source: "manual",
      });
      if (error) break; // don't loop forever against a persistent write error
      await applyAssetDelta(sub.account_id, paymentType, amount, -1);
      await applyLiabilityDelta(sub.account_id, paymentType, amount, +1);
      if (account.linked_liability_id) {
        const debt = debts.find((d) => d.id === account.linked_liability_id);
        if (debt) debt.balance = Math.max(0, Math.round((Number(debt.balance) + amount) * 100) / 100);
      } else {
        const asset = assets.find((a) => a.id === account.linked_asset_id);
        if (asset) asset.value = Math.round((Number(asset.value) - amount) * 100) / 100;
      }
      loggedCount++;
      renewal = advanceRenewal(renewal, sub.billing_cycle);
      cycles++;
    }
    if (renewal !== sub.next_renewal) {
      await sb.from("subscriptions").update({ next_renewal: renewal }).eq("id", sub.id);
    }
  }

  if (loggedCount) { await loadAssets(); await loadDebts(); await loadExpenses(); await loadSubscriptions(); }
  if (blockedNames.size) {
    toast(`Logged ${loggedCount} charge${loggedCount === 1 ? "" : "s"} - couldn't cover ${[...blockedNames].join(", ")}`);
  } else if (loggedCount) {
    toast(`Logged ${loggedCount} subscription/bill charge${loggedCount === 1 ? "" : "s"} automatically`);
  }
}

// ---- RECURRING-EXPENSE DETECTION (README appendix open decision) --------
// Depends on both allExpenses and subscriptions, which load in parallel in
// init() (Promise.all) - called from the end of both loadExpenses() and
// loadSubscriptions() so it re-renders correctly once whichever finishes
// second lands, same eventually-consistent pattern renderNetWorth() uses.
function renderRecurringCandidates() {
  const card = $("recurringCard");
  if (!allExpenses.length && !subscriptions.length) { card.classList.add("hidden"); return; }
  const candidates = detectRecurringExpenses(allExpenses, subscriptions);
  card.classList.toggle("hidden", candidates.length === 0);
  if (!candidates.length) return;
  $("recurringList").innerHTML = candidates.map((c, i) => `
    <div class="exp" style="cursor:pointer" data-recur-idx="${i}">
      <div>
        <div>${esc(c.merchant)}</div>
        <div class="meta">${c.occurrenceCount}x, last ${c.lastOccurredAt} · every ${c.cycleLabel}</div>
      </div>
      <span class="amt" style="color:var(--accent)">${fmt(c.amount)} · Add →</span>
    </div>`).join("");
  document.querySelectorAll("#recurringList [data-recur-idx]").forEach((el) => {
    el.onclick = () => {
      const c = candidates[Number(el.dataset.recurIdx)];
      openSubForm(null);
      $("sName").value = c.merchant;
      $("sAmount").value = c.amount;
      $("sCycle").value = c.suggestedCycle;
      $("sAccount").value = c.accountId || "";
      $("sCategory").value = c.category || "";
    };
  });
}

// ---- DISCOUNT DISCOVERY (README §3.7 / F6) ---------------------------------
// One question per plan_type eligibilityUpsells() can nudge toward.
const UPSELL_PLAN_LABEL = {
  military: "Are you in the military?",
  first_responder: "Are you a first responder?",
  healthcare: "Are you a healthcare worker?",
  senior: "Are you a senior?",
};

function renderDeals() {
  const deals = findDeals(subscriptions, catalog, profile);
  const upsells = studentUpsell(subscriptions, catalog, profile);
  const eligUpsells = eligibilityUpsells(subscriptions, catalog, profile);
  const totalYearly = deals.reduce((s, d) => s + d.yearlySavings, 0);
  $("dealsTotal").textContent = totalYearly > 0 ? `up to ${fmt(totalYearly)}/yr` : "";

  const parts = [];

  for (const d of deals) {
    const link = d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="color:var(--accent)">view plan →</a>` : "";
    parts.push(`
      <div class="exp" style="cursor:default">
        <div>
          <div>${esc(d.service)} · <span style="color:var(--ok)">save ${fmt(d.monthlySavings)}/mo</span></div>
          <div class="meta">You pay ${fmt(d.currentMonthly)}/mo · ${esc(d.planType)} plan is ${fmt(d.planPrice)}/${d.planCycle === "annual" ? "yr" : "mo"}${d.eligibility ? " (" + esc(d.eligibility) + ")" : ""} ${link}</div>
        </div>
        <span class="amt" style="color:var(--ok)">${fmt(d.yearlySavings)}/yr</span>
      </div>`);
  }

  // Gentle student upsell if the user hasn't set student status.
  if (upsells.length) {
    const svc = upsells.map((u) => `${esc(u.service)} (${fmt(u.potentialYearly)}/yr)`).join(", ");
    parts.push(`
      <div class="exp" style="cursor:pointer;border-top:1px dashed var(--border)" id="upsellRow">
        <div>
          <div>Are you a student?</div>
          <div class="meta">Set your status to Student to unlock deals on: ${svc}. Tap to update your profile.</div>
        </div>
      </div>`);
  }

  // Eligibility upsells (military/first_responder/healthcare/senior) - one
  // row per matched plan type, same "tap to open profile" pattern as the
  // student upsell above. Currently always empty in practice, since no
  // real catalog rows exist yet for these plan types (seeding real
  // researched prices was explicitly deferred); the mechanism is complete
  // and will start surfacing rows the moment real catalog data exists.
  const byPlanType = new Map();
  for (const u of eligUpsells) {
    if (!byPlanType.has(u.planType)) byPlanType.set(u.planType, []);
    byPlanType.get(u.planType).push(u);
  }
  for (const [planType, items] of byPlanType) {
    const svc = items.map((u) => `${esc(u.service)} (${fmt(u.potentialYearly)}/yr)`).join(", ");
    parts.push(`
      <div class="exp" style="cursor:pointer;border-top:1px dashed var(--border)" data-upsell-plantype="${planType}">
        <div>
          <div>${UPSELL_PLAN_LABEL[planType] || "You may be eligible for a discount"}</div>
          <div class="meta">Update your profile to unlock deals on: ${svc}. Tap to update your profile.</div>
        </div>
      </div>`);
  }

  if (!parts.length) {
    const hint = subscriptions.some((s) => s.is_active)
      ? "No cheaper eligible plans found for your current subscriptions."
      : "Add subscriptions to see cheaper eligible plans.";
    $("dealsList").innerHTML = `<p class="muted" style="font-size:13px">${hint}</p>`;
    return;
  }
  $("dealsList").innerHTML = parts.join("");
  const up = $("upsellRow");
  if (up) up.onclick = () => $("profileBtn").click();
  document.querySelectorAll("[data-upsell-plantype]").forEach((el) => {
    el.onclick = () => $("profileBtn").click();
  });
}

// Machine-found deals (F6 stretch) - separate, clearly-labeled, unverified.
// Never blended into the trusted curated numbers above.
function renderDealFindings() {
  const card = $("dealFindingsCard");
  if (!card) return;
  if (!DEAL_FINDINGS_ENABLED) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const activeNames = subscriptions.filter((s) => s.is_active).map((s) => s.name);
  const matches = dealFindings.filter((f) => activeNames.some((name) => matchService(name, f.service)));

  if (!matches.length) {
    $("dealFindingsList").innerHTML = `<p class="muted" style="font-size:13px">No live findings yet for your subscriptions.</p>`;
    return;
  }
  $("dealFindingsList").innerHTML = matches.map((f) => {
    const link = f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:var(--accent)">check source →</a>` : "";
    const price = f.price != null ? fmt(Number(f.price)) : "?";
    // A candidate finding gets Promote/Reject (F6 Phase E); an already-
    // verified one just shows its status - nothing left to review.
    const actions = f.status === "candidate"
      ? `<button class="secondary" data-promote-finding="${f.id}" style="width:auto;padding:3px 8px;font-size:11px;margin-right:4px">Promote</button><button class="secondary" data-reject-finding="${f.id}" style="width:auto;padding:3px 8px;font-size:11px">Reject</button>`
      : `<span class="muted" style="font-size:11px">${f.status === "verified" ? "✓ verified" : esc(f.status)}</span>`;
    return `
      <div class="exp" style="cursor:default;flex-wrap:wrap;gap:6px">
        <div>
          <div>${esc(f.service)}${f.plan_type ? " · " + esc(f.plan_type) : ""}</div>
          <div class="meta">${price}${f.eligibility ? " (" + esc(f.eligibility) + ")" : ""} ${link}</div>
        </div>
        <span class="amt">${actions}</span>
      </div>`;
  }).join("");
  document.querySelectorAll("[data-promote-finding]").forEach((el) => {
    el.onclick = () => promoteFinding(dealFindings.find((f) => f.id === el.dataset.promoteFinding));
  });
  document.querySelectorAll("[data-reject-finding]").forEach((el) => {
    el.onclick = () => rejectFinding(el.dataset.rejectFinding);
  });
}

// F6 Phase E: promoting copies a finding's fields into subscription_catalog
// (a plain insert, not
// atomic with the status update below; low risk for this app's ~2-user
// trust model, same as the rest of this app's multi-step writes) and
// marks the finding verified so it stops offering Promote/Reject again.
// Confirmed first (confirmModal) since this has an ongoing effect on
// the shared, trusted catalog every user sees - not a one-off action.
async function promoteFinding(finding) {
  if (!finding) return;
  const priceLabel = finding.price != null ? fmt(Number(finding.price)) : "no price";
  const msg = `Add ${finding.service} (${finding.plan_type || "unknown plan"}, ${priceLabel}) to your trusted catalog? This becomes a normal deal every user sees.`;
  if (!(await confirmModal(msg, { title: "Promote this finding?", confirmLabel: "Promote" }))) return;
  const { error: insertErr } = await sb.from("subscription_catalog").insert({
    service: finding.service, plan_type: finding.plan_type, price: finding.price,
    eligibility: finding.eligibility, url: finding.url, notes: "Promoted from a live finding",
  });
  if (insertErr) return toast(insertErr.message);
  const { error: updateErr } = await sb.from("deal_findings").update({ status: "verified" }).eq("id", finding.id);
  if (updateErr) return toast(updateErr.message);
  await loadCatalog();
  await loadDealFindings();
  renderDealFindings();
  renderDeals();
  toast("Promoted to your trusted catalog");
}

// Rejecting just hides it - deal_findings' own SELECT policy excludes
// status = 'rejected', so a rejected row simply stops coming back.
async function rejectFinding(id) {
  const { error } = await sb.from("deal_findings").update({ status: "rejected" }).eq("id", id);
  if (error) return toast(error.message);
  await loadDealFindings();
  renderDealFindings();
  toast("Finding rejected");
}

function renderSubscriptions() {
  const monthly = totalMonthly(subscriptions);
  $("subsTotalMonthly").textContent = fmt(monthly);
  $("subsTotalYearly").textContent = fmt(monthly * 12);

  // Upcoming renewals (next 30 days) - display only, not editable here;
  // edit from the full list below instead.
  const up = upcomingRenewals(subscriptions, 30);
  $("subUpcoming").innerHTML = up.length
    ? up.map((s) => `
      <div class="exp" style="cursor:default">
        <div><div>${esc(s.name)}</div><div class="meta">${s.next_renewal} · ${renewalLabel(s.days)}${acctName(s.account_id) ? " · " + esc(acctName(s.account_id)) : ""}</div></div>
        <span class="amt">${fmt(s.amount)}${s.billing_cycle === "annual" ? "/yr" : "/mo"}</span>
      </div>`).join("")
    : `<p class="muted">None in the next 30 days.</p>`;

  // Full list (active first, then inactive)
  const sorted = [...subscriptions].sort((a, b) => (b.is_active - a.is_active) || a.name.localeCompare(b.name));
  $("subList").innerHTML = sorted.length
    ? sorted.map((s) => `
      <div class="exp" data-sub="${s.id}" style="${s.is_active ? "" : "opacity:.5"}">
        <div>
          <div>${esc(s.name)}${s.is_essential ? " · Essential" : ""}${s.is_active ? "" : " · (inactive)"}</div>
          <div class="meta">${s.category ? esc(s.category) + " · " : ""}${fmt(monthlyAmount(s))}/mo${s.billing_cycle !== "monthly" ? " (" + cap(s.billing_cycle) + ")" : ""}${s.next_renewal ? " · renews " + s.next_renewal : ""}</div>
        </div>
        <span class="amt">${fmt(s.amount)}</span>
      </div>`).join("")
    : `<p class="muted">No subscriptions or bills yet - add one above.</p>`;

  // Scoped to #subList only - the upcoming-renewals block above is display-only.
  document.querySelectorAll("#subList [data-sub]").forEach((el) => {
    el.onclick = () => {
      const sub = subscriptions.find((x) => x.id === el.dataset.sub);
      if (sub) openSubForm(sub);
    };
  });
}

const openNewSubForm = () => openSubForm(null);
$("addSubBtn").onclick = openNewSubForm;
$("addSubBtnBottom").onclick = openNewSubForm;
$("cancelSubBtn").onclick = closeSubForm;

function openSubForm(sub) {
  editingSub = sub;
  $("subFormTitle").textContent = sub ? "Edit subscription/bill" : "New subscription/bill";
  $("sName").value = sub?.name ?? "";
  $("sCategory").value = sub?.category ?? "";
  $("sAmount").value = sub?.amount ?? "";
  $("sCycle").value = sub?.billing_cycle ?? "monthly";
  $("sRenewal").value = sub?.next_renewal ?? "";
  $("sAccount").value = sub?.account_id ?? "";
  $("sActive").checked = sub ? !!sub.is_active : true;
  $("sEssential").checked = !!sub?.is_essential;
  $("sNotes").value = sub?.notes ?? "";
  $("deleteSubBtn").classList.toggle("hidden", !sub);
  // Only makes sense for an existing, currently-active subscription.
  $("markPaidBtn").classList.toggle("hidden", !sub || !sub.is_active);
  $("subForm").classList.remove("hidden");
  $("subForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeSubForm() { $("subForm").classList.add("hidden"); editingSub = null; }

$("saveSubBtn").onclick = async () => {
  const name = $("sName").value.trim();
  const amount = parseFloat($("sAmount").value);
  if (!name) return toast("Service name required");
  if (!amount || amount <= 0) return toast("Enter a valid amount");
  const row = {
    name, amount,
    category: $("sCategory").value.trim() || null,
    billing_cycle: $("sCycle").value,
    next_renewal: $("sRenewal").value || null,
    account_id: $("sAccount").value || null,
    is_active: $("sActive").checked,
    is_essential: $("sEssential").checked,
    notes: $("sNotes").value.trim() || null,
  };
  $("saveSubBtn").disabled = true;
  const q = editingSub
    ? sb.from("subscriptions").update(row).eq("id", editingSub.id)
    : sb.from("subscriptions").insert(row);
  const { error } = await q;
  $("saveSubBtn").disabled = false;
  if (error) return toast(error.message);
  closeSubForm();
  await loadSubscriptions();
  toast(editingSub ? "Subscription/bill updated" : "Subscription/bill added");
};

// A subscription's amount/cycle is just a forecast (see networth.js) until
// an actual charge is logged - this is what turns "will cost $X/mo" into a
// real, dated expense that hits the linked account like any other purchase,
// through the exact same asset/liability-delta + negative-balance guard as
// quick-add. Operates on the saved editingSub, not unsaved form edits -
// Save first if you changed the amount or account.
$("markPaidBtn").onclick = async () => {
  if (!editingSub) return;
  const sub = editingSub;
  if (!sub.account_id) return toast("Link an account to this subscription/bill first, then save, then mark as paid.");
  const account = accounts.find((a) => a.id === sub.account_id);
  if (!account) return toast("Linked account not found - pick one, save, then mark as paid.");
  const amount = Number(sub.amount);
  const paymentType = account.type;
  const assetErr = assetDeltaError([{ accountId: sub.account_id, paymentType, amount, sign: -1 }]);
  if (assetErr) return toast(assetErr);

  const row = {
    amount, description: sub.name, merchant: sub.name,
    category: "Subscriptions", payment_type: paymentType,
    account_id: sub.account_id, occurred_at: new Date().toISOString().slice(0, 10),
    source: "manual",
  };
  $("markPaidBtn").disabled = true;
  const { error } = await sb.from("expenses").insert(row);
  if (error) { $("markPaidBtn").disabled = false; return toast(error.message); }
  await applyAssetDelta(sub.account_id, paymentType, amount, -1);
  await applyLiabilityDelta(sub.account_id, paymentType, amount, +1);

  const nextRenewal = advanceRenewal(sub.next_renewal, sub.billing_cycle);
  if (nextRenewal !== sub.next_renewal) {
    await sb.from("subscriptions").update({ next_renewal: nextRenewal }).eq("id", sub.id);
  }
  $("markPaidBtn").disabled = false;
  closeSubForm();
  await loadAssets(); await loadDebts(); await loadExpenses(); await loadSubscriptions();
  toast(nextRenewal && nextRenewal !== sub.next_renewal ? `Logged - renews ${nextRenewal}` : "Logged");
};

$("deleteSubBtn").onclick = async () => {
  if (!editingSub) return;
  if (!(await confirmModal("This can't be undone.", { title: `Delete ${editingSub.name}?` }))) return;
  const { error } = await sb.from("subscriptions").delete().eq("id", editingSub.id);
  if (error) return toast(error.message);
  closeSubForm();
  await loadSubscriptions();
  toast("Subscription/bill deleted");
};

// ---- PROFILE (README §1.2, feeds Phase 4 discount matching) ----------------
async function loadProfile() {
  // A profile row is auto-created on sign-up by the DB trigger; fetch it.
  const { data } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();
  profile = data || null;
}

function toggleStudentFields() {
  $("pStudentFields").classList.toggle("hidden", $("pStatus").value !== "student");
}
$("pStatus").onchange = toggleStudentFields;

$("profileBtn").onclick = () => {
  $("pEmail").value = userEmail ?? "";
  $("pName").value = profile?.display_name ?? "";
  $("pStatus").value = profile?.status ?? "other";
  $("pSchool").value = profile?.school ?? "";
  $("pGradYear").value = profile?.graduation_year ?? "";
  $("pMilitary").checked = !!profile?.is_military;
  $("pFirstResponder").checked = !!profile?.is_first_responder_healthcare;
  $("pBirthYear").value = profile?.birth_year ?? "";
  $("pEmployer").value = profile?.employer ?? "";
  $("pOccupation").value = profile?.occupation ?? "";
  $("pHousing").value = profile?.housing_status ?? "";
  $("pEmployment").value = profile?.employment_status ?? "";
  $("pHouseholdSize").value = profile?.household_size ?? "";
  $("pDependents").value = profile?.dependents ?? "";
  $("pGoals").value = profile?.financial_goals ?? "";
  $("pNotes").value = profile?.notes ?? "";
  toggleStudentFields();
  $("profileModal").classList.remove("hidden");
};
$("profileClose").onclick = () => $("profileModal").classList.add("hidden");

// parseInt returns NaN on empty/invalid input - toNullableInt keeps that
// out of the row entirely (null) rather than writing NaN, same
// reasoning as the pre-existing graduation_year handling below.
function toNullableInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

$("profileSave").onclick = async () => {
  const isStudent = $("pStatus").value === "student";
  const gradRaw = parseInt($("pGradYear").value, 10);
  const row = {
    id: userId,
    display_name: $("pName").value.trim() || null,
    status: $("pStatus").value,
    school: isStudent ? ($("pSchool").value.trim() || null) : null,
    graduation_year: isStudent && Number.isFinite(gradRaw) ? gradRaw : null,
    is_military: $("pMilitary").checked,
    is_first_responder_healthcare: $("pFirstResponder").checked,
    birth_year: toNullableInt($("pBirthYear").value),
    employer: $("pEmployer").value.trim() || null,
    occupation: $("pOccupation").value.trim() || null,
    housing_status: $("pHousing").value || null,
    employment_status: $("pEmployment").value || null,
    household_size: toNullableInt($("pHouseholdSize").value),
    dependents: toNullableInt($("pDependents").value),
    financial_goals: $("pGoals").value.trim() || null,
    notes: $("pNotes").value.trim() || null,
  };
  $("profileSave").disabled = true;
  const { error } = await sb.from("profiles").upsert(row, { onConflict: "id" });
  $("profileSave").disabled = false;
  if (error) return toast(error.message);
  profile = row;
  $("profileModal").classList.add("hidden");
  renderDeals(); // eligibility may have changed (e.g. now a student, or military)
  toast("Profile saved");
};

// "Download all my data" - a plain JSON dump of every table this
// user's own data actually lives in, RLS-scoped automatically since this
// runs as the signed-in user (not service_role). Deliberately excludes
// the shared reference tables (subscription_catalog, deal_findings,
// asset_price_findings, service_domains) - not this user's data, and
// dumping deal_findings especially would mix in other users' unrelated
// candidate/rejected rows that happen to still be readable.
const USER_DATA_TABLES = [
  "profiles", "accounts", "expenses", "category_rules", "subscriptions",
  "assets", "liabilities", "account_activity", "budgets", "net_worth_snapshots",
];
$("downloadDataBtn").onclick = async () => {
  $("downloadDataBtn").disabled = true;
  const dump = { exported_at: new Date().toISOString() };
  for (const table of USER_DATA_TABLES) {
    const { data, error } = await sb.from(table).select("*");
    if (error) { $("downloadDataBtn").disabled = false; return toast(`Export failed on ${table}: ${error.message}`); }
    dump[table] = data || [];
  }
  $("downloadDataBtn").disabled = false;
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `personal-finance-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("Download started");
};

// Only reachable while already signed in (via password or magic link), so
// this is how the ~2 known users move onto password sign-in for the first
// time, or change it later - see index.html's authView/Account security
// comments for why a password is what actually keeps an installed
// home-screen icon signed in.
$("setPasswordBtn").onclick = async () => {
  const pw = $("pNewPassword").value;
  if (!pw || pw.length < 6) return toast("Password must be at least 6 characters");
  $("setPasswordBtn").disabled = true;
  $("setPasswordBtn").textContent = "Saving...";
  const { error } = await sb.auth.updateUser({ password: pw });
  $("setPasswordBtn").disabled = false;
  $("setPasswordBtn").textContent = "Set / change password";
  if (error) {
    $("passwordSetMsg").textContent = error.message;
    toast("Couldn't set password");
    return;
  }
  $("pNewPassword").value = "";
  $("passwordSetMsg").textContent = "Password updated ✓";
  toast("Password updated ✓");
};