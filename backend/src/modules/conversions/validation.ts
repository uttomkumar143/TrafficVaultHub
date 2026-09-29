/**
 * Conversion validation pipeline (Phase 4 Unit 3; PRD §38–§40, §115).
 *
 * Pure, ordered, deterministic. The service pre-fetches every fact the checks
 * need (`ValidationFacts`) and this module answers PASS | REJECT | HOLD with a
 * per-check result list so the outcome is explainable after the fact.
 *
 * Order is cheap → expensive (PRD §38 "validate early"):
 *   1. advertiser identity       10. traffic rules
 *   2. offer                     11. fraud signals
 *   3. click                     12. offer-specific requirements
 *   4. affiliate
 *   5. conversion event
 *   6. timestamp
 *   7. attribution
 *   8. dedup
 *
 * Semantics:
 *   REJECT — a hard fact says the conversion cannot be valid; stop at the
 *            first REJECT (later checks are reported as SKIPPED).
 *   HOLD   — the conversion may be valid but needs a human (→ FRAUD_REVIEW);
 *            the pipeline keeps running so the reviewer sees every signal.
 *   PASS   — all checks passed → PENDING (never auto-APPROVED here; approval
 *            is a separate audited decision).
 *
 * A fraud score is a signal, never proof: HIGH holds, CRITICAL holds, nothing
 * in this module rejects on score alone (PRD §40).
 */

export type CheckStatus = "PASS" | "FAIL" | "HOLD" | "SKIPPED";

export type CheckResult = {
  readonly check: CheckName;
  readonly status: CheckStatus;
  readonly code: string;
  readonly detail?: string;
};

