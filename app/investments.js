// ============================================================================
// Investments tab. Pure, unit-testable - same style as budgets.js/
// networth.js. asset_price_findings is insert-only (tools/price-agent.js
// never updates or deletes a row), so it's already a real historical price
// series per symbol once the agent runs regularly - no separate price-
// history table needed for the day-change/trend math below.
// ============================================================================
import { effectiveAssetValue } from "./depreciation.js";

const r2 = (n) => Math.round(n * 100) / 100;
const pct = (num, denom) => (denom ? r2((num / denom) * 100) : null);

// found_at is a timestamptz; the date part is what groups "a day's price."
const dateKey = (iso) => (iso || "").slice(0, 10);

// Findings for one symbol, grouped by day, each day represented by its
// latest (most recently found) finding that day - a stand-in for "that
// day's price" since the agent isn't guaranteed to run at a fixed time.
function dailyFindingsForSymbol(findings, symbol) {
  const bySymbol = findings.filter((f) => (f.symbol || "").trim().toUpperCase() === symbol);
  const byDay = new Map();
  for (const f of bySymbol) {
    const day = dateKey(f.found_at);
    const existing = byDay.get(day);
    if (!existing || new Date(f.found_at) > new Date(existing.found_at)) byDay.set(day, f);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One row per asset with a price_symbol set - the ticker-tracked holdings.
 * Symbol-less investment assets (a blended 401(k), say) are handled
 * separately in portfolioTotals(), since there's no per-share price to
 * compute gain/loss or a day-change against.
 * @param {object[]} assets
 * @param {object[]} priceFindings rows from asset_price_findings
 */
export function investmentHoldings(assets, priceFindings) {
  return assets
    .filter((a) => a.price_symbol)
    .map((a) => {
      const symbol = a.price_symbol.trim().toUpperCase();
      const quantity = a.quantity != null ? Number(a.quantity) : null;
      const days = dailyFindingsForSymbol(priceFindings, symbol);
      const latest = days.length ? days[days.length - 1][1] : null;
      const prior = days.length > 1 ? days[days.length - 2][1] : null;

      const latestPrice = latest ? Number(latest.price) : null;
      // Falls back to the asset's own stored value with no live finding yet
      // (e.g. before the price pipeline is running), so the tab is useful
      // from day one, not just once live pricing is live.
      const currentValue = latestPrice != null && quantity != null
        ? r2(latestPrice * quantity)
        : Number(a.value || 0);
      const costBasis = a.purchase_price != null ? Number(a.purchase_price) : null;
      const gainLoss = costBasis != null ? r2(currentValue - costBasis) : null;
      const gainLossPct = costBasis ? pct(gainLoss, costBasis) : null;

      const priorPrice = prior ? Number(prior.price) : null;
      const dayChange = latestPrice != null && priorPrice != null && quantity != null
        ? r2((latestPrice - priorPrice) * quantity)
        : null;
      const priorValue = priorPrice != null && quantity != null ? priorPrice * quantity : null;
      const dayChangePct = dayChange != null ? pct(dayChange, priorValue) : null;

      return {
        asset: a, symbol, quantity, latestPrice, currentValue, costBasis,
        gainLoss, gainLossPct, priorPrice, dayChange, dayChangePct,
        explanation: latestExplanationForSymbol(priceFindings, symbol),
        headlines: latestHeadlinesForSymbol(priceFindings, symbol),
      };
    });
}

/**
 * Portfolio-wide totals. `investmentAssets` is every investment-flavored
 * asset (app.js's INVESTMENT_ASSET_TYPES), a superset of `holdings`' own
 * ticker-tracked assets - a symbol-less one still contributes its value to
 * totalValue, just with no gain/loss or day-change math (nothing to
 * compare it against). Cost-basis and day-change totals are scoped only to
 * holdings that actually have that data, rather than mixing in undated/
 * uncosted assets and silently understating the real gain/loss.
 * @param {object[]} holdings from investmentHoldings()
 * @param {object[]} investmentAssets every investment-flavored asset
 */
export function portfolioTotals(holdings, investmentAssets) {
  const bySymbolAssetId = new Set(holdings.map((h) => h.asset.id));
  const symbolLessValue = investmentAssets
    .filter((a) => !bySymbolAssetId.has(a.id))
    .reduce((s, a) => s + effectiveAssetValue(a), 0);
  const holdingsValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const totalValue = r2(holdingsValue + symbolLessValue);

  const withCostBasis = holdings.filter((h) => h.costBasis != null);
  const totalCostBasis = r2(withCostBasis.reduce((s, h) => s + h.costBasis, 0));
  const totalGainLoss = withCostBasis.length
    ? r2(withCostBasis.reduce((s, h) => s + h.currentValue, 0) - totalCostBasis)
    : null;

  const withDayChange = holdings.filter((h) => h.dayChange != null);
  const todayChange = withDayChange.length
    ? r2(withDayChange.reduce((s, h) => s + h.dayChange, 0))
    : null;
  const todayPriorValue = withDayChange.length
    ? withDayChange.reduce((s, h) => s + h.currentValue, 0) - todayChange
    : null;

  return {
    totalValue,
    totalCostBasis,
    totalGainLoss,
    totalGainLossPct: totalGainLoss != null ? pct(totalGainLoss, totalCostBasis) : null,
    todayChange,
    todayChangePct: todayChange != null ? pct(todayChange, todayPriorValue) : null,
  };
}

/**
 * Current allocation (grouped by investment_bucket) measured against each
 * of the user's own targets - a calculator, not a recommendation. Only
 * buckets with a target set are returned; gapDollars is signed (positive =
 * under target, negative = over) so the number informs the user's own
 * decision rather than telling them what to do.
 * @param {object[]} assets investment-flavored assets with investment_bucket set
 * @param {object[]} holdings from investmentHoldings() - used for a
 *   ticker-tracked asset's live-priced value, so a bucket's current value
 *   matches the same number the holdings list itself shows, not a stale
 *   `assets.value` that hasn't had a finding "Applied" to it yet.
 * @param {object[]} targets rows from investment_targets (bucket, target_percent)
 */
export function allocationVsTarget(assets, holdings, targets) {
  const valueById = new Map(holdings.map((h) => [h.asset.id, h.currentValue]));
  const bucketed = assets.filter((a) => a.investment_bucket);
  const valueOf = (a) => valueById.get(a.id) ?? effectiveAssetValue(a);
  const totalValue = bucketed.reduce((s, a) => s + valueOf(a), 0);
  const byBucket = new Map();
  for (const a of bucketed) {
    const key = a.investment_bucket;
    byBucket.set(key, (byBucket.get(key) || 0) + valueOf(a));
  }
  return targets.map((t) => {
    const currentValue = r2(byBucket.get(t.bucket) || 0);
    const currentPct = totalValue ? pct(currentValue, totalValue) : 0;
    const targetPercent = Number(t.target_percent);
    const targetValue = totalValue * (targetPercent / 100);
    const gapDollars = r2(targetValue - currentValue);
    return { bucket: t.bucket, currentValue, currentPct, targetPercent, gapDollars };
  });
}

/**
 * Annual contribution-limit usage per group, for the groups the user
 * actually has a qualifying account in (a group with zero matching assets
 * is omitted entirely, not shown as "$0 of $X" - see
 * the code comments in app.js for why only some types are
 * tracked at all, and which types share one limit vs. have their own).
 *
 * limitGroups' shape (keyed by group id, defined in app.js as
 * CONTRIBUTION_LIMIT_GROUPS - kept out of this pure module, same as
 * INVESTMENT_ASSET_TYPES/ACCOUNT_TYPES already are, since the groups are
 * app-level configuration, not a calculation this module owns):
 *   { [groupId]: { types: string[], limit: number, label: string } }
 *
 * A contribution counts toward a group if its account_activity row has
 * kind 'contribution', its asset_id resolves to an asset whose type is in
 * that group, and its occurred_at falls in the given year - deliberately
 * NOT "any balance increase," which would double-count ordinary market
 * gains as if they were new money (the entire reason 'contribution' exists
 * as its own account_activity kind rather than reusing asset_adjust).
 *
 * @param {object[]} assets every asset (used to map an asset id -> its type)
 * @param {object[]} contributionActivity account_activity rows with kind 'contribution'
 * @param {Object} limitGroups CONTRIBUTION_LIMIT_GROUPS from app.js
 * @param {Date} [today]
 */
export function contributionLimitUsage(assets, contributionActivity, limitGroups, today = new Date()) {
  const year = String(today.getFullYear());
  const typeById = new Map(assets.map((a) => [a.id, a.type]));
  const results = [];
  for (const [groupId, group] of Object.entries(limitGroups)) {
    const hasQualifyingAsset = assets.some((a) => group.types.includes(a.type));
    if (!hasQualifyingAsset) continue;
    const contributed = r2(
      contributionActivity
        .filter((row) => group.types.includes(typeById.get(row.asset_id)))
        .filter((row) => (row.occurred_at || "").startsWith(year))
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
    );
    results.push({
      groupId,
      label: group.label,
      limit: group.limit,
      contributed,
      remaining: r2(group.limit - contributed),
      overLimit: contributed > group.limit,
    });
  }
  return results;
}

// A bucket counts as "off target" once it drifts this many percentage
// points from its own target - same "flag it before it's actually over,
// not just after" shape as budgets.js's WARN_THRESHOLD_PCT, applied to
// allocation drift instead of budget overspend.
export const ALLOCATION_DRIFT_WARN_PCT = 5;

// A contribution group counts as "approaching" its limit at 90% used, not
// just once actually over - same threshold and reasoning as budgets.js's
// WARN_THRESHOLD_PCT.
const CONTRIBUTION_APPROACHING_PCT = 90;

/**
 * Compiles the numbers already computed elsewhere on the Investments tab
 * (portfolioTotals, allocationVsTarget, contributionLimitUsage, and the
 * per-holding price data from investmentHoldings) into a short list of
 * status lines for the "Daily health check" card at the top of the tab.
 * Deliberately a compilation of real, already-computed facts - never a
 * fabricated composite score. Same boundary this app already draws for
 * the Liabilities card's credit-utilization line: real math shown back to
 * the user, not an invented number presented as authoritative.
 *
 * Returns raw structured data, not formatted strings - app.js does the
 * fmt()/esc()/text-assembly, same separation portfolioTotals/
 * allocationVsTarget/contributionLimitUsage already keep between
 * calculation and presentation. Each line has a `tone` of 'ok' (green),
 * 'warn' (needs attention), or 'neutral' (no data yet / nothing to flag) -
 * a UI hint only, callers pick the actual color.
 *
 * A line is omitted entirely (not shown with a "no data" placeholder) when
 * its underlying section has nothing to compile from at all (no allocation
 * targets set, no contribution tracking, no ticker holdings) - same
 * "omit rather than fake a zero" rule contributionLimitUsage itself
 * already follows for a group with no qualifying account.
 *
 * @param {object} totals from portfolioTotals()
 * @param {object[]} allocation from allocationVsTarget()
 * @param {object[]} limitUsage from contributionLimitUsage()
 * @param {object[]} holdings from investmentHoldings()
 */
export function portfolioHealthSummary(totals, allocation, limitUsage, holdings) {
  const lines = [];

  lines.push(totals.todayChange != null
    ? { kind: "today", tone: totals.todayChange >= 0 ? "ok" : "warn", value: totals.totalValue, change: totals.todayChange, changePct: totals.todayChangePct }
    : { kind: "today", tone: "neutral", value: totals.totalValue, change: null, changePct: null });

  lines.push(totals.totalGainLoss != null
    ? { kind: "gainLoss", tone: totals.totalGainLoss >= 0 ? "ok" : "warn", gainLoss: totals.totalGainLoss, gainLossPct: totals.totalGainLossPct }
    : { kind: "gainLoss", tone: "neutral", gainLoss: null, gainLossPct: null });

  // Only the single furthest-off-target bucket, not the whole table - the
  // full breakdown already has its own card/chart further down the page.
  if (allocation.length) {
    const worst = allocation.reduce((a, b) =>
      Math.abs(b.currentPct - b.targetPercent) > Math.abs(a.currentPct - a.targetPercent) ? b : a
    );
    const drift = r2(worst.currentPct - worst.targetPercent);
    lines.push({
      kind: "allocation",
      tone: Math.abs(drift) >= ALLOCATION_DRIFT_WARN_PCT ? "warn" : "ok",
      bucket: worst.bucket,
      drift,
    });
  }

  if (limitUsage.length) {
    const overCount = limitUsage.filter((u) => u.overLimit).length;
    const approachingCount = limitUsage.filter(
      (u) => !u.overLimit && u.limit > 0 && (u.contributed / u.limit) * 100 >= CONTRIBUTION_APPROACHING_PCT
    ).length;
    lines.push({
      kind: "contributions",
      tone: overCount || approachingCount ? "warn" : "ok",
      overCount,
      approachingCount,
      groupCount: limitUsage.length,
    });
  }

  // Only meaningful once at least one ticker holding exists - a portfolio
  // of purely blended/symbol-less accounts (a plain 401(k) with no
  // per-ticker detail) has no live-pricing concept to report on at all.
  if (holdings.length) {
    const priced = holdings.filter((h) => h.latestPrice != null).length;
    lines.push({
      kind: "pricing",
      tone: priced === holdings.length ? "ok" : "neutral",
      priced,
      total: holdings.length,
    });
  }

  return lines;
}

/**
 * Daily overview of a fixed set of major market indexes (S&P 500, NASDAQ,
 * ...) - genuinely NOT tied to anything the user owns, unlike every other
 * function in this module. Same day-over-day shape as investmentHoldings
 * (reuses dailyFindingsForSymbol), just against market_index_findings and
 * a fixed label list (app.js's MARKET_INDEXES) instead of each user's own
 * assets.price_symbol. An index with no finding yet (the price-agent
 * hasn't run, or hasn't found this particular one yet) still gets a row
 * back with price/change left null, rather than being dropped - callers
 * show a per-row "not available yet" state, same graceful-degradation
 * posture the rest of this dormant pipeline already has.
 * @param {string[]} indexes MARKET_INDEXES from app.js
 * @param {object[]} findings rows from market_index_findings
 */
export function marketIndexSummary(indexes, findings) {
  return indexes.map((label) => {
    const days = dailyFindingsForSymbol(findings, label.toUpperCase());
    const latest = days.length ? days[days.length - 1][1] : null;
    const prior = days.length > 1 ? days[days.length - 2][1] : null;

    const price = latest ? Number(latest.price) : null;
    const priorPrice = prior ? Number(prior.price) : null;
    const change = price != null && priorPrice != null ? r2(price - priorPrice) : null;
    const changePct = change != null ? pct(change, priorPrice) : null;

    return {
      label, price, change, changePct,
      explanation: latestExplanationForSymbol(findings, label.toUpperCase()),
      headlines: latestHeadlinesForSymbol(findings, label.toUpperCase()),
    };
  });
}

/**
 * Today's biggest movers from a fixed stock watchlist (app.js's
 * MARKET_MOVERS_WATCHLIST) - same "public market data, not tied to any
 * user" category as marketIndexSummary above, and literally reuses it
 * (the watchlist is just another label list against the same findings)
 * rather than re-deriving price/change math a second time. Ranked by the
 * size of the move regardless of direction, so a big drop shows up here
 * just as readily as a big gain. A symbol with no day-over-day change yet
 * (price-agent has only found it once so far, or not at all) has nothing
 * to rank it by, so it's excluded rather than sorted in as a false 0%.
 * @param {string[]} watchlist MARKET_MOVERS_WATCHLIST from app.js
 * @param {object[]} findings rows from market_index_findings
 * @param {number} n how many movers to return
 */
export function topMarketMovers(watchlist, findings, n = 3) {
  return marketIndexSummary(watchlist, findings)
    .filter((m) => m.changePct != null)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, n);
}

/**
 * A purely computed market-breadth signal - how many of the tracked
 * large-cap movers are up/down/flat today, and the average change across
 * the four index ETF proxies (app.js's MARKET_INDEX_ETF_PROXIES) -
 * deliberately NOT the same thing as market_news_findings.sentiment,
 * which is a real AI read of actual news coverage and requires a Gemini
 * call that's constrained by its real daily quota. This needs no
 * external call at all: every number here is already loaded client-side
 * (the same Finnhub-only data topMarketMovers/marketIndexSummary already
 * read), so it's available exactly as often as real prices are - every
 * 15 minutes, with zero rate-limit exposure. A plain count of real,
 * already-displayed numbers, not an interpretation of them - stays
 * strictly on the "show real math" side of this app's established
 * never-fabricate-a-score line, the same restraint portfolioHealthSummary
 * and the credit-utilization line already hold. Returns null only when
 * there's truly nothing to compute from yet (no day-change data at all),
 * matching this app's "omit rather than fake a number" convention.
 * @param {string[]} watchlist MARKET_MOVERS_WATCHLIST from app.js
 * @param {string[]} etfTickers Object.values(MARKET_INDEX_ETF_PROXIES) from app.js
 * @param {object[]} findings rows from market_index_findings
 */
export function marketBreadth(watchlist, etfTickers, findings) {
  const movers = marketIndexSummary(watchlist, findings).filter((m) => m.changePct != null);
  const up = movers.filter((m) => m.changePct > 0).length;
  const down = movers.filter((m) => m.changePct < 0).length;
  const flat = movers.length - up - down;

  const etfRows = marketIndexSummary(etfTickers, findings).filter((e) => e.changePct != null);
  const avgEtfChangePct = etfRows.length
    ? r2(etfRows.reduce((sum, e) => sum + e.changePct, 0) / etfRows.length)
    : null;

  if (!movers.length && avgEtfChangePct == null) return null;
  return { up, down, flat, total: movers.length, avgEtfChangePct };
}

/**
 * Freshest found_at among Finnhub-sourced findings (real ticker prices,
 * refreshed on a much tighter cadence - see tools/price-agent.js's
 * FAST_ONLY mode) - deliberately separate from a row's Gemini-sourced
 * siblings (market indexes, "why did it move" explanations), which stay
 * on the slower weekly cadence. Mixing the two into one freshness read
 * would be misleading once they diverge: a card could say "12 minutes
 * ago" while its index data is actually a week stale. Works against
 * either assetPriceFindings (a user's own watchlist) or
 * marketIndexFindings (movers), both share the same extracted_by/found_at
 * shape. Returns null when there's nothing Finnhub-sourced yet.
 * @param {object[]} findings rows from asset_price_findings or market_index_findings
 */
export function latestFinnhubRefresh(findings) {
  const finnhub = findings.filter((f) => f.extracted_by === "finnhub" && f.found_at);
  if (!finnhub.length) return null;
  return finnhub.reduce((latest, f) => (new Date(f.found_at) > new Date(latest) ? f.found_at : latest), finnhub[0].found_at);
}

/**
 * Most recent real headlines for one symbol, or null if none exist yet.
 * Deliberately does NOT reuse dailyFindingsForSymbol() above - that picks
 * each day's single LATEST finding, but tools/price-agent.js only fetches
 * headlines on roughly 1 of every 4 FAST_ONLY runs
 * (shouldFetchNewsThisRun()), so the single most-recent row usually has
 * headlines: null even when a real, still-current set exists from up to
 * an hour ago. This scans every finding for the symbol instead, so a
 * fresher price-only row never hides an older row's still-good headlines.
 * @param {object[]} findings rows from asset_price_findings or market_index_findings
 * @param {string} symbol already-uppercased ticker
 */
/**
 * Most recent non-null explanation for one symbol, or null if there isn't
 * one. Same reason latestHeadlinesForSymbol below doesn't reuse
 * dailyFindingsForSymbol's "that day's latest row" pick: an explanation is
 * written only by the slow weekly Gemini pass, while price rows land every
 * 15 minutes (and every minute once app.js's live-quote overlay is
 * running), so the single most recent row for a symbol essentially never
 * carries one. Reading `latest.explanation` directly meant a perfectly
 * good explanation was blanked by the next price-only row - verified
 * against production, where 0 of 24 symbols had an explanation on their
 * latest row while one genuinely had a current explanation in the window.
 * @param {object[]} findings rows from asset_price_findings or market_index_findings
 * @param {string} symbol already-uppercased ticker
 */
export function latestExplanationForSymbol(findings, symbol) {
  const withExplanation = findings.filter(
    (f) => (f.symbol || "").trim().toUpperCase() === symbol && f.explanation && f.found_at
  );
  if (!withExplanation.length) return null;
  return withExplanation.reduce((latest, f) => (new Date(f.found_at) > new Date(latest.found_at) ? f : latest)).explanation;
}

export function latestHeadlinesForSymbol(findings, symbol) {
  const withHeadlines = findings.filter(
    (f) => (f.symbol || "").trim().toUpperCase() === symbol && Array.isArray(f.headlines) && f.headlines.length && f.found_at
  );
  if (!withHeadlines.length) return null;
  return withHeadlines.reduce((latest, f) => (new Date(f.found_at) > new Date(latest.found_at) ? f : latest)).headlines;
}

/**
 * Most recent valid daily market news digest (headlines + overall
 * sentiment), or null if there's nothing usable yet. Defensive even
 * though tools/price-agent.js already validates before writing - matches
 * this module's existing "no DOM/fetch, tolerate partial data" style.
 * @param {object[]} findings rows from market_news_findings
 */
export function latestNewsDigest(findings) {
  if (!findings.length) return null;
  const latest = [...findings].sort((a, b) => new Date(b.found_at) - new Date(a.found_at))[0];
  const headlines = Array.isArray(latest.headlines)
    ? latest.headlines.filter((h) => h && h.title && h.url).slice(0, 5)
    : [];
  if (!headlines.length || !latest.sentiment) return null;
  return { headlines, sentiment: latest.sentiment, sentimentReason: latest.sentiment_reason || null, foundAt: latest.found_at };
}

/**
 * Whether the US equity market is in its regular session right now
 * (Mon-Fri, 9:30-16:00 America/New_York). Uses Intl with an explicit
 * timeZone rather than a fixed UTC offset so the DST shift is handled
 * without a lookup table of its own.
 *
 * Deliberately carries NO market-holiday list. One hardcoded here would
 * go stale and then state something false on a day it got wrong - the
 * same honesty caveat tickers.js/BANK_NAMES already carry, and the
 * reason this app won't fabricate a credit score or a sentiment label
 * it can't ground. A holiday instead surfaces the truthful way: this
 * reports open, no new price ever arrives, and app.js's existing
 * PRICE_REFRESH_WARN_MINUTES coloring flags the data as stale on its
 * own. That's why the caller only ever states the CLOSED case out loud
 * ("Market closed - prices as of X") and says nothing while open - a
 * wrong "closed" would be a false claim, a missing one is just silence.
 * @param {Date} now
 */
export function marketStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get("weekday");
  const minutesEt = Number(get("hour")) * 60 + Number(get("minute"));
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return {
    open: isWeekday && minutesEt >= 9 * 60 + 30 && minutesEt < 16 * 60,
    weekday,
    minutesEt,
  };
}

