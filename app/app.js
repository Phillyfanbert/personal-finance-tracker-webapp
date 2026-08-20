// ============================================================================
// Expense Tracker - Phase 1 app logic (plain ES modules, no build step).
// Adds: editable expenses, category-correction learning loop (README §3.5),
// richer account management, and monthly charts (README §3.8).
// RLS scopes every query to the signed-in user.
// ============================================================================
import { categorize, quickParse, CATEGORIES } from "./categorize.js";
import {
  monthKey, monthLabel, lastMonths, sumBy, monthlyTotals, incomeVsExpense,
  renderBreakdownBar, renderTrendBar, renderLineChart,
} from "./charts.js";
import { buildBalanceHistory } from "./accountHistory.js";
import { estimateValue, effectiveAssetValue } from "./depreciation.js";
import { payoffProjection, compareDebtStrategies } from "./payoff.js";
import { cycleDates, cycleStatus } from "./creditCycle.js";
import { budgetStatus } from "./budgets.js";
import { investmentHoldings, portfolioTotals, allocationVsTarget, contributionLimitUsage, portfolioHealthSummary, marketIndexSummary, topMarketMovers, latestNewsDigest, latestFinnhubRefresh, marketBreadth, marketStatus, latestRecap } from "./investments.js";
import { ALL_SECURITY_TICKERS, CRYPTO_SYMBOLS } from "./tickers.js";
import {
  guessColumnMapping, guessSignConvention, normalizeRow, isLikelyDuplicate,
} from "./csvImport.js";
import { buildExpensesCsv } from "./export.js";
import {
  monthlyAmount, totalMonthly, daysUntil, upcomingRenewals, renewalLabel, advanceRenewal,
  detectRecurringExpenses,
} from "./subscriptions.js";
import { advanceIncomeDate } from "./income.js";
import { forecastCashFlow } from "./cashflow.js";
import { findDeals, studentUpsell, eligibilityUpsells, matchService } from "./discounts.js";
import { parseWithGemma, askGemma, warmUpGemma, embedText } from "./gemma.js";
import { buildQaContext } from "./insights.js";
import { computeNetWorth, emergencyFundCoverage } from "./networth.js";
import { BANK_NAMES } from "./bankNames.js";

const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMMA_ENDPOINT, GEMMA_MODEL, GEMMA_EMBED_MODEL, GEMMA_AUTH_KEY, DEAL_FINDINGS_ENABLED, PRICE_FINDINGS_ENABLED } = window.APP_CONFIG || {};
// Ollama's embeddings endpoint, derived from GEMMA_ENDPOINT (the full
// /api/generate URL) rather than a second config field for a value that's
// mechanically the same host/port - kept in sync with tools/embed-
// expenses.js's identical derivation by hand, same category as
// MARKET_INDEXES. Used only by retrieveRelevantHistory() below.
const GEMMA_EMBED_ENDPOINT = (GEMMA_ENDPOINT || "").replace(/\/api\/generate$/, "/api/embeddings");
if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR-PROJECT")) {
  alert("Set your Supabase URL and anon key in config.js (see SETUP.md §4).");
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- tiny helpers ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fmt = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Same numeric formatting as fmt(), no "$" prefix - a market index level
// (Market overview card) is a points figure, not a dollar amount.
const fmtNum = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// Generic red-border flag for a denied action (this app's "every denial
// flags its field" rule) - call right before a `return toast(...)` that
// rejects a save/action over one or more specific fields. Self-clearing:
// the border comes off the moment the user next touches that exact field
// (input or change, whichever fires first), no separate per-form tracking
// function needed the way REQUIRED_QUICK_ADD_FIELDS/REQUIRED_HOLDING_
// FIELDS' *live* always-on highlighters are (this is one-shot, not live -
// those two forms already have live coverage for plain emptiness, so this
// is what patches the gap for a non-empty-but-invalid value, a cross-field
// check, or a server-side rejection, everywhere else in the app). Accepts
// one id or an array, for a denial that's jointly about more than one
// field. Silently does nothing for an id with no matching element (a
// field this action isn't clearly about, or a page whose fields aren't
// mounted in a force-unhide test) rather than throwing.
function flagField(ids) {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const el = $(id);
    if (!el) continue;
    el.classList.add("field-required");
    const clear = () => el.classList.remove("field-required");
    el.addEventListener("input", clear, { once: true });
    el.addEventListener("change", clear, { once: true });
  }
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
// A stable keyword to learn from (first meaningful token of merchant/
// description). Strips leading/trailing punctuation from each candidate
// word before the length check - categorize.js now matches keywords as
// whole words (\b...\b), and a keyword ending in a trailing comma/period
// picked up from raw typed text ("at walmart, bought milk" -> "walmart,")
// would never match anything again, since \b's behavior right at a
// punctuation edge is unreliable, not a silent no-op.
function learnKeyword(row) {
  const src = (row.merchant || row.description || "").toLowerCase().trim();
  const tok = src.split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((w) => w.length >= 3)[0];
  return tok || null;
}

let userRules = {};   // keyword -> category
let accounts = [];
let allExpenses = []; // cache for reports (last ~12 months)
let subscriptions = []; // cache of the user's subscriptions
let incomeSources = []; // cache of the user's recurring income sources
let catalog = [];     // shared subscription_catalog reference data
let dealFindings = []; // shared, machine-found deals (a background search agent)
let assetPriceFindings = []; // shared, machine-found asset prices (a background price agent)
let marketIndexFindings = []; // shared, machine-found market index levels (Investments tab's Market overview)
let marketNewsFindings = []; // shared, machine-found daily market news digest + sentiment (market_news_findings)
let dailyRecaps = []; // stored zero-LLM daily market recaps (daily_recaps, 55_daily_recaps.sql)
let agentRunStatus = {}; // { "deal-agent": {...}, "price-agent": {...} } - last-run freshness/health (agent_run_status)
let budgets = []; // per-category monthly limits
let budgetWarnings = []; // this month's budgetStatus() rows at/over WARN_THRESHOLD_PCT
let investmentTargets = []; // per-bucket allocation targets (Investments tab)
let assets = [];      // net-worth assets (Log page)
let debts = [];        // tracked debts, i.e. rows in the `liabilities` table (Log page)
let accountActivity = []; // non-expense money movements (asset adjust, liability pay) - Recent History
let editing = null;   // expense row currently in the edit modal
let editingSub = null; // subscription row currently in the sub form
let editingIncome = null; // income row currently in the income form
let userId = null;    // signed-in user's uuid
let userEmail = null; // signed-in user's email, shown read-only in Profile
let profile = null;   // the user's profiles row
let entrySource = "manual"; // 'manual' | 'parsed' - set to 'parsed' when Gemma fills fields
let gemmaTimer = null;      // debounce handle for background parsing

// ---- AUTH ------------------------------------------------------------------
$("signInBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { flagField("email"); return toast("Enter your email"); }
  $("signInBtn").disabled = true;
  $("signInBtn").textContent = "Sending...";
  $("authMsg").textContent = "Sending magic link...";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  $("signInBtn").disabled = false;
  $("signInBtn").textContent = "Send magic link instead";
  $("authMsg").textContent = error ? error.message : "Link sent ✓ - check your email.";
  if (error) flagField("email");
  toast(error ? "Couldn't send link" : "Magic link sent ✓");
};
// Primary sign-in path (see index.html's authView comment) - completes
// entirely in whichever window is open, so it's the only path that keeps
// an installed home-screen icon signed in. Magic link above stays as the
// bootstrap/recovery path for setting or resetting this password.
$("passwordSignInBtn").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email) { flagField("email"); return toast("Enter your email"); }
  if (!password) { flagField("password"); return toast("Enter your password"); }
  $("passwordSignInBtn").disabled = true;
  $("passwordSignInBtn").textContent = "Signing in...";
  $("passwordAuthMsg").textContent = "Signing in...";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  $("passwordSignInBtn").disabled = false;
  $("passwordSignInBtn").textContent = "Sign in";
  $("passwordAuthMsg").textContent = error ? error.message : "";
  if (error) { flagField(["email", "password"]); toast("Couldn't sign in"); }
};
$("signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };

sb.auth.onAuthStateChange((_e, session) => renderAuth(session));
sb.auth.getSession().then(({ data }) => renderAuth(data.session));

// Which tab the user was last on, restored after a reload instead of
// always landing on Log - localStorage (per-device UI state, not account
// data, so no RLS/table involved) rather than a URL param, since this is
// a single-page app with no routing. Falls back to "log" for a missing or
// unrecognized value (a fresh browser, or a value from some future build
// this one doesn't know).
const VIEWS = ["log", "subs", "reports", "invest"];
const lastView = () => (VIEWS.includes(localStorage.getItem("lastView")) ? localStorage.getItem("lastView") : "log");

function renderAuth(session) {
  const authed = !!session;
  userId = session?.user?.id ?? null;
  userEmail = session?.user?.email ?? null;
  $("authView").classList.toggle("hidden", authed);
  $("nav").classList.toggle("hidden", !authed);
  if (authed) {
    const view = lastView();
    showView(view);
    // The per-tab data each view needs (loadSubscriptions/loadReports/the
    // Investments renders) only exists once init() finishes - Log itself
    // needs no extra call since its own cards already self-render as each
    // of init()'s loadX() calls completes, the same way they always have.
    init().then(() => {
      if (view === "subs") loadSubscriptions();
      else if (view === "reports") loadReports();
      else if (view === "invest") { renderInvestments(); renderInvestmentsTrend(); renderMarketOverview(); }
    });
  }
  else { $("logView").classList.add("hidden"); $("subsView").classList.add("hidden"); $("reportsView").classList.add("hidden"); $("investView").classList.add("hidden"); }
}

// ---- NAVIGATION ------------------------------------------------------------
$("navLog").onclick = () => showView("log");
$("navSubs").onclick = () => { showView("subs"); loadSubscriptions(); };
$("navReports").onclick = () => { showView("reports"); loadReports(); };
$("navInvest").onclick = () => { showView("invest"); renderInvestments(); renderInvestmentsTrend(); renderMarketOverview(); };
$("backFromSubs").onclick = () => showView("log");
$("backFromReports").onclick = () => showView("log");
$("backFromInvest").onclick = () => showView("log");
function showView(v) {
  localStorage.setItem("lastView", v);
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
  await Promise.all([loadRules(), loadProfile(), loadCatalog(), loadDealFindings(), loadAssetPriceFindings(), loadMarketIndexFindings(), loadMarketNewsFindings(), loadAgentRunStatus(), loadDailyRecaps(), loadAssets(), loadDebts(), loadAccountActivity(), loadBudgets(), loadInvestmentTargets()]);
  // Both assets and assetPriceFindings are guaranteed loaded by the
  // Promise.all above (no race) - this is what keeps Net Worth/the Assets
  // card/the net-worth trend chart in sync with live prices on every app
  // open, not just whenever someone happens to manually edit a holding.
  await syncAllParentAssetValues();
  await Promise.all([loadExpenses(), loadSubscriptions(), loadIncome()]);
  await autoLogDueSubscriptions();
  await autoLogDueIncome();
  await snapshotNetWorthIfNeeded();
  await snapshotPortfolioIfNeeded();
  // The two findings loaders above already pulled a headline batch, so the
  // slower headline cadence starts from here rather than firing again on
  // the very first tick.
  lastHeadlineRefresh = Date.now();
  startLiveRefresh();
  // Not awaited: the live overlay is a best-effort enhancement on top of
  // data that's already rendered, so app startup shouldn't wait on a
  // round-trip to /api/quotes to finish.
  refreshLivePrices();
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
// the home-machine search agent starts writing rows.
async function loadDealFindings() {
  if (!DEAL_FINDINGS_ENABLED) { dealFindings = []; return; }
  const { data } = await sb.from("deal_findings").select("*").gt("expires_at", new Date().toISOString());
  dealFindings = data || [];
}

// Last-run health for deal-agent.js/price-agent.js (agent_run_status,
// migration 48) - loaded unconditionally (cheap, at most 2 rows) rather
// than gated by DEAL_FINDINGS_ENABLED/PRICE_FINDINGS_ENABLED, since the
// render functions that use it already check those flags themselves
// before showing anything. Previously a rate-limited or failed agent run
// was completely invisible to anyone without SSH access to the server
// machine's raw log file - this is what actually surfaces that to a
// signed-in user instead. Re-renders both dependent cards on its own
// completion (same "whichever parallel load finishes last wins" pattern
// loadAssetPriceFindings() already documents) since loadDealFindings()/
// loadSubscriptions()/loadMarketIndexFindings() all run in parallel with
// this and each also trigger their own render of the same cards.
async function loadAgentRunStatus() {
  const { data } = await sb.from("agent_run_status").select("*");
  agentRunStatus = {};
  for (const row of data || []) agentRunStatus[row.agent] = row;
  renderDealFindings();
  renderMarketOverview();
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Shared by renderDealFindings()/renderMarketOverview() below - both
// cards have an identical freshness-line + warning-banner shape, just
// against a different agent name and pair of element ids.
function renderAgentFreshness(agent, freshnessId, warningId) {
  const status = agentRunStatus[agent];
  const freshnessEl = $(freshnessId);
  const warningEl = $(warningId);
  if (!freshnessEl || !warningEl) return;

  if (!status) {
    freshnessEl.textContent = "";
    warningEl.classList.add("hidden");
    return;
  }
  freshnessEl.textContent = `Last updated ${timeAgo(status.ran_at)}`;

  if (status.status === "ok" || !status.detail) {
    warningEl.classList.add("hidden");
  } else {
    warningEl.classList.remove("hidden");
    warningEl.style.color = status.status === "failed" ? "var(--err)" : "var(--warn)";
    warningEl.textContent = status.detail; // .textContent, not innerHTML - no esc() needed
  }
}

// Deliberately separate from renderAgentFreshness above, which reflects
// an AGENT RUN's status (the whole weekly Tavily/Gemini pipeline) - this
// reflects the literal truth of the specific real-ticker prices on
// screen, computed straight from their own found_at timestamps
// (latestFinnhubRefresh, investments.js) rather than a job-level status
// row. Matters once the two cadences diverge: "Prices as of 12 minutes
// ago" (Finnhub, FAST_ONLY) and "Last updated 6 days ago" (indexes,
// Tavily+Gemini) can both be true on the same card at once, and blending
// them into one line would misstate one or the other.
const PRICE_REFRESH_WARN_MINUTES = 30; // 2x the 15-min FAST_ONLY interval
function renderPricesAsOf(elId, foundAt) {
  const el = $(elId);
  if (!el) return;
  if (!foundAt) { el.textContent = ""; return; }
  const { open } = marketStatus();
  const minutesAgo = (Date.now() - new Date(foundAt).getTime()) / 60000;
  // Outside the regular session a price many hours old is the correct,
  // current fact - the last close really is the latest price there is.
  // Warn-coloring it would flag ordinary overnight/weekend behavior as a
  // problem, which is exactly what made this line look broken every
  // evening. Only the CLOSED case is stated out loud; see marketStatus()'s
  // own comment for why a wrong "closed" would be worse than silence.
  el.textContent = open
    ? `Prices as of ${timeAgo(foundAt)}`
    : `Market closed - prices as of ${timeAgo(foundAt)}`;
  el.style.color = open && minutesAgo > PRICE_REFRESH_WARN_MINUTES ? "var(--warn)" : "";
}

// Only the columns something on this page actually reads, never select("*").
// source_query/raw_snippet/confidence/expires_at/id are never touched
// client-side for these two tables, and `headlines` is fetched separately
// by fetchLatestHeadlines() below rather than inline - see its comment for
// why pulling it with the price rows costs far more than it looks.
const PRICE_FINDING_COLS = "symbol,price,found_at,explanation,extracted_by";
// renderAssetPriceFindings() additionally shows a source link and currency.
const ASSET_PRICE_FINDING_COLS = `${PRICE_FINDING_COLS},url,currency`;

// A findings row is uniquely identified by symbol + found_at (each agent run
// writes one row per symbol), so dedup needs no id column of its own -
// which is the point, since id is a 36-byte uuid on every one of ~4,600 rows.
const findingKey = (r) => `${r.symbol}|${r.found_at}`;
// Matches the tables' own `expires_at` default (found_at + 2 days) so a
// session left open for days keeps the in-memory array bounded the same way
// the server-side query already bounds the fetch.
const FINDINGS_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

// Merges any number of findings lists into one deduped, still-fresh array.
// A row carrying `headlines` wins over the same row without it, since the
// price query deliberately omits that column.
function mergeFindings(...lists) {
  const cutoff = new Date(Date.now() - FINDINGS_RETENTION_MS).toISOString();
  const byKey = new Map();
  for (const list of lists) {
    for (const row of list) {
      if (row.found_at && row.found_at < cutoff) continue;
      const existing = byKey.get(findingKey(row));
      if (!existing || (row.headlines && !existing.headlines)) byKey.set(findingKey(row), row);
    }
  }
  return [...byKey.values()];
}

// `since` is what makes refreshLivePrices() cheap: a tick asks only for
// rows newer than the newest one already in memory (~25 rows) instead of
// re-running the full 2-day query. Narrowing by found_at on the INITIAL
// load would have been a no-op - expires_at (found_at + 2 days) already
// bounds that history, and the row count comes from the FAST_ONLY run
// writing all ~24 symbols every 15 minutes, not from a long tail.
async function fetchFindings(table, cols, since = null) {
  let q = sb.from(table).select(cols).gt("expires_at", new Date().toISOString());
  if (since) q = q.gt("found_at", since);
  const { data } = await q;
  return data || [];
}

// tools/price-agent.js writes headlines on roughly 1 of every 4 FAST_ONLY
// runs (shouldFetchNewsThisRun()) for every symbol at once, so a 2-day
// window holds ~950 near-duplicate copies of a blob - over half the whole
// payload - when latestHeadlinesForSymbol() only ever displays the newest
// per symbol. Taking the most recent few batches instead gets an identical
// render for a fraction of the bytes.
const HEADLINE_ROW_LIMIT = 60;
async function fetchLatestHeadlines(table, cols) {
  const { data } = await sb.from(table).select(`${cols},headlines`)
    .not("headlines", "is", null)
    .gt("expires_at", new Date().toISOString())
    .order("found_at", { ascending: false })
    .limit(HEADLINE_ROW_LIMIT);
  return data || [];
}

// Dormant until PRICE_FINDINGS_ENABLED is flipped on (config.js) and
// tools/price-agent.js starts writing rows.
// Loads in parallel with loadAssets() (init()'s Promise.all), so this also
// re-renders on its own completion - whichever of the two finishes second
// is the one that ends up with a correct render, same pattern
// renderRecurringCandidates() already uses for its own two parallel loads.
async function loadAssetPriceFindings() {
  if (!PRICE_FINDINGS_ENABLED) { assetPriceFindings = []; renderAssetPriceFindings(); return; }
  const [prices, headlines] = await Promise.all([
    fetchFindings("asset_price_findings", ASSET_PRICE_FINDING_COLS),
    fetchLatestHeadlines("asset_price_findings", ASSET_PRICE_FINDING_COLS),
  ]);
  assetPriceFindings = mergeFindings(prices, headlines);
  renderAssetPriceFindings();
}

// Same dormant-until-flag shape as loadAssetPriceFindings above, same
// PRICE_FINDINGS_ENABLED flag (one switch for "is the price-agent
// pipeline on," not a second flag for what's fundamentally the same
// pipeline just writing to a different table for a fixed index list).
async function loadMarketIndexFindings() {
  if (!PRICE_FINDINGS_ENABLED) { marketIndexFindings = []; renderMarketOverview(); return; }
  const [prices, headlines] = await Promise.all([
    fetchFindings("market_index_findings", PRICE_FINDING_COLS),
    fetchLatestHeadlines("market_index_findings", PRICE_FINDING_COLS),
  ]);
  marketIndexFindings = mergeFindings(prices, headlines);
  renderMarketOverview();
}

// Same dormant-until-flag shape as loadMarketIndexFindings above, same
// PRICE_FINDINGS_ENABLED flag - one switch for the whole dormant pipeline.
async function loadMarketNewsFindings() {
  if (!PRICE_FINDINGS_ENABLED) { marketNewsFindings = []; renderMarketOverview(); return; }
  const { data } = await sb.from("market_news_findings").select("*").gt("expires_at", new Date().toISOString());
  marketNewsFindings = data || [];
  renderMarketOverview();
}

// The stored daily recap (daily_recaps). Unlike the findings loaders
// above this is NOT gated by PRICE_FINDINGS_ENABLED: that flag gates the
// live-pricing pipeline, and a recap is a different thing - it is built
// entirely from data already in the database, makes no live call of its
// own, and stays readable even if live pricing were switched off. Only a
// handful of rows, newest first.
const RECAP_HISTORY_DAYS = 30;
async function loadDailyRecaps() {
  const { data } = await sb.from("daily_recaps")
    .select("trade_date,movers,breadth,index_moves,summary,generated_by")
    .order("trade_date", { ascending: false })
    .limit(RECAP_HISTORY_DAYS);
  dailyRecaps = data || [];
  renderDailyRecap();
}

// ---- LIVE PRICE REFRESH ----------------------------------------------------
// tools/price-agent.js's FAST_ONLY run writes real Finnhub prices every 15
// minutes, but init() read those tables exactly ONCE - so an installed
// home-screen icon left open (which is the normal case here, not an edge
// case: an iOS icon keeps its own storage container and a password session
// stays signed in for days) kept showing whatever it fetched at the last
// cold start. The data was never the stale part; the page was.
//
// Cheap by construction rather than by luck: a tick asks only for rows
// newer than the newest already in memory (~25 rows, a few kB), so this
// never re-runs the full initial 2-day query.
const LIVE_REFRESH_MS = 60000;
// Headlines land on only ~1 of every 4 agent runs and are much heavier per
// row than a price, so they get their own slower cadence instead of riding
// every tick.
const HEADLINE_REFRESH_MS = 15 * 60 * 1000;
let liveRefreshTimer = null;
let lastHeadlineRefresh = 0;

const newestFoundAt = (rows) =>
  rows.reduce((max, r) => (r.found_at && (!max || r.found_at > max) ? r.found_at : max), null);

function renderPriceDependentCards() {
  renderAssetPriceFindings();
  renderMarketOverview();
  renderInvestments();
}

// ---- LIVE QUOTE OVERLAY ----------------------------------------------------
// The findings tables are only ever as fresh as the server machine's
// 15-minute FAST_ONLY run, which is a real dependency on one Mac being
// awake. This asks worker.js's /api/quotes for the same symbols directly,
// so the numbers on screen are current to the minute and keep working even
// when that machine is off. The findings rows stay the fallback, and stay
// the only source of what a live quote doesn't carry - the weekly Gemini
// explanation and the real Finnhub headlines.
//
// Written into the SAME row shape the findings tables use, so every
// existing render path picks a quote up as "today's latest finding" for
// that symbol with no changes of its own. Tagged `live` so each tick
// REPLACES the previous overlay rather than appending to it: the findings
// tables are insert-only history on purpose, but this is a moving snapshot
// of right now, not a series worth keeping. Nothing here is ever written
// back to the database.
const ownedPriceSymbols = () => [...new Set(
  assets.filter((a) => a.price_symbol).map((a) => a.price_symbol.trim().toUpperCase())
)];
const indexPriceSymbols = () => [...new Set(
  [...MARKET_MOVERS_WATCHLIST, ...Object.values(MARKET_INDEX_ETF_PROXIES)]
)];

async function fetchLiveQuotes(symbols) {
  if (!symbols.length) return null;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.quotes || null;
  } catch {
    return null;
  }
}

// Two rows per symbol, not one. The live price is today's; Finnhub's own
// `previousClose` rides along on the same call and becomes a synthetic
// PRIOR-day row, which is what lets dailyFindingsForSymbol() derive an
// exact day change with no changes to any pure function. Without it the
// prior day would be whatever row the agent last happened to write, so a
// day the server machine was off would silently be presented as "today's"
// change against a two-day-old price.
//
// Stamped at the very end of the previous UTC day so it reliably wins that
// day's bucket (dailyFindingsForSymbol keeps each day's LATEST row, and a
// real agent row from late yesterday would otherwise outrank it).
function liveQuoteRows(quotes, symbols, stamp) {
  const prev = new Date(Date.parse(stamp) - 24 * 60 * 60 * 1000);
  prev.setUTCHours(23, 59, 59, 999);
  const prevStamp = prev.toISOString();
  const rows = [];
  for (const symbol of symbols) {
    const quote = quotes[symbol];
    if (!quote || quote.price == null) continue;
    rows.push({ symbol, price: quote.price, found_at: stamp, extracted_by: "finnhub", live: true });
    if (quote.previousClose != null) {
      rows.push({ symbol, price: quote.previousClose, found_at: prevStamp, extracted_by: "finnhub", live: true });
    }
  }
  return rows;
}

function applyLiveQuotes(quotes) {
  const stamp = new Date().toISOString();
  assetPriceFindings = mergeFindings(
    assetPriceFindings.filter((r) => !r.live),
    liveQuoteRows(quotes, ownedPriceSymbols(), stamp)
  );
  marketIndexFindings = mergeFindings(
    marketIndexFindings.filter((r) => !r.live),
    liveQuoteRows(quotes, indexPriceSymbols(), stamp)
  );
}

// Best-effort throughout: a failed refresh leaves the last-known prices on
// screen rather than blanking a card, the same non-fatal shape the loaders
// above and retrieveRelevantHistory() already have.
async function refreshLivePrices() {
  if (!PRICE_FINDINGS_ENABLED || !userId || document.hidden) return;
  // Market shut: no fetch at all, since a price genuinely cannot change
  // between the close and the next open - a tick could only ever re-read
  // the same last-close rows. Still re-renders, so the freshness lines
  // pick up "Market closed" at the bell instead of only at the next
  // navigation, and keep their "X ago" reading current.
  if (!marketStatus().open) { renderPriceDependentCards(); return; }
  try {
    const wantHeadlines = Date.now() - lastHeadlineRefresh > HEADLINE_REFRESH_MS;
    // newestFoundAt() is read BEFORE the overlay is reapplied below, and the
    // overlay's own rows are excluded from it - a synthetic row stamped
    // "now" would otherwise become the incremental cursor and permanently
    // hide every real agent row written after it.
    const assetSince = newestFoundAt(assetPriceFindings.filter((r) => !r.live));
    const indexSince = newestFoundAt(marketIndexFindings.filter((r) => !r.live));
    const [assetRows, indexRows, assetHeads, indexHeads, quotes] = await Promise.all([
      fetchFindings("asset_price_findings", ASSET_PRICE_FINDING_COLS, assetSince),
      fetchFindings("market_index_findings", PRICE_FINDING_COLS, indexSince),
      wantHeadlines ? fetchLatestHeadlines("asset_price_findings", ASSET_PRICE_FINDING_COLS) : [],
      wantHeadlines ? fetchLatestHeadlines("market_index_findings", PRICE_FINDING_COLS) : [],
      fetchLiveQuotes([...new Set([...ownedPriceSymbols(), ...indexPriceSymbols()])]),
    ]);
    if (wantHeadlines) lastHeadlineRefresh = Date.now();
    assetPriceFindings = mergeFindings(assetPriceFindings, assetRows, assetHeads);
    marketIndexFindings = mergeFindings(marketIndexFindings, indexRows, indexHeads);
    // Reapplied after the agent rows land, so the overlay always sits on
    // top of the freshest stored data rather than being merged underneath.
    if (quotes) applyLiveQuotes(quotes);
    renderPriceDependentCards();
  } catch {
    // Leave the existing prices and their honest "as of" reading in place.
  }
}

// Deliberately NOT scoped to the Investments view: the Log page's own
// "Live asset prices" card reads the same rows, and an incremental tick is
// cheap enough that gating it per-view would add branching for no real
// saving. Restarted rather than stacked, since renderAuth() can run init()
// again on a later auth-state change.
function startLiveRefresh() {
  if (liveRefreshTimer) clearInterval(liveRefreshTimer);
  liveRefreshTimer = setInterval(refreshLivePrices, LIVE_REFRESH_MS);
}

// A background tab has its timers throttled hard, so returning to the app
// after hours away needs its own immediate catch-up - this is the path that
// actually matters for an installed icon, where "reopening" never reloads
// the page.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLivePrices();
});

