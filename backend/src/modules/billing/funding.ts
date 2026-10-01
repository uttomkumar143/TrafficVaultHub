/**
 * Advertiser funding capacity — Phase 5 Unit 8a (PRD §62). PURE: no I/O.
 *
 * Decides whether an advertiser can fund `required_minor` more spend under
 * its billing profile (migration 0011 `advertiser_billing_profiles`):
 *
 *   PREPAID  — capacity is the ADVERTISER_PREPAID ledger balance in the
 *              profile currency (credit − debit over ledger_entries, computed
 *              by the caller from the ledger — NEVER stored on the profile,
 *              see 0011 header). It arrives here as `facts.prepaid_balance_minor`.
 *              An overdrawn balance (negative) is a legitimate measured fact and
 *              yields capacity 0 (it is not an input amount, so it is not
 *              rejected like a negative limit would be).
 *   POSTPAID — capacity is credit_limit − used_credit; `payment_terms_days`
 *              only governs invoicing cadence and MUST be present (0011 CHECK);
 *              a profile without it is an invariant violation and is rejected.
 *   CREDIT   — capacity is credit_limit − used_credit.
 *
 * Status gates (any model): risk_status BLOCKED → capacity 0 (RISK_BLOCKED);
 * billing_status other than ACTIVE → capacity 0 (BILLING_INACTIVE).
 *
 * Money rules: INTEGER minor units only — floats, NaN, ±Infinity, unsafe
 * integers are rejected; credit_limit / used_credit / required must be ≥ 0.
 * `facts.currency` must equal the profile currency — mixed currency is an
 * error (FUNDING_CURRENCY_MISMATCH), never a conversion.
 *
 * Boundary: `ok` is `capacity_minor >= required_minor` — exact capacity is OK.
 */

import { isValidCurrency } from "../ledger/money";

export const FUNDING_MODELS = ["PREPAID", "POSTPAID", "CREDIT"] as const;
export type FundingModel = (typeof FUNDING_MODELS)[number];

