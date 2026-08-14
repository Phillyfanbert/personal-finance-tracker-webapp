#!/usr/bin/env node
// ============================================================================
// Live asset price agent. Same architecture as
// tools/deal-agent.js (F6), reused rather than duplicated conceptually -
// runs on the SERVER MACHINE ONLY, alongside SearXNG and Ollama. Never runs
// in the browser, never ships in the PWA, needs the Supabase SERVICE_ROLE
// key - keep that out of the repo (env var only).
//
// Built on this dormant pipeline instead of a real market-data API by
// explicit choice: virtually every stock/crypto price API is either paid,
// rate-limited without a key, or both - a hard conflict with this project's
// $0/no-card constraint (README §1.4). SearXNG+Gemma is $0 and already
// running on the server machine for F6.
//
// What it does, per distinct assets.price_symbol in use across all users
// (a symbol's price is a public fact, not user-specific - same reasoning
// deal_findings already uses for service prices):
//   1. Query SearXNG for the symbol's current price, keeping only results
//      on a small hardcoded allowlist of reputable finance-data domains
//      (TRUSTED_PRICE_DOMAINS below) - same "never guess a domain" posture
//      already established by the Option C decision,
//      just a fixed list instead of a per-service table, since price
//      sources are generic rather than per-symbol the way subscription
//      pricing pages are per-service.
//   2. Fetch each surviving page's text and ask Gemma to extract a price as
//      strict JSON (same pattern as app/gemma.js's parseWithGemma).
//   3. If a price was found, one more best-effort step: search for recent
//      news on the symbol (TRUSTED_NEWS_DOMAINS, a superset of the price
//      allowlist) and ask Gemma for a short neutral explanation of why the
//      price moved (Investments tab). One attempt per symbol per run, not
//      per price-finding row - the news search doesn't depend on which
//      allowlisted page happened to produce the price. Failure here
//      (search, fetch, or Gemma) never blocks the price write itself;
//      explanation just stays null, same failure-tolerance as step 2.
//   4. Write validated findings to asset_price_findings via the REST API
//      using the service_role key (bypasses RLS by design).
//
// Also runs the exact same 4-step pipeline against a small FIXED list of
// major market indexes (MARKET_INDEXES below - S&P 500, NASDAQ, ...),
// writing to a separate market_index_findings table instead (Investments
// tab's Daily overview) - see that constant's own comment for why this
// reuses processSymbol()/findExplanation() unchanged rather than forking.
//
// Setup (on the server machine, next to Ollama and deal-agent.js):
//   Shares tools/.env.deal-agent (same env vars, see that file's header) -
//   no separate env file needed. Run directly:
//   node tools/price-agent.js            # writes findings
//   DRY_RUN=1 node tools/price-agent.js  # prints what it would write, no DB writes
//   Or via tools/run-price-agent.sh, which brings SearXNG up/down around it,
//   same as tools/run-deal-agent.sh does for the deal agent.
//
// Scheduling: not wired up yet (the F6 Phase D item - same
// unresolved question applies here) - run manually or via your own
// cron/systemd timer for now. A price goes stale far faster than a
// subscription plan price does, so this probably wants a tighter interval
// than deal-agent.js's weekly cadence once that's set up - daily, maybe,
// not continuously (same hammering-SearXNG concern deal-agent.js's own
// header already raises).
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEARXNG_URL = process.env.SEARXNG_URL;
const GEMMA_ENDPOINT = process.env.GEMMA_ENDPOINT;
const GEMMA_MODEL = process.env.GEMMA_MODEL || "gemma";
const DRY_RUN = !!process.env.DRY_RUN;

// A small, deliberately conservative allowlist - reputable finance-data
// sources only, not "any page that mentions a price." Extend this list
// rather than removing the allowlist entirely if a legitimate source keeps
// getting filtered out.
const TRUSTED_PRICE_DOMAINS = [
  "finance.yahoo.com",
  "marketwatch.com",
  "google.com",
  "coinmarketcap.com",
  "coingecko.com",
  "morningstar.com",
  "nasdaq.com",
];

// Superset of the price domains, plus a couple of dedicated news outlets -
// a "why did this move" explanation benefits from an actual news article,
// which a pure price-quote page usually doesn't have.
const TRUSTED_NEWS_DOMAINS = [...TRUSTED_PRICE_DOMAINS, "reuters.com", "cnbc.com"];

const RESULTS_PER_QUERY = 2;
const PAGE_TEXT_LIMIT = 4000;
const FETCH_TIMEOUT_MS = 8000;
const GEMMA_TIMEOUT_MS = 60000;
const REQUEST_DELAY_MS = 1000;

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

// ---- Watchlist: every symbol in use across all users -----------------------
async function loadWatchlist() {
  const rows = await sbGet("assets?select=price_symbol&price_symbol=not.is.null");
  return [...new Set(rows.map((r) => (r.price_symbol || "").trim()).filter(Boolean))];
}