// A blank "None" first option, not just the real categories - so a select
// that's never been explicitly set (fCategory on a fresh Quick Add) starts
// genuinely empty rather than silently defaulting to CATEGORIES[0] ("Food")
// the way an <select> with no blank option always does. That default was
// masking category as a de-facto optional field: the saveBtn/editSave
// validation already checked `if (!category) return toast(...)`, but the
// check could never actually fire since the select could never BE empty.
// Every caller (fCategory, eCategory, bulkCategorySelect, budgetCategory)
// already has that same guard, so this one change makes "required" real
// everywhere at once rather than needing a per-caller fix. eCategory's own
// `.value = row.category ?? CATEGORIES[0]` (openEdit, below) still
// explicitly selects a real category for an existing expense regardless -
// an already-saved expense always has one, so it never lands on "None".
function fillCategorySelect(sel) {
  sel.innerHTML = `<option value="">None</option>` + CATEGORIES.map((c) => `<option>${c}</option>`).join("");
}

async function loadRules() {
  const { data } = await sb.from("category_rules").select("keyword,category");
  userRules = {};
  (data || []).forEach((r) => { userRules[r.keyword] = r.category; });
}

// ---- ACCOUNTS --------------------------------------------------------------
// Every supported account type, as a single
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

  medical_credit_card:    { label: "Medical / Deferred-Interest Card", category: "Credit accounts",     kind: "liability", linkType: "medical_credit_card" },

  personal_loan:          { label: "Personal Loan",               category: "Loans",                    kind: "liability", linkType: "personal_loan" },
  auto_loan:              { label: "Auto Loan",                   category: "Loans",                    kind: "liability", linkType: "auto_loan" },
  mortgage:               { label: "Mortgage",                    category: "Loans",                    kind: "liability", linkType: "mortgage" },
  home_equity_loan:       { label: "Home Equity Loan",            category: "Loans",                    kind: "liability", linkType: "home_equity_loan" },
  student_loan:           { label: "Student Loan",                category: "Loans",                    kind: "liability", linkType: "student_loan" },
  payday_loan:            { label: "Payday Loan",                 category: "Loans",                    kind: "liability", linkType: "payday_loan" },
  title_loan:             { label: "Title Loan",                  category: "Loans",                    kind: "liability", linkType: "title_loan" },
  credit_builder_loan:    { label: "Credit-Builder Loan",         category: "Loans",                    kind: "liability", linkType: "credit_builder_loan" },
  retirement_plan_loan:   { label: "Retirement Plan Loan",        category: "Loans",                    kind: "liability", linkType: "retirement_plan_loan" },

  // Traditional vs. Roth is the single most consequential split in this
  // whole table and it is NOT cosmetic: a traditional balance is pre-tax
  // (a future withdrawal owes income tax, so the number shown overstates
  // what the money is actually worth) while a Roth balance is post-tax
  // (qualified withdrawals owe nothing, so the number is what you keep).
  // Both still count into net worth at face value here, by design -
  // real account-type research backs why this is the honest default
  // rather than applying a guessed tax haircut.
  traditional_401k:       { label: "401(k) (Traditional)",        category: "Retirement & investment",  kind: "asset",     linkType: "traditional_401k" },
  roth_401k:              { label: "401(k) (Roth)",               category: "Retirement & investment",  kind: "asset",     linkType: "roth_401k" },
  plan_403b:              { label: "403(b)",                      category: "Retirement & investment",  kind: "asset",     linkType: "plan_403b" },
  plan_457b:              { label: "457(b)",                      category: "Retirement & investment",  kind: "asset",     linkType: "plan_457b" },
  traditional_ira:        { label: "Traditional IRA",             category: "Retirement & investment",  kind: "asset",     linkType: "traditional_ira" },
  roth_ira:               { label: "Roth IRA",                    category: "Retirement & investment",  kind: "asset",     linkType: "roth_ira" },
  sep_ira:                { label: "SEP IRA",                     category: "Retirement & investment",  kind: "asset",     linkType: "sep_ira" },
  simple_ira:             { label: "SIMPLE IRA",                  category: "Retirement & investment",  kind: "asset",     linkType: "simple_ira" },
  brokerage:              { label: "Brokerage",                   category: "Retirement & investment",  kind: "asset",     linkType: "brokerage" },
  espp:                   { label: "Employee Stock Purchase Plan",category: "Retirement & investment",  kind: "asset",     linkType: "espp" },
  pension:                { label: "Pension (Defined Benefit)",   category: "Retirement & investment",  kind: "asset",     linkType: "pension" },
  custodial_utma:         { label: "UTMA / UGMA Custodial",       category: "Retirement & investment",  kind: "asset",     linkType: "custodial_utma" },
  plan_529:               { label: "529 Plan",                    category: "Retirement & investment",  kind: "asset",     linkType: "plan_529" },
  tsp:                    { label: "Thrift Savings Plan (TSP)",   category: "Retirement & investment",  kind: "asset",     linkType: "tsp" },
  solo_401k:              { label: "Solo 401(k)",                 category: "Retirement & investment",  kind: "asset",     linkType: "solo_401k" },
  rollover_inherited_ira: { label: "Rollover / Inherited IRA",    category: "Retirement & investment",  kind: "asset",     linkType: "rollover_inherited_ira" },
  annuity:                { label: "Annuity",                     category: "Retirement & investment",  kind: "asset",     linkType: "annuity" },
  // Superseded by the split-out types above, kept so existing rows still
  // resolve to a readable label - see LEGACY_ACCOUNT_TYPES.
  retirement_employer:    { label: "401(k) / 403(b) / 457",       category: "Retirement & investment",  kind: "asset",     linkType: "retirement_employer" },
  ira:                    { label: "IRA (unspecified)",           category: "Retirement & investment",  kind: "asset",     linkType: "ira" },

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
  trust_account:          { label: "Trust Account",               category: "Specialty",                kind: "asset",     linkType: "trust_account" },
};
// Types that predate a finer-grained split and are no longer offered when
// creating something new, but must stay in ACCOUNT_TYPES so rows already
// stored against them still render a real label instead of a raw enum
// value. 'ira' and 'retirement_employer' were single buckets before
// Traditional/Roth/SEP/SIMPLE and 401(k)/403(b)/457 were split out above -
// the distinction is a genuine tax difference, not a naming preference, so
// new accounts should always pick the specific one. Hidden from the
// pickers only (populateAcctTypeSelect / populateAssetTypeSelect); every
// other code path treats them normally.
const LEGACY_ACCOUNT_TYPES = new Set(["ira", "retirement_employer"]);
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
// A medical/deferred-interest card (CareCredit and friends) is deliberately
// NOT here - it is a real card you hand over at a clinic or vet, so it
// belongs in the payment-method pickers exactly like a store card does.
// Every Retirement & investment type is excluded (you cannot swipe a Roth
// IRA), as is a trust account - a trustee may well have checkbook access in
// real life, but it is not this app's user's personal payment method.
const NON_SPENDABLE_ACCOUNT_TYPES = new Set([
  "cd",
  "personal_loan", "auto_loan", "mortgage", "home_equity_loan", "student_loan", "payday_loan", "title_loan",
  "credit_builder_loan", "retirement_plan_loan",
  "retirement_employer", "ira", "traditional_401k", "roth_401k", "plan_403b", "plan_457b",
  "traditional_ira", "roth_ira", "sep_ira", "simple_ira", "espp", "pension", "custodial_utma",
  "brokerage", "plan_529", "tsp", "solo_401k", "rollover_inherited_ira", "annuity",
  "coverdell_esa", "treasury_direct", "crypto", "life_insurance_cash_value", "trust_account",
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
// A fixed set, not free text - the allocation calculator (allocationVsTarget,
// investments.js) groups an asset/holding's investment_bucket against a
// investment_targets.bucket by exact string match, so a typo used to create
// a second, orphaned bucket a target could never match ("Stock" vs
// "Stocks"). Every picker that sets one of these values (the standalone
// Assets-card form, a holding, and the Target-allocation form itself) reads
// from this single list via populateInvestBucketSelects() below, so the
// three can never drift out of sync with each other. "Other" is the
// deliberate catch-all for anything not covered by the rest, rather than
// leaving no option for it.
const INVESTMENT_BUCKETS = ["Stocks", "Bonds", "Cash", "Crypto", "Real Estate", "Other"];
// A fixed list of major US indexes for the Investments tab's Market
// overview card - genuinely NOT derived from anything a user owns, unlike
// every other Investments config above. Must match tools/price-agent.js's
// own MARKET_INDEXES constant exactly (same strings, same order isn't
// required but the strings are what ties a market_index_findings row back
// to a row here) - that file has no import/export machinery to share this
// list from a single source, so the two are kept in sync by hand.
const MARKET_INDEXES = ["S&P 500", "Dow Jones Industrial Average", "NASDAQ Composite", "Russell 2000"];
// A live, Gemini-free stand-in for the exact index-point number above -
// added 2026-08-16 after confirming live that raw index tickers
// (^GSPC/^DJI/^IXIC/^RUT) require a paid Finnhub subscription ("Market
// data subscription required for CFD indices" - a real API response, not
// an assumption), but these four highly liquid, widely-tracked ETFs work
// on the free tier and closely track the same four indexes. Written to
// market_index_findings under the ETF's OWN ticker as `symbol`
// (tools/price-agent.js), deliberately never under the index's plain-
// English label - mixing an ETF's dollar price into the same day-series
// as the index's own point value would corrupt day-change math (a real,
// ~10x scale difference, not a rounding nuance). QQQ tracks the
// NASDAQ-100 specifically, not the full NASDAQ Composite - the closest
// free, liquid option, labeled honestly as such rather than implied to
// be an exact match. Must match tools/price-agent.js's own copy, kept in
// sync by hand for the same reason MARKET_INDEXES already is.
const MARKET_INDEX_ETF_PROXIES = { "S&P 500": "SPY", "Dow Jones Industrial Average": "DIA", "NASDAQ Composite": "QQQ", "Russell 2000": "IWM" };
// A fixed, curated watchlist of well-known large-cap stocks (not each
// user's own holdings) so the Investments tab can surface "today's biggest
// movers" even for a user who holds nothing at all - same "public market
// data, not tied to any user" category as MARKET_INDEXES above, and
// deliberately written to the SAME market_index_findings table rather than
// a new one, since that table's real meaning was always "public market
// data," not literally "indexes only." Must match tools/price-agent.js's
// own MARKET_MOVERS_WATCHLIST constant, kept in sync by hand for the same
// reason MARKET_INDEXES already is. Comprehensive-but-not-exhaustive by
// design (20 large caps across sectors) - the same honesty caveat as
// tickers.js/BANK_NAMES: this is a fixed watchlist, not a live scan of
// "every stock," since there's no $0 feed that could do that.
const MARKET_MOVERS_WATCHLIST = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "UNH",
  "XOM", "JNJ", "WMT", "PG", "MA", "HD", "DIS", "NFLX", "AMD", "KO",
];
// A plain flat list with no dependency on fetched data, unlike
// populateAcctTypeSelect/populateAssetTypeSelect/populateDebtTypeSelect
// (which lazily populate on first form-open) - safe to populate once,
// eagerly, at module load instead of needing a trigger per select.
// assetInvestBucket/holdingBucket get a blank "Not set" first option since
// a bucket is optional there (an investment asset can exist outside the
// allocation calculator entirely); investTargetBucket does not, since
// setting a target with no bucket chosen isn't a meaningful action.
function populateInvestBucketSelects() {
  const opts = INVESTMENT_BUCKETS.map((b) => `<option value="${b}">${b}</option>`).join("");
  $("assetInvestBucket").innerHTML = `<option value="">Not set</option>${opts}`;
  $("holdingBucket").innerHTML = `<option value="">Not set</option>${opts}`;
  $("investTargetBucket").innerHTML = opts;
}
populateInvestBucketSelects();
// BANK_NAMES (bankNames.js) is ~3,570 real FDIC-insured banks plus a few
// well-known credit unions/brands FDIC doesn't cover - not a hardcoded
// seed list anymore. isKnownBank() is a soft gate (saveAcctBtn below): a
// no-match asks for confirmation rather than blocking outright, since the
// list is comprehensive but not exhaustive - see saveAcctBtn's override.
// The datalist (rankBankMatches(), just below) is this same source made
// pickable and ranked instead of typed blind.
//
// Matching is deliberately loose, not exact-equals: official FDIC names
// are legal-entity names ("JPMorgan Chase Bank, National Association"),
// not brand names ("Chase") - a strict match would reject the name
// everyone actually uses. Both sides are reduced to the same normalized
// key first (bankKey), so the legal-entity noise that differs between what
// FDIC stores and what a person types stops mattering at all.
//
// Matching runs in BOTH directions, which the pre-dedup version could not
// safely do. Forward ("a real bank's name contains what was typed") catches
// "Chase". Reverse ("what was typed contains a real bank's name") is what
// keeps the deduplicated list from rejecting real input - BANK_NAMES now
// holds one canonical spelling per bank, so a charter-specific name typed
// verbatim ("Wells Fargo Bank South Central") only matches by finding the
// canonical "Wells Fargo Bank" inside it. The reverse direction was unsafe
// before purely because FDIC charters an institution literally named
// "BANK", which matched any made-up name containing that word; those
// generic-only entries are now dropped from the list outright, and the
// reverse direction additionally ignores any key that is nothing but
// generic banking words. Re-tested against real brands, full legal names,
// small community banks, and constructed gibberish ("Made Up Savings
// Bank", "Community Bank of Fakeville") before shipping - not just the
// happy path, which is what caught the original one-direction bug too.
const BANK_GENERIC_WORDS = new Set([
  "bank", "banks", "savings", "trust", "national", "first", "state",
  "community", "federal", "credit", "union", "financial", "of", "and",
  "the", "company", "co",
]);
const bankKey = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\b/, " ")
    .replace(/\b(national association|n a|inc|incorporated|ssb|fsb|llc|ltd|co|company|corporation|corp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const bankGenericOnly = (key) => {
  const tokens = key.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => BANK_GENERIC_WORDS.has(t));
};
// Word-boundary containment, not raw substring - so "American Bank" can't
// match inside "Pan American Bankers" on a partial word.
const containsWords = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);
const BANK_KEYS = BANK_NAMES.map(bankKey);
// Only keys distinctive enough to identify a bank on their own are allowed
// to match in the reverse direction.
const BANK_REVERSE_KEYS = BANK_KEYS.filter(
  (k) => k.length >= 8 && k.split(" ").length >= 2 && !bankGenericOnly(k)
);
// All ~3,570 FDIC-insured banks plus every bank_name a real account of
// this user's has ever used - kept as a plain array, not written to the
// DOM, since dumping all of it into the datalist at once produced the
// unusable wall of "Capital Bank" / "Capital Bank, National Association" /
// "Capital City Bank" / ... seen live when typing "capital" (native
// datalist shows every match, alphabetically, with no ranking or cap).
// Updated in loadAccounts(); read by rankBankMatches() below.
let knownBankNames = BANK_NAMES;

