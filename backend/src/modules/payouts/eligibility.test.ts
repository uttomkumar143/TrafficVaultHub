/**
 * Phase 5 Unit 10b — payout eligibility. Pure: every input individually, blocks actually block.
 */
import { describe, expect, it } from "vitest";
import {
  OPEN_COMPLIANCE_CASE_STATUSES,
  OPEN_FRAUD_CASE_STATUSES,
  PAYOUT_INELIGIBILITY_REASONS,
  evaluatePayoutEligibility,
  ineligibilityCodes,
  type PayoutEligibilityInput,
} from "./eligibility";

const ORG = "org_aff_1";

/** A fully eligible baseline; each test breaks exactly one thing. */
function base(over: DeepPartial<PayoutEligibilityInput> = {}): PayoutEligibilityInput {
  const b: PayoutEligibilityInput = {
    request: { organization_id: ORG, amount_minor: 50_000, currency: "USD" },
    balance: { currency: "USD", available_minor: 80_000, payable_minor: 80_000 },
    threshold: { currency: "USD", minimum_minor: 10_000 },
    holding: { holding_period_days: 30, newest_earned_age_days: 45 },
    organization: { id: ORG, status: "ACTIVE" },
    payout_method: { id: "pm1", organization_id: ORG, status: "VERIFIED", currency: "USD" },
    compliance_case_statuses: ["RESOLVED", "CLOSED"],
    fraud_case_statuses: ["DISMISSED", "CLOSED", "CONFIRMED", "APPEAL_REJECTED", "APPEAL_UPHELD"],
    active_hold_types: ["CONVERSION_HOLD"], // a CONVERSION_HOLD blocks approval, NOT payout
    open_dispute_count: 0,
  };
  return {
    request: { ...b.request, ...over.request },
    balance: { ...b.balance, ...over.balance },
    threshold: { ...b.threshold, ...over.threshold },
    holding: { ...b.holding, ...over.holding },
    organization: { ...b.organization, ...over.organization },
    payout_method: { ...b.payout_method, ...over.payout_method },
    compliance_case_statuses: over.compliance_case_statuses ?? b.compliance_case_statuses,
    fraud_case_statuses: over.fraud_case_statuses ?? b.fraud_case_statuses,
    active_hold_types: over.active_hold_types ?? b.active_hold_types,
    open_dispute_count: over.open_dispute_count ?? b.open_dispute_count,
  } as PayoutEligibilityInput;
}
type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Partial<T[K]> : T[K] };

const codes = (over: DeepPartial<PayoutEligibilityInput>) => ineligibilityCodes(evaluatePayoutEligibility(base(over)));

describe("payouts/eligibility — eligible baseline", () => {
  it("baseline is eligible and reports payable + currency; exact boundaries (amount == payable, amount == minimum, age == holding) are OK", () => {
    expect(evaluatePayoutEligibility(base())).toEqual({ eligible: true, payable_minor: 80_000, currency: "USD" });
    expect(codes({ request: { amount_minor: 80_000 } })).toEqual([]);
    expect(codes({ request: { amount_minor: 10_000 } })).toEqual([]);
    expect(codes({ holding: { newest_earned_age_days: 30 } })).toEqual([]);
    expect(codes({ threshold: { minimum_minor: 0 } })).toEqual([]);
    expect(codes({ holding: { newest_earned_age_days: null } })).toEqual([]); // nothing earned-dated; amount check decides
    expect(codes({ holding: { holding_period_days: 0, newest_earned_age_days: 0 } })).toEqual([]);
  });
});

