/**
 * Payout eligibility (Phase 5 Unit 10) — PURE.
 *
 * Takes already-loaded facts (the repository/service in Unit 11+ gathers them)
 * and answers: may this org be paid `amount_minor` `currency` via this method
 * right now? Output is `{ eligible: true }` or `{ eligible: false, reasons[] }`
 * where every reason has a STABLE code — reasons are collected, not
 * short-circuited, so the snapshot (payouts.eligibility_snapshot) explains
 * everything that is wrong at once.
 *
 * Inputs (every one is checked individually by the tests):
 *   - available balance        reserve- and hold-aware (ledger/reserves computeAvailable
 *                              shape: available_minor may be NEGATIVE when over-reserved;
 *                              payable_minor = max(0, available)). We only trust the
 *                              caller's figure; we never recompute ledger math here.
 *   - minimum threshold        org / platform minimum payout in the SAME currency.
 *   - holding period           conversions younger than `holding_period_days` are not
 *                              yet payable; the caller supplies the oldest unpaid-earned
 *                              conversion age (or newest, see `newest_earned_age_days`).
 *   - compliance               compliance_cases status (OPEN / INVESTIGATING /
 *                              WAITING_FOR_INFORMATION / ESCALATED block).
 *   - organizations.status     must be ACTIVE (RESTRICTED / SUSPENDED / TERMINATED block).
 *   - payout method            VERIFIED, same org, same currency as the request.
 *   - reserves                 reflected via available; an over-reserve (negative
 *                              available) is additionally reported.
 *   - disputes                 open disputes block (count > 0).
 *   - manual holds             conversion_holds ACTIVE PAYOUT_HOLD / COMPLIANCE_BLOCK
 *                              — reuses conversions/state-machine isPayoutBlockedBy.
 *   - fraud                    OPEN / UNDER_REVIEW / APPEALED fraud cases block
 *                              (same open-set as conversions HoldFacts.fraudReviewOpen).
 *   - amount                   INTEGER minor units > 0, ≤ payable_minor, same currency.
 *
 * Money: INTEGER minor units + currency only. No floats. No cross-currency math —
 * any currency disagreement is a reason, never a conversion.
 */

import { COMPLIANCE_CASE_STATUSES, type ComplianceCaseStatus } from "../compliance/repository";
import { type HoldFacts, type HoldType, isPayoutBlockedBy } from "../conversions/state-machine";
import { FRAUD_CASE_STATUSES, type FraudCaseStatus } from "../fraud/repository";

// ---- reason codes -----------------------------------------------------------------------

export const PAYOUT_INELIGIBILITY_REASONS = [
  "AMOUNT_NOT_INTEGER",
  "AMOUNT_NOT_POSITIVE",
  "AMOUNT_EXCEEDS_PAYABLE",
  "CURRENCY_INVALID",
  "CURRENCY_MISMATCH_METHOD",
  "CURRENCY_MISMATCH_BALANCE",
  "CURRENCY_MISMATCH_THRESHOLD",
  "BELOW_MINIMUM_THRESHOLD",
  "HOLDING_PERIOD_NOT_ELAPSED",
  "NO_PAYABLE_BALANCE",
  "OVER_RESERVED",
  "ORG_NOT_ACTIVE",
  "PAYOUT_METHOD_NOT_VERIFIED",
  "PAYOUT_METHOD_WRONG_ORG",
  "COMPLIANCE_CASE_OPEN",
  "FRAUD_CASE_OPEN",
  "PAYOUT_ON_HOLD",
  "COMPLIANCE_BLOCKED",
  "OPEN_DISPUTES",
] as const;
export type PayoutIneligibilityReason = (typeof PAYOUT_INELIGIBILITY_REASONS)[number];

export interface EligibilityReason {
  readonly code: PayoutIneligibilityReason;
  readonly message: string;
}

export type PayoutEligibilityResult =
  | { readonly eligible: true; readonly payable_minor: number; readonly currency: string }
  | { readonly eligible: false; readonly reasons: readonly EligibilityReason[]; readonly payable_minor: number; readonly currency: string };

// ---- inputs -----------------------------------------------------------------------------

export const ORG_STATUSES = ["ACTIVE", "RESTRICTED", "SUSPENDED", "TERMINATED"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const PAYOUT_METHOD_STATUSES = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "DISABLED"] as const;
export type PayoutMethodStatus = (typeof PAYOUT_METHOD_STATUSES)[number];

/** Fraud case statuses that count as "open" for payout purposes (mirrors conversions HoldFacts.fraudReviewOpen). */
export const OPEN_FRAUD_CASE_STATUSES: readonly FraudCaseStatus[] = ["OPEN", "UNDER_REVIEW", "APPEALED"];
/** Compliance case statuses that block payout (everything not RESOLVED / CLOSED). */
export const OPEN_COMPLIANCE_CASE_STATUSES: readonly ComplianceCaseStatus[] = ["OPEN", "INVESTIGATING", "WAITING_FOR_INFORMATION", "ESCALATED"];

