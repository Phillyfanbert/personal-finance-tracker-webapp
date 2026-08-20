// Cloudflare Worker entry point. Everything except /api/* falls through to
// the static app/ assets, same as before this file existed.
//
// SUPABASE_URL/SUPABASE_ANON_KEY are hardcoded (not Runtime env vars) -
// neither is secret. The anon key is already shipped client-side in
// app/config.js; Row Level Security is what actually protects data, not
// keeping this string hidden. FINNHUB_API_KEY below is the one real
// secret, and must be set as a Worker Runtime secret in the Cloudflare
// dashboard (Settings -> Runtime -> Variables and secrets) - a different
// panel from the Build-time secrets tools/generate-config.js reads.
const SUPABASE_URL = "https://ixosipgbikygqilbgvjx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5-glVkeUx8LsOOe12x3OPQ_F8x-sa8w";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/price") return handlePriceRequest(url, request, env);
    if (url.pathname === "/api/quotes") return handleQuotesRequest(url, request, env);
    return env.ASSETS.fetch(request);
  },
};

const SYMBOL_RE = /^[A-Z.\-]{1,10}$/;

// One Investments-page refresh asks for the 20-symbol movers watchlist, the
// 4 index ETF proxies, and whatever tickers the user actually owns. The cap
// also keeps this route inside the free plan's 50-subrequests-per-request
// limit: worst case is 40 uncached quote lookups plus the one Supabase auth
// check below.
const MAX_SYMBOLS_PER_REQUEST = 40;

// Finnhub's free tier allows 60 calls/minute and the Investments page
// refreshes once a minute for ~25 symbols, so without this two people with
// the app open at once would sit right at that ceiling. A Worker isolate is
// reused across requests, so caching here means every viewer shares one
// upstream call per symbol per TTL instead of each paying for their own -
// which is what keeps this route's cost flat as viewers are added.
//
// Deliberately NOT the Cache API: wrangler.jsonc declares no route or
// custom domain, so this Worker is served from a workers.dev hostname,
// where Cloudflare's edge cache is bypassed and caches.default would
// silently no-op. A module-scope Map has no such caveat. An isolate being
// evicted just means the next request re-fetches - correct, only slower.
const QUOTE_TTL_MS = 60000;
const quoteCache = new Map();

async function cachedQuote(symbol, env) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote;
  const quote = await fetchQuote(symbol, env);
  // A transient upstream failure is deliberately not cached - pinning a
  // null onto this symbol for the rest of the TTL would turn one bad
  // moment into a minute of missing prices. An unknown symbol IS cached,
  // since that's a real, stable answer rather than a failure.
  if (quote !== null) quoteCache.set(symbol, { at: Date.now(), quote });
  return quote;
}

// null means "couldn't ask" (upstream error); { price: null } means
// "asked, and this symbol isn't real."
async function fetchQuote(symbol, env) {
  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${env.FINNHUB_API_KEY}`
  );
  if (!res.ok) return null;
  const quote = await res.json();
  // Finnhub returns c: 0 (not an HTTP error) for an unknown symbol - the
  // same signal tools/price-agent.js's validateFinnhubQuote() handles
  // server-side.
  if (!Number.isFinite(quote.c) || quote.c <= 0) return { price: null };
  return {
    price: quote.c,
    // d/dp/pc ride along on the same quote call at no extra cost. They're
    // a real previous close rather than the day-over-day comparison the
    // client otherwise derives by diffing two stored findings rows.
    change: Number.isFinite(quote.d) ? quote.d : null,
    changePct: Number.isFinite(quote.dp) ? quote.dp : null,
    previousClose: Number.isFinite(quote.pc) && quote.pc > 0 ? quote.pc : null,
  };
}

// Confirms the caller is a real signed-in user of this app before spending
// a Finnhub call on their behalf - the only real abuse concern at this
// app's ~2-user scale, no separate rate-limiting product needed.
async function isSignedIn(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: SUPABASE_ANON_KEY },
  });
  return userRes.ok;
}

// Single-symbol lookup for the Holdings form's "Buying now" mode. Response
// shape ({ price }) is unchanged from before /api/quotes existed - app.js's
// fetchLivePriceOnDemand() reads exactly that.
async function handlePriceRequest(url, request, env) {
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) return json({ error: "invalid symbol" }, 400);
  if (!(await isSignedIn(request))) return json({ error: "unauthorized" }, 401);

  const quote = await cachedQuote(symbol, env);
  if (quote === null) return json({ error: "upstream error" }, 502);
  return json({ price: quote.price });
}

// Batch lookup for the Investments page's live overlay. A symbol that
// couldn't be reached is simply absent from `quotes` rather than present
// with a null - the client falls back to its stored finding for that
// symbol, so "no answer" and "answered null" need to stay tellable apart.
async function handleQuotesRequest(url, request, env) {
  const raw = (url.searchParams.get("symbols") || "").trim().toUpperCase();
  const symbols = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) return json({ error: "no symbols" }, 400);
  if (symbols.length > MAX_SYMBOLS_PER_REQUEST) return json({ error: "too many symbols" }, 400);
  if (!symbols.every((s) => SYMBOL_RE.test(s))) return json({ error: "invalid symbol" }, 400);
  if (!(await isSignedIn(request))) return json({ error: "unauthorized" }, 401);

  const results = await Promise.all(
    symbols.map(async (symbol) => [symbol, await cachedQuote(symbol, env)])
  );
  const quotes = {};
  for (const [symbol, quote] of results) {
    if (quote && quote.price != null) quotes[symbol] = quote;
  }
  return json({ quotes });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