/**
 * The most recent stored daily recap (daily_recaps, 55_daily_recaps.sql),
 * or null if there's nothing usable yet. Defensive about the jsonb shape
 * the same way latestNewsDigest() above is - these columns are written by
 * a server-side script, so a partial or malformed row should render
 * nothing rather than throw inside a render path.
 *
 * `summary` is stage 2's batched Gemini synthesis and is null on every
 * stage-1 row; a recap is complete and worth showing without it, which is
 * the entire point of building the zero-LLM half first.
 * @param {object[]} recaps rows from daily_recaps
 */
export function latestRecap(recaps) {
  if (!recaps.length) return null;
  const latest = [...recaps].sort((a, b) =>
    (a.trade_date || "") < (b.trade_date || "") ? 1 : -1
  )[0];
  const movers = Array.isArray(latest.movers)
    ? latest.movers.filter((m) => m && m.symbol && m.change_pct != null)
    : [];
  // A recap with no rankable mover has nothing to say - omit it rather
  // than render an empty card, same convention marketBreadth() and
  // contributionLimitUsage() already follow.
  if (!movers.length) return null;
  return {
    tradeDate: latest.trade_date,
    movers,
    breadth: latest.breadth && Number.isFinite(Number(latest.breadth.total)) ? latest.breadth : null,
    indexMoves: Array.isArray(latest.index_moves)
      ? latest.index_moves.filter((i) => i && i.symbol && i.change_pct != null)
      : [],
    summary: latest.summary || null,
    generatedBy: latest.generated_by || "rollup",
  };
}