function buildQueries(symbol) {
  return [`${symbol} price today`, `${symbol} current price USD`];
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
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "personal-finance-agent-price-checker/0.1" } });
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
function buildExtractionPrompt(symbol, pageText) {
  return [
    "You extract a current market price from webpage text. Respond with ONLY",
    'a JSON object, no prose, no code fences. Use this exact shape:',
    '{ "price": number|null, "currency": string|null, "confidence": number }',
    `The symbol is "${symbol}". confidence is 0..1, how sure you are this is`,
    "the current price of this exact symbol (not a different, similarly-named one).",
    "If you cannot find a clear current price, set price to null.",
    `Page text: ${JSON.stringify(pageText)}`,
  ].join("\n");
}

function validateFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const currency = typeof raw.currency === "string" && raw.currency.trim() ? raw.currency.trim().toUpperCase() : "USD";
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : 0.5;
  return { price: Math.round(price * 10000) / 10000, currency, confidence };
}

async function extractWithGemma(symbol, pageText) {
  const res = await fetchWithTimeout(GEMMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      prompt: buildExtractionPrompt(symbol, pageText),
      stream: false,
      format: "json",
    }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
  const data = await res.json();
  const payload = "response" in data ? JSON.parse(data.response) : data;
  return validateFinding(payload);
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

// ---- "Why did this move" explanation (Investments tab, best-effort) -------
function buildNewsQuery(symbol) {
  return `${symbol} stock price today news`;
}

function buildExplanationPrompt(symbol, pageText) {
  return [
    "You explain why a stock or crypto price moved, based on webpage text.",
    'Respond with ONLY a JSON object, no prose, no code fences. Use this',
    'exact shape: { "explanation": string|null, "confidence": number }',
    `The symbol is "${symbol}". explanation should be a short, neutral,`,
    "1-2 sentence summary of why the price moved today, only if the text",
    "actually gives a reason (earnings, news, a market-wide move, etc).",
    "confidence is 0..1, how sure you are this reason is real and specific",
    "to this exact symbol. If the text gives no clear reason, set",
    "explanation to null rather than guessing.",
    `Page text: ${JSON.stringify(pageText)}`,
  ].join("\n");
}

function validateExplanation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const explanation = typeof raw.explanation === "string" && raw.explanation.trim() ? raw.explanation.trim() : null;
  if (!explanation) return null;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : 0.5;
  return { explanation, confidence };
}