describe("payouts/eligibility — money (integer minor units, same currency only)", () => {
  it("amount must be a safe positive integer", () => {
    expect(codes({ request: { amount_minor: 12.5 } })).toEqual(["AMOUNT_NOT_INTEGER"]);
    expect(codes({ request: { amount_minor: Number.NaN } })).toEqual(["AMOUNT_NOT_INTEGER"]);
    expect(codes({ request: { amount_minor: Number.POSITIVE_INFINITY } })).toEqual(["AMOUNT_NOT_INTEGER"]);
    expect(codes({ request: { amount_minor: 2 ** 53 } })).toEqual(["AMOUNT_NOT_INTEGER"]);
    expect(codes({ request: { amount_minor: "100" as unknown as number } })).toEqual(["AMOUNT_NOT_INTEGER"]);
    expect(codes({ request: { amount_minor: 0 } })).toEqual(["AMOUNT_NOT_POSITIVE", "BELOW_MINIMUM_THRESHOLD"]);
    expect(codes({ request: { amount_minor: -5 } })).toEqual(["AMOUNT_NOT_POSITIVE", "BELOW_MINIMUM_THRESHOLD"]);
  });

  it("amount > payable is refused (AMOUNT_EXCEEDS_PAYABLE); payable comes from the reserve/hold-aware balance", () => {
    expect(codes({ request: { amount_minor: 80_001 } })).toEqual(["AMOUNT_EXCEEDS_PAYABLE"]);
    const r = evaluatePayoutEligibility(base({ request: { amount_minor: 80_001 } }));
    expect(r.eligible).toBe(false);
    expect(r.payable_minor).toBe(80_000);
    if (!r.eligible) expect(r.reasons[0]!.message).toMatch(/80001 USD exceeds payable 80000 USD/);
  });

  it("currency must be valid and identical across request, method, balance and threshold — never converted", () => {
    expect(codes({ request: { currency: "usd" } })).toEqual(["CURRENCY_INVALID", "CURRENCY_MISMATCH_METHOD", "CURRENCY_MISMATCH_BALANCE", "CURRENCY_MISMATCH_THRESHOLD"]);
    expect(codes({ payout_method: { currency: "EUR" } })).toEqual(["CURRENCY_MISMATCH_METHOD"]);
    expect(codes({ threshold: { currency: "EUR" } })).toEqual(["CURRENCY_MISMATCH_THRESHOLD"]);
    // A balance in another currency contributes NOTHING to payable (no cross-currency math):
    const r = evaluatePayoutEligibility(base({ balance: { currency: "EUR", available_minor: 1_000_000, payable_minor: 1_000_000 } }));
    expect(ineligibilityCodes(r)).toEqual(["CURRENCY_MISMATCH_BALANCE"]);
    expect(r.payable_minor).toBe(0);
  });
});

describe("payouts/eligibility — balance, reserves, threshold, holding period", () => {
  it("reserve-aware balance: over-reserve (negative available) → OVER_RESERVED + NO_PAYABLE_BALANCE + amount refused", () => {
    expect(codes({ balance: { available_minor: -2_500, payable_minor: 0 } })).toEqual(["AMOUNT_EXCEEDS_PAYABLE", "NO_PAYABLE_BALANCE", "OVER_RESERVED"]);
    expect(codes({ balance: { available_minor: 0, payable_minor: 0 } })).toEqual(["AMOUNT_EXCEEDS_PAYABLE", "NO_PAYABLE_BALANCE"]);
    // inconsistent figure (payable ≠ max(0, available)) is not trusted
    expect(codes({ balance: { available_minor: -2_500, payable_minor: 2_500 } })).toEqual(["NO_PAYABLE_BALANCE"]);
    expect(codes({ balance: { available_minor: 10.5, payable_minor: 10.5 } })).toEqual(["NO_PAYABLE_BALANCE"]);
  });

  it("minimum threshold: amount below minimum refused; invalid minimum refused", () => {
    expect(codes({ request: { amount_minor: 9_999 } })).toEqual(["BELOW_MINIMUM_THRESHOLD"]);
    expect(codes({ threshold: { minimum_minor: 50_001 } })).toEqual(["BELOW_MINIMUM_THRESHOLD"]);
    expect(codes({ threshold: { minimum_minor: -1 } })).toEqual(["BELOW_MINIMUM_THRESHOLD"]);
    expect(codes({ threshold: { minimum_minor: 1.5 } })).toEqual(["BELOW_MINIMUM_THRESHOLD"]);
  });

  it("holding period: newest earned conversion younger than the holding period → HOLDING_PERIOD_NOT_ELAPSED", () => {
    expect(codes({ holding: { newest_earned_age_days: 29 } })).toEqual(["HOLDING_PERIOD_NOT_ELAPSED"]);
    expect(codes({ holding: { newest_earned_age_days: 0 } })).toEqual(["HOLDING_PERIOD_NOT_ELAPSED"]);
    expect(codes({ holding: { holding_period_days: 60 } })).toEqual(["HOLDING_PERIOD_NOT_ELAPSED"]);
    expect(codes({ holding: { holding_period_days: -1 } })).toEqual(["HOLDING_PERIOD_NOT_ELAPSED"]);
    expect(codes({ holding: { newest_earned_age_days: 1.5 } })).toEqual(["HOLDING_PERIOD_NOT_ELAPSED"]);
  });
});

