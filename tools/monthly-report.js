#!/usr/bin/env node
// ============================================================================
// Monthly spending report generator (server-machine script, same shape as
// tools/deal-agent.js). Runs alongside Ollama, talks to Gemma over localhost.
//
// Unlike deal-agent.js, this reads REAL personal financial data (per user),
// which is exactly why it has to run self-hosted rather than against any
// third-party API - see the privacy discussion in the project history.
//
// What it does, per distinct user with any expenses:
//   1. Pull last month's + prior month's expenses and active subscriptions
//      for that user_id (service_role bypasses RLS, so we filter explicitly
//      per user - never read across users into one prompt).
//   2. Aggregate into category totals + a month-over-month comparison.
//   3. Ask Gemma to write a short natural-language report from that summary.
//   4. Upsert one row per (user_id, period) into spending_insights.
//
// Setup: same tools/.env.deal-agent file as deal-agent.js (same env var
// names - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMMA_ENDPOINT,
// GEMMA_MODEL). SearXNG is not needed here, so no docker-compose wrapper -
// just run it directly:
//   node tools/monthly-report.js
//   DRY_RUN=1 node tools/monthly-report.js   # prints report text, no writes
//
// Intended schedule: monthly, e.g. the 1st of each month, covering the
// month that just ended. A cron/systemd timer entry (same pattern as
// run-deal-agent.sh) is a one-line addition once you're ready to schedule it.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMMA_ENDPOINT = process.env.GEMMA_ENDPOINT;
const GEMMA_MODEL = process.env.GEMMA_MODEL || "gemma";
const DRY_RUN = !!process.env.DRY_RUN;

const FETCH_TIMEOUT_MS = 10000;
const GEMMA_TIMEOUT_MS = 60000; // generous - Gemma may need to cold-load, same as deal-agent.js

function requireEnv() {
  const missing = ["SUPABASE_URL", "GEMMA_ENDPOINT"].filter((k) => !process.env[k]);
  if (!DRY_RUN) missing.push(...(!SERVICE_ROLE_KEY ? ["SUPABASE_SERVICE_ROLE_KEY"] : []));
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Supabase REST helpers (PostgREST, no SDK dependency) ------------------
async function sbGet(path) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function sbUpsert(table, rows, conflictCols) {
  if (DRY_RUN) {
    console.log(`[dry-run] would upsert ${rows.length} row(s) into ${table}:`);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCols}`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} -> HTTP ${res.status}: ${await res.text()}`);
}

// ---- Period helpers ---------------------------------------------------
function monthKey(d) {
  return d.toISOString().slice(0, 7);
}
function priorMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return monthKey(d);
}

// ---- Per-user data + aggregation ----------------------------------------
async function loadUserIds() {
  const rows = await sbGet("expenses?select=user_id");
  return [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
}

async function loadUserExpenses(userId, sinceYm) {
  return sbGet(
    `expenses?select=amount,category,occurred_at&user_id=eq.${userId}&occurred_at=gte.${sinceYm}-01`
  );
}

async function loadUserSubscriptions(userId) {
  return sbGet(`subscriptions?select=name,amount,billing_cycle,is_active&user_id=eq.${userId}&is_active=eq.true`);
}

function monthlyAmount(sub) {
  const amt = Number(sub.amount || 0);
  return sub.billing_cycle === "annual" ? amt / 12 : amt;
}

function summarize(expenses, period, prevPeriod) {
  const byCategory = {};
  let currentTotal = 0;
  let prevTotal = 0;
  for (const e of expenses) {
    const ym = (e.occurred_at || "").slice(0, 7);
    const amt = Number(e.amount || 0);
    if (ym === period) {
      currentTotal += amt;
      const cat = e.category || "Uncategorized";
      byCategory[cat] = Math.round(((byCategory[cat] || 0) + amt) * 100) / 100;
    } else if (ym === prevPeriod) {
      prevTotal += amt;
    }
  }
  return {
    period,
    total: Math.round(currentTotal * 100) / 100,
    prior_period: prevPeriod,
    prior_total: Math.round(prevTotal * 100) / 100,
    category_totals: byCategory,
  };
}

// ---- Gemma report generation ------------------------------------------
function buildReportPrompt(summary, subsMonthlyTotal) {
  return [
    "You are a personal finance assistant. Write a short monthly spending",
    "report (3-5 sentences, plain prose, no headers or markdown) for the",
    `period ${summary.period}, based ONLY on the data below. Mention the`,
    "total, the biggest category, how it compares to the prior month, and",
    "subscription costs. If something stands out (a spike, a cheap win),",
    "offer one brief, concrete suggestion - otherwise skip suggestions",
    "rather than inventing one. Be friendly and concise, no fluff.",
    "",
    `Data: ${JSON.stringify({ ...summary, subscriptions_monthly_total: subsMonthlyTotal })}`,
  ].join("\n");
}

async function warmUpGemma() {
  const start = Date.now();
  const res = await fetchWithTimeout(GEMMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: GEMMA_MODEL, prompt: "ping", stream: false }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma warm-up HTTP ${res.status}`);
  await res.json();
  console.log(`Gemma warm-up took ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function generateReport(summary, subsMonthlyTotal) {
  const res = await fetchWithTimeout(GEMMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      prompt: buildReportPrompt(summary, subsMonthlyTotal),
      stream: false,
    }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
  const data = await res.json();
  const text = typeof data.response === "string" ? data.response.trim() : "";
  if (!text) throw new Error("Gemma returned an empty report");
  return text;
}

// ---- Main ----------------------------------------------------------------
async function main() {
  requireEnv();

  const period = priorMonth(monthKey(new Date())); // the month that just ended
  const prevPeriod = priorMonth(period);
  console.log(`Generating reports for period ${period} (prior: ${prevPeriod})`);

  console.log("Warming up Gemma...");
  await warmUpGemma();

  const userIds = await loadUserIds();
  if (!userIds.length) {
    console.log("No users with expenses - nothing to report.");
    return;
  }
  console.log(`Users with expenses: ${userIds.length}`);

  const rows = [];
  for (const userId of userIds) {
    try {
      const [expenses, subs] = await Promise.all([
        loadUserExpenses(userId, prevPeriod),
        loadUserSubscriptions(userId),
      ]);
      const summary = summarize(expenses, period, prevPeriod);
      if (summary.total === 0) {
        console.log(`[${userId}] no expenses in ${period} - skipping`);
        continue;
      }
      const subsMonthlyTotal = Math.round(subs.reduce((s, sub) => s + monthlyAmount(sub), 0) * 100) / 100;
      const report = await generateReport(summary, subsMonthlyTotal);
      rows.push({ user_id: userId, period, report, generated_by: "gemma" });
      console.log(`[${userId}] report generated`);
    } catch (err) {
      console.warn(`[${userId}] failed: ${err.message}`);
    }
  }

  if (!rows.length) {
    console.log("No reports generated this run.");
    return;
  }
  await sbUpsert("spending_insights", rows, "user_id,period");
  console.log(`Wrote ${rows.length} report(s) to spending_insights.`);
}

main().catch((err) => {
  console.error("Report run failed:", err);
  process.exit(1);
});
