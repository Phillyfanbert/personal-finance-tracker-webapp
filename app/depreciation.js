// ============================================================================
// Vehicle depreciation (Option A).
// Pure, unit-testable - same style as networth.js/subscriptions.js.
// ============================================================================

/**
 * Estimated current value from a flat annual depreciation rate, compounded
 * continuously by elapsed years (not a per-year step function, so it moves
 * smoothly day to day rather than jumping once a year).
 * @param {number} purchasePrice
 * @param {string} purchaseDate ISO "YYYY-MM-DD"
 * @param {number} annualRate 0-1 (0.15 = 15%/year)
 * @returns {number|null} null if any input is missing
 */
export function estimateValue(purchasePrice, purchaseDate, annualRate, asOf = new Date()) {
  if (purchasePrice == null || !purchaseDate || annualRate == null) return null;
  // +"T00:00:00" - same defensive parse as daysUntil/advanceRenewal
  // (subscriptions.js), so a bare date string isn't read as UTC midnight
  // and off by a day in the browser's local timezone.
  const purchased = new Date(purchaseDate + "T00:00:00");
  // Clamped at 0: a purchase date in the future (or asOf still on the
  // purchase day) hasn't depreciated anything yet, and Math.pow with a
  // negative exponent would otherwise inflate the value above the
  // purchase price, which isn't meaningful before the purchase happened.
  const years = Math.max(0, (asOf - purchased) / (365.25 * 86400000));
  return Math.round(Number(purchasePrice) * Math.pow(1 - Number(annualRate), years) * 100) / 100;
}

/**
 * The value to actually use for display/net-worth: the live depreciation
 * estimate for a vehicle with full purchase info, otherwise the asset's
 * own stored `value` unchanged - every other asset type behaves exactly
 * as it always has.
 */
export function effectiveAssetValue(asset, asOf = new Date()) {
  if (asset.type !== "vehicle") return Number(asset.value || 0);
  const estimate = estimateValue(asset.purchase_price, asset.purchase_date, asset.depreciation_rate, asOf);
  return estimate ?? Number(asset.value || 0);
}