describe("payouts/eligibility — organization, method, compliance, fraud, holds, disputes (blocks actually block)", () => {
  it("organizations.status must be ACTIVE; facts for the wrong org are refused", () => {
    for (const status of ["RESTRICTED", "SUSPENDED", "TERMINATED"] as const) {
      expect(codes({ organization: { status } })).toEqual(["ORG_NOT_ACTIVE"]);
    }
    expect(codes({ organization: { id: "org_other" } })).toEqual(["ORG_NOT_ACTIVE"]);
  });

  it("payout method must be VERIFIED and belong to the requesting org", () => {
    for (const status of ["PENDING_VERIFICATION", "REJECTED", "DISABLED"] as const) {
      expect(codes({ payout_method: { status } })).toEqual(["PAYOUT_METHOD_NOT_VERIFIED"]);
    }
    expect(codes({ payout_method: { organization_id: "org_other" } })).toEqual(["PAYOUT_METHOD_WRONG_ORG"]);
  });

  it("any open compliance case (OPEN / INVESTIGATING / WAITING_FOR_INFORMATION / ESCALATED) blocks; RESOLVED / CLOSED do not", () => {
    for (const s of OPEN_COMPLIANCE_CASE_STATUSES) {
      expect(codes({ compliance_case_statuses: ["CLOSED", s] })).toEqual(["COMPLIANCE_CASE_OPEN"]);
    }
    expect(codes({ compliance_case_statuses: [] })).toEqual([]);
    expect(codes({ compliance_case_statuses: ["RESOLVED", "CLOSED"] })).toEqual([]);
  });

  it("any open fraud case (OPEN / UNDER_REVIEW / APPEALED) blocks; decided cases do not", () => {
    for (const s of OPEN_FRAUD_CASE_STATUSES) {
      expect(codes({ fraud_case_statuses: ["DISMISSED", s] })).toEqual(["FRAUD_CASE_OPEN"]);
    }
    expect(codes({ fraud_case_statuses: [] })).toEqual([]);
    expect(codes({ fraud_case_statuses: ["CONFIRMED", "DISMISSED", "APPEAL_UPHELD", "APPEAL_REJECTED", "CLOSED"] })).toEqual([]);
  });

  it("active PAYOUT_HOLD and COMPLIANCE_BLOCK block (same guard as conversions → PAYOUT_ELIGIBLE); CONVERSION_HOLD alone does not", () => {
    expect(codes({ active_hold_types: ["PAYOUT_HOLD"] })).toEqual(["PAYOUT_ON_HOLD"]);
    expect(codes({ active_hold_types: ["COMPLIANCE_BLOCK"] })).toEqual(["COMPLIANCE_BLOCKED"]);
    expect(codes({ active_hold_types: ["CONVERSION_HOLD", "PAYOUT_HOLD", "COMPLIANCE_BLOCK"] })).toEqual(["PAYOUT_ON_HOLD", "COMPLIANCE_BLOCKED"]);
    expect(codes({ active_hold_types: [] })).toEqual([]);
    expect(codes({ active_hold_types: ["CONVERSION_HOLD"] })).toEqual([]);
  });

  it("open disputes block; invalid count refused", () => {
    expect(codes({ open_dispute_count: 1 })).toEqual(["OPEN_DISPUTES"]);
    expect(codes({ open_dispute_count: -1 })).toEqual(["OPEN_DISPUTES"]);
    expect(codes({ open_dispute_count: 0.5 })).toEqual(["OPEN_DISPUTES"]);
  });

  it("reasons are collected (not short-circuited), de-duplicated, and emitted in the stable declared order", () => {
    const r = evaluatePayoutEligibility(
      base({
        request: { amount_minor: 90_000 },
        organization: { status: "SUSPENDED" },
        payout_method: { status: "DISABLED" },
        fraud_case_statuses: ["OPEN", "UNDER_REVIEW"],
        active_hold_types: ["PAYOUT_HOLD", "PAYOUT_HOLD"],
        open_dispute_count: 2,
      }),
    );
    expect(r.eligible).toBe(false);
    const got = ineligibilityCodes(r);
    expect(got).toEqual(["AMOUNT_EXCEEDS_PAYABLE", "ORG_NOT_ACTIVE", "PAYOUT_METHOD_NOT_VERIFIED", "FRAUD_CASE_OPEN", "PAYOUT_ON_HOLD", "OPEN_DISPUTES"]);
    expect(new Set(got).size).toBe(got.length);
    const order = got.map((c) => PAYOUT_INELIGIBILITY_REASONS.indexOf(c));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    if (!r.eligible) for (const reason of r.reasons) expect(reason.message.length).toBeGreaterThan(0);
  });
});