// Ranked, capped suggestions for the acctBank datalist - recomputed on
// every keystroke (see acctBank.oninput) rather than shown as one static
// list. A match whose normalized key STARTS WITH what was typed ("Chase"
// typing "chase") ranks above one where a later WORD starts with it
// ("JPMorgan Chase Bank" typing "chase"), which in turn ranks above a
// mid-word substring match; ties break toward the shorter, more
// brand-like spelling. Capped at 25 so the dropdown stays scannable
// instead of scrolling for a screen and a half.
function rankBankMatches(query, limit = 25) {
  const typed = bankKey(query);
  if (typed.length < 2) return [];
  const scored = [];
  for (const name of knownBankNames) {
    const key = bankKey(name);
    if (!key.includes(typed)) continue;
    const words = key.split(" ");
    const score = key.startsWith(typed) ? 0 : words.some((w) => w.startsWith(typed)) ? 1 : 2;
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
$("acctBank").oninput = () => {
  const matches = rankBankMatches($("acctBank").value);
  $("bankSuggestions").innerHTML = matches.map((b) => `<option value="${esc(b)}"></option>`).join("");
};

function isKnownBank(name) {
  const typed = bankKey(name);
  if (typed.length < 3) return false; // too short to mean anything either way
  const tokens = typed.split(" ").filter(Boolean);
  // A lone generic word ("bank") or a very short single token is not a name.
  if (tokens.length === 1 && (bankGenericOnly(typed) || typed.length < 5)) return false;
  if (BANK_KEYS.some((k) => containsWords(k, typed))) return true;
  return BANK_REVERSE_KEYS.some((k) => containsWords(typed, k));
}

// Exact match, not fuzzy - a ticker is a precise, case-sensitive-in-reality
// (normalized to uppercase here) code, unlike a bank's legal name, which is
// why this doesn't need isKnownBank's word-containment logic. Checks
// CRYPTO_SYMBOLS instead of the security lists specifically for a holding
// whose parent account is type 'crypto' (tickers.js's header comment
// explains why a crypto "ticker" isn't a market-issued security symbol and
// so isn't in the same list). See tickers.js's own header for the honesty
// caveat this function inherits: a false negative here does not mean the
// ticker isn't real, only that this hand-curated list doesn't have it -
// that's exactly why the caller (saveHoldingBtn) always offers a confirm-
// to-override path rather than a hard block, the same pattern isKnownBank's
// caller (saveAcctBtn) already established.
function isKnownTicker(symbol, parentType) {
  const typed = symbol.trim().toUpperCase();
  if (!typed) return false;
  const list = parentType === "crypto" ? CRYPTO_SYMBOLS : ALL_SECURITY_TICKERS;
  return list.includes(typed);
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
      .filter(([type, cfg]) => cfg.category === cat && !LEGACY_ACCOUNT_TYPES.has(type))
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

// The Accounts card has one "add" panel and three "edit an existing account"
// panels (adjust an asset balance, adjust what's owed, edit liability
// details), all of which render inline in the same card. Letting two sit
// open at once was genuinely confusing: tapping an account circle while the
// add form was open dropped its edit panel *below* the add form, so the
// screen showed a half-filled "Adding: Checking" form directly above an
// unrelated account's balance editor, with no indication which one a tap on
// Save would act on. Opening any one of them now closes the others, so the
// card only ever shows a single active form.
function closeAcctForm() {
  $("acctForm").classList.add("hidden");
}
function closeTransferForm() {
  $("transferForm").classList.add("hidden");
  $("transferAmount").value = "";
}
function closeAccountEditPanels() {
  closeAssetAdjust();
  closeDebtBalanceForm();
  closeDebtDetailsForm();
  closeTransferForm();
}
$("addAcctBtn").onclick = () => {
  const opening = $("acctForm").classList.contains("hidden");
  if (opening) closeAccountEditPanels();
  $("acctForm").classList.toggle("hidden");
  populateAcctTypeSelect();
  setAcctType("debit"); // every fresh open starts from the same visible state
};
$("transferBtn").onclick = () => {
  const opening = $("transferForm").classList.contains("hidden");
  if (opening) { closeAcctForm(); closeAccountEditPanels(); }
  $("transferForm").classList.toggle("hidden");
};
$("transferCancelBtn").onclick = closeTransferForm;
// Asset-to-asset only (see transferForm's own comment in index.html) -
// reuses assetDeltaError/applyAssetDelta exactly as Quick Add already
// does for an expense, just applied twice (once per leg) instead of
// once, since a transfer is symmetric rather than expense-shaped.
$("transferConfirmBtn").onclick = async () => {
  const amount = parseFloat($("transferAmount").value);
  if (!amount || amount <= 0) { flagField("transferAmount"); return toast("Enter a valid amount"); }
  const fromId = $("transferFrom").value;
  const toId = $("transferTo").value;
  if (!fromId) { flagField("transferFrom"); return toast("Choose an account to transfer from"); }
  if (!toId) { flagField("transferTo"); return toast("Choose an account to transfer to"); }
  const fromAccount = accounts.find((a) => a.id === fromId);
  const toAccount = accounts.find((a) => a.id === toId);
  if (!fromAccount || !toAccount) { flagField(["transferFrom", "transferTo"]); return toast("Choose valid accounts"); }
  // Compares the underlying ASSET, not just the account id - two accounts
  // could in principle point at the same asset, and two applyAssetDelta
  // calls against the same asset would net to zero silently instead of
  // erroring.
  if (fromAccount.linked_asset_id === toAccount.linked_asset_id) {
    flagField(["transferFrom", "transferTo"]);
    return toast("Choose two different accounts");
  }
  const err = assetDeltaError([{ accountId: fromId, amount, sign: -1 }]);
  if (err) { flagField("transferFrom"); return toast(err); }

  await applyAssetDelta(fromId, null, amount, -1);
  await applyAssetDelta(toId, null, amount, +1);
  await logActivity(
    "transfer", `Transferred ${fmt(amount)} from ${acctName(fromId)} to ${acctName(toId)}`,
    amount, undefined, fromId, toId
  );
  closeTransferForm();
  await loadAssets();
  renderRecentTransactions();
  toast("Transfer recorded");
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
  if (!bank_name) { flagField("acctBank"); return toast(`${bankLabel} name required`); }
  // isKnownBank() checks against ~3,570 real FDIC-insured banks plus a
  // handful of well-known non-FDIC brands - comprehensive, but genuinely
  // not exhaustive (a small credit union, a newer neobank, a foreign
  // bank). A no-match is no longer a hard stop: it's a confirmation, the
  // same "are you sure" bar as any other deliberate override in this app,
  // rather than a wall with no way through for someone who typed a real
  // name we just don't carry.
  if (BANK_VALIDATED_TYPES.has(type) && !isKnownBank(bank_name)) {
    const ok = await confirmModal(
      `"${bank_name}" isn't in our list of FDIC-insured banks and well-known credit unions. If this is a real bank or credit union we're just missing, you can add it as typed.`,
      { title: "Bank not recognized", confirmLabel: "Add anyway" }
    );
    if (!ok) return;
  }

  let linked_asset_id = null;
  let linked_liability_id = null;
  let autoMsg = null;
  if (AUTO_LIABILITY_TYPE[type]) {
    const { data: newDebt, error: debtErr } = await sb.from("liabilities")
      .insert({ name: bank_name, type: AUTO_LIABILITY_TYPE[type], balance: 0 })
      .select().single();
    if (debtErr) { flagField("acctBank"); return toast(debtErr.message); }
    linked_liability_id = newDebt.id;
    autoMsg = "Account added - linked to a new $0 balance liability";
  } else if (AUTO_ASSET_TYPE[type]) {
    const { data: newAsset, error: assetErr } = await sb.from("assets")
      .insert({ name: bank_name, type: AUTO_ASSET_TYPE[type], value: 0 })
      .select().single();
    if (assetErr) { flagField("acctBank"); return toast(assetErr.message); }
    linked_asset_id = newAsset.id;
    autoMsg = "Account added - linked to a new $0 asset, edit its value below";
  }

  const { data: newAccount, error } = await sb.from("accounts")
    .insert({ name, bank_name, type, linked_asset_id, linked_liability_id })
    .select().single();
  if (error) { flagField("acctBank"); return toast(error.message); }
  // Opening an account is the one history entry that moves no money - it's
  // there so the log can explain where an account came from, rather than a
  // balance appearing to materialise from nowhere. Amount 0, no undo (see
  // NON_UNDOABLE_ACTIVITY_KINDS).
  await logActivity(
    "account_created", `Opened ${bank_name} ${name}`, 0, undefined, newAccount.id
  );
  $("acctBank").value = ""; $("acctForm").classList.add("hidden");
  // loadAccounts first - loadDebts reads `accounts` to know which
  // liabilities are now account-linked (hides their delete button).
  await loadAccounts(); await loadAssets(); await loadDebts();
  renderRecentTransactions(); // surface the account_created row straight away
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
  // of relying on null/empty-string sorting first. Archived accounts are
  // excluded entirely (not sorted last and dimmed, as they used to be) -
  // see the archived modal below.
  const sorted = accounts.filter((a) => !a.archived_at).sort((a, b) => {
    if (a.type === "cash") return -1;
    if (b.type === "cash") return 1;
    return (a.bank_name || "").localeCompare(b.bank_name || "") || a.name.localeCompare(b.name);
  });
  renderArchivedAccounts();
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
        const styleAttr = clickAttr ? ` style="cursor:pointer"` : "";
        return `
      <div class="acct-circle-item" ${clickAttr}${styleAttr}>
        <div class="acct-circle" style="background:${ACCT_COLORS[i % ACCT_COLORS.length]}">${a.type === "cash" ? "💵" : esc((bankLabel.trim()[0] || "?").toUpperCase())}</div>
        ${a.type === "cash" ? "" : `<span class="x" data-del-acct="${a.id}">✕</span>`}
        <div class="name">${esc(bankLabel)}</div>
        <div class="type">${a.name}</div>
        ${balance != null ? `<div class="balance">${a.linked_liability_id ? "Owed " : ""}${fmt(balance)}</div>` : ""}
        ${a.type === "cash" ? "" : `<div class="muted" data-archive-acct="${a.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-top:2px">Archive</div>`}
      </div>`;
      }).join("")
    : `<p class="muted" style="font-size:13px">No accounts yet.</p>`;
  // Archive - reversible, unlike deleteAccount above. The DB row (archived_
  // at timestamp only) is all that changes here; the linked asset/liability
  // itself is left completely untouched (22_account_archive.sql) so
  // Unarchive can bring back the exact same balance. It DOES change what's
  // DISPLAYED, though: net worth and every asset/liability listing treat an
  // archived account as if deleted (topLevelAssets/countableDebts) - see
  // archivedAccountAssetIds' comment for the reasoning. Only one direction
  // here now: this list holds active accounts only, so unarchiving lives in
  // the archived modal instead (renderArchivedAccounts).
  document.querySelectorAll("[data-archive-acct]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const { error } = await sb.from("accounts")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", el.dataset.archiveAcct);
      if (error) return toast(error.message);
      await loadAccounts();
      toast("Account archived");
    };
  });
  // delete handlers - expenses keep their history (account_id -> null on delete, per schema)
  // Cash has no delete affordance - it's auto-managed (ensureCashAccount), use
  // the +/- adjust form instead of removing it.
  document.querySelectorAll("[data-del-acct]").forEach((el) => {
    el.onclick = async (ev) => { ev.stopPropagation(); await deleteAccount(el.dataset.delAcct); };
  });
  document.querySelectorAll("[data-adjust-acct]").forEach((el) => {
    el.onclick = () => openAssetAdjust(el.dataset.adjustAcct);
  });
  document.querySelectorAll("[data-adjust-liability]").forEach((el) => {
    el.onclick = () => openDebtBalanceForm(el.dataset.adjustLiability, "paying");
  });
}

// Shared by the main Accounts card's "✕" and the Archived-accounts modal's
// Delete button below - same cascading DB-trigger delete (12_delete_
// liability_with_account.sql / 13_delete_asset_with_account.sql), same
// confirmation, same refresh. Unlike archiving, this is permanent: a linked
// liability or asset is deleted along with the account, and its past
// expenses are unassigned (account_id -> null on delete, per schema), not
// preserved the way an archived account's history stays intact. Returns
// whether the delete actually happened, so a caller that needs to react
// (none currently do beyond the shared refresh here) can tell a cancel
// apart from a failure.
async function deleteAccount(acctId) {
  const acct = accounts.find((a) => a.id === acctId);
  const msg = acct?.linked_liability_id
    ? "Its linked liability and tracked balance are deleted too, and existing expenses become unassigned. This can't be undone."
    : acct?.linked_asset_id
    ? "Its linked asset and balance are deleted too, and existing expenses become unassigned. This can't be undone."
    : "Existing expenses become unassigned. This can't be undone.";
  const label = acct ? (acct.bank_name || acct.name) : "this account";
  if (!(await confirmModal(msg, { title: `Delete ${label}?` }))) return false;
  const { error } = await sb.from("accounts").delete().eq("id", acctId);
  if (error) { toast(error.message); return false; }
  // loadAssets/loadDebts refresh so a deleted linked asset or liability
  // disappears from its own card too, not just the account from its own;
  // loadAccounts refreshes both the main circle list and the archived
  // modal (renderAccountsList calls renderArchivedAccounts).
  await loadAccounts(); await loadExpenses(); await loadAssets(); await loadDebts();
  toast("Account deleted");
  return true;
}

// Archived accounts live only here, behind the Accounts card's "View
// archived" link - keeping them in the main circle list crowded out the
// accounts actually in use, since a closed account is never deleted (it's
// still fully recoverable via Unarchive). Listed as plain rows rather than
// circles: this is a recovery/cleanup screen, not something to browse, and
// the actions are Unarchive (bring it back exactly as it was) or Delete
// (permanent - deleteAccount above).
//
// While archived, its linked asset/liability is excluded from every
// listing and total (Assets/Liabilities cards, net worth, Investments tab -
// see archivedAccountAssetIds/archivedAccountLiabilityIds) even though the
// row itself, and every past expense/account_activity referencing this
// account, stays fully intact - that's the "acts deleted, but recoverable
// and history-preserving" behavior this whole feature is for. The balance
// shown here is read directly, bypassing that exclusion, since a recovery
// screen is exactly where you'd want to see what unarchiving would bring
// back.
function renderArchivedAccounts() {
  const archived = accounts.filter((a) => a.archived_at);
  const toggle = $("archivedAcctToggle");
  toggle.classList.toggle("hidden", archived.length === 0);
  toggle.textContent = `View archived (${archived.length})`;
  if (!archived.length) {
    $("archivedAcctModal").classList.add("hidden"); // last one unarchived while open
    return;
  }
  $("archivedAcctList").innerHTML = archived
    .sort((a, b) => (a.bank_name || "").localeCompare(b.bank_name || "") || a.name.localeCompare(b.name))
    .map((a) => {
      const balance = a.linked_asset_id
        ? assets.find((x) => x.id === a.linked_asset_id)?.value
        : a.linked_liability_id
        ? debts.find((x) => x.id === a.linked_liability_id)?.balance
        : null;
      return `
      <div class="exp" style="cursor:default">
        <div>
          <div>${esc(a.bank_name || a.name)}</div>
          <div class="meta">${esc(a.name)}${balance != null ? ` · ${a.linked_liability_id ? "Owed " : ""}${fmt(balance)}` : ""}</div>
        </div>
        <span class="amt">
          <button class="secondary" data-unarchive-acct="${a.id}" style="width:auto;padding:4px 10px;font-size:12px;margin-right:6px">Unarchive</button>
          <button class="secondary" data-delete-archived-acct="${a.id}" style="width:auto;padding:4px 10px;font-size:12px;color:var(--err);border-color:var(--err)">Delete</button>
        </span>
      </div>`;
    }).join("");
  document.querySelectorAll("[data-unarchive-acct]").forEach((el) => {
    el.onclick = async () => {
      const { error } = await sb.from("accounts").update({ archived_at: null }).eq("id", el.dataset.unarchiveAcct);
      if (error) return toast(error.message);
      await loadAccounts();
      toast("Account unarchived");
    };
  });
  // deleteAccount() already refreshes and re-renders this list (via
  // loadAccounts -> renderAccountsList -> renderArchivedAccounts), and
  // closes the modal itself once the archived list is empty - no extra
  // handling needed here beyond triggering the shared delete.
  document.querySelectorAll("[data-delete-archived-acct]").forEach((el) => {
    el.onclick = async () => { await deleteAccount(el.dataset.deleteArchivedAcct); };
  });
}
$("archivedAcctToggle").onclick = () => $("archivedAcctModal").classList.remove("hidden");
$("archivedAcctClose").onclick = () => $("archivedAcctModal").classList.add("hidden");

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
  $("holdingFundingAccount").innerHTML = opts;
  // Deliberately NOT the spendable list above - Transfer needs an
  // asset-backed account specifically (applyAssetDelta/assetDeltaError
  // are silent no-ops for a credit/liability-linked one, which the
  // spendable list above intentionally includes) - see transferForm's
  // own comment in index.html for why this would otherwise be a real,
  // silent balance-not-actually-changing bug.
  const transferable = accounts.filter((a) => a.linked_asset_id && !a.archived_at);
  const transferOpts = `<option value="">Choose an account</option>` + transferable.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("");
  $("transferFrom").innerHTML = transferOpts;
  $("transferTo").innerHTML = transferOpts;
  // Same asset-backed-only reasoning as Transfer above - an income
  // deposit needs a real linked_asset_id to actually apply via
  // applyAssetDelta, which a credit-type account never has.
  $("incAccount").innerHTML = `<option value="">None</option>` + transferable.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("");
  // A previously-typed bank_name (including one added via the "not
  // recognized, add anyway" override in saveAcctBtn) becomes just as
  // suggestable as a seeded FDIC name next time - rankBankMatches reads
  // this, the datalist itself is populated per-keystroke, not here.
  knownBankNames = [...new Set([...BANK_NAMES, ...accounts.map((a) => a.bank_name).filter(Boolean)])];
  $("bankSuggestions").innerHTML = "";
  populateTxnTypeFilter();
  populateTxnAccountFilter();
}

// Shared by all four Recent History filters below - rebuilds a
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
      .filter(([type, cfg]) => cfg.category === cat && cfg.kind === "asset" &&
        !ACCOUNT_ONLY_SPECIALTY_TYPES.has(type) && !LEGACY_ACCOUNT_TYPES.has(type))
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
  if (!name) { flagField("assetName"); return toast("Asset name required"); }
  if (!Number.isFinite(value)) { flagField("assetValue"); return toast("Enter a value"); }
  if (type === "cash") { flagField("assetType"); return toast("Cash is automatic - use the Cash account's +/- panel instead."); }
  if (type === "bank") { flagField("assetType"); return toast("Bank assets come from a Checking account - add one in the Accounts card instead."); }

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
  if (error) { flagField("assetName"); return toast(error.message); }
  const wasEditing = !!editingAsset;
  closeAssetForm();
  await loadAssets(); toast(wasEditing ? "Asset updated" : "Asset added");
};

// CD is the only asset type with a maturity date today - reuses
// subscriptions.js's daysUntil/renewalLabel rather than duplicating date
// math; those two are generic day-delta helpers, not actually
// subscription-specific despite living in that file.
function upcomingMaturities(withinDays = 30, today = new Date()) {
  const hidden = archivedAccountAssetIds();
  return assets
    .filter((a) => a.type === "cd" && a.maturity_date && !hidden.has(a.id))
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
  const hidden = archivedAccountAssetIds();
  return assets
    .filter((a) => a.type !== "cash" && a.type !== "bank" && a.updated_at && !hidden.has(a.id))
    .filter((a) => !(a.type === "vehicle" && estimateValue(a.purchase_price, a.purchase_date, a.depreciation_rate) !== null))
    .map((a) => ({ ...a, monthsSince: Math.floor((today - new Date(a.updated_at)) / (30.44 * 86400000)) }))
    .filter((a) => a.monthsSince >= monthsThreshold)
    .sort((a, b) => b.monthsSince - a.monthsSince);
}

// An archived account is treated as functionally deleted everywhere assets
// or liabilities are LISTED or SUMMED (Assets/Liabilities cards, net worth,
// Investments tab), while its linked asset/liability row - and every
// expense/account_activity row that references the account - stays in the
// database exactly as it was. That's the difference from an actual delete:
// archiving is reversible (Unarchive brings back the same balance, unlike a
// real delete's DB-trigger cascade), and history stays fully resolvable
// (acctName() etc. read the raw `accounts` array, unfiltered by archived
// status, on purpose). Reversed 2026-08-12 at explicit user request - see
// 22_account_archive.sql's original "archiving never changes net worth"
// comment, which this supersedes.
//
// A lookup by a specific known id (undo, editing a history row's label,
// Pay/Edit-details reached from a form already open on that row)
// deliberately does NOT filter through these - those operate on a row the
// user is already looking at or a past transaction that must stay
// resolvable regardless of the account's current archived state. Only the
// listing/summing call sites below do.
function archivedAccountAssetIds() {
  const archivedParents = new Set(
    accounts.filter((a) => a.archived_at && a.linked_asset_id).map((a) => a.linked_asset_id)
  );
  // A holding nested inside an archived parent (40_asset_holdings.sql) has
  // no linked_asset_id of its own - hidden via its parent's id here, not a
  // separate check, so archiving hides the whole position list at once,
  // not just the summary line.
  const ids = new Set(archivedParents);
  for (const a of assets) if (a.parent_asset_id && archivedParents.has(a.parent_asset_id)) ids.add(a.id);
  return ids;
}
function archivedAccountLiabilityIds() {
  return new Set(accounts.filter((a) => a.archived_at && a.linked_liability_id).map((a) => a.linked_liability_id));
}
// The liabilities-table counterpart to topLevelAssets, below - every
// summing/listing call site (net worth, the Liabilities card) goes through
// this.
function countableDebts() {
  const hidden = archivedAccountLiabilityIds();
  return debts.filter((d) => !hidden.has(d.id));
}

