// ============================================================================
// Discount discovery (README §3.7 / F6, v1 scope).
// Matches the user's ACTIVE subscriptions + profile against the curated
// subscription_catalog and surfaces cheaper, eligible plans.
// Pure & unit-testable; UI wiring lives in app.js.
// ============================================================================
import { monthlyAmount } from "./subscriptions.js";

/** Catalog price normalized to a monthly-equivalent (annual plans / 12). null if no price. */
export function catalogMonthly(entry) {
  if (entry.price === null || entry.price === undefined || entry.price === "") return null;
  const p = Number(entry.price);
  if (!Number.isFinite(p)) return null;
  return entry.plan_type === "annual" ? p / 12 : p;
}

// Approximate - real "senior discount" ages vary a lot by provider (50 for
// AARP-linked ones, 55-65 elsewhere). No catalog data uses this plan_type
// yet; tune this if/when real seeded entries need a specific threshold.
const SENIOR_AGE = 62;

function age(profile) {
  return profile?.birth_year ? new Date().getFullYear() - profile.birth_year : null;
}

/** Is the user eligible for a catalog plan given their profile? */
export function isEligible(entry, profile) {
  const status = profile?.status;
  switch (entry.plan_type) {
    case "student":
      return status === "student";      // needs verified student status
    case "military":
      return !!profile?.is_military;
    case "first_responder":
    case "healthcare":
      return !!profile?.is_first_responder_healthcare;
    case "senior": {
      const a = age(profile);
      return a !== null && a >= SENIOR_AGE;
    }
    case "individual":
    case "annual":
    case "family":
    default:
      return true;                       // available to anyone (family = household caveat)
  }
}

/** Loose service-name match, case-insensitive, tolerant of suffixes ("Spotify Premium"). */
export function matchService(subName, service) {
  const a = (subName || "").toLowerCase().trim();
  const b = (service || "").toLowerCase().trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * For each active subscription, find the cheapest ELIGIBLE catalog plan that
 * beats what the user currently pays (monthly-normalized).
 * @returns deals sorted by yearly savings, desc.
 */
export function findDeals(subscriptions, catalog, profile) {
  const deals = [];
  for (const sub of subscriptions) {
    if (!sub.is_active) continue;
    const current = monthlyAmount(sub);
    let best = null;
    for (const e of catalog) {
      if (!matchService(sub.name, e.service)) continue;
      if (!isEligible(e, profile)) continue;
      const m = catalogMonthly(e);
      if (m === null) continue;
      if (m < current - 0.01 && (!best || m < best.monthly)) best = { entry: e, monthly: m };
    }
    if (best) {
      const rawMonthly = current - best.monthly;
      const monthlySavings = r2(rawMonthly);
      deals.push({
        service: sub.name,
        currentMonthly: r2(current),
        planType: best.entry.plan_type,
        planMonthly: r2(best.monthly),
        planPrice: Number(best.entry.price),
        planCycle: best.entry.plan_type === "annual" ? "annual" : "monthly",
        eligibility: best.entry.eligibility || null,
        url: best.entry.url || null,
        notes: best.entry.notes || null,
        monthlySavings,
        yearlySavings: r2(rawMonthly * 12),
      });
    }
  }
  return deals.sort((a, b) => b.yearlySavings - a.yearlySavings);
}

/**
 * If the user is NOT marked as a student, find student-only plans they'd unlock
 * by setting that status - a gentle upsell (README §1.2 profile → F6).
 * @returns list of { service, studentMonthly, currentMonthly, potentialYearly }
 */
export function studentUpsell(subscriptions, catalog, profile) {
  if (profile?.status === "student") return [];
  const already = new Set(findDeals(subscriptions, catalog, profile).map((d) => d.service));
  const out = [];
  for (const sub of subscriptions) {
    if (!sub.is_active) continue;
    if (already.has(sub.name)) continue; // already have a non-student deal shown
    const current = monthlyAmount(sub);
    let best = null;
    for (const e of catalog) {
      if (e.plan_type !== "student") continue;
      if (!matchService(sub.name, e.service)) continue;
      const m = catalogMonthly(e);
      if (m === null) continue;
      if (m < current - 0.01 && (!best || m < best)) best = m;
    }
    if (best !== null) {
      out.push({
        service: sub.name,
        currentMonthly: r2(current),
        studentMonthly: r2(best),
        potentialYearly: r2((current - best) * 12),
      });
    }
  }
  return out.sort((a, b) => b.potentialYearly - a.potentialYearly);
}

// Generalizes studentUpsell() above for the profile-expansion eligibility
// fields - military, first_responder/healthcare, senior. Reuses
// isEligible() rather than re-deriving each profile-field check, so this
// and findDeals/isEligible can never silently disagree about what
// "eligible" means for a given plan_type. Currently has no catalog data
// to match against (seeding real researched prices was explicitly
// deferred), so this returns [] in practice today; the mechanism is
// complete and tested, it's just waiting on data, same shape
// studentUpsell() itself was in before any student catalog rows existed.
const UPSELLABLE_PLAN_TYPES = ["military", "first_responder", "healthcare", "senior"];

export function eligibilityUpsells(subscriptions, catalog, profile) {
  const already = new Set(findDeals(subscriptions, catalog, profile).map((d) => d.service));
  const out = [];
  for (const sub of subscriptions) {
    if (!sub.is_active) continue;
    if (already.has(sub.name)) continue;
    const current = monthlyAmount(sub);
    for (const planType of UPSELLABLE_PLAN_TYPES) {
      if (isEligible({ plan_type: planType }, profile)) continue; // already eligible - findDeals would've matched it
      let best = null;
      for (const e of catalog) {
        if (e.plan_type !== planType) continue;
        if (!matchService(sub.name, e.service)) continue;
        const m = catalogMonthly(e);
        if (m === null) continue;
        if (m < current - 0.01 && (!best || m < best)) best = m;
      }
      if (best !== null) {
        out.push({
          service: sub.name, planType,
          currentMonthly: r2(current), upsellMonthly: r2(best),
          potentialYearly: r2((current - best) * 12),
        });
        break; // one nudge per subscription - don't stack multiple plan-type nudges for the same sub
      }
    }
  }
  return out.sort((a, b) => b.potentialYearly - a.potentialYearly);
}