export interface PayoutEligibilityInput {
  /** The payout being requested. */
  readonly request: {
    readonly organization_id: string;
    readonly amount_minor: number;
    readonly currency: string;
  };
  /** Reserve- and hold-aware available balance (ledger/reserves AvailableBalance shape, caller-computed). */
  readonly balance: {
    readonly currency: string;
    /** May be negative when holds + reserves exceed the ledger balance. */
    readonly available_minor: number;
    /** max(0, available_minor). Verified here; a mismatch is treated as NO_PAYABLE_BALANCE defensively. */
    readonly payable_minor: number;
  };
  /** Minimum payout in the request currency (0 = none). */
  readonly threshold: {
    readonly currency: string;
    readonly minimum_minor: number;
  };
  /** Holding period: conversions must be at least `holding_period_days` old (measured from EARNED). */
  readonly holding: {
    readonly holding_period_days: number;
    /**
     * Age in whole days of the NEWEST conversion whose commission is part of the
     * balance being paid out. `null` when nothing is earned yet (then the amount
     * check alone decides). Must be ≥ holding_period_days.
     */
    readonly newest_earned_age_days: number | null;
  };
  readonly organization: {
    readonly id: string;
    readonly status: OrgStatus;
  };
  readonly payout_method: {
    readonly id: string;
    readonly organization_id: string;
    readonly status: PayoutMethodStatus;
    readonly currency: string;
  };
  /** Statuses of the org's compliance cases (any — we pick the open ones). */
  readonly compliance_case_statuses: readonly ComplianceCaseStatus[];
  /** Statuses of the org's fraud cases (any — we pick the open ones). */
  readonly fraud_case_statuses: readonly FraudCaseStatus[];
  /** hold_type of every ACTIVE conversion_holds row scoped to this affiliate (conversions HoldFacts). */
  readonly active_hold_types: readonly HoldType[];
  /** Number of open disputes / chargebacks against this org's conversions. */
  readonly open_dispute_count: number;
}

// ---- evaluation -------------------------------------------------------------------------

const CURRENCY_RE = /^[A-Z]{3}$/;

function isSafeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && Number.isSafeInteger(n);
}

function isValidCurrency(c: unknown): c is string {
  return typeof c === "string" && CURRENCY_RE.test(c);
}

/**
 * Evaluates every rule and returns all failing reasons (stable codes, ordered as
 * declared in PAYOUT_INELIGIBILITY_REASONS). Never throws on bad money — a
 * non-integer amount is itself a reason, so the snapshot can record it.
 */