// Assets that stand on their own, i.e. everything except per-ticker holdings
// nested inside an investment account (40_asset_holdings.sql). A holding's
// value belongs to its parent account and is counted there, so anywhere that
// totals or lists "your assets" must go through this rather than the raw
// `assets` array - net worth, the Assets card, and the snapshot writer all
// do. The Investments tab is the deliberate exception: it wants the
// individual positions, which is the entire point of the tab. Also drops
// anything belonging to an archived account - see archivedAccountAssetIds
// above.
function topLevelAssets() {
  const hidden = archivedAccountAssetIds();
  return assets.filter((a) => !a.parent_asset_id && !hidden.has(a.id));
}
// Holdings roll up: an investment account is worth the sum of the positions
// inside it. Written back to the parent's own `value` rather than computed
// on the fly so that every existing reader (the account circle's balance
// line, net worth, the trend snapshots, the Assets card) keeps working off
// the same single column it always has, with no idea holdings exist.
async function syncParentAssetValue(parentAssetId) {
  if (!parentAssetId) return;
  const holdings = assets.filter((a) => a.parent_asset_id === parentAssetId);
  if (!holdings.length) return; // last holding removed - leave the manual value alone
  const priced = investmentHoldings(holdings, assetPriceFindings);
  const total = holdings.reduce((sum, h) => {
    const live = priced.find((p) => p.asset.id === h.id);
    return sum + (live ? live.currentValue : Number(h.value || 0));
  }, 0);
  await sb.from("assets").update({ value: Math.round(total * 100) / 100 }).eq("id", parentAssetId);
}

// Runs syncParentAssetValue for every parent with holdings, not just the
// one being actively edited - this is what makes Net Worth/the Assets
// card/the net-worth trend chart pick up a background price-agent.js
// refresh on the next app open, instead of only ever seeing a live price
// at the moment someone happens to open a holding's edit form. Each
// parent's sync targets a distinct row with no interdependency, so these
// run in parallel; one trailing loadAssets() (mirroring saveHoldingBtn's
// own pattern) pulls the resynced values into memory and re-renders.
async function syncAllParentAssetValues() {
  const parentIds = new Set(assets.filter((a) => a.parent_asset_id).map((a) => a.parent_asset_id));
  if (!parentIds.size) return;
  await Promise.all([...parentIds].map((id) => syncParentAssetValue(id)));
  await loadAssets();
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
  const listedAssets = topLevelAssets(); // holdings show on the Investments tab, not here
  $("assetsList").innerHTML = listedAssets.length
    ? listedAssets.map((a) => `
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
  // listedAssets already excludes an archived account's asset (topLevelAssets)
  // - you can't pay a liability down from an account that's been archived.
  const payableAssets = listedAssets.filter((a) => linkedAssetIds.has(a.id));
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
  renderPricesAsOf("assetPriceFindingsFreshness", latestFinnhubRefresh(assetPriceFindings));

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
      const parentsToSync = new Set();
      for (const asset of targets) {
        if (!asset.quantity) { toast(`Set a quantity for ${asset.name} first`); continue; }
        const newValue = Math.round(Number(finding.price) * Number(asset.quantity) * 100) / 100;
        const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
        if (error) { toast(error.message); continue; }
        applied++;
        // A holding's own .value is never read by anything on its own -
        // only the parent account's rolled-up value matters for net worth
        // - without this, "Apply" on a holding looked
        // successful but changed nothing anywhere.
        if (asset.parent_asset_id) parentsToSync.add(asset.parent_asset_id);
      }
      for (const parentId of parentsToSync) await syncParentAssetValue(parentId);
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
// Expenses already show up in Recent History since they're rows in
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
const ACTIVITY_LABEL = {
  asset_adjust: "Balance update",
  liability_payment: "Debt payment",
  owed_adjust: "Owed correction",
  account_created: "Account opened",
  contribution: "Contribution",
  transfer: "Transfer",
  income: "Income received",
};
// The one activity kind that moves no money and so has nothing to reverse -
// "undoing" it would mean deleting the account, which is what the Accounts
// card's own delete button is for. renderExpenseList checks this to decide
// whether a row gets an undo affordance at all.
const NON_UNDOABLE_ACTIVITY_KINDS = new Set(["account_created"]);

async function loadAccountActivity() {
  const since = lastMonths(12)[0] + "-01";
  const { data } = await sb.from("account_activity").select("*")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false }).order("created_at", { ascending: false });
  accountActivity = data || [];
}

// accountId is the account whose own balance changed (required, so this
// always shows up when filtering Recent History by that account -
// omitting it was a real bug caught live: adjusting Cash's balance didn't
// show up when filtering by the Cash account, since nothing recorded
// which account it was). relatedAccountId is only for a liability_payment
// where the liability itself is account-linked (a credit card), so the
// payment also shows up when filtering by the card, not just the account
// the money came from. liabilityId is the liability actually paid down -
// needed for undoActivity() to find a STANDALONE liability (no linked
// account, so relatedAccountId is null for it) well enough to reverse it.
// assetId (trailing, optional) is for 'contribution' rows specifically -
// most investment assets are standalone (STANDALONE_ONLY_ASSET_CATEGORIES),
// no linked account at all, so accountId alone can't say WHICH investment
// asset a contribution belongs to. See 42_contribution_tracking.sql.
async function logActivity(kind, description, amount, occurred_at, accountId, relatedAccountId = null, liabilityId = null, assetId = null) {
  const rounded = Math.round(Number(amount) * 100) / 100;
  // A zero amount normally means nothing actually changed (a "set" to the
  // same value), so there is nothing worth a history row. account_created is
  // the deliberate exception - it is an audit breadcrumb, not a money
  // movement, so its amount is always 0 and it must still be recorded.
  if (!rounded && kind !== "account_created") return;
  const { error } = await sb.from("account_activity").insert({
    kind, description, amount: rounded, occurred_at: occurred_at || new Date().toISOString().slice(0, 10),
    account_id: accountId, related_account_id: relatedAccountId, liability_id: liabilityId, asset_id: assetId,
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
  closeAcctForm(); closeTransferForm(); // never leave the add-account/transfer panels stacked behind this
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
  if (!amount || amount <= 0) { flagField("adjustAmount"); return toast("Enter a valid amount"); }
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  const newValue = Math.round((Number(asset.value) + amount) * 100) / 100;
  const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
  if (error) { flagField("adjustAmount"); return toast(error.message); }
  $("adjustAmount").value = "";
  await logActivity("asset_adjust", `Added ${fmt(amount)} to ${asset.name}`, amount, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Added");
};

$("adjustSubtractBtn").onclick = async () => {
  const amount = parseFloat($("adjustAmount").value);
  if (!amount || amount <= 0) { flagField("adjustAmount"); return toast("Enter a valid amount"); }
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  if (amount > Number(asset.value)) { flagField("adjustAmount"); return toast("Balance can't go negative - not enough in " + asset.name); }
  const newValue = Math.round((Number(asset.value) - amount) * 100) / 100;
  const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
  if (error) { flagField("adjustAmount"); return toast(error.message); }
  $("adjustAmount").value = "";
  await logActivity("asset_adjust", `Subtracted ${fmt(amount)} from ${asset.name}`, -amount, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Subtracted");
};

$("adjustSetBtn").onclick = async () => {
  const newValue = parseFloat($("adjustNewBalance").value);
  if (!Number.isFinite(newValue)) { flagField("adjustNewBalance"); return toast("Enter a valid balance"); }
  if (newValue < 0) { flagField("adjustNewBalance"); return toast("Balance can't go negative"); }
  const asset = assets.find((a) => a.id === adjustingAssetId);
  if (!asset) return;
  const rounded = Math.round(newValue * 100) / 100;
  const oldValue = Number(asset.value);
  const { error } = await sb.from("assets").update({ value: rounded }).eq("id", asset.id);
  if (error) { flagField("adjustNewBalance"); return toast(error.message); }
  await logActivity("asset_adjust", `Set ${asset.name} balance to ${fmt(rounded)}`, rounded - oldValue, undefined, adjustingAccountId);
  await loadAssets(); renderRecentTransactions(); closeAssetAdjust(); toast("Balance updated");
};

// A date the user sees and acts on manually, not something that auto-
// converts or auto-reminds beyond the notice in loadAssets() below -
// consistent with this app's general preference for explicit user action
// over automatic mutation of financial data (see CD in ROADMAP.md).
$("adjustMaturitySaveBtn").onclick = async () => {
  if (!adjustingAssetId) return;
  const maturity_date = $("adjustMaturityDate").value || null;
  const { error } = await sb.from("assets").update({ maturity_date }).eq("id", adjustingAssetId);
  if (error) { flagField("adjustMaturityDate"); return toast(error.message); }
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
  if (!name) { flagField("debtName"); return toast("Liability name required"); }
  if (!Number.isFinite(balance)) { flagField("debtBalance"); return toast("Enter a balance"); }
  const row = {
    name, type, balance,
    interest_rate: $("debtRate").value ? parseFloat($("debtRate").value) : null,
    minimum_payment: $("debtMinPay").value ? parseFloat($("debtMinPay").value) : null,
    due_date: $("debtDue").value || null,
  };
  const { error } = await sb.from("liabilities").insert(row);
  if (error) { flagField("debtName"); return toast(error.message); }
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

// Liability types with a real grace period - the ones where paying the
// statement balance in full by the due date means no interest at all, which
// is what creditCycle.js's math assumes. A HELOC, personal line of credit or
// overdraft line is deliberately excluded: those accrue interest from the day
// they are drawn, with no grace period to lose, so showing a "pay in full to
// avoid interest" status against them would state something untrue. BNPL is
// excluded for the same reason from the other direction - a typical pay-in-4
// plan has its own fixed instalment schedule rather than a revolving cycle.
// Per-type, not per-category, same rule as BANK_VALIDATED_TYPES.
const GRACE_PERIOD_LIABILITY_TYPES = new Set([
  "credit_card", "charge_card", "secured_credit_card", "store_card", "medical_credit_card",
]);

// Liability types where "credit limit" is a real, revolving ceiling the
// balance sits against - what credit utilization (balance / limit) is
// computed from below. Deliberately NOT the same set as
// GRACE_PERIOD_LIABILITY_TYPES: a HELOC/personal line of credit/overdraft
// line has no grace period (interest above) but absolutely has a credit
// limit, while a charge card has a grace period but, by definition, no
// preset spending limit at all ("no preset spending limit" is the
// traditional charge card's whole distinguishing feature) - so it's
// excluded here for the opposite reason it's included there. BNPL is
// excluded too: a pay-in-4 plan has a fixed installment amount for that one
// purchase, not a revolving limit you utilize a percentage of. Per-type,
// not per-category, same rule as BANK_VALIDATED_TYPES/GRACE_PERIOD_
// LIABILITY_TYPES above.
const CREDIT_LIMIT_LIABILITY_TYPES = new Set([
  "credit_card", "secured_credit_card", "store_card", "medical_credit_card",
  "personal_line_of_credit", "heloc", "overdraft_line",
]);

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
  // Plain balance/limit math, no judgment attached - shown once both are
  // set (CREDIT_LIMIT_LIABILITY_TYPES), same "stored but unused until now"
  // shape as interest_rate/minimum_payment above. Deliberately no color
  // threshold or "aim for under 30%" framing: that's a real, commonly-cited
  // credit-scoring guideline, but stating it here would edge from "show the
  // math" into advice, the same line the Investments tab's allocation
  // calculator already refuses to cross for what to buy.
  const utilizationLine = (d) => {
    if (!CREDIT_LIMIT_LIABILITY_TYPES.has(d.type) || d.credit_limit == null || !d.credit_limit) return "";
    const pct = Math.round((Number(d.balance) / Number(d.credit_limit)) * 100);
    return `<div class="meta">${fmt(d.balance)} of ${fmt(d.credit_limit)} limit used (${pct}%)</div>`;
  };
  // The plain-language version of creditCycle.js's three end-of-cycle
  // outcomes. Deliberately explicit that paying the minimum does not stop
  // interest - that misunderstanding is the whole reason this exists, so the
  // wording says so outright rather than just showing a number.
  const cycleLine = (d) => {
    if (!GRACE_PERIOD_LIABILITY_TYPES.has(d.type)) return "";
    const s = cycleStatus(d, accountActivity);
    if (s.state === "no_cycle") return "";
    if (s.state === "no_statement") {
      return `<div class="meta">Statement due ${s.dueDate} - add a statement balance in Edit details to track interest</div>`;
    }
    const interest = s.interestEstimate != null
      ? ` Interest so far about ${fmt(s.interestEstimate)}/mo at ${d.interest_rate}% APR.` : "";
    const logBtn = s.interestEstimate
      ? `<span class="muted" data-log-interest="${d.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-left:6px">Log interest charge</span>` : "";
    if (s.state === "paid_in_full") {
      return `<div class="meta" style="color:var(--ok)">Statement paid in full - no interest this cycle</div>`;
    }
    if (s.state === "due_soon") {
      return `<div class="meta">${fmt(s.remaining)} of the ${fmt(s.statementBalance)} statement still unpaid, due ${s.dueDate} (${s.daysUntilDue}d). Pay it all to avoid interest.</div>`;
    }
    if (s.state === "carrying_balance") {
      return `<div class="meta" style="color:var(--err)">Carrying ${fmt(s.remaining)} past the ${s.dueDate} due date - interest applies even though the minimum was paid.${interest}${logBtn}</div>`;
    }
    return `<div class="meta" style="color:var(--err)">Under the ${fmt(s.minimum)} minimum by the ${s.dueDate} due date - interest applies and a late fee is likely.${interest}${logBtn}</div>`;
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
        ${utilizationLine(d)}
        ${cycleLine(d)}
        <div class="muted" data-edit-debt="${d.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-top:2px">Edit details</div>
      </div>
      <span class="amt">
        ${linkedDebtIds.has(d.id) ? "" : `<button class="secondary" data-add-debt="${d.id}" style="width:auto;padding:4px 10px;font-size:12px;margin-right:6px">+</button>`}
        <button class="secondary" data-pay-debt="${d.id}" style="width:auto;padding:4px 10px;font-size:12px;margin-right:8px">Pay</button>
        ${fmt(d.balance)}${linkedDebtIds.has(d.id) ? "" : `<span class="x" data-del-debt="${d.id}" style="margin-left:8px">✕</span>`}
      </span>
    </div>`;
  };
  // An archived credit account's liability disappears from this card
  // entirely, same as a real delete would - countableDebts() drops it. A
  // standalone liability (otherDebts) is never affected, since archiving is
  // account-scoped and a standalone liability has no account to archive.
  const visibleDebts = countableDebts();
  const creditDebts = visibleDebts.filter((d) => linkedDebtIds.has(d.id));
  const otherDebts = visibleDebts.filter((d) => !linkedDebtIds.has(d.id));
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
  // Never automatic. An interest charge is real money added to what is owed,
  // so it goes through the same confirm-then-log path a person would use for
  // any other charge, lands in the history as an undoable row, and shows the
  // exact figure before it is applied. Auto-accruing it on a timer was
  // considered and rejected: nothing here runs on a schedule (static PWA, no
  // server), so a "monthly" job would actually fire whenever the app happened
  // to be opened, silently double-charging or skipping months.
  document.querySelectorAll("[data-log-interest]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const debt = debts.find((d) => d.id === el.dataset.logInterest);
      if (!debt) return;
      const s = cycleStatus(debt, accountActivity);
      if (!s.interestEstimate) return toast("No interest to log for this cycle");
      const ok = await confirmModal(
        `Adds ${fmt(s.interestEstimate)} of interest to ${debt.name}, based on ${fmt(s.remaining)} unpaid at ${debt.interest_rate}% APR. This is an estimate - a real issuer uses your average daily balance, so check your statement for the exact figure.`,
        { title: "Log this interest charge?", confirmLabel: "Add charge" }
      );
      if (!ok) return;
      const newBalance = Math.round((Number(debt.balance) + s.interestEstimate) * 100) / 100;
      const { error } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
      if (error) return toast(error.message);
      const debtAccountId = accounts.find((a) => a.linked_liability_id === debt.id)?.id ?? null;
      await logActivity(
        "owed_adjust", `Interest charge on ${debt.name} (${debt.interest_rate}% APR)`,
        s.interestEstimate, undefined, debtAccountId, null, debt.id
      );
      await loadDebts();
      renderRecentTransactions();
      toast("Interest charge logged");
    };
  });
  renderNetWorth();
  renderAccountsList(); // a changed liability balance may be a linked account's balance line
  renderDebtStrategy();
}

// Purely informational - shows real avalanche/snowball numbers side by
// side, never states which to pick (same boundary the Investments tab's
// allocation calculator already holds for what to buy). Re-runs live as
// the "extra monthly" input changes and whenever loadDebts() re-runs, so
// it always reflects the current liabilities and their real balances.
function renderDebtStrategy() {
  const extra = parseFloat($("debtStrategyExtra").value) || 0;
  const { avalanche, snowball, excludedCount } = compareDebtStrategies(debts, extra);
  const el = $("debtStrategyResult");
  if (!avalanche) {
    el.innerHTML = `<p class="muted">Add an interest rate and minimum payment to at least one liability to see this comparison.</p>`;
  } else {
    const line = (label, r) => r.neverPaysOff
      ? `<div><strong>${esc(label)}:</strong> minimum payment won't cover interest - balance will grow</div>`
      : `<div><strong>${esc(label)}:</strong> ${r.months}mo to debt-free, ${fmt(r.totalInterest)} total interest</div>`;
    el.innerHTML = line("Avalanche (highest interest first)", avalanche) + line("Snowball (smallest balance first)", snowball);
  }
  $("debtStrategyExcluded").textContent = excludedCount
    ? `${excludedCount} liabilit${excludedCount === 1 ? "y" : "ies"} not included (missing interest rate/minimum payment, already paid off, or an active HELOC draw period).`
    : "";
}
$("debtStrategyExtra").addEventListener("input", renderDebtStrategy);

// Interest rate / minimum payment / due date / draw period end - never
// balance, which stays strictly driven by real expenses/payments against
// the liability regardless of type.
// Works for both a standalone liability and an account-linked one (a
// credit card or HELOC never goes through debtForm above at all, so this
// was previously the only way to set these fields for those).
let editingDebtDetails = null;
function openDebtDetailsForm(debt) {
  if (!debt) return;
  closeAcctForm(); closeTransferForm(); // never leave the add-account/transfer panels stacked behind this
  editingDebtDetails = debt;
  $("debtDetailsRate").value = debt.interest_rate ?? "";
  $("debtDetailsMinPay").value = debt.minimum_payment ?? "";
  $("debtDetailsDue").value = debt.due_date ?? "";
  const hasLimit = CREDIT_LIMIT_LIABILITY_TYPES.has(debt.type);
  $("debtDetailsLimitSection").classList.toggle("hidden", !hasLimit);
  if (hasLimit) $("debtDetailsLimit").value = debt.credit_limit ?? "";
  const hasCycle = GRACE_PERIOD_LIABILITY_TYPES.has(debt.type);
  $("debtDetailsCycleSection").classList.toggle("hidden", !hasCycle);
  if (hasCycle) {
    $("debtDetailsStatementDay").value = debt.statement_day ?? "";
    $("debtDetailsDueDay").value = debt.due_day ?? "";
    $("debtDetailsStatementBalance").value = debt.last_statement_balance ?? "";
    $("debtDetailsStatementDate").value = debt.last_statement_date ?? "";
    const dates = cycleDates(debt.statement_day, debt.due_day);
    $("debtDetailsCycleInfo").textContent = dates
      ? `Current cycle closed ${dates.statementDate}, payment due ${dates.dueDate}. Paying the statement balance in full by the due date avoids interest entirely; paying only the minimum does not.`
      : "Set both days to track whether this card is about to be charged interest.";
  }
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
  const touchedIds = ["debtDetailsRate", "debtDetailsMinPay", "debtDetailsDue"];
  const patch = {
    interest_rate: $("debtDetailsRate").value !== "" ? parseFloat($("debtDetailsRate").value) : null,
    minimum_payment: $("debtDetailsMinPay").value !== "" ? parseFloat($("debtDetailsMinPay").value) : null,
    due_date: $("debtDetailsDue").value || null,
  };
  if (editingDebtDetails.type === "heloc") {
    touchedIds.push("debtDetailsDrawEnd");
    patch.draw_period_end = $("debtDetailsDrawEnd").value || null;
  }
  if (CREDIT_LIMIT_LIABILITY_TYPES.has(editingDebtDetails.type)) {
    touchedIds.push("debtDetailsLimit");
    const limit = $("debtDetailsLimit").value !== "" ? parseFloat($("debtDetailsLimit").value) : null;
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) { flagField("debtDetailsLimit"); return toast("Credit limit can't be negative"); }
    patch.credit_limit = limit;
  }
  if (GRACE_PERIOD_LIABILITY_TYPES.has(editingDebtDetails.type)) {
    touchedIds.push("debtDetailsStatementDay", "debtDetailsDueDay", "debtDetailsStatementBalance", "debtDetailsStatementDate");
    const day = (id) => ($(id).value !== "" ? parseInt($(id).value, 10) : null);
    const statementDay = day("debtDetailsStatementDay");
    const dueDay = day("debtDetailsDueDay");
    for (const [label, v, id] of [["Statement closes", statementDay, "debtDetailsStatementDay"], ["Payment due", dueDay, "debtDetailsDueDay"]]) {
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 31)) { flagField(id); return toast(`${label} must be a day from 1 to 31`); }
    }
    const stmtBalance = $("debtDetailsStatementBalance").value !== ""
      ? parseFloat($("debtDetailsStatementBalance").value) : null;
    if (stmtBalance !== null && (!Number.isFinite(stmtBalance) || stmtBalance < 0)) {
      flagField("debtDetailsStatementBalance");
      return toast("Statement balance can't be negative");
    }
    patch.statement_day = statementDay;
    patch.due_day = dueDay;
    patch.last_statement_balance = stmtBalance;
    patch.last_statement_date = $("debtDetailsStatementDate").value || null;
  }
  const { error } = await sb.from("liabilities").update(patch).eq("id", editingDebtDetails.id);
  if (error) { flagField(touchedIds); return toast(error.message); }
  closeDebtDetailsForm();
  await loadDebts();
  toast("Liability details saved");
};

