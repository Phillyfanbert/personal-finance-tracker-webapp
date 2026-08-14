#!/usr/bin/env node
// ============================================================================
// F6 stretch - live deal-search agent.
// Runs on the SERVER MACHINE ONLY (the one already running Ollama), alongside
// SearXNG. Never runs in the browser, never ships in the PWA, and needs the
// Supabase SERVICE_ROLE key - keep that out of the repo (env var only).
//
// Deliberately talks to Gemma over localhost, not Tailscale or a public
// tunnel - running here means no network hop, no new device on any tailnet,
// and the most private option available (nothing about this feature leaves
// the machine except the final validated findings sent to Supabase).
//
// What it does, per active-subscription service:
//   1. Look up the service's allowlisted domain(s) in service_domains. No
//      entry -> skip and log (the Option C
//      decision - we never guess a domain).
//   2. Query SearXNG with a handful of angles (pricing, student, promo,
//      annual, family) and keep only results on an allowlisted domain.
//   3. Fetch each surviving page's text and ask Gemma to extract a plan as
//      strict JSON (same pattern as app/gemma.js's parseWithGemma).
//   4. Write validated findings to deal_findings via the REST API using the
//      service_role key (bypasses RLS by design - the PWA can only read).
//
// Setup (on the server machine, next to Ollama):
//   Preferred: copy tools/.env.deal-agent.example to tools/.env.deal-agent,
//   fill in real values, then run ./tools/run-deal-agent.sh - it brings
//   SearXNG up, runs this script, and tears SearXNG back down afterward.
//
//   This script can also be run directly with plain env vars:
//   export SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=sb_secret_...   # Dashboard -> API Keys. NEVER commit this.
//   export SEARXNG_URL=http://localhost:8080
//   export GEMMA_ENDPOINT=http://localhost:11434/api/generate
//   export GEMMA_MODEL=gemma3:4b   # exact tag from `ollama list` - "Gemma 4" is not a real tag
//   node tools/deal-agent.js            # writes findings
//   DRY_RUN=1 node tools/deal-agent.js  # prints what it would write, no DB writes
//
// Note: Ollama's dynamic model unloading means Gemma may need to cold-load
// on first use after being idle - that's why there's a warm-up call before
// the extraction loop, and why Gemma calls get a longer timeout than the
// SearXNG/page-fetch calls (see GEMMA_TIMEOUT_MS below).
//
// Scheduling (Phase D, not yet wired up): run this weekly via cron/systemd
// timer, not continuously - prices don't change fast enough to
// justify the compute, and hammering SearXNG risks getting upstream engines
// to rate-limit or block it.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEARXNG_URL = process.env.SEARXNG_URL;
const GEMMA_ENDPOINT = process.env.GEMMA_ENDPOINT;
const GEMMA_MODEL = process.env.GEMMA_MODEL || "gemma";
const DRY_RUN = !!process.env.DRY_RUN;

const RESULTS_PER_QUERY = 3;       // top N allowlisted results kept per query
const PAGE_TEXT_LIMIT = 4000;      // chars of page text sent to Gemma
const FETCH_TIMEOUT_MS = 8000;     // SearXNG + page fetches: fast, no model load involved
const GEMMA_TIMEOUT_MS = 60000;    // Gemma calls: generous - a dynamically-unloaded model
                                    // (Ollama keep_alive) can take well past 8s to cold-load
const REQUEST_DELAY_MS = 1000;     // politeness gap between outbound requests