export function evaluatePayoutEligibility(input: PayoutEligibilityInput): PayoutEligibilityResult {
  const found = new Map<PayoutIneligibilityReason, string>();
  const add = (code: PayoutIneligibilityReason, message: string): void => {
    if (!found.has(code)) found.set(code, message);
  };

  const { request, balance, threshold, holding, organization, payout_method } = input;
  const currency = isValidCurrency(request.currency) ? request.currency : "???";

  // ---- money shape -----------------------------------------------------------------------
  if (!isSafeInt(request.amount_minor)) {
    add("AMOUNT_NOT_INTEGER", `amount_minor=${String(request.amount_minor)} is not a safe integer`);
  } else if (request.amount_minor <= 0) {
    add("AMOUNT_NOT_POSITIVE", `amount_minor=${request.amount_minor} must be > 0`);
  }
  if (!isValidCurrency(request.currency)) {
    add("CURRENCY_INVALID", `currency=${String(request.currency)} must be an upper-case 3-letter code`);
  }

  // ---- same-currency only (no conversion, ever) -------------------------------------------
  if (payout_method.currency !== request.currency) {
    add("CURRENCY_MISMATCH_METHOD", `payout method is ${payout_method.currency}, request is ${request.currency}`);
  }
  if (balance.currency !== request.currency) {
    add("CURRENCY_MISMATCH_BALANCE", `available balance is ${balance.currency}, request is ${request.currency}`);
  }
  if (threshold.currency !== request.currency) {
    add("CURRENCY_MISMATCH_THRESHOLD", `minimum threshold is ${threshold.currency}, request is ${request.currency}`);
  }

  // ---- balance (reserve + hold aware) -----------------------------------------------------
  let payable = 0;
  const balanceSane = isSafeInt(balance.available_minor) && isSafeInt(balance.payable_minor) && balance.payable_minor === Math.max(0, balance.available_minor);
  if (balanceSane && balance.currency === request.currency) {
    payable = balance.payable_minor;
  }
  if (!balanceSane) {
    add("NO_PAYABLE_BALANCE", "available balance figure is not a consistent integer (payable must equal max(0, available))");
  } else {
    if (balance.available_minor < 0) {
      add("OVER_RESERVED", `holds + reserves exceed the ledger balance by ${-balance.available_minor} ${balance.currency}`);
    }
    if (balance.payable_minor <= 0) {
      add("NO_PAYABLE_BALANCE", `payable balance is ${balance.payable_minor} ${balance.currency}`);
    }
  }
  if (isSafeInt(request.amount_minor) && request.amount_minor > 0 && balanceSane && balance.currency === request.currency && request.amount_minor > payable) {
    add("AMOUNT_EXCEEDS_PAYABLE", `amount ${request.amount_minor} ${currency} exceeds payable ${payable} ${currency}`);
  }

  // ---- minimum threshold -----------------------------------------------------------------
  if (!isSafeInt(threshold.minimum_minor) || threshold.minimum_minor < 0) {
    add("BELOW_MINIMUM_THRESHOLD", `minimum threshold ${String(threshold.minimum_minor)} is not a valid non-negative integer`);
  } else if (isSafeInt(request.amount_minor) && threshold.currency === request.currency && request.amount_minor < threshold.minimum_minor) {
    add("BELOW_MINIMUM_THRESHOLD", `amount ${request.amount_minor} ${currency} is below the minimum ${threshold.minimum_minor} ${currency}`);
  }

  // ---- holding period --------------------------------------------------------------------
  if (!isSafeInt(holding.holding_period_days) || holding.holding_period_days < 0) {
    add("HOLDING_PERIOD_NOT_ELAPSED", `holding_period_days=${String(holding.holding_period_days)} is invalid`);
  } else if (holding.newest_earned_age_days !== null) {
    if (!isSafeInt(holding.newest_earned_age_days) || holding.newest_earned_age_days < 0) {
      add("HOLDING_PERIOD_NOT_ELAPSED", `newest_earned_age_days=${String(holding.newest_earned_age_days)} is invalid`);
    } else if (holding.newest_earned_age_days < holding.holding_period_days) {
      add("HOLDING_PERIOD_NOT_ELAPSED", `newest earned conversion is ${holding.newest_earned_age_days}d old; holding period is ${holding.holding_period_days}d`);
    }
  }

  // ---- organization ----------------------------------------------------------------------
  if (organization.id !== request.organization_id) {
    add("ORG_NOT_ACTIVE", `organization facts are for ${organization.id}, request is for ${request.organization_id}`);
  } else if (organization.status !== "ACTIVE") {
    add("ORG_NOT_ACTIVE", `organization status is ${organization.status}`);
  }

  // ---- payout method ---------------------------------------------------------------------
  if (payout_method.organization_id !== request.organization_id) {
    add("PAYOUT_METHOD_WRONG_ORG", `payout method ${payout_method.id} belongs to ${payout_method.organization_id}`);
  }
  if (payout_method.status !== "VERIFIED") {
    add("PAYOUT_METHOD_NOT_VERIFIED", `payout method ${payout_method.id} is ${payout_method.status}`);
  }

  // ---- compliance / fraud cases ----------------------------------------------------------
  const openCompliance = input.compliance_case_statuses.filter((s) => OPEN_COMPLIANCE_CASE_STATUSES.includes(s));
  if (openCompliance.length > 0) {
    add("COMPLIANCE_CASE_OPEN", `${openCompliance.length} open compliance case(s): ${[...new Set(openCompliance)].join(",")}`);
  }
  const openFraud = input.fraud_case_statuses.filter((s) => OPEN_FRAUD_CASE_STATUSES.includes(s));
  const holdFacts: HoldFacts = { activeHoldTypes: input.active_hold_types, fraudReviewOpen: openFraud.length > 0 };

  // ---- manual holds / payout blocks (same guard the conversion state machine applies) -----
  if (isPayoutBlockedBy(holdFacts)) {
    if (input.active_hold_types.includes("PAYOUT_HOLD")) add("PAYOUT_ON_HOLD", "an active PAYOUT_HOLD blocks payout");
    if (input.active_hold_types.includes("COMPLIANCE_BLOCK")) add("COMPLIANCE_BLOCKED", "an active COMPLIANCE_BLOCK blocks payout");
    if (openFraud.length > 0) add("FRAUD_CASE_OPEN", `${openFraud.length} open fraud case(s): ${[...new Set(openFraud)].join(",")}`);
  }

  // ---- disputes --------------------------------------------------------------------------
  if (!isSafeInt(input.open_dispute_count) || input.open_dispute_count < 0) {
    add("OPEN_DISPUTES", `open_dispute_count=${String(input.open_dispute_count)} is invalid`);
  } else if (input.open_dispute_count > 0) {
    add("OPEN_DISPUTES", `${input.open_dispute_count} open dispute(s)`);
  }

  if (found.size === 0) {
    return { eligible: true, payable_minor: payable, currency };
  }
  const reasons = PAYOUT_INELIGIBILITY_REASONS.filter((c) => found.has(c)).map((code) => ({ code, message: found.get(code)! }));
  return { eligible: false, reasons, payable_minor: payable, currency };
}

/** Convenience: just the codes, in stable order. */
export function ineligibilityCodes(result: PayoutEligibilityResult): readonly PayoutIneligibilityReason[] {
  return result.eligible ? [] : result.reasons.map((r) => r.code);
}

// Re-exported so Unit 11+ can validate DB rows without reaching into other modules.
export { COMPLIANCE_CASE_STATUSES, FRAUD_CASE_STATUSES };