// ---- ADJUST A LIABILITY'S BALANCE (owed vs. paying it down) -------------
// "Paying balance" (transfer: asset down, liability down, never a new
// expense) and "Owed" (direct set + add-a-charge) are both available for
// every liability, account-linked or standalone.
//
// This reverses an earlier deliberate rule, at the user's explicit request.
// Previously an account-linked liability (a credit card, a HELOC) could only
// move through real dated expenses, on the reasoning that its balance should
// always be reconstructable from its purchase trail. In practice the trail
// drifts from reality - a charge logged late, a refund, a fee or an interest
// charge the app never saw - and there was no way to reconcile against the
// actual statement short of inventing fake expenses, which corrupts the
// history far worse than a typed correction does.
//
// What keeps the reversal safe is that every manual correction is now
// written to account_activity as an 'owed_adjust' row (see
// 39_account_activity_kinds.sql): it shows up in the Log page's history, it
// says who moved the number and by how much, and it is undoable. The old
// rule's real goal was "an owed balance should never change without a
// traceable reason" - a logged adjustment satisfies that, an untracked
// typed number would not.
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
  const effectiveTab = tab;
  // Tapping the same entry point again (same debt, same tab already showing)
  // while the modal is open closes it; anything else switches to it instead.
  if (activeDebtId === debtId && effectiveTab === currentDebtTab() && !modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    activeDebtId = null;
    return;
  }
  const debt = debts.find((d) => d.id === debtId);
  if (!debt) return;
  closeAcctForm(); closeTransferForm(); // never leave the add-account/transfer panels stacked behind this
  activeDebtId = debtId;
  $("debtBalanceLabel").textContent = debt.name;
  $("debtBalanceCurrent").textContent = fmt(debt.balance);
  $("debtTabRow").classList.remove("hidden");
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
// The delta is what gets logged, not the new total - an owed_adjust row
// carries a SIGNED amount exactly like asset_adjust, so undoing it is the
// same "subtract whatever the original delta was" operation whether the
// correction raised or lowered the balance. Storing the typed total instead
// would make a "set" impossible to reverse, which is the bug asset_adjust
// already had once and had to be fixed for.
async function logOwedAdjust(debt, delta, reason) {
  if (!delta) return; // no actual change, nothing worth a history row
  const debtAccountId = accounts.find((a) => a.linked_liability_id === debt.id)?.id ?? null;
  await logActivity("owed_adjust", reason, delta, undefined, debtAccountId, null, debt.id);
}

$("debtOwedSetConfirm").onclick = async () => {
  const newBalance = parseFloat($("debtOwedSet").value);
  if (!Number.isFinite(newBalance)) { flagField("debtOwedSet"); return toast("Enter a valid amount"); }
  if (newBalance < 0) { flagField("debtOwedSet"); return toast("Amount owed can't be negative"); }
  const debt = debts.find((d) => d.id === activeDebtId);
  if (!debt) return;
  const rounded = Math.round(newBalance * 100) / 100;
  const delta = Math.round((rounded - Number(debt.balance)) * 100) / 100;
  const { error } = await sb.from("liabilities").update({ balance: rounded }).eq("id", debt.id);
  if (error) { flagField("debtOwedSet"); return toast(error.message); }
  await logOwedAdjust(debt, delta, `Corrected ${debt.name} owed to ${fmt(rounded)}`);
  await loadDebts();
  renderRecentTransactions();
  closeDebtBalanceForm();
  toast("Amount owed updated");
};

$("debtOwedConfirm").onclick = async () => {
  const amount = parseFloat($("debtOwedAmount").value);
  if (!amount || amount <= 0) { flagField("debtOwedAmount"); return toast("Enter a valid amount"); }
  const debt = debts.find((d) => d.id === activeDebtId);
  if (!debt) return;
  const newBalance = Math.round((Number(debt.balance) + amount) * 100) / 100;
  const { error } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
  if (error) { flagField("debtOwedAmount"); return toast(error.message); }
  await logOwedAdjust(debt, amount, `Added ${fmt(amount)} charge to ${debt.name}`);
  $("debtOwedAmount").value = "";
  await loadDebts();
  renderRecentTransactions();
  closeDebtBalanceForm();
  toast("Added to balance owed");
};

$("payConfirmBtn").onclick = async () => {
  const amount = parseFloat($("payAmount").value);
  if (!amount || amount <= 0) { flagField("payAmount"); return toast("Enter a valid amount"); }
  const assetId = $("payFromAsset").value;
  if (!assetId) { flagField("payFromAsset"); return toast("Choose an account to pay from - add one in the Accounts card if none are listed."); }
  const debt = debts.find((d) => d.id === activeDebtId);
  const asset = assets.find((a) => a.id === assetId);
  if (!debt || !asset) { flagField("payFromAsset"); return toast("Pick a valid liability and asset"); }
  if (amount > Number(asset.value)) { flagField("payAmount"); return toast(`Not enough in ${asset.name} to pay ${fmt(amount)}`); }

  const newAssetValue = Math.round((Number(asset.value) - amount) * 100) / 100;
  const newBalance = Math.max(0, Math.round((Number(debt.balance) - amount) * 100) / 100);

  const { error: assetErr } = await sb.from("assets").update({ value: newAssetValue }).eq("id", asset.id);
  if (assetErr) { flagField("payAmount"); return toast(assetErr.message); }
  const { error: debtErr } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
  if (debtErr) { flagField("payAmount"); return toast(debtErr.message); }

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
  // topLevelAssets/countableDebts both exclude two things here: child
  // holdings (already rolled into their parent - counting both would
  // double every invested dollar) and anything belonging to an archived
  // account (archiving now acts like a delete for net-worth purposes).
  const depreciatedAssets = topLevelAssets().map((a) => ({ ...a, value: effectiveAssetValue(a) }));
  const nw = computeNetWorth(depreciatedAssets, countableDebts());

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
  // See renderNetWorth's comment - same two exclusions (child holdings,
  // archived-account assets/liabilities) apply to the daily snapshot too.
  const depreciatedAssets = topLevelAssets().map((a) => ({ ...a, value: effectiveAssetValue(a) }));
  const nw = computeNetWorth(depreciatedAssets, countableDebts());
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
// no way for the two to disagree.
//
// A payment-type word ("debit") and/or a bank name ("bank of america") in
// the free text can each narrow which account is meant, and combine rather
// than compete when both appear - only an account matching every signal
// actually found in the text survives. That means "chase debit" can
// resolve to the one Chase debit account even with a second (Chase credit)
// account present, which "chase" alone would leave ambiguous. Bank-name
// matching is a plain case-insensitive substring check against the user's
// own already-saved accounts (a small, exact list) - not the fuzzy,
// FDIC-wide isKnownBank() logic used to validate a bank name when adding
// an account elsewhere; that one is answering a different question ("is
// this a real bank"), this one is "which of MY accounts does this refer
// to." Auto-selects only when exactly one account survives every filter
// that matched something - typing nothing recognizable, or something that
// matches 2+ accounts (two accounts at the same bank), leaves Account on
// "None" for the user to pick themselves. Silently guessing wrong here
// would be worse than not guessing at all.
function accountsMatchingBankName(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return accounts.filter((a) => a.bank_name && lower.includes(a.bank_name.toLowerCase()));
}
function selectAccountFromText(text, type) {
  let candidates = accounts;
  let matchedSomething = false;
  if (type) {
    candidates = candidates.filter((a) => a.type === type);
    matchedSomething = true;
  }
  const bankMatches = accountsMatchingBankName(text);
  if (bankMatches.length) {
    const bankMatchIds = new Set(bankMatches.map((a) => a.id));
    candidates = candidates.filter((a) => bankMatchIds.has(a.id));
    matchedSomething = true;
  }
  if (matchedSomething && candidates.length === 1) $("fAccount").value = candidates[0].id;
}

// Live "still needs to be filled in" signal, not a submit-attempt-only
// flash - a red border (`.field-required`, index.html) on whichever of the
// four fields saveBtn actually requires (same order it validates in) is
// currently empty, clearing itself the moment that field gets a value from
// either the user or a parse. Re-run after every keyword/Gemma auto-fill
// and on direct edits to any of the four, so it always reflects current
// state rather than only appearing after a rejected Save.
const REQUIRED_QUICK_ADD_FIELDS = ["fAmount", "fAccount", "fCategory", "fDate"];
function updateRequiredFieldHighlighting() {
  for (const id of REQUIRED_QUICK_ADD_FIELDS) {
    $(id).classList.toggle("field-required", !$(id).value);
  }
}
for (const id of REQUIRED_QUICK_ADD_FIELDS) {
  $(id).addEventListener("input", updateRequiredFieldHighlighting);
}

$("quick").addEventListener("input", (e) => {
  const raw = e.target.value;
  if (!raw.trim()) { $("confirm").classList.add("hidden"); $("parseStatus").textContent = ""; return; }
  $("confirm").classList.remove("hidden");
  // Layer 1: instant keyword parse (always on, README §3.5).
  const p = quickParse(raw);
  $("fAmount").value = p.amount ?? "";
  selectAccountFromText(raw, p.payment_type);
  $("fDesc").value = p.rest;
  const guessed = categorize(raw, userRules);
  if (guessed) $("fCategory").value = guessed;
  entrySource = "manual";
  updateRequiredFieldHighlighting();
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
        endpoint: GEMMA_ENDPOINT, model: GEMMA_MODEL, key: GEMMA_AUTH_KEY, today: $("fDate").value,
      });
      // Only apply if the user hasn't typed something new in the meantime.
      if ($("quick").value !== sent) { $("parseStatus").textContent = ""; return; }
      if (g.amount != null) $("fAmount").value = g.amount;
      selectAccountFromText(sent, g.payment_type);
      if (g.merchant) $("fDesc").value = g.merchant;
      if (g.category) $("fCategory").value = g.category;
      if (g.occurred_at) $("fDate").value = g.occurred_at;
      entrySource = "parsed";
      $("parseStatus").textContent = "Parsed by Gemma - confirm & save";
      updateRequiredFieldHighlighting();
    } catch (err) {
      // Home machine asleep / unreachable - keep the keyword guess.
      $("parseStatus").textContent = "Gemma unavailable - using quick parse";
    }
  }, 650);
}

$("saveBtn").onclick = async () => {
  updateRequiredFieldHighlighting(); // guaranteed-fresh red border right as Save is attempted
  const amount = parseFloat($("fAmount").value);
  if (!amount || amount <= 0) { flagField("fAmount"); return toast("Enter a valid amount"); }
  const accountId = $("fAccount").value || null;
  if (!accountId) { flagField("fAccount"); return toast("Select an account"); }
  const category = $("fCategory").value || null;
  if (!category) { flagField("fCategory"); return toast("Select a category"); }
  const occurredAt = $("fDate").value;
  if (!occurredAt) { flagField("fDate"); return toast("Select a date"); }
  // No separate Payment field - the account IS the payment type, since
  // account.type and payment_type share the same values (cash/debit/credit).
  const paymentType = accounts.find((a) => a.id === accountId).type;
  const assetErr = assetDeltaError([{ accountId, paymentType, amount, sign: -1 }]);
  if (assetErr) { flagField("fAccount"); return toast(assetErr); }
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
  if (error) { flagField("fAmount"); return toast(error.message); }
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
  if (dateCol == null || amountCol == null) { flagField(["csvMapDate", "csvMapAmount"]); return toast("Pick a Date and an Amount column"); }
  if (!$("csvAccount").value) { flagField("csvAccount"); return toast("Pick an account to import into"); }
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
          <input type="checkbox" class="csv-row-select" data-csv-idx="${i}" ${r.duplicate ? "" : "checked"} style="width:auto;flex-shrink:0" />
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
      flagField("csvAccount");
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
// list - the Log page's Recent History (expenses + account_activity
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
// `selectable` (Recent History only, not the Reports month log - see
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
      <span class="amt">${NON_UNDOABLE_ACTIVITY_KINDS.has(r.kind) ? "" : fmt(Math.abs(r.amount))}${
        NON_UNDOABLE_ACTIVITY_KINDS.has(r.kind)
          ? ""
          : `<span class="x" data-undo-idx="${i}" style="margin-left:8px;cursor:pointer" title="Undo">↶</span>`
      }</span>
    </div>` : `
    <div class="exp" data-idx="${i}">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        ${selectable ? `<input type="checkbox" class="txn-select" data-sel-idx="${i}" style="width:auto;flex-shrink:0" ${selectedTxnIds.has(r.id) ? "checked" : ""} />` : ""}
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

// Selected ids persist across a Recent History re-render (filter
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

// Reverses a transaction picked from Recent History (or the Reports
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
  } else if (row.kind === "owed_adjust") {
    // Signed delta, same convention as asset_adjust - reversing is always
    // "subtract what was applied," correct whether the original correction
    // raised the balance (a missed charge, an interest charge) or lowered it.
    const debt = row.liability_id ? debts.find((d) => d.id === row.liability_id) : null;
    if (!debt) return toast("Can't undo - the liability no longer exists.");
    const newBalance = Math.round((Number(debt.balance) - Number(row.amount)) * 100) / 100;
    if (newBalance < 0) return toast(`Can't undo - would take ${debt.name} below $0 owed.`);
    const { error } = await sb.from("liabilities").update({ balance: newBalance }).eq("id", debt.id);
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
  } else if (row.kind === "contribution") {
    // Unlike asset_adjust, this goes straight to asset_id - a contribution
    // is logged against the specific investment asset directly (most are
    // standalone, no account to indirect through via account_id at all;
    // see 42_contribution_tracking.sql). amount is always positive (a
    // contribution only ever adds money in), so undoing is always a
    // straight subtraction, never a sign-dependent one like asset_adjust's.
    const asset = row.asset_id ? assets.find((a) => a.id === row.asset_id) : null;
    if (!asset) return toast("Can't undo - the investment no longer exists.");
    const newValue = Math.round((Number(asset.value) - Number(row.amount)) * 100) / 100;
    if (newValue < 0) return toast(`Can't undo - would take ${asset.name} below $0.`);
    const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
    if (error) return toast(error.message);
    await syncParentAssetValue(asset.parent_asset_id); // no-op unless asset is itself a holding
  } else if (row.kind === "transfer") {
    // Reverses both legs - money goes back from the receiving asset
    // (related_account_id) to the funding asset (account_id), the exact
    // mirror of the original transfer.
    const fromAccount = accounts.find((a) => a.id === row.account_id);
    const toAccount = accounts.find((a) => a.id === row.related_account_id);
    const fromAsset = fromAccount ? assets.find((a) => a.id === fromAccount.linked_asset_id) : null;
    const toAsset = toAccount ? assets.find((a) => a.id === toAccount.linked_asset_id) : null;
    if (!fromAsset || !toAsset) return toast("Can't undo - one of the accounts no longer exists.");
    const newToValue = Math.round((Number(toAsset.value) - Number(row.amount)) * 100) / 100;
    if (newToValue < 0) return toast(`Can't undo - would take ${toAsset.name} below $0.`);
    const { error: toErr } = await sb.from("assets").update({ value: newToValue }).eq("id", toAsset.id);
    if (toErr) return toast(toErr.message);
    const newFromValue = Math.round((Number(fromAsset.value) + Number(row.amount)) * 100) / 100;
    const { error: fromErr } = await sb.from("assets").update({ value: newFromValue }).eq("id", fromAsset.id);
    if (fromErr) return toast(fromErr.message);
  } else if (row.kind === "income") {
    // Always a positive deposit, so undoing is always a straight
    // subtraction - never a sign-dependent reversal the way asset_adjust's
    // undo is.
    const account = accounts.find((a) => a.id === row.account_id);
    const asset = account ? assets.find((a) => a.id === account.linked_asset_id) : null;
    if (!asset) return toast("Can't undo - the linked account no longer exists.");
    const newValue = Math.round((Number(asset.value) - Number(row.amount)) * 100) / 100;
    if (newValue < 0) return toast(`Can't undo - would take ${asset.name} below $0.`);
    const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
    if (error) return toast(error.message);
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
    ? "No history matches these filters."
    : "No history yet - add an expense above.";
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
  renderBudgets(); // Log-page card now, so it refreshes with the expense list

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
  if (!amount || amount <= 0) { flagField("eAmount"); return toast("Enter a valid amount"); }
  const accountId = $("eAccount").value;
  if (!accountId) { flagField("eAccount"); return toast("Select an account"); }
  const newCategory = $("eCategory").value || null;
  if (!newCategory) { flagField("eCategory"); return toast("Select a category"); }
  const occurredAt = $("eDate").value;
  if (!occurredAt) { flagField("eDate"); return toast("Select a date"); }
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
  if (assetErr) { flagField("eAccount"); return toast(assetErr); }

  $("editSave").disabled = true;
  const { error } = await sb.from("expenses").update(patch).eq("id", editing.id);
  if (error) { $("editSave").disabled = false; flagField("eAmount"); return toast(error.message); }

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
  // Fire-and-forget: loads the model into memory in the background so it's
  // likely already warm by the time the user finishes reading this page and
  // clicks Ask - see warmUpGemma()'s own comment in gemma.js for why.
  if (GEMMA_ENDPOINT) warmUpGemma({ endpoint: GEMMA_ENDPOINT, model: GEMMA_MODEL, key: GEMMA_AUTH_KEY });
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
  populateForecastAccountSelect();
  renderCashFlowForecast();
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

// ---- BUDGETS ---------------------------------------------------------------
async function loadBudgets() {
  const { data } = await sb.from("budgets").select("*").order("category");
  budgets = data || [];
}

// The compact at-a-glance banner at the top of the Log page, distinct from
// the Budgets card further down (renderBudgets) which lists every limit and
// is where they're set - this one only ever appears when something is
// actually at or over its limit, the same "surface it without being asked"
// pattern assetMaturityNotice/assetStaleNotice already use. Both are scoped
// to the current calendar month (monthKey(), no month-selector input), since
// that's what "am I about to go over budget right now" means. Called from
// loadExpenses() (a new expense can change this) and whenever budgets
// themselves change (saveBudgetBtn, the delete handler in renderBudgets).
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

// Lives on the Log page now, not Reports, so it is always scoped to the
// CURRENT month rather than following the Reports month selector - a limit
// you are setting is about the month you are in, and a budget bar that
// silently reported some other month's spend because a selector three
// screens away was left on it would be actively misleading. Called from
// loadExpenses() alongside renderBudgetWarnings(), which already computes
// the same current-month sumBy for the warning banner.
function renderBudgets(byCat = sumBy(allExpenses, "category", monthKey())) {
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
      renderBudgets();
      renderBudgetWarnings(); // a removed budget can also remove a Log-page warning
      toast("Budget removed");
    };
  });
}

$("saveBudgetBtn").onclick = async () => {
  const category = $("budgetCategory").value;
  const monthly_limit = parseFloat($("budgetLimit").value);
  if (!category) { flagField("budgetCategory"); return toast("Pick a category"); }
  if (!Number.isFinite(monthly_limit) || monthly_limit <= 0) { flagField("budgetLimit"); return toast("Enter a valid monthly limit"); }
  const { error } = await sb.from("budgets")
    .upsert({ category, monthly_limit }, { onConflict: "user_id,category" });
  if (error) { flagField("budgetLimit"); return toast(error.message); }
  $("budgetLimit").value = "";
  await loadBudgets();
  renderBudgets();
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
  const investmentAssets = countableInvestmentAssets();
  const holdings = investmentHoldings(investmentAssets, assetPriceFindings);
  const totals = portfolioTotals(holdings, investmentAssets);
  const snapshot_date = new Date().toISOString().slice(0, 10);
  await sb.from("portfolio_snapshots").upsert(
    { snapshot_date, total_value: totals.totalValue, total_cost_basis: totals.totalCostBasis },
    { onConflict: "user_id,snapshot_date" }
  );
}

// Same portfolio_snapshots query feeds both the full-history "Value over
// time" chart and the Daily health check card's compact recent-trend
// sparkline (last HEALTH_SPARKLINE_DAYS points) - one fetch, two renders,
// rather than a second round-trip for what's already the same rows.
const HEALTH_SPARKLINE_DAYS = 14;