function requireEnv() {
  const missing = ["SUPABASE_URL", "SEARXNG_URL", "GEMMA_ENDPOINT"].filter((k) => !process.env[k]);
  if (!DRY_RUN) missing.push(...(!SERVICE_ROLE_KEY ? ["SUPABASE_SERVICE_ROLE_KEY"] : []));
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function sbInsert(table, rows) {
  if (DRY_RUN) {
    console.log(`[dry-run] would insert ${rows.length} row(s) into ${table}:`);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} -> HTTP ${res.status}: ${await res.text()}`);
}

// ---- Watchlist: only services the user actually subscribes to --------------
async function loadWatchlist() {
  const rows = await sbGet("subscriptions?select=name&is_active=eq.true");
  return [...new Set(rows.map((r) => r.name).filter(Boolean))];
}

async function loadDomainMap(services) {
  if (!services.length) return new Map();
  const filter = `in.(${services.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",")})`;
  const rows = await sbGet(`service_domains?select=service,domains&service=${filter}`);
  return new Map(rows.map((r) => [r.service, r.domains]));
}

// ---- Query generation: multiple angles, not just "pricing" -----------------
function buildQueries(service) {
  return [
    `${service} pricing plans`,
    `${service} student discount`,
    `${service} promo code`,
    `${service} annual plan discount`,
    `${service} family plan price`,
  ];
}

// ---- SearXNG -----------------------------------------------------------
async function searchSearxng(query) {
  const url = `${SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

function hostAllowed(urlStr, domains) {
  try {
    const host = new URL(urlStr).hostname.replace(/^www\./, "");
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ---- Page fetch + strip -----------------------------------------------
async function fetchPageText(url) {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "personal-finance-agent-deal-checker/0.1" } });
  if (!res.ok) throw new Error(`Page fetch HTTP ${res.status}`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, PAGE_TEXT_LIMIT);
}

// ---- Gemma extraction (same strict-JSON contract style as app/gemma.js) ----
const PLAN_TYPES = ["individual", "student", "family", "annual"];

function buildExtractionPrompt(service, pageText) {
  return [
    "You extract subscription pricing from webpage text. Respond with ONLY a JSON",
    'object, no prose, no code fences. Use this exact shape:',
    '{ "plan_type": "individual"|"student"|"family"|"annual"|null, "price": number|null,',
    '  "eligibility": string|null, "confidence": number }',
    `The service is "${service}". confidence is 0..1, how sure you are this price is`,
    "current and correct for this exact service (not a different product).",
    "If you cannot find a clear price for this service, set price to null.",
    `Page text: ${JSON.stringify(pageText)}`,
  ].join("\n");
}

function validateFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const plan_type = PLAN_TYPES.includes(raw.plan_type) ? raw.plan_type : null;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : 0.5;
  const eligibility = typeof raw.eligibility === "string" && raw.eligibility.trim() ? raw.eligibility.trim() : null;
  return { price: Math.round(price * 100) / 100, plan_type, eligibility, confidence };
}

async function extractWithGemma(service, pageText) {
  const res = await fetchWithTimeout(GEMMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      prompt: buildExtractionPrompt(service, pageText),
      stream: false,
      format: "json",
    }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
  const data = await res.json();
  const payload = "response" in data ? JSON.parse(data.response) : data;
  return validateFinding(payload);
}

// Force the model to load before the extraction loop starts, so the first
// real extraction isn't racing a cold-load against its own timeout. Ollama
// keeps a model resident for a keep_alive window after any request,
// including this one, so the rest of the run should stay warm.
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

// ---- Per-service pipeline ----------------------------------------------
async function processService(service, domains) {
  const findings = [];
  for (const query of buildQueries(service)) {
    let results;
    try {
      results = await searchSearxng(query);
    } catch (err) {
      console.warn(`[${service}] search failed for "${query}": ${err.message}`);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    const allowed = results.filter((r) => hostAllowed(r.url, domains)).slice(0, RESULTS_PER_QUERY);
    for (const result of allowed) {
      let pageText;
      try {
        pageText = await fetchPageText(result.url);
      } catch (err) {
        console.warn(`[${service}] page fetch failed for ${result.url}: ${err.message}`);
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      let extracted;
      try {
        extracted = await extractWithGemma(service, pageText);
      } catch (err) {
        console.warn(`[${service}] extraction failed for ${result.url}: ${err.message}`);
        continue;
      }
      if (!extracted) continue;

      findings.push({
        service,
        plan_type: extracted.plan_type,
        price: extracted.price,
        eligibility: extracted.eligibility,
        url: result.url,
        source_query: query,
        raw_snippet: (result.content || "").slice(0, 500),
        confidence: extracted.confidence,
        extracted_by: "gemma",
      });
    }
  }
  return findings;
}

// ---- Main ----------------------------------------------------------------
async function main() {
  requireEnv();

  const watchlist = await loadWatchlist();
  if (!watchlist.length) {
    console.log("No active subscriptions - nothing to search for. Exiting.");
    return;
  }
  console.log(`Watchlist (${watchlist.length}): ${watchlist.join(", ")}`);

  console.log("Warming up Gemma...");
  await warmUpGemma();

  const domainMap = await loadDomainMap(watchlist);
  const skipped = watchlist.filter((s) => !domainMap.has(s));
  if (skipped.length) {
    console.log(
      `Skipping (no service_domains entry - add one to search these): ${skipped.join(", ")}`
    );
  }

  const allFindings = [];
  for (const service of watchlist) {
    const domains = domainMap.get(service);
    if (!domains) continue;
    console.log(`Searching: ${service} (allowed domains: ${domains.join(", ")})`);
    const findings = await processService(service, domains);
    console.log(`  -> ${findings.length} finding(s)`);
    allFindings.push(...findings);
  }

  if (!allFindings.length) {
    console.log("No findings this run.");
    return;
  }
  await sbInsert("deal_findings", allFindings);
  console.log(`Wrote ${allFindings.length} finding(s) to deal_findings.`);
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
