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
        explanation: latest?.explanation || null,
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