async function renderInvestmentsTrend() {
  const { data } = await sb.from("portfolio_snapshots").select("*").order("snapshot_date", { ascending: true });
  const rows = data || [];
  const dayLabel = (r) => {
    const [y, m, d] = r.snapshot_date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  $("investTrendEmpty").classList.toggle("hidden", rows.length >= 2);
  if (rows.length >= 2) {
    renderLineChart($("investTrendChart"), rows.map(dayLabel), rows.map((r) => Number(r.total_value)));
  }

  const recent = rows.slice(-HEALTH_SPARKLINE_DAYS);
  $("investHealthTrendEmpty").classList.toggle("hidden", recent.length >= 2);
  if (recent.length >= 2) {
    renderLineChart($("investHealthTrendChart"), recent.map(dayLabel), recent.map((r) => Number(r.total_value)));
  }
}

const gainColor = (n) => (n == null ? "" : n >= 0 ? "var(--ok)" : "var(--err)");
const signedPct = (n) => (n >= 0 ? "+" : "") + n + "%";

// Every investment-flavoured asset, parents and per-ticker holdings alike,
// EXCLUDING anything belonging to an archived account (archivedAccountAssetIds
// - same "archived acts deleted" rule as topLevelAssets). Fine for DISPLAY,
// where the grouping wants both parent and holdings, but never for
// totalling - see countableInvestmentAssets.
function allInvestmentAssets() {
  const hidden = archivedAccountAssetIds();
  return assets.filter((a) => INVESTMENT_ASSET_TYPES.has(a.type) && !hidden.has(a.id));
}
// The set that may be summed without double-counting. An account whose value
// is the roll-up of its own holdings (syncParentAssetValue) is dropped, since
// those holdings are each counted individually here; an account with no
// holdings recorded keeps its own blended value, which is the only figure it
// has. Getting this wrong doubles the portfolio total, so every totalling
// call (portfolioTotals, allocationVsTarget, the daily snapshot) goes
// through this rather than filtering inline.
function countableInvestmentAssets() {
  const investmentAssets = allInvestmentAssets();
  const parentsWithHoldings = new Set(
    investmentAssets.filter((a) => a.parent_asset_id).map((a) => a.parent_asset_id)
  );
  return investmentAssets.filter((a) => !parentsWithHoldings.has(a.id));
}

function renderInvestments() {
  const investmentAssets = allInvestmentAssets();          // display: parents + holdings
  const countable = countableInvestmentAssets();           // maths: never both
  const holdings = investmentHoldings(investmentAssets, assetPriceFindings);
  const totals = portfolioTotals(investmentHoldings(countable, assetPriceFindings), countable);

  $("investTotalValue").textContent = fmt(totals.totalValue);
  $("investTotalCostBasis").textContent = fmt(totals.totalCostBasis);
  $("investTotalGainLoss").textContent = totals.totalGainLoss != null
    ? `${fmt(totals.totalGainLoss)} (${signedPct(totals.totalGainLossPct)})` : "-";
  $("investTotalGainLoss").style.color = gainColor(totals.totalGainLoss);
  $("investTodayChangeEmpty").classList.toggle("hidden", totals.todayChange != null);
  $("investTodayChange").textContent = totals.todayChange != null
    ? `${fmt(totals.todayChange)} (${signedPct(totals.todayChangePct)})` : "-";
  $("investTodayChange").style.color = gainColor(totals.todayChange);

  // Grouped account-first: each investment account, then the individual
  // tickers held inside it (assets with parent_asset_id set). An account
  // with no holdings still shows its own blended value, which is what a
  // plain 401(k) with no per-ticker detail actually is.
  const parents = investmentAssets.filter((a) => !a.parent_asset_id);
  const holdingRow = (a) => {
    const h = holdings.find((x) => x.asset.id === a.id);
    if (!h) {
      return `
        <div class="exp" data-edit-holding="${a.id}" style="cursor:pointer;padding-left:12px">
          <div><div>${esc(a.name)}</div><div class="meta">no symbol set</div></div>
          <span class="amt">${fmt(effectiveAssetValue(a))}<span class="x" data-del-holding="${a.id}" style="margin-left:8px">✕</span></span>
        </div>`;
    }
    return `
      <div class="exp" data-edit-holding="${a.id}" style="cursor:pointer;flex-direction:column;align-items:stretch;gap:4px;padding-left:12px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div>
            <div>${esc(h.symbol)}</div>
            <div class="meta">${h.quantity ?? "?"} @ ${h.latestPrice != null ? fmt(h.latestPrice) : "no live price yet"}</div>
          </div>
          <div style="text-align:right">
            <div class="amt">${fmt(h.currentValue)}<span class="x" data-del-holding="${a.id}" style="margin-left:8px">✕</span></div>
            <div style="font-size:12px;color:${gainColor(h.gainLoss)}">${h.gainLoss != null ? `${fmt(h.gainLoss)} (${signedPct(h.gainLossPct)})` : "no cost basis set"}</div>
            ${h.dayChange != null ? `<div style="font-size:12px;color:${gainColor(h.dayChange)}">today ${fmt(h.dayChange)} (${signedPct(h.dayChangePct)})</div>` : ""}
          </div>
        </div>
        ${h.explanation ? `<div class="muted" style="font-size:12px">${esc(h.explanation)}</div>` : ""}
        ${h.headlines && h.headlines.length ? `<div class="muted" style="font-size:12px"><a href="${esc(h.headlines[0].url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(h.headlines[0].title)}</a>${h.headlines[0].source ? " · " + esc(h.headlines[0].source) : ""}</div>` : ""}
      </div>`;
  };
  $("investHoldingsList").innerHTML = parents.length ? parents.map((p) => {
    const children = investmentAssets.filter((a) => a.parent_asset_id === p.id);
    // Log contribution only makes sense for a parent with no holdings under
    // it - it bumps the parent's own .value directly, but a with-holdings
    // parent's value is ONLY ever the sum of its holdings ("no
    // separate uninvested-cash concept"). syncParentAssetValue() would
    // silently overwrite a logged contribution back to sum(holdings) the
    // next time it runs for that parent - real "new money in" for a
    // with-holdings account already has its own path, the Holdings form's
    // funding-account field.
    const contributionAffordance = children.length
      ? ""
      : `<div class="muted" data-log-contribution="${p.id}" style="font-size:11px;cursor:pointer;text-decoration:underline;margin-top:2px">Log contribution</div>`;
    return `
      <div style="margin-bottom:14px">
        <div class="exp" style="cursor:default">
          <div>
            <div><strong>${esc(p.name)}</strong></div>
            <div class="meta">${assetTypeLabel(p.type)}${children.length ? ` · ${children.length} holding${children.length === 1 ? "" : "s"}` : ""}</div>
            ${contributionAffordance}
          </div>
          <span class="amt">${fmt(effectiveAssetValue(p))}</span>
        </div>
        ${children.length
          ? children.map(holdingRow).join("")
          : `<p class="muted" style="font-size:12px;padding-left:12px;margin:6px 0 0">No specific holdings recorded - use "+ Add stock" to enter tickers.</p>`}
      </div>`;
  }).join("") : `<p class="muted" style="font-size:13px">No investments added yet - add one from the Assets card on the Log page (Brokerage, IRA, 401(k), crypto, ...).</p>`;
  document.querySelectorAll("[data-log-contribution]").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openContributionForm(el.dataset.logContribution); };
  });
  document.querySelectorAll("[data-edit-holding]").forEach((el) => {
    el.onclick = () => openHoldingForm(assets.find((a) => a.id === el.dataset.editHolding));
  });
  document.querySelectorAll("[data-del-holding]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation(); // don't also open the edit form
      const holding = assets.find((a) => a.id === el.dataset.delHolding);
      if (!holding) return;
      if (!(await confirmModal(`Removes ${holding.name} from this account. Its account total is recalculated from the remaining holdings.`,
        { title: "Delete this holding?" }))) return;
      const parentId = holding.parent_asset_id;
      const { error } = await sb.from("assets").delete().eq("id", holding.id);
      if (error) return toast(error.message);
      await loadAssets();
      await syncParentAssetValue(parentId);
      await loadAssets();
      renderInvestments();
      renderNetWorth();
      toast("Holding deleted");
    };
  });

  // Base 2025 IRS limits, factual math only - see CONTRIBUTION_LIMIT_GROUPS'
  // own comment above. Colored red
  // once over the limit, same as renderBudgets' over-budget styling - this
  // is a real hard legal limit, not the soft "aim for under 30%" utilization
  // guideline the Liabilities card's credit-utilization line deliberately
  // leaves uncolored, so a color here is stating a fact, not nudging advice.
  const contributions = accountActivity.filter((a) => a.kind === "contribution");
  const limitUsage = contributionLimitUsage(assets, contributions, CONTRIBUTION_LIMIT_GROUPS);
  $("contributionLimitsCard").style.display = limitUsage.length ? "" : "none";
  $("contributionLimitsList").innerHTML = limitUsage.map((u) => {
    const pctClamped = Math.min(100, (u.contributed / u.limit) * 100);
    return `
      <div style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between;font-size:13px">
          <span>${esc(u.label)}</span>
          <span style="${u.overLimit ? "color:var(--err)" : ""}">${fmt(u.contributed)} / ${fmt(u.limit)}${u.overLimit ? " - over limit" : ""}</span>
        </div>
        <div style="background:var(--panel-2);border-radius:6px;height:6px;margin-top:4px;overflow:hidden">
          <div style="background:${u.overLimit ? "var(--err)" : "var(--ok)"};width:${pctClamped}%;height:100%"></div>
        </div>
      </div>`;
  }).join("");

  $("investRiskLabel").value = profile?.risk_label ?? "";

  const allocation = allocationVsTarget(countable, holdings, investmentTargets);
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

  renderInvestmentHealth(totals, allocation, limitUsage, holdings);
}

// Daily health check card (index.html, top of investView) - a short
// compilation of the totals/allocation/limitUsage/holdings this function
// already computed above, via investments.js's portfolioHealthSummary.
// That function returns raw structured data, not text - formatting and
// esc() happen here, same split every other Investments render function
// already keeps between math and presentation.
const HEALTH_TONE_COLOR = { ok: "var(--ok)", warn: "var(--err)", neutral: "var(--muted)" };
function healthLineText(l) {
  switch (l.kind) {
    case "today":
      return l.change != null
        ? `Today ${fmt(l.change)} (${signedPct(l.changePct)}) - portfolio at ${fmt(l.value)}`
        : `Portfolio at ${fmt(l.value)} - no live price data yet for today's change`;
    case "gainLoss":
      return l.gainLoss != null
        ? `${fmt(l.gainLoss)} (${signedPct(l.gainLossPct)}) since cost basis`
        : `No cost basis on file yet - gain/loss can't be calculated`;
    case "allocation":
      return l.tone === "ok"
        ? "Allocation is within target"
        : `${esc(l.bucket)} is ${Math.abs(l.drift)}% ${l.drift > 0 ? "over" : "under"} target`;
    case "contributions":
      return l.overCount
        ? `${l.overCount} of ${l.groupCount} contribution group${l.groupCount === 1 ? "" : "s"} over the annual limit`
        : l.approachingCount
        ? `${l.approachingCount} of ${l.groupCount} contribution group${l.groupCount === 1 ? "" : "s"} approaching its annual limit`
        : "Contributions within limits";
    case "pricing":
      return l.priced === l.total
        ? `Live pricing available for all ${l.total} holding${l.total === 1 ? "" : "s"}`
        : `Live pricing available for ${l.priced} of ${l.total} holding${l.total === 1 ? "" : "s"}`;
    default:
      return "";
  }
}
function renderInvestmentHealth(totals, allocation, limitUsage, holdings) {
  const health = portfolioHealthSummary(totals, allocation, limitUsage, holdings);
  $("investHealthList").innerHTML = health.map((l) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0">
      <span style="width:8px;height:8px;border-radius:50%;flex:none;background:${HEALTH_TONE_COLOR[l.tone]}"></span>
      <span>${healthLineText(l)}</span>
    </div>`).join("");
}

// Market overview card (top of investView) - a fixed set of major US
// indexes, genuinely NOT tied to anything the user owns (unlike every
// other Investments render function). Same dormant-until-flag shape as
// renderAssetPriceFindings: fully hidden while PRICE_FINDINGS_ENABLED is
// off, since unlike the Daily health check card above (which always has
// real facts about the user's own entered data to show), there's no
// manual-entry fallback for a market index - an empty "not available yet"
// card forever would be pure clutter, not a fact worth stating.
//
// Reuses HEALTH_TONE_COLOR's ok/warn/neutral vocabulary for the daily
// news digest's sentiment dot below, rather than inventing a new color
// map - bullish maps to the same green "ok" already means elsewhere,
// bearish to the same red "warn."
const SENTIMENT_TONE = { bullish: "ok", neutral: "neutral", bearish: "warn" };
const SENTIMENT_LABEL = { bullish: "Bullish", neutral: "Neutral", bearish: "Bearish" };

// A trade_date is a plain "YYYY-MM-DD" with no timezone in it, so build
// the Date from its parts - `new Date("2026-08-20")` parses as UTC and
// renders as the previous day for anyone west of Greenwich.
const recapDateLabel = (iso) => {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};

// Stage 1 recap: real numbers and real linked headlines, no generated text
// anywhere on this card. Deliberately no bullish/bearish label and no
// causal claim - a headline is shown as that day's COVERAGE of the symbol,
// which is what it actually is. Asserting it as the reason the price moved
// would be stating a causation this app can't establish, the same line
// marketBreadth()'s plain count and the credit-utilization line already
// hold.
function renderDailyRecap() {
  const card = $("dailyRecapCard");
  if (!card) return;
  const recap = latestRecap(dailyRecaps);
  // No manual-entry fallback exists for a market recap, so an empty card
  // would be clutter rather than a fact worth stating - hidden entirely
  // until a real one exists, same convention as Market overview.
  if (!recap) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  renderAgentFreshness("daily-recap", "dailyRecapFreshness", "dailyRecapWarning");

  $("dailyRecapDate").textContent = `Market close, ${recapDateLabel(recap.tradeDate)}`;

  const breadth = recap.breadth;
  const breadthEl = $("dailyRecapBreadth");
  if (breadth) {
    breadthEl.textContent = `${breadth.up} of ${breadth.total} tracked large-caps finished up`;
    breadthEl.style.color = breadth.up > breadth.down ? "var(--ok)"
      : breadth.down > breadth.up ? "var(--err)" : "var(--text)";
  } else {
    breadthEl.textContent = "";
  }

  // Stage 2 (a single batched Gemini synthesis) is the only thing that
  // ever fills this - stays hidden on a rollup-only recap rather than
  // showing a placeholder for something that may never be generated.
  // Explicitly labelled as written rather than measured: every other line
  // on this card is a real number or a real link, and the reader should
  // never have to guess which is which. Same distinction marketBreadth()
  // draws when it calls itself "a plain count, not an AI's read."
  // esc() because this is model output, the exact provenance that rule
  // exists for.
  const summaryEl = $("dailyRecapSummary");
  summaryEl.innerHTML = recap.summary
    ? `<span class="muted" style="font-size:11px">AI-written summary of the numbers and coverage above</span><br>${esc(recap.summary)}`
    : "";
  summaryEl.classList.toggle("hidden", !recap.summary);

  $("dailyRecapMovers").innerHTML = recap.movers.map((m) => `
    <div class="exp" style="cursor:default">
      <div>
        <div>${esc(m.symbol)}</div>
        ${m.headline
          ? `<div class="meta"><a href="${esc(m.headline.url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(m.headline.title)}</a>${m.headline.source ? " · " + esc(m.headline.source) : ""}</div>`
          : `<div class="meta muted">No headline found for this move</div>`}
      </div>
      <span class="amt" style="text-align:right">
        ${fmt(m.close)}
        <div style="font-size:12px;color:${gainColor(m.change_pct)}">${signedPct(m.change_pct)}</div>
      </span>
    </div>`).join("");

  $("dailyRecapIndexes").textContent = recap.indexMoves.length
    ? "Index proxies: " + recap.indexMoves.map((i) => `${i.symbol} ${signedPct(i.change_pct)}`).join("  ·  ")
    : "";
}

function renderMarketOverview() {
  const card = $("marketOverviewCard");
  if (!card) return;
  if (!PRICE_FINDINGS_ENABLED) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  renderAgentFreshness("price-agent", "marketOverviewFreshness", "marketOverviewWarning");
  const indexes = marketIndexSummary(MARKET_INDEXES, marketIndexFindings);
  // Live ETF-proxy prices - marketIndexSummary() works unchanged against
  // any label list, so this reuses it directly with the ETF tickers
  // instead of the index names (see MARKET_INDEX_ETF_PROXIES's own
  // comment for why the two are stored as separate symbols, never mixed).
  const etfTickers = Object.values(MARKET_INDEX_ETF_PROXIES);
  const etfByTicker = new Map(marketIndexSummary(etfTickers, marketIndexFindings).map((e) => [e.label, e]));
  renderPricesAsOf("marketOverviewLiveFreshness", latestFinnhubRefresh(marketIndexFindings));

  // A real, computed fact from the same already-loaded live data below -
  // never an AI-inferred read, so it's available exactly as often as
  // real prices are, with zero rate-limit exposure. Plain "X of Y up"
  // wording, not a bullish/bearish label - a count isn't an opinion.
  const pulse = marketBreadth(MARKET_MOVERS_WATCHLIST, etfTickers, marketIndexFindings);
  const pulseEl = $("marketPulse");
  if (pulseEl) {
    if (!pulse) {
      pulseEl.textContent = "";
    } else {
      const tone = pulse.up > pulse.down ? "var(--ok)" : pulse.down > pulse.up ? "var(--err)" : "var(--text)";
      pulseEl.style.color = tone;
      const avgText = pulse.avgEtfChangePct != null ? `, tracked indexes avg ${signedPct(pulse.avgEtfChangePct)}` : "";
      pulseEl.textContent = `${pulse.up} of ${pulse.total} tracked large-caps up today${avgText}`;
    }
  }
  $("marketOverviewList").innerHTML = indexes.map((idx) => {
    const etfTicker = MARKET_INDEX_ETF_PROXIES[idx.label];
    const live = etfTicker ? etfByTicker.get(etfTicker) : null;
    return `
    <div class="exp" style="cursor:default;flex-direction:column;align-items:stretch;gap:2px">
      <div style="display:flex;justify-content:space-between;gap:10px">
        <div>
          <div>${esc(idx.label)}</div>
          ${idx.explanation ? `<div class="meta">${esc(idx.explanation)}</div>` : ""}
        </div>
        <span class="amt" style="text-align:right">
          ${idx.price != null ? fmtNum(idx.price) : `<span class="muted" style="font-size:12px">index level not available yet</span>`}
          ${idx.change != null ? `<div style="font-size:12px;color:${gainColor(idx.change)}">${signedPct(idx.changePct)}</div>` : ""}
        </span>
      </div>
      ${live && live.price != null ? `<div class="meta" style="font-size:12px">Live via ${esc(etfTicker)}: ${fmt(live.price)}${live.changePct != null ? ` <span style="color:${gainColor(live.change)}">${signedPct(live.changePct)}</span>` : ""}</div>` : ""}
    </div>`;
  }).join("");

  const movers = topMarketMovers(MARKET_MOVERS_WATCHLIST, marketIndexFindings, 3);
  const moversSection = $("marketMoversSection");
  if (moversSection) moversSection.classList.toggle("hidden", !movers.length);
  renderPricesAsOf("marketMoversFreshness", latestFinnhubRefresh(marketIndexFindings));
  $("marketMoversList").innerHTML = movers.map((m) => `
    <div class="exp" style="cursor:default">
      <div>
        <div>${esc(m.label)}</div>
        ${m.explanation ? `<div class="meta">${esc(m.explanation)}</div>` : ""}
        ${m.headlines && m.headlines.length ? `<div class="meta"><a href="${esc(m.headlines[0].url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(m.headlines[0].title)}</a>${m.headlines[0].source ? " · " + esc(m.headlines[0].source) : ""}</div>` : ""}
      </div>
      <span class="amt" style="text-align:right">
        ${fmtNum(m.price)}
        <div style="font-size:12px;color:${gainColor(m.change)}">${signedPct(m.changePct)}</div>
      </span>
    </div>`).join("");

  const digest = latestNewsDigest(marketNewsFindings);
  const newsSection = $("marketNewsSection");
  if (newsSection) newsSection.classList.toggle("hidden", !digest);
  if (digest) {
    $("marketSentimentDot").style.background = HEALTH_TONE_COLOR[SENTIMENT_TONE[digest.sentiment]];
    $("marketSentimentLabel").textContent = SENTIMENT_LABEL[digest.sentiment];
    $("marketSentimentReason").textContent = digest.sentimentReason || "";
    $("marketNewsList").innerHTML = digest.headlines.map((h) => `
      <div class="exp" style="cursor:default">
        <a href="${esc(h.url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
          <div>${esc(h.title)}</div>
          ${h.source ? `<div class="meta">${esc(h.source)}</div>` : ""}
        </a>
      </div>`).join("");
  }
}

// ---- HOLDINGS (specific tickers inside an investment account) -----------
// The gap this closes: price_symbol/quantity were only reachable from the
// standalone-asset form, so an investment account created from the Accounts
// card had no way to record what was actually bought in it - it tracked one
// blended number and nothing else. A holding is an `assets` row with
// parent_asset_id pointing at the account's asset (40_asset_holdings.sql).
let editingHolding = null;

// A pension is an income promise, not a tradable security - there is no
// real-world "ticker" a pension holds, unlike every other INVESTMENT_ASSET_
// TYPES entry. Excluded here specifically, not from INVESTMENT_ASSET_TYPES
// itself - a pension asset still shows up everywhere else on the
// Investments tab (total value, the plain listing) exactly as before, it
// just can't be the PARENT of a new ticker holding. Everything else stays
// eligible, including `annuity`: a FIXED annuity has no ticker either, but
// a VARIABLE annuity genuinely does (its value tracks named sub-account
// funds, much like a 401(k)'s fund menu) - there's no separate fixed/
// variable type to gate on, so this stays permissive rather than blocking
// a real use case to guard against a different one (see docs/bank-account-
// types-research.md §5.8/§9b for the fixed-vs-variable distinction).
const TICKER_ELIGIBLE_ASSET_TYPES = new Set(
  [...INVESTMENT_ASSET_TYPES].filter((t) => t !== "pension")
);

// Base 2025 IRS contribution limits, no catch-up/income-phase-out/filing-
// status adjustments - see the code comments above for
// the full reasoning per type and per group, including every excluded
// type's specific reason for not being tracked (sep_ira needs income data
// this app doesn't have, 529/UTMA use a gift-tax exclusion rather than a
// clean single limit, a rollover/inherited IRA generally can't receive new
// contributions at all, ...). Consumed by contributionLimitUsage()
// (investments.js), which stays free of this app-level configuration the
// same way it already takes INVESTMENT_ASSET_TYPES-derived lists as
// arguments rather than hardcoding them itself.
//
// Which types share one limit vs. have their own is the part most likely
// to be gotten wrong by intuition - a 401(k) and a 457(b) look similar but
// do NOT share a limit, while a Traditional and a Roth 401(k) look
// different but DO. Verify the current year's actual figures before
// relying on this for a real contribution decision - this is a reference
// calculator showing your own logged numbers back to you, not tax advice,
// and a stale limit would be worse than showing none.
const CONTRIBUTION_LIMIT_GROUPS = {
  elective_deferral: {
    types: ["traditional_401k", "roth_401k", "plan_403b", "tsp", "solo_401k"],
    limit: 23500,
    label: "401(k) / 403(b) / TSP",
  },
  plan_457b: { types: ["plan_457b"], limit: 23500, label: "457(b)" },
  ira: { types: ["traditional_ira", "roth_ira"], limit: 7000, label: "IRA (Traditional + Roth combined)" },
  simple_ira: { types: ["simple_ira"], limit: 16500, label: "SIMPLE IRA" },
  espp: { types: ["espp"], limit: 25000, label: "ESPP" },
};

// Only accounts that can actually contain positions. An investment account
// created from the Accounts card has a linked asset; a standalone investment
// asset added from the Assets card can hold tickers too, so both are offered
// as parents. A holding itself is never a parent (no nesting).
function holdingParentAssets() {
  // allInvestmentAssets() already drops anything belonging to an archived
  // account (archivedAccountAssetIds) - so an archived account isn't
  // offered as somewhere to file a new holding either. Deliberately NOT
  // countableInvestmentAssets(): that helper drops a parent that ALREADY
  // has holdings, for double-counting reasons in totals - the wrong list
  // here, since an account with existing positions must still be offered
  // as somewhere to add another one.
  return allInvestmentAssets().filter(
    (a) => !a.parent_asset_id && TICKER_ELIGIBLE_ASSET_TYPES.has(a.type)
  );
}

// Required fields on the holding form: an explicit account, a ticker, share
// count, and price per share - the same "starts blank, red border while
// empty" treatment as REQUIRED_QUICK_ADD_FIELDS, reused rather than
// reinvented. holdingCostBasis holds a
// PER-SHARE price now (see saveHoldingBtn for the conversion to the
// TOTAL actually stored in assets.purchase_price) - same id, changed
// meaning, so this list and the highlighting wiring below needed no change.
const REQUIRED_HOLDING_FIELDS = ["holdingAccount", "holdingSymbol", "holdingQuantity", "holdingCostBasis"];
// Tracks the exact symbol text the user has already confirmed via the
// "not recognized, add anyway" override, so re-showing that confirm on
// every subsequent save click (with nothing changed) would be needless -
// cleared whenever the symbol text itself changes, so a genuinely new,
// still-unconfirmed symbol is always re-checked.
let holdingSymbolOverrideConfirmedFor = null;
// Live, on every keystroke in any of the four - plain emptiness only.
// Deliberately does NOT include the "unrecognized ticker" check (see
// updateHoldingSymbolTickerHighlight below) - that one is checked only at
// save time, not here, even though holdingSymbol is one of the four ids
// this function runs against. Using classList.toggle (not .add) matters
// for that separation: it unconditionally SETS the class to match current
// emptiness on every call, which is also what clears a previous ticker-
// invalid flag the instant the user edits the text at all, before the
// (separate, save-time-only) validity check has even re-run.
function updateHoldingFieldHighlighting() {
  for (const id of REQUIRED_HOLDING_FIELDS) {
    $(id).classList.toggle("field-required", !$(id).value);
  }
}
// A non-empty holdingSymbol that isn't a recognized ticker and hasn't been
// override-confirmed yet is ALSO red, on top of the plain-empty check above -
// but only evaluated at save time (called from saveHoldingBtn), never wired
// to holdingSymbol's own input event. Flagging every partial, still-being-
// typed ticker as "wrong" while the user is mid-typing "AAPL" would be
// actively annoying - caught by testing the live-typing experience, not
// assumed safe just because the empty-check version of this pattern was
// already proven to work well for Quick Add.
function updateHoldingSymbolTickerHighlight() {
  const symbol = $("holdingSymbol").value.trim().toUpperCase();
  const parentType = assets.find((a) => a.id === $("holdingAccount").value)?.type;
  if (symbol && symbol !== holdingSymbolOverrideConfirmedFor && !isKnownTicker(symbol, parentType)) {
    $("holdingSymbol").classList.add("field-required");
  }
}
for (const id of REQUIRED_HOLDING_FIELDS) {
  $(id).addEventListener("input", updateHoldingFieldHighlighting);
}
// A changed symbol invalidates any prior override confirmation for the OLD
// text - typing over a confirmed "BRK.A" into something else must be
// re-checked, not silently inherit the earlier confirmation.
$("holdingSymbol").addEventListener("input", () => { holdingSymbolOverrideConfirmedFor = null; });

// Checks both already-loaded findings arrays - a user's own tracked
// symbols (assetPriceFindings) AND the fixed movers watchlist
// (marketIndexFindings), since a brand-new ticker being entered for the
// first time won't be in the former yet but might already be priced via
// the latter. No new network call - both are already in module state.
function findLivePrice(symbol) {
  const upper = symbol.trim().toUpperCase();
  const rows = [...assetPriceFindings, ...marketIndexFindings]
    .filter((f) => (f.symbol || "").trim().toUpperCase() === upper);
  if (!rows.length) return null;
  const latest = rows.sort((a, b) => new Date(b.found_at) - new Date(a.found_at))[0];
  return latest.price != null ? Number(latest.price) : null;
}

// Genuinely real-time, on-demand lookup for the Holdings form's "Buying now"
// mode - unlike findLivePrice() above, which only checks the already-loaded,
// weekly-refreshed price-agent.js findings. Proxied through this app's own
// Worker route (worker.js's /api/price) so the Finnhub key never reaches the
// browser and Finnhub's own lack of CORS support (confirmed live) is never
// hit directly. Best-effort: returns null on any failure (not signed in,
// network error, unknown symbol) so the caller can degrade gracefully
// rather than throwing.
async function fetchLivePriceOnDemand(symbol) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch(`/api/price?symbol=${encodeURIComponent(symbol)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ?? null;
  } catch {
    return null;
  }
}

// Live "estimated total" line, same shape a real trade ticket shows as you
// type quantity/price - purely a display confirmation, not itself saved.
function updateHoldingTotalCost() {
  const quantity = parseFloat($("holdingQuantity").value);
  const pricePerShare = parseFloat($("holdingCostBasis").value);
  const el = $("holdingTotalCost");
  if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(pricePerShare) && pricePerShare >= 0) {
    el.textContent = `Total: ${fmt(quantity * pricePerShare)}`;
  } else {
    el.textContent = "";
  }
}
$("holdingQuantity").addEventListener("input", updateHoldingTotalCost);
$("holdingCostBasis").addEventListener("input", updateHoldingTotalCost);

// "Already own this" (the default): only for a NEW holding (editing one
// means the user already has a real price basis set - never silently
// overwrite that just because they touched the ticker field) and only if
// price-per-share is still empty (never clobber something the user already
// typed). Fires on blur, not every keystroke, so it doesn't fight with
// someone still mid-typing a ticker. "Buying now" routes to a genuinely
// live, on-demand lookup instead - see refreshHoldingLivePrice below.
$("holdingSymbol").addEventListener("blur", () => {
  const symbol = $("holdingSymbol").value.trim();
  if (!symbol) return;
  if (holdingEntryMode === "buying") {
    refreshHoldingLivePrice(symbol);
    return;
  }
  if (editingHolding || $("holdingCostBasis").value !== "") return;
  const price = findLivePrice(symbol);
  if (price == null) return;
  $("holdingCostBasis").value = price;
  updateHoldingTotalCost();
  updateHoldingFieldHighlighting();
  toast(`Filled with today's live price (${fmt(price)}) - edit if you paid differently`);
});

// State for the "Buying now" mode's shares<->dollar-amount conversion -
// holdingLivePrice is the last on-demand quote fetched for the current
// ticker (null until one arrives, or if none was found). holdingLiveFetchToken
// guards against a stale response landing after a newer request was already
// sent (the user changed the ticker again while the first lookup was still
// in flight) - only the response matching the current token is applied.
let holdingEntryMode = "own";
let holdingBuyBasis = "shares";
let holdingLivePrice = null;
let holdingLiveFetchToken = 0;

async function refreshHoldingLivePrice(symbol) {
  const token = ++holdingLiveFetchToken;
  holdingLivePrice = null;
  $("holdingCostBasis").value = "";
  $("holdingLivePriceStatus").textContent = "Checking live price...";
  const price = await fetchLivePriceOnDemand(symbol);
  if (token !== holdingLiveFetchToken) return;
  if (price == null) {
    // No live price - degrade to the same manual price-per-share entry
    // "Already own this" mode already uses, rather than dead-ending the form.
    $("holdingLivePriceStatus").textContent = "No live price available for this ticker right now - enter the price you're paying manually.";
    $("holdingCostBasis").readOnly = false;
    setHoldingBuyBasis("shares");
  } else {
    holdingLivePrice = price;
    $("holdingLivePriceStatus").textContent = `Live price: ${fmt(price)} per share`;
    $("holdingCostBasis").value = price;
    $("holdingCostBasis").readOnly = true;
  }
  recomputeHoldingBuyFields();
}

// Only the "By dollar amount" sub-mode derives a field (shares, from the
// typed dollar amount / the live price) - "By shares" is directly typed and
// already flows through the existing updateHoldingTotalCost() unchanged.
function recomputeHoldingBuyFields() {
  if (holdingEntryMode === "buying" && holdingBuyBasis === "dollars" && holdingLivePrice != null) {
    const dollars = parseFloat($("holdingDollarAmount").value);
    $("holdingQuantity").value = Number.isFinite(dollars) && dollars > 0
      ? Math.round((dollars / holdingLivePrice) * 1e6) / 1e6
      : "";
  }
  updateHoldingTotalCost();
  updateHoldingFieldHighlighting();
}

function setHoldingBuyBasis(basis) {
  holdingBuyBasis = basis;
  document.querySelectorAll("#holdingBuyModePills [data-holding-buy-basis]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.holdingBuyBasis === basis);
  });
  const dollarMode = basis === "dollars";
  $("holdingDollarAmountRow").classList.toggle("hidden", !dollarMode);
  $("holdingQuantity").readOnly = holdingEntryMode === "buying" && dollarMode;
  if (!dollarMode) $("holdingDollarAmount").value = "";
  recomputeHoldingBuyFields();
}