export const CHECK_NAMES = [
  "ADVERTISER_IDENTITY",
  "OFFER",
  "CLICK",
  "AFFILIATE",
  "CONVERSION_EVENT",
  "TIMESTAMP",
  "ATTRIBUTION",
  "DEDUP",
  "TRAFFIC_RULES",
  "FRAUD_SIGNALS",
  "OFFER_REQUIREMENTS",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type ValidationOutcome = "PASS" | "REJECT" | "HOLD";

export type ValidationResult = {
  readonly outcome: ValidationOutcome;
  /** Machine reason of the decisive check (first FAIL, else first HOLD, else VALIDATION_PASSED). */
  readonly reasonCode: string;
  readonly checks: readonly CheckResult[];
};

export type ValidationFacts = {
  readonly advertiser: {
    readonly organizationId: string;
    readonly organizationType: string;
    readonly organizationStatus: string;
  } | null;
  readonly offer: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: string;
    readonly conversionEvents: readonly string[];
    readonly requiresClick: boolean;
    readonly requiresSaleAmount: boolean;
    readonly allowedCurrencies: readonly string[];
    readonly minSaleAmountMinor: number | null;
  } | null;
  readonly click: {
    readonly id: string;
    readonly offerId: string;
    readonly affiliateOrganizationId: string | null;
    readonly occurredAt: string;
  } | null;
  readonly affiliate: {
    readonly organizationId: string;
    readonly organizationStatus: string;
    readonly hasOfferAccess: boolean;
  } | null;
  readonly conversion: {
    readonly conversionEvent: string;
    readonly saleAmountMinor: number | null;
    readonly currency: string | null;
    readonly occurredAt: string;
    readonly receivedAt: string;
  };
  readonly attribution: { readonly decision: string; readonly reasonCode: string } | null;
  readonly dedup: { readonly duplicateOfConversionId: string | null };
  readonly trafficRules: {
    readonly affiliateRestricted: boolean;
    readonly geoAllowed: boolean | null;
    readonly deviceAllowed: boolean | null;
  };
  readonly fraud: { readonly score: number; readonly level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" } | null;
  /** Tolerance for occurred_at in the future relative to received_at (ms). */
  readonly futureSkewMs?: number;
  /** Maximum age of occurred_at relative to received_at (ms). */
  readonly maxAgeMs?: number;
};

const DEFAULT_FUTURE_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const LIVE_OFFER_STATUSES: ReadonlySet<string> = new Set(["LIVE", "PAUSED", "CAP_REACHED", "BUDGET_EXHAUSTED"]);

function pass(check: CheckName, code = "OK"): CheckResult {
  return { check, status: "PASS", code };
}
function fail(check: CheckName, code: string, detail?: string): CheckResult {
  return detail === undefined ? { check, status: "FAIL", code } : { check, status: "FAIL", code, detail };
}
function hold(check: CheckName, code: string, detail?: string): CheckResult {
  return detail === undefined ? { check, status: "HOLD", code } : { check, status: "HOLD", code, detail };
}

type Check = (f: ValidationFacts) => CheckResult;

const checkAdvertiser: Check = (f) => {
  if (!f.advertiser) return fail("ADVERTISER_IDENTITY", "ADVERTISER_NOT_FOUND");
  if (f.advertiser.organizationType !== "ADVERTISER" && f.advertiser.organizationType !== "AGENCY")
    return fail("ADVERTISER_IDENTITY", "ORGANIZATION_NOT_ADVERTISER");
  if (f.advertiser.organizationStatus === "SUSPENDED" || f.advertiser.organizationStatus === "TERMINATED")
    return fail("ADVERTISER_IDENTITY", "ADVERTISER_INACTIVE", f.advertiser.organizationStatus);
  if (f.advertiser.organizationStatus === "RESTRICTED") return hold("ADVERTISER_IDENTITY", "ADVERTISER_RESTRICTED");
  return pass("ADVERTISER_IDENTITY");
};

const checkOffer: Check = (f) => {
  if (!f.offer) return fail("OFFER", "OFFER_NOT_FOUND");
  if (f.advertiser && f.offer.organizationId !== f.advertiser.organizationId) return fail("OFFER", "OFFER_NOT_OWNED");
  if (!LIVE_OFFER_STATUSES.has(f.offer.status)) return fail("OFFER", "OFFER_NOT_LIVE", f.offer.status);
  return pass("OFFER");
};

const checkClick: Check = (f) => {
  if (!f.click) {
    return f.offer?.requiresClick ? fail("CLICK", "CLICK_REQUIRED") : pass("CLICK", "NO_CLICK_OPTIONAL");
  }
  if (f.offer && f.click.offerId !== f.offer.id) return fail("CLICK", "CLICK_OFFER_MISMATCH");
  return pass("CLICK");
};

const checkAffiliate: Check = (f) => {
  if (!f.affiliate) {
    return f.click?.affiliateOrganizationId ? fail("AFFILIATE", "AFFILIATE_NOT_FOUND") : pass("AFFILIATE", "NO_AFFILIATE");
  }
  if (f.click?.affiliateOrganizationId && f.click.affiliateOrganizationId !== f.affiliate.organizationId)
    return fail("AFFILIATE", "AFFILIATE_CLICK_MISMATCH");
  if (f.affiliate.organizationStatus === "SUSPENDED" || f.affiliate.organizationStatus === "TERMINATED")
    return fail("AFFILIATE", "AFFILIATE_INACTIVE", f.affiliate.organizationStatus);
  if (!f.affiliate.hasOfferAccess) return fail("AFFILIATE", "AFFILIATE_NO_OFFER_ACCESS");
  if (f.affiliate.organizationStatus === "RESTRICTED") return hold("AFFILIATE", "AFFILIATE_RESTRICTED");
  return pass("AFFILIATE");
};

const checkEvent: Check = (f) => {
  const ev = f.conversion.conversionEvent;
  if (ev.length === 0) return fail("CONVERSION_EVENT", "EVENT_MISSING");
  if (f.offer && f.offer.conversionEvents.length > 0 && !f.offer.conversionEvents.includes(ev))
    return fail("CONVERSION_EVENT", "EVENT_NOT_CONFIGURED", ev);
  return pass("CONVERSION_EVENT");
};

const checkTimestamp: Check = (f) => {
  const occurred = Date.parse(f.conversion.occurredAt);
  const received = Date.parse(f.conversion.receivedAt);
  if (Number.isNaN(occurred) || Number.isNaN(received)) return fail("TIMESTAMP", "TIMESTAMP_INVALID");
  const futureSkew = f.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS;
  const maxAge = f.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (occurred > received + futureSkew) return fail("TIMESTAMP", "OCCURRED_IN_FUTURE");
  if (received - occurred > maxAge) return fail("TIMESTAMP", "OCCURRED_TOO_OLD");
  if (f.click) {
    const clickAt = Date.parse(f.click.occurredAt);
    if (!Number.isNaN(clickAt) && occurred < clickAt) return fail("TIMESTAMP", "CONVERSION_BEFORE_CLICK");
  }
  return pass("TIMESTAMP");
};

const checkAttribution: Check = (f) => {
  if (!f.attribution) return fail("ATTRIBUTION", "ATTRIBUTION_MISSING");
  switch (f.attribution.decision) {
    case "ATTRIBUTED":
      return pass("ATTRIBUTION", f.attribution.reasonCode);
    case "HELD":
      return hold("ATTRIBUTION", f.attribution.reasonCode);
    case "REJECTED":
    case "DUPLICATE":
      return fail("ATTRIBUTION", f.attribution.reasonCode);
    default:
      return fail("ATTRIBUTION", "ATTRIBUTION_DECISION_UNKNOWN", f.attribution.decision);
  }
};

const checkDedup: Check = (f) =>
  f.dedup.duplicateOfConversionId ? fail("DEDUP", "DUPLICATE_CONVERSION", f.dedup.duplicateOfConversionId) : pass("DEDUP");

const checkTrafficRules: Check = (f) => {
  if (f.trafficRules.affiliateRestricted) return hold("TRAFFIC_RULES", "AFFILIATE_TRAFFIC_RESTRICTED");
  if (f.trafficRules.geoAllowed === false) return fail("TRAFFIC_RULES", "GEO_NOT_ALLOWED");
  if (f.trafficRules.deviceAllowed === false) return fail("TRAFFIC_RULES", "DEVICE_NOT_ALLOWED");
  return pass("TRAFFIC_RULES");
};

const checkFraud: Check = (f) => {
  if (!f.fraud) return pass("FRAUD_SIGNALS", "NOT_SCORED");
  if (f.fraud.level === "HIGH" || f.fraud.level === "CRITICAL")
    return hold("FRAUD_SIGNALS", `FRAUD_${f.fraud.level}`, String(f.fraud.score));
  return pass("FRAUD_SIGNALS", `FRAUD_${f.fraud.level}`);
};

const checkOfferRequirements: Check = (f) => {
  if (!f.offer) return fail("OFFER_REQUIREMENTS", "OFFER_NOT_FOUND");
  const { saleAmountMinor, currency } = f.conversion;
  if (f.offer.requiresSaleAmount && (saleAmountMinor === null || currency === null))
    return fail("OFFER_REQUIREMENTS", "SALE_AMOUNT_REQUIRED");
  if (saleAmountMinor !== null && !Number.isInteger(saleAmountMinor)) return fail("OFFER_REQUIREMENTS", "SALE_AMOUNT_NOT_INTEGER");
  if (currency !== null && f.offer.allowedCurrencies.length > 0 && !f.offer.allowedCurrencies.includes(currency))
    return fail("OFFER_REQUIREMENTS", "CURRENCY_NOT_ALLOWED", currency);
  if (f.offer.minSaleAmountMinor !== null && saleAmountMinor !== null && saleAmountMinor < f.offer.minSaleAmountMinor)
    return fail("OFFER_REQUIREMENTS", "SALE_AMOUNT_BELOW_MINIMUM");
  return pass("OFFER_REQUIREMENTS");
};

const PIPELINE: readonly Check[] = [
  checkAdvertiser,
  checkOffer,
  checkClick,
  checkAffiliate,
  checkEvent,
  checkTimestamp,
  checkAttribution,
  checkDedup,
  checkTrafficRules,
  checkFraud,
  checkOfferRequirements,
];

export function validateConversion(facts: ValidationFacts): ValidationResult {
  const checks: CheckResult[] = [];
  let rejected: CheckResult | null = null;
  let held: CheckResult | null = null;
  for (let i = 0; i < PIPELINE.length; i++) {
    const run = PIPELINE[i];
    const name = CHECK_NAMES[i];
    if (!run || !name) continue;
    if (rejected) {
      checks.push({ check: name, status: "SKIPPED", code: "SKIPPED_AFTER_REJECT" });
      continue;
    }
    const result = run(facts);
    checks.push(result);
    if (result.status === "FAIL") rejected = result;
    else if (result.status === "HOLD" && !held) held = result;
  }
  if (rejected) return { outcome: "REJECT", reasonCode: rejected.code, checks };
  if (held) return { outcome: "HOLD", reasonCode: held.code, checks };
  return { outcome: "PASS", reasonCode: "VALIDATION_PASSED", checks };
}