async function extractExplanationWithGemma(symbol, pageText) {
  const res = await fetchWithTimeout(GEMMA_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      prompt: buildExplanationPrompt(symbol, pageText),
      stream: false,
      format: "json",
    }),
  }, GEMMA_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemma HTTP ${res.status}`);
  const data = await res.json();
  const payload = "response" in data ? JSON.parse(data.response) : data;
  return validateExplanation(payload);
}

// One attempt per symbol per run (not per price-finding row - see the
// header comment). Every failure mode here (search, fetch, Gemma) is
// caught and logged, never thrown - this must never take down a run that
// otherwise found a valid price.
async function findExplanation(symbol) {
  let results;
  try {
    results = await searchSearxng(buildNewsQuery(symbol));
  } catch (err) {
    console.warn(`[${symbol}] news search failed: ${err.message}`);
    return null;
  }
  await sleep(REQUEST_DELAY_MS);

  const allowed = results.filter((r) => hostAllowed(r.url, TRUSTED_NEWS_DOMAINS)).slice(0, 2);
  for (const result of allowed) {
    let pageText;
    try {
      pageText = await fetchPageText(result.url);
    } catch (err) {
      console.warn(`[${symbol}] news page fetch failed for ${result.url}: ${err.message}`);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    let extracted;
    try {
      extracted = await extractExplanationWithGemma(symbol, pageText);
    } catch (err) {
      console.warn(`[${symbol}] explanation extraction failed for ${result.url}: ${err.message}`);
      continue;
    }
    if (extracted) return extracted.explanation;
  }
  return null;
}

// ---- Per-symbol pipeline ----------------------------------------------
async function processSymbol(symbol) {
  const findings = [];
  for (const query of buildQueries(symbol)) {
    let results;
    try {
      results = await searchSearxng(query);
    } catch (err) {
      console.warn(`[${symbol}] search failed for "${query}": ${err.message}`);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    const allowed = results.filter((r) => hostAllowed(r.url, TRUSTED_PRICE_DOMAINS)).slice(0, RESULTS_PER_QUERY);
    for (const result of allowed) {
      let pageText;
      try {
        pageText = await fetchPageText(result.url);
      } catch (err) {
        console.warn(`[${symbol}] page fetch failed for ${result.url}: ${err.message}`);
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      let extracted;
      try {
        extracted = await extractWithGemma(symbol, pageText);
      } catch (err) {
        console.warn(`[${symbol}] extraction failed for ${result.url}: ${err.message}`);
        continue;
      }
      if (!extracted) continue;

      findings.push({
        symbol,
        price: extracted.price,
        currency: extracted.currency,
        url: result.url,
        source_query: query,
        raw_snippet: (result.content || "").slice(0, 500),
        confidence: extracted.confidence,
        extracted_by: "gemma",
        explanation: null,
      });
    }
  }

  if (findings.length) {
    const explanation = await findExplanation(symbol);
    if (explanation) {
      for (const f of findings) f.explanation = explanation;
    }
  }
  return findings;
}

// ---- Market indexes (Investments tab, Daily overview) ---------------------
// Fixed - unlike the per-user watchlist above, a market index isn't
// something anyone "holds," so this always runs every time regardless of
// what any user's assets.price_symbol contains. Mirror this list in
// app.js's own MARKET_INDEXES if it ever changes - this file has no
// import/export machinery to share it with app/*.js, same as
// TRUSTED_PRICE_DOMAINS already has no client-side counterpart either.
//
// Deliberately reuses processSymbol()/findExplanation() unchanged rather
// than forking parallel index-specific query/prompt builders: passing a
// full plain-English label ("S&P 500") as the "symbol" already produces
// sensible search queries and a sensible Gemma extraction target (the
// prompts don't hard-require a ticker shape), and market_index_findings'
// columns deliberately mirror asset_price_findings' for exactly this
// reuse. The wording in buildExplanationPrompt ("why a stock or crypto
// price moved") is slightly imprecise for an index - accepted as
// best-effort, same honesty stance the rest of this file already takes on
// explanation quality, rather than forking the whole pipeline to fix one
// word.
const MARKET_INDEXES = ["S&P 500", "Dow Jones Industrial Average", "NASDAQ Composite", "Russell 2000"];

// ---- Market movers watchlist (Investments tab, "Today's top movers") -----
// A fixed, curated list of well-known large-cap stocks - NOT each user's
// own holdings (that's the per-user watchlist above) - so the UI can rank
// "today's biggest movers" even for a user who holds nothing. Same category
// as MARKET_INDEXES immediately above (public market data, tied to no
// user), so it's searched the same way and written to the SAME
// market_index_findings table rather than a new one - that table's real
// meaning was always "public market data," not literally "indexes only."
// Must match app.js's own MARKET_MOVERS_WATCHLIST constant, kept in sync by
// hand for the same reason MARKET_INDEXES already is.
const MARKET_MOVERS_WATCHLIST = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "UNH",
  "XOM", "JNJ", "WMT", "PG", "MA", "HD", "DIS", "NFLX", "AMD", "KO",
];

// ---- Main ----------------------------------------------------------------
async function main() {
  requireEnv();

  const watchlist = await loadWatchlist();
  console.log(`Watchlist (${watchlist.length}): ${watchlist.join(", ")}`);
  console.log(`Market indexes (${MARKET_INDEXES.length}): ${MARKET_INDEXES.join(", ")}`);
  console.log(`Market movers watchlist (${MARKET_MOVERS_WATCHLIST.length}): ${MARKET_MOVERS_WATCHLIST.join(", ")}`);

  if (!watchlist.length && !MARKET_INDEXES.length && !MARKET_MOVERS_WATCHLIST.length) {
    console.log("Nothing to search for. Exiting.");
    return;
  }

  console.log("Warming up Gemma...");
  await warmUpGemma();

  const allFindings = [];
  for (const symbol of watchlist) {
    console.log(`Searching: ${symbol}`);
    const findings = await processSymbol(symbol);
    console.log(`  -> ${findings.length} finding(s)`);
    allFindings.push(...findings);
  }
  if (allFindings.length) {
    await sbInsert("asset_price_findings", allFindings);
    console.log(`Wrote ${allFindings.length} finding(s) to asset_price_findings.`);
  } else {
    console.log("No asset findings this run.");
  }

  const allIndexFindings = [];
  for (const label of MARKET_INDEXES) {
    console.log(`Searching index: ${label}`);
    const findings = await processSymbol(label);
    console.log(`  -> ${findings.length} finding(s)`);
    allIndexFindings.push(...findings);
  }
  for (const symbol of MARKET_MOVERS_WATCHLIST) {
    console.log(`Searching mover: ${symbol}`);
    const findings = await processSymbol(symbol);
    console.log(`  -> ${findings.length} finding(s)`);
    allIndexFindings.push(...findings);
  }
  if (allIndexFindings.length) {
    await sbInsert("market_index_findings", allIndexFindings);
    console.log(`Wrote ${allIndexFindings.length} finding(s) to market_index_findings (indexes + movers watchlist).`);
  } else {
    console.log("No market index or movers findings this run.");
  }
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