function setHoldingEntryMode(mode) {
  holdingEntryMode = mode;
  holdingLivePrice = null;
  document.querySelectorAll("#holdingModePills [data-holding-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.holdingMode === mode);
  });
  $("holdingBuyModePills").classList.toggle("hidden", mode !== "buying");
  $("holdingDollarAmountRow").classList.add("hidden");
  $("holdingDollarAmount").value = "";
  $("holdingLivePriceStatus").textContent = "";
  $("holdingCostBasisLabel").textContent = mode === "buying" ? "Price per share (live)" : "Price per share";
  $("holdingQuantity").readOnly = false;
  $("holdingCostBasis").readOnly = false;
  if (mode === "buying") {
    holdingBuyBasis = "shares";
    document.querySelectorAll("#holdingBuyModePills [data-holding-buy-basis]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.holdingBuyBasis === "shares");
    });
    const symbol = $("holdingSymbol").value.trim();
    if (symbol) refreshHoldingLivePrice(symbol);
  }
  updateHoldingFieldHighlighting();
  updateHoldingTotalCost();
}
document.querySelectorAll("#holdingModePills [data-holding-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setHoldingEntryMode(btn.dataset.holdingMode));
});
document.querySelectorAll("#holdingBuyModePills [data-holding-buy-basis]").forEach((btn) => {
  btn.addEventListener("click", () => setHoldingBuyBasis(btn.dataset.holdingBuyBasis));
});
$("holdingDollarAmount").addEventListener("input", recomputeHoldingBuyFields);