export const RISK_STATUSES = ["NORMAL", "WATCH", "HIGH", "BLOCKED"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const BILLING_STATUSES = ["ACTIVE", "PAST_DUE", "SUSPENDED", "CLOSED"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const FUNDING_ERROR_CODES = [
  "FUNDING_INVALID_MODEL",
  "FUNDING_INVALID_CURRENCY",
  "FUNDING_CURRENCY_MISMATCH",
  "FUNDING_NOT_INTEGER",
  "FUNDING_NEGATIVE",
  "FUNDING_UNSAFE_INTEGER",
  "FUNDING_TERMS_REQUIRED",
  "FUNDING_PREPAID_BALANCE_REQUIRED",
  "FUNDING_INVALID_STATUS",
] as const;
export type FundingErrorCode = (typeof FUNDING_ERROR_CODES)[number];

export class FundingError extends Error {
  readonly code: FundingErrorCode;
  constructor(code: FundingErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FundingError";
    this.code = code;
  }
}

/** The subset of an `advertiser_billing_profiles` row the decision depends on. */
export interface BillingProfileFacts {
  readonly funding_model: FundingModel;
  readonly currency: string;
  readonly credit_limit_minor: number;
  readonly used_credit_minor: number;
  readonly payment_terms_days: number | null;
  readonly risk_status: RiskStatus;
  readonly billing_status: BillingStatus;
}

/** Facts measured by the caller at evaluation time. */
export interface FundingFacts {
  /** Must equal the profile currency. */
  readonly currency: string;
  /** Spend that must be fundable right now (≥ 0 integer minor units). */
  readonly required_minor: number;
  /**
   * ADVERTISER_PREPAID ledger balance (credit − debit) in `currency`. Required
   * for PREPAID profiles, ignored otherwise. May be negative (overdrawn).
   */
  readonly prepaid_balance_minor?: number;
}

export const CAPACITY_REASONS = ["OK", "INSUFFICIENT_CAPACITY", "RISK_BLOCKED", "BILLING_INACTIVE"] as const;
export type CapacityReason = (typeof CAPACITY_REASONS)[number];

export interface CapacityDecision {
  readonly ok: boolean;
  readonly reason: CapacityReason;
  readonly funding_model: FundingModel;
  readonly currency: string;
  /** Fundable spend right now, ≥ 0. */
  readonly capacity_minor: number;
  readonly required_minor: number;
  /** max(0, required − capacity). */
  readonly shortfall_minor: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (integers only; signed variant for measured balances)
// ---------------------------------------------------------------------------

function assertInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new FundingError("FUNDING_NOT_INTEGER", `${field}=${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) throw new FundingError("FUNDING_UNSAFE_INTEGER", `${field}=${String(value)}`);
  return value;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  const n = assertInteger(value, field);
  if (n < 0 || Object.is(n, -0)) throw new FundingError("FUNDING_NEGATIVE", `${field}=${String(value)}`);
  return n;
}

function isFundingModel(v: unknown): v is FundingModel {
  return (FUNDING_MODELS as readonly unknown[]).includes(v);
}

function assertProfile(p: BillingProfileFacts): void {
  if (!isFundingModel(p.funding_model)) throw new FundingError("FUNDING_INVALID_MODEL", String(p.funding_model));
  if (!isValidCurrency(p.currency)) throw new FundingError("FUNDING_INVALID_CURRENCY", `profile.currency=${String(p.currency)}`);
  if (!(RISK_STATUSES as readonly unknown[]).includes(p.risk_status)) {
    throw new FundingError("FUNDING_INVALID_STATUS", `risk_status=${String(p.risk_status)}`);
  }
  if (!(BILLING_STATUSES as readonly unknown[]).includes(p.billing_status)) {
    throw new FundingError("FUNDING_INVALID_STATUS", `billing_status=${String(p.billing_status)}`);
  }
  assertNonNegativeInteger(p.credit_limit_minor, "credit_limit_minor");
  assertNonNegativeInteger(p.used_credit_minor, "used_credit_minor");
  if (p.funding_model === "POSTPAID") {
    if (p.payment_terms_days === null || p.payment_terms_days === undefined) throw new FundingError("FUNDING_TERMS_REQUIRED");
    assertNonNegativeInteger(p.payment_terms_days, "payment_terms_days");
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Raw model capacity before status gates: PREPAID balance, or limit − used. Never negative. */
export function modelCapacity(profile: BillingProfileFacts, facts: FundingFacts): number {
  if (profile.funding_model === "PREPAID") {
    if (facts.prepaid_balance_minor === undefined) throw new FundingError("FUNDING_PREPAID_BALANCE_REQUIRED");
    const balance = assertInteger(facts.prepaid_balance_minor, "prepaid_balance_minor");
    return Math.max(0, balance);
  }
  // POSTPAID and CREDIT: credit_limit − used_credit (0011 keeps available_credit_minor equal to this).
  const available = profile.credit_limit_minor - profile.used_credit_minor;
  return Math.max(0, available);
}

/**
 * Can the advertiser fund `facts.required_minor` more spend? Pure; throws
 * FundingError on invalid money, mixed currency or an inconsistent profile.
 */
export function capacity(profile: BillingProfileFacts, facts: FundingFacts): CapacityDecision {
  assertProfile(profile);
  if (!isValidCurrency(facts.currency)) throw new FundingError("FUNDING_INVALID_CURRENCY", `facts.currency=${String(facts.currency)}`);
  if (facts.currency !== profile.currency) {
    throw new FundingError("FUNDING_CURRENCY_MISMATCH", `profile=${profile.currency} facts=${facts.currency}`);
  }
  const required = assertNonNegativeInteger(facts.required_minor, "required_minor");

  const base = {
    funding_model: profile.funding_model,
    currency: profile.currency,
    required_minor: required,
  };

  if (profile.risk_status === "BLOCKED") {
    return { ...base, ok: false, reason: "RISK_BLOCKED", capacity_minor: 0, shortfall_minor: required };
  }
  if (profile.billing_status !== "ACTIVE") {
    return { ...base, ...(modelCapacityOrZero(profile, facts)), ok: false, reason: "BILLING_INACTIVE", shortfall_minor: required };
  }

  const cap = modelCapacity(profile, facts);
  const shortfall = Math.max(0, required - cap);
  return {
    ...base,
    ok: shortfall === 0,
    reason: shortfall === 0 ? "OK" : "INSUFFICIENT_CAPACITY",
    capacity_minor: cap,
    shortfall_minor: shortfall,
  };
}

/**
 * For BILLING_INACTIVE we still validate the model inputs (so a bad PREPAID
 * fact is never silently accepted) but report capacity 0: an inactive
 * profile can fund nothing regardless of its balance or limit.
 */
function modelCapacityOrZero(profile: BillingProfileFacts, facts: FundingFacts): { capacity_minor: number } {
  modelCapacity(profile, facts);
  return { capacity_minor: 0 };
}
