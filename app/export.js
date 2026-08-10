// ============================================================================
// CSV export for a month's report.
// Pure, unit-testable - same style as networth.js/budgets.js. PDF export
// (window.print() against an isolated print view, not a library) lives in
// app.js instead, since it's inherently DOM/window work, not pure logic.
// ============================================================================

// RFC 4180: a field containing a comma, quote, or newline must be quoted,
// with any internal quotes doubled.
function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {object[]} rows expense rows (occurred_at, description/merchant,
 *   category, payment_type, account_id, amount)
 * @param {(id:string)=>string} [accountName] resolves account_id to a
 *   display name - passed in rather than imported, same reasoning sumBy()
 *   (charts.js) already takes one, so this stays decoupled from app.js's
 *   `accounts` global.
 */
export function buildExpensesCsv(rows, accountName = () => "") {
  const header = ["Date", "Description", "Category", "Payment Type", "Account", "Amount"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push([
      r.occurred_at,
      r.description || r.merchant || "",
      r.category || "",
      r.payment_type || "",
      accountName(r.account_id) || "",
      Number(r.amount).toFixed(2),
    ].map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}