function openHoldingForm(holding) {
  editingHolding = holding || null;
  holdingSymbolOverrideConfirmedFor = null;
  const parents = holdingParentAssets();
  if (!parents.length) {
    return toast("Add an investment account first (Accounts or Assets card on the Log page) - a pension can't hold individual tickers.");
  }
  const opts = parents
    .map((a) => `<option value="${a.id}">${esc(a.name)} (${assetTypeLabel(a.type)})</option>`).join("");
  // New holding: starts on the blank "Choose an account" option, same
  // "required means actually reachable as empty" fix already applied to
  // Quick Add's Category - defaulting to parents[0] silently would make
  // the required-field check below structurally unreachable, the exact
  // bug that was already found and fixed once. Editing an existing holding
  // still explicitly selects its real current parent, same as eCategory
  // does for an existing expense's real category.
  $("holdingAccount").innerHTML = holding
    ? opts
    : `<option value="">Choose an account</option>${opts}`;
  $("holdingAccount").value = holding?.parent_asset_id ?? "";
  $("holdingSymbol").value = holding?.price_symbol ?? "";
  $("holdingQuantity").value = holding?.quantity ?? "";
  // assets.purchase_price stores the TOTAL paid, but this field shows a
  // PER-SHARE price (matches a real trade ticket) - convert back for
  // display. Guarded against a zero/missing quantity even though it's
  // already required and should never be 0 on a saved holding.
  $("holdingCostBasis").value = holding && holding.quantity
    ? Math.round((holding.purchase_price / holding.quantity) * 100) / 100
    : "";
  // Always blank, add or edit - this represents a one-shot action taken
  // at save time, not a stored fact about the holding, so there's nothing
  // on the holding row to pre-fill it from.
  $("holdingFundingAccount").value = "";
  $("holdingBucket").value = holding?.investment_bucket ?? "";
  // Always resets to "Already own this" on open (add or edit) - the more
  // common case (entering an existing portfolio) and today's already-shipped
  // default behavior, unaffected by whatever mode was active last time.
  setHoldingEntryMode("own");
  updateHoldingFieldHighlighting();
  updateHoldingTotalCost();
  $("holdingForm").classList.remove("hidden");
  $("holdingForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeHoldingForm() {
  $("holdingForm").classList.add("hidden");
  editingHolding = null;
  holdingSymbolOverrideConfirmedFor = null;
}
$("addHoldingBtn").onclick = () => {
  if ($("holdingForm").classList.contains("hidden")) openHoldingForm(null);
  else closeHoldingForm();
};
$("cancelHoldingBtn").onclick = closeHoldingForm;

$("saveHoldingBtn").onclick = async () => {
  // Guaranteed-fresh red borders right as Save is attempted - both halves,
  // since updateHoldingSymbolTickerHighlight is otherwise never wired to
  // fire on its own (deliberately not live, see its own comment).
  updateHoldingFieldHighlighting();
  updateHoldingSymbolTickerHighlight();
  const parentId = $("holdingAccount").value;
  if (!parentId) { flagField("holdingAccount"); return toast("Choose the account this sits in"); }
  const symbol = $("holdingSymbol").value.trim().toUpperCase();
  if (!symbol) { flagField("holdingSymbol"); return toast("Enter a ticker or symbol"); }
  // Shares and price per share are required, not optional - a holding
  // without them was previously just a name with no actual position
  // behind it.
  if ($("holdingQuantity").value === "") { flagField("holdingQuantity"); return toast("Enter the number of shares"); }
  const quantity = parseFloat($("holdingQuantity").value);
  if (!Number.isFinite(quantity) || quantity <= 0) { flagField("holdingQuantity"); return toast("Shares must be a positive number"); }
  if ($("holdingCostBasis").value === "") { flagField("holdingCostBasis"); return toast("Enter what you paid per share"); }
  const pricePerShare = parseFloat($("holdingCostBasis").value);
  if (!Number.isFinite(pricePerShare) || pricePerShare < 0) { flagField("holdingCostBasis"); return toast("Price per share can't be negative"); }

  // The form takes a PER-SHARE price (matches a real trade ticket), but
  // assets.purchase_price stores the TOTAL - every reader of that column
  // (investments.js's investmentHoldings(), gain/loss math) already
  // expects a total, so convert here rather than changing that contract.
  const totalCostBasis = Math.round(pricePerShare * quantity * 100) / 100;
  // Only a POSITIVE delta is money actually being spent right now - a new
  // holding starts from 0, editing one compares against its existing
  // total. Editing quantity/price DOWN (a correction, not a sale - this
  // app has no "sell" workflow) yields a delta <= 0, which deliberately
  // skips funding entirely below - there's no reliable way to tell a
  // correction apart from a real partial sale, so guessing would be worse
  // than doing nothing.
  const previousCostBasis = editingHolding ? Number(editingHolding.purchase_price) : 0;
  const costBasisDelta = Math.round((totalCostBasis - previousCostBasis) * 100) / 100;
  const fundingAccountId = $("holdingFundingAccount").value || null;
  // Checked up front, before the async ticker-confirm dialog below - fail
  // fast on insufficient funds rather than making someone confirm an
  // unusual ticker only to then find out they can't afford it.
  if (fundingAccountId && costBasisDelta > 0) {
    const fundingErr = assetDeltaError([{ accountId: fundingAccountId, amount: costBasisDelta, sign: -1 }]);
    if (fundingErr) { flagField("holdingFundingAccount"); return toast(fundingErr); }
  }

  const parent = assets.find((a) => a.id === parentId);
  // isKnownTicker() checks a hand-curated, necessarily incomplete list
  // (tickers.js) - a no-match is a confirmation, not a hard stop, same
  // "comprehensive but not exhaustive" override bank-name entry already
  // established (saveAcctBtn). Skipped entirely once already confirmed for
  // this exact symbol text this time around.
  if (symbol !== holdingSymbolOverrideConfirmedFor && !isKnownTicker(symbol, parent?.type)) {
    const kind = parent?.type === "crypto" ? "crypto symbol" : "ticker";
    const ok = await confirmModal(
      `"${symbol}" isn't in our list of recognized ${kind}s. If this is real and we're just missing it, you can add it as typed.`,
      { title: `${kind === "crypto symbol" ? "Symbol" : "Ticker"} not recognized`, confirmLabel: "Add anyway" }
    );
    if (!ok) { updateHoldingSymbolTickerHighlight(); return; }
    holdingSymbolOverrideConfirmedFor = symbol;
  }

  const row = {
    // A holding inherits its parent's type so INVESTMENT_ASSET_TYPES keeps
    // matching it and the Investments tab picks it up with no special case.
    name: symbol,
    type: parent?.type ?? "investment",
    parent_asset_id: parentId,
    price_symbol: symbol,
    quantity,
    purchase_price: totalCostBasis,
    // No separate "current value" input anymore (removed - a real
    // purchase doesn't have one either, and it only ever mattered as a
    // fallback until a live price arrived). Starting value is just what
    // was paid - not a false "worth $0" claim, and syncParentAssetValue/
    // price-agent takes over the moment a live price actually exists.
    value: totalCostBasis,
    investment_bucket: $("holdingBucket").value.trim() || null,
  };
  // Captured before closeHoldingForm() clears editingHolding below.
  const wasEditing = !!editingHolding;
  // Moving a holding between accounts changes BOTH totals, so the old
  // parent is resynced too, not just the new one.
  const previousParentId = editingHolding?.parent_asset_id;
  const { error } = editingHolding
    ? await sb.from("assets").update(row).eq("id", editingHolding.id)
    : await sb.from("assets").insert(row);
  if (error) { flagField("holdingSymbol"); return toast(error.message); }
  // Mirrors exactly where Quick Add calls applyAssetDelta after its own
  // expenses.insert - re-checked against fundingAccountId/costBasisDelta
  // (not just "was a funding account selected") since a decrease must
  // never reach here even if a funding account happens to still be set.
  if (fundingAccountId && costBasisDelta > 0) {
    await applyAssetDelta(fundingAccountId, null, costBasisDelta, -1);
    await logActivity(
      "asset_adjust",
      `Bought ${quantity} ${symbol} - funded from ${acctName(fundingAccountId)}`,
      -costBasisDelta, undefined, fundingAccountId
    );
  }
  closeHoldingForm();
  await loadAssets();
  await syncParentAssetValue(parentId);
  if (previousParentId && previousParentId !== parentId) await syncParentAssetValue(previousParentId);
  await loadAssets();
  renderInvestments();
  renderNetWorth();
  toast(wasEditing ? "Holding updated" : "Holding added");
};

// ---- CONTRIBUTIONS (Investments tab) -------------------------------------
// One shared panel, retargeted per account - same pattern assetAdjustForm
// already uses for Checking/Cash (openAssetAdjust). Writing 'contribution'
// through logActivity (rather than a plain assets.update) is the whole
// point - it's what lets contributionLimitUsage() later tell "new money in"
// apart from a market gain or a manual correction.
let contributingAssetId = null;
function closeContributionForm() {
  $("contributionForm").classList.add("hidden");
  contributingAssetId = null;
}
function openContributionForm(assetId) {
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) return;
  // Tapping the same account's link again while its panel is already open
  // closes it - same toggle-shut convenience openAssetAdjust already has.
  if (contributingAssetId === assetId && !$("contributionForm").classList.contains("hidden")) {
    closeContributionForm();
    return;
  }
  contributingAssetId = assetId;
  $("contributionLabel").textContent = `Log a contribution to ${asset.name}`;
  $("contributionAmount").value = "";
  $("contributionDate").value = new Date().toISOString().slice(0, 10);
  $("contributionAmount").classList.remove("field-required");
  $("contributionForm").classList.remove("hidden");
  $("contributionForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("cancelContributionBtn").onclick = closeContributionForm;
$("contributionAmount").addEventListener("input", () => {
  $("contributionAmount").classList.toggle("field-required", !$("contributionAmount").value);
});
$("saveContributionBtn").onclick = async () => {
  const asset = assets.find((a) => a.id === contributingAssetId);
  if (!asset) return closeContributionForm();
  if (!$("contributionAmount").value) { flagField("contributionAmount"); return toast("Enter an amount"); }
  const amount = parseFloat($("contributionAmount").value);
  if (!Number.isFinite(amount) || amount <= 0) { flagField("contributionAmount"); return toast("Enter a positive amount"); }
  const occurred_at = $("contributionDate").value || new Date().toISOString().slice(0, 10);
  const newValue = Math.round((Number(asset.value) + amount) * 100) / 100;
  const { error } = await sb.from("assets").update({ value: newValue }).eq("id", asset.id);
  if (error) { flagField("contributionAmount"); return toast(error.message); }
  // account_id: the linked account if this asset has one (most investment
  // assets are standalone and won't), purely so Recent History's account
  // filter can also surface a contribution the same way it already does
  // for asset_adjust - asset_id (not account_id) is what
  // contributionLimitUsage() actually reads.
  const linkedAccountId = accounts.find((a) => a.linked_asset_id === asset.id)?.id ?? null;
  await logActivity(
    "contribution", `Contributed ${fmt(amount)} to ${asset.name}`,
    amount, occurred_at, linkedAccountId, null, null, asset.id
  );
  await syncParentAssetValue(asset.parent_asset_id); // no-op unless asset is itself a holding
  closeContributionForm();
  await loadAssets();
  renderInvestments();
  renderRecentTransactions();
  renderNetWorth();
  toast("Contribution logged");
};

$("saveInvestTargetBtn").onclick = async () => {
  // investTargetBucket is a fixed select with no blank option (see
  // populateInvestBucketSelects) - always a real bucket, nothing to
  // validate as "missing" the way a free-text field would need.
  const bucket = $("investTargetBucket").value;
  const target_percent = parseFloat($("investTargetPercent").value);
  if (!Number.isFinite(target_percent) || target_percent < 0 || target_percent > 100) { flagField("investTargetPercent"); return toast("Enter a valid target percent (0-100)"); }
  const { error } = await sb.from("investment_targets")
    .upsert({ bucket, target_percent }, { onConflict: "user_id,bucket" });
  if (error) { flagField("investTargetPercent"); return toast(error.message); }
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
  if (error) { flagField("investRiskLabel"); return toast(error.message); }
  profile = { ...(profile || {}), risk_label };
  toast("Risk label saved");
};

// Whichever side of accounts.linked_asset_id/linked_liability_id is set is
// where the live balance actually lives - an
// account row itself never stores a dollar value.
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

// Same account-picker shape as populateHistoryAccountSelect above, kept
// as its own separate select (not shared) since a user may reasonably
// want to look at a different account's history vs. its forecast at once.
function populateForecastAccountSelect() {
  const sel = $("forecastAccountSelect");
  const prev = sel.value;
  sel.innerHTML = accounts.map((a) => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join("");
  sel.value = accounts.some((a) => a.id === prev) ? prev : (accounts[0]?.id ?? "");
}
$("forecastAccountSelect").onchange = renderCashFlowForecast;

function renderCashFlowForecast() {
  const account = accounts.find((a) => a.id === $("forecastAccountSelect").value);
  if (!account) return;
  const points = forecastCashFlow(account, accountCurrentBalance(account), subscriptions, incomeSources, 30);
  const labels = points.map((p) => {
    const [y, m, d] = p.date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  renderLineChart($("forecastChart"), labels, points.map((p) => p.balance));
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

// RAG retrieval, additive to buildQaContext's recent-window data (see
// supabase/45_expense_embeddings.sql's header for the full rationale).
// Embeds the question, vector-searches expense_embeddings for whatever's
// semantically relevant, and only ever looks at transactions strictly
// older than `sinceDate` (buildQaContext's own recent-window boundary) so
// nothing gets double-counted between the two sources. Best-effort by
// design, matching every other Gemma call in this app: a retrieval
// failure (embeddings not indexed yet, home machine unreachable, RPC
// error) must never block the actual answer, so any failure here just
// returns an empty array rather than throwing.
async function retrieveRelevantHistory(question, sinceDate) {
  try {
    const vector = await embedText(question, { endpoint: GEMMA_EMBED_ENDPOINT, model: GEMMA_EMBED_MODEL || "nomic-embed-text", key: GEMMA_AUTH_KEY });
    const { data: matches } = await sb.rpc("match_expense_embeddings", {
      query_embedding: vector, match_count: 10, before_date: sinceDate,
    });
    if (!matches?.length) return [];
    const ids = matches.map((m) => m.expense_id);
    const { data: rows } = await sb.from("expenses").select("*").in("id", ids);
    return (rows || []).map((e) => ({
      date: e.occurred_at,
      amount: Number(e.amount),
      category: e.category || null,
      description: e.description || e.merchant || null,
      payment_type: e.payment_type || null,
    }));
  } catch {
    return [];
  }
}

$("qaAskBtn").onclick = async () => {
  const question = $("qaQuestion").value.trim();
  if (!question) { flagField("qaQuestion"); return toast("Type a question first"); }
  if (!GEMMA_ENDPOINT) {
    $("qaStatus").textContent = "Not configured - set GEMMA_ENDPOINT in config.js (SETUP.md §3.6).";
    return;
  }
  $("qaAskBtn").disabled = true;
  $("qaAnswer").classList.add("hidden");
  // Sets an honest expectation up front rather than a bare "Thinking…" -
  // the home model can take up to ~20s (askGemma's own timeout) if it
  // wasn't already warmed up by loadReports() opening this page.
  $("qaStatus").textContent = "Thinking… (can take up to ~20s on the home model, less if you've had this page open a bit)";
  try {
    if (!allExpenses.length) await loadExpenses();
    const since = lastMonths(6)[0] + "-01"; // same boundary buildQaContext computes internally
    const relevantHistory = await retrieveRelevantHistory(question, since);
    const context = buildQaContext(allExpenses, subscriptions, 6, profile, relevantHistory);
    const answer = await askGemma(question, context, { endpoint: GEMMA_ENDPOINT, model: GEMMA_MODEL, key: GEMMA_AUTH_KEY });
    $("qaAnswer").textContent = answer;
    $("qaAnswer").classList.remove("hidden");
    // Transparency, matching this app's existing "state the real math/
    // scope, don't blend in silently" conventions (the ticker/bank-list
    // "comprehensive but not exhaustive" caveats, Daily health check's
    // real-numbers-only stance) - the user can see when older history
    // actually contributed to the answer, not just trust it happened.
    $("qaStatus").textContent = relevantHistory.length
      ? `Also found ${relevantHistory.length} older transaction${relevantHistory.length === 1 ? "" : "s"} related to this question.`
      : "";
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

  // Always "right now," not scoped to the selected month above - liquid
  // assets are a live current balance, not a historical figure, so
  // anchoring to today (not ym) keeps this from changing confusingly as
  // the user browses past months in the dropdown. Same reasoning the
  // account-history/net-worth-trend cards already use for staying
  // unscoped to monthSel.
  const efMonths = lastMonths(3, monthKey());
  const efAvgSpending = monthlyTotals(allExpenses, efMonths).reduce((s, v) => s + v, 0) / efMonths.length;
  const efLiquidAssets = accounts
    .filter((a) => !NON_SPENDABLE_ACCOUNT_TYPES.has(a.type) && !a.archived_at && a.linked_asset_id)
    .reduce((sum, a) => {
      const asset = assets.find((x) => x.id === a.linked_asset_id);
      return sum + (asset ? Number(asset.value) : 0);
    }, 0);
  const efCoverage = emergencyFundCoverage(efLiquidAssets, efAvgSpending);
  $("rptEmergencyFund").textContent = efCoverage != null ? `${efCoverage}mo` : "—";

  const empty = total === 0;
  $("rptEmpty").classList.toggle("hidden", !empty);

  const monthRows = allExpenses.filter((r) => (r.occurred_at || "").startsWith(ym));
  renderExpenseList("rptExpList", monthRows, "No expenses this month.");

  renderBreakdownBar($("catChart"), byCat);
  renderBreakdownBar($("acctChart"), byAcct);
  renderBreakdownBar($("payChart"), byPayment);
  const trailing = lastMonths(6, ym);
  renderTrendBar($("trendChart"), trailing, monthlyTotals(allExpenses, trailing));

  const incomeActivity = accountActivity.filter((a) => a.kind === "income");
  const ive = incomeVsExpense(incomeActivity, allExpenses, trailing);
  renderTrendBar($("incomeExpenseChart"), trailing, ive.map((r) => r.expense), {
    label: "Income", data: ive.map((r) => r.income), color: "#34d399",
  });
  const selectedMonth = ive.find((r) => r.month === ym);
  $("savingsRateStat").textContent = selectedMonth && selectedMonth.savingsRate != null
    ? signedPct(Math.round(selectedMonth.savingsRate * 1000) / 10)
    : "—";
}

// ---- MONTH REPORT EXPORT ---------------------------------------------------
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
// Set drawn from researched billing conventions.
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

async function loadIncome() {
  const { data, error } = await sb.from("income").select("*").order("next_expected", { ascending: true });
  if (error) { $("incomeList").innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
  incomeSources = data || [];
  renderIncomeList();
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
    // A real delete already stops this loop (account_id -> null on delete,
    // per schema, fails the !sub.account_id check above); archiving must
    // stop it the same way, or this would keep silently charging an
    // account that's supposed to act deleted every time the app loads.
    if (!account || account.archived_at) continue;
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

// Exact mirror of autoLogDueSubscriptions() above, deliberately - runs
// unprompted on every app load, no confirm-first step (checked the real
// subscription auto-logging behavior before assuming otherwise; there
// isn't one). A received paycheck increases an asset, so this uses
// applyAssetDelta(+1) instead of the expense-shaped insert + -1 delta
// subscriptions use, and logs to account_activity (kind: "income") rather
// than expenses, since income isn't spending - everything else (the
// per-source catch-up loop, the 36-cycle cap, updating next_expected only
// if it actually moved) is the same shape.
async function autoLogDueIncome() {
  const today = new Date().toISOString().slice(0, 10);
  let loggedCount = 0;

  for (const src of incomeSources) {
    if (!src.is_active || !src.next_expected || !src.account_id) continue;
    const account = accounts.find((a) => a.id === src.account_id);
    if (!account || account.archived_at || !account.linked_asset_id) continue;
    const amount = Number(src.amount);

    // one_time never advances (advanceIncomeDate returns it unchanged),
    // so it's handled as its own single-shot case rather than the
    // while-loop below - looping it would either infinite-loop (bounded
    // only by the 36-cycle cap) or double-log the same deposit repeatedly
    // across future app loads. Deactivating it here is what actually
    // stops that, not just the cap.
    if (src.cadence === "one_time") {
      if (src.next_expected > today) continue;
      await applyAssetDelta(src.account_id, null, amount, +1);
      await logActivity("income", src.source, amount, src.next_expected, src.account_id);
      loggedCount++;
      await sb.from("income").update({ is_active: false }).eq("id", src.id);
      continue;
    }

    let expected = src.next_expected;
    let cycles = 0;
    while (expected <= today && cycles < 36) {
      await applyAssetDelta(src.account_id, null, amount, +1);
      await logActivity("income", src.source, amount, expected, src.account_id);
      loggedCount++;
      expected = advanceIncomeDate(expected, src.cadence, src.semimonthly_day_1, src.semimonthly_day_2);
      cycles++;
    }
    if (expected !== src.next_expected) {
      await sb.from("income").update({ next_expected: expected }).eq("id", src.id);
    }
  }

  if (loggedCount) {
    await loadAssets();
    await loadIncome();
    toast(`Logged ${loggedCount} income deposit${loggedCount === 1 ? "" : "s"} automatically`);
  }
}

// ---- RECURRING-EXPENSE DETECTION (README appendix open decision, ROADMAP.md
// Log/Quick Add #1) --------------------------------------------------------
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
// One question per plan_type eligibilityUpsells() can nudge toward
// eligibility fields.
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
  // researched prices was explicitly deferred - see ROADMAP.md); the
  // mechanism is complete and will start surfacing rows the moment real
  // catalog data exists.
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
  renderAgentFreshness("deal-agent", "dealFindingsFreshness", "dealFindingsWarning");

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
          ${f.status === "candidate" && f.extracted_by === "regex" ? `<div class="muted" style="font-size:11px">pattern match${f.raw_snippet ? " - " + esc(f.raw_snippet) : ""}</div>` : ""}
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

// Promoting a candidate deal copies a
// finding's fields into subscription_catalog (a plain insert, not
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
  if (!name) { flagField("sName"); return toast("Service name required"); }
  if (!amount || amount <= 0) { flagField("sAmount"); return toast("Enter a valid amount"); }
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
  if (error) { flagField("sName"); return toast(error.message); }
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
  if (!sub.account_id) { flagField("sAccount"); return toast("Link an account to this subscription/bill first, then save, then mark as paid."); }
  const account = accounts.find((a) => a.id === sub.account_id);
  if (!account) { flagField("sAccount"); return toast("Linked account not found - pick one, save, then mark as paid."); }
  const amount = Number(sub.amount);
  const paymentType = account.type;
  const assetErr = assetDeltaError([{ accountId: sub.account_id, paymentType, amount, sign: -1 }]);
  if (assetErr) { flagField("sAccount"); return toast(assetErr); }

  const row = {
    amount, description: sub.name, merchant: sub.name,
    category: "Subscriptions", payment_type: paymentType,
    account_id: sub.account_id, occurred_at: new Date().toISOString().slice(0, 10),
    source: "manual",
  };
  $("markPaidBtn").disabled = true;
  const { error } = await sb.from("expenses").insert(row);
  if (error) { $("markPaidBtn").disabled = false; flagField("sAccount"); return toast(error.message); }
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

// ---- INCOME SOURCES (structurally mirrors subscriptions above) -----------
function renderIncomeList() {
  const sorted = [...incomeSources].sort((a, b) => (b.is_active - a.is_active) || a.source.localeCompare(b.source));
  $("incomeList").innerHTML = sorted.length
    ? sorted.map((s) => `
      <div class="exp" data-income="${s.id}" style="${s.is_active ? "" : "opacity:.5"}">
        <div>
          <div>${esc(s.source)}${s.is_active ? "" : " · (inactive)"}</div>
          <div class="meta">${cap(s.cadence.replace("_", " "))}${s.next_expected ? " · next " + s.next_expected : ""}${acctName(s.account_id) ? " · " + esc(acctName(s.account_id)) : ""}</div>
        </div>
        <span class="amt">${fmt(s.amount)}</span>
      </div>`).join("")
    : `<p class="muted">No income sources yet - add one above.</p>`;

  document.querySelectorAll("#incomeList [data-income]").forEach((el) => {
    el.onclick = () => {
      const src = incomeSources.find((x) => x.id === el.dataset.income);
      if (src) openIncomeForm(src);
    };
  });
}

function updateIncomeSemimonthlyVisibility() {
  $("incomeSemimonthlyRow").classList.toggle("hidden", $("incCadence").value !== "semimonthly");
}
$("incCadence").addEventListener("change", updateIncomeSemimonthlyVisibility);

const openNewIncomeForm = () => openIncomeForm(null);
$("addIncomeBtn").onclick = openNewIncomeForm;
$("cancelIncomeBtn").onclick = closeIncomeForm;

function openIncomeForm(src) {
  editingIncome = src;
  $("incomeFormTitle").textContent = src ? "Edit income source" : "New income source";
  $("incSource").value = src?.source ?? "";
  $("incAmount").value = src?.amount ?? "";
  $("incCadence").value = src?.cadence ?? "monthly";
  $("incSemimonthlyDay1").value = src?.semimonthly_day_1 ?? "";
  $("incSemimonthlyDay2").value = src?.semimonthly_day_2 ?? "";
  $("incNextExpected").value = src?.next_expected ?? "";
  $("incAccount").value = src?.account_id ?? "";
  $("incActive").checked = src ? !!src.is_active : true;
  $("incNotes").value = src?.notes ?? "";
  $("deleteIncomeBtn").classList.toggle("hidden", !src);
  updateIncomeSemimonthlyVisibility();
  $("incomeForm").classList.remove("hidden");
  $("incomeForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeIncomeForm() { $("incomeForm").classList.add("hidden"); editingIncome = null; }

$("saveIncomeBtn").onclick = async () => {
  const source = $("incSource").value.trim();
  const amount = parseFloat($("incAmount").value);
  if (!source) { flagField("incSource"); return toast("Source required"); }
  if (!amount || amount <= 0) { flagField("incAmount"); return toast("Enter a valid amount"); }
  const cadence = $("incCadence").value;
  let semimonthlyDay1 = null;
  let semimonthlyDay2 = null;
  if (cadence === "semimonthly") {
    semimonthlyDay1 = parseInt($("incSemimonthlyDay1").value, 10) || null;
    semimonthlyDay2 = parseInt($("incSemimonthlyDay2").value, 10) || null;
    if (!semimonthlyDay1 || !semimonthlyDay2) {
      flagField(["incSemimonthlyDay1", "incSemimonthlyDay2"]);
      return toast("Enter both pay days for a semimonthly source");
    }
  }
  const row = {
    source, amount, cadence,
    semimonthly_day_1: semimonthlyDay1,
    semimonthly_day_2: semimonthlyDay2,
    next_expected: $("incNextExpected").value || null,
    account_id: $("incAccount").value || null,
    is_active: $("incActive").checked,
    notes: $("incNotes").value.trim() || null,
  };
  $("saveIncomeBtn").disabled = true;
  const q = editingIncome
    ? sb.from("income").update(row).eq("id", editingIncome.id)
    : sb.from("income").insert(row);
  const { error } = await q;
  $("saveIncomeBtn").disabled = false;
  if (error) { flagField("incSource"); return toast(error.message); }
  closeIncomeForm();
  await loadIncome();
  toast(editingIncome ? "Income source updated" : "Income source added");
};

$("deleteIncomeBtn").onclick = async () => {
  if (!editingIncome) return;
  if (!(await confirmModal("This can't be undone.", { title: `Delete ${editingIncome.source}?` }))) return;
  const { error } = await sb.from("income").delete().eq("id", editingIncome.id);
  if (error) return toast(error.message);
  closeIncomeForm();
  await loadIncome();
  toast("Income source deleted");
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

// ---- HELP MODAL --------------------------------------------------------
// One shared modal (index.html) for all 4 pages' documentation - openHelp
// swaps which #helpContent* block and pill is active rather than opening
// four separate modals, so browsing another page's help doesn't need a
// close/reopen. Static content, no data to load - unlike every other
// modal in this file, this one has no corresponding loadX()/renderX().
const HELP_PAGES = ["log", "subs", "reports", "invest"];
const HELP_TITLES = { log: "Log page help", subs: "Subscriptions/Bills help", reports: "Reports help", invest: "Investments help" };
function openHelp(page) {
  $("helpModalTitle").textContent = HELP_TITLES[page];
  for (const p of HELP_PAGES) {
    $(`helpContent${cap(p)}`).classList.toggle("hidden", p !== page);
  }
  document.querySelectorAll("[data-help-page]").forEach((el) => {
    el.classList.toggle("active", el.dataset.helpPage === page);
  });
  $("helpModal").classList.remove("hidden");
}
$("helpLogBtn").onclick = () => openHelp("log");
$("helpSubsBtn").onclick = () => openHelp("subs");
$("helpReportsBtn").onclick = () => openHelp("reports");
$("helpInvestBtn").onclick = () => openHelp("invest");
$("helpClose").onclick = () => $("helpModal").classList.add("hidden");
document.querySelectorAll("[data-help-page]").forEach((el) => {
  el.onclick = () => openHelp(el.dataset.helpPage);
});

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
  if (error) { flagField("pName"); return toast(error.message); }
  profile = row;
  $("profileModal").classList.add("hidden");
  renderDeals(); // eligibility may have changed (e.g. now a student, or military)
  toast("Profile saved");
};

// A plain JSON dump of every table this
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
  if (!pw || pw.length < 6) { flagField("pNewPassword"); return toast("Password must be at least 6 characters"); }
  $("setPasswordBtn").disabled = true;
  $("setPasswordBtn").textContent = "Saving...";
  const { error } = await sb.auth.updateUser({ password: pw });
  $("setPasswordBtn").disabled = false;
  $("setPasswordBtn").textContent = "Set / change password";
  if (error) {
    flagField("pNewPassword");
    $("passwordSetMsg").textContent = error.message;
    toast("Couldn't set password");
    return;
  }
  $("pNewPassword").value = "";
  $("passwordSetMsg").textContent = "Password updated ✓";
  toast("Password updated ✓");
};