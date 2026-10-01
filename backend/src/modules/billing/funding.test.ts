/**
 * Funding capacity — Phase 5 Unit 8a tests (PRD §62). Pure function, no DB.
 */
import { describe, expect, it } from "vitest";
import { FundingError, capacity, modelCapacity, type BillingProfileFacts } from "./funding";

const base: BillingProfileFacts = {
  funding_model: "CREDIT",
  currency: "USD",
  credit_limit_minor: 10_000,
  used_credit_minor: 4_000,
  payment_terms_days: null,
  risk_status: "NORMAL",
  billing_status: "ACTIVE",
};
const prepaid: BillingProfileFacts = { ...base, funding_model: "PREPAID", credit_limit_minor: 0, used_credit_minor: 0 };
const postpaid: BillingProfileFacts = { ...base, funding_model: "POSTPAID", payment_terms_days: 30 };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof FundingError) return e.code;
    throw e;
  }
  throw new Error("expected FundingError");
}

describe("funding.capacity — models", () => {
  it("PREPAID: capacity is the ledger balance; ok when balance covers required", () => {
    const d = capacity(prepaid, { currency: "USD", required_minor: 2_500, prepaid_balance_minor: 7_000 });
    expect(d).toMatchObject({ ok: true, reason: "OK", funding_model: "PREPAID", capacity_minor: 7_000, shortfall_minor: 0 });
  });

  it("PREPAID: insufficient balance reports the exact shortfall; overdrawn balance → capacity 0", () => {
    expect(capacity(prepaid, { currency: "USD", required_minor: 7_001, prepaid_balance_minor: 7_000 })).toMatchObject({
      ok: false, reason: "INSUFFICIENT_CAPACITY", capacity_minor: 7_000, shortfall_minor: 1,
    });
    expect(capacity(prepaid, { currency: "USD", required_minor: 100, prepaid_balance_minor: -500 })).toMatchObject({
      ok: false, capacity_minor: 0, shortfall_minor: 100,
    });
  });

  it("PREPAID: the balance fact is mandatory", () => {
    expect(codeOf(() => capacity(prepaid, { currency: "USD", required_minor: 1 }))).toBe("FUNDING_PREPAID_BALANCE_REQUIRED");
  });

  it("POSTPAID: capacity is limit − used; payment terms required", () => {
    expect(capacity(postpaid, { currency: "USD", required_minor: 6_000 })).toMatchObject({ ok: true, capacity_minor: 6_000, shortfall_minor: 0 });
    expect(capacity(postpaid, { currency: "USD", required_minor: 6_500 })).toMatchObject({ ok: false, capacity_minor: 6_000, shortfall_minor: 500 });
    expect(codeOf(() => capacity({ ...postpaid, payment_terms_days: null }, { currency: "USD", required_minor: 1 }))).toBe("FUNDING_TERMS_REQUIRED");
    // The prepaid balance fact is ignored for POSTPAID.
    expect(capacity(postpaid, { currency: "USD", required_minor: 6_000, prepaid_balance_minor: 0 }).ok).toBe(true);
  });

  it("CREDIT: capacity is limit − used; used ≥ limit → capacity 0", () => {
    expect(capacity(base, { currency: "USD", required_minor: 1 })).toMatchObject({ ok: true, capacity_minor: 6_000 });
    expect(capacity({ ...base, used_credit_minor: 10_000 }, { currency: "USD", required_minor: 1 })).toMatchObject({
      ok: false, reason: "INSUFFICIENT_CAPACITY", capacity_minor: 0, shortfall_minor: 1,
    });
    expect(modelCapacity({ ...base, used_credit_minor: 10_000 }, { currency: "USD", required_minor: 0 })).toBe(0);
  });
});

describe("funding.capacity — boundaries and gates", () => {
  it("exact capacity is OK (required == capacity) and one more minor unit is not", () => {
    expect(capacity(base, { currency: "USD", required_minor: 6_000 })).toMatchObject({ ok: true, shortfall_minor: 0 });
    expect(capacity(base, { currency: "USD", required_minor: 6_001 })).toMatchObject({ ok: false, shortfall_minor: 1 });
    expect(capacity(prepaid, { currency: "USD", required_minor: 0, prepaid_balance_minor: 0 })).toMatchObject({ ok: true, capacity_minor: 0 });
  });

  it("risk BLOCKED → capacity 0 regardless of model/limit", () => {
    const d = capacity({ ...base, risk_status: "BLOCKED" }, { currency: "USD", required_minor: 1 });
    expect(d).toMatchObject({ ok: false, reason: "RISK_BLOCKED", capacity_minor: 0, shortfall_minor: 1 });
    expect(capacity({ ...prepaid, risk_status: "BLOCKED" }, { currency: "USD", required_minor: 1, prepaid_balance_minor: 1_000_000 }).ok).toBe(false);
  });

  it("billing status other than ACTIVE → capacity 0 (PAST_DUE, SUSPENDED, CLOSED)", () => {
    for (const billing_status of ["PAST_DUE", "SUSPENDED", "CLOSED"] as const) {
      const d = capacity({ ...base, billing_status }, { currency: "USD", required_minor: 10 });
      expect(d).toMatchObject({ ok: false, reason: "BILLING_INACTIVE", capacity_minor: 0, shortfall_minor: 10 });
    }
    // required 0 on an inactive profile is still not ok (nothing is fundable).
    expect(capacity({ ...base, billing_status: "SUSPENDED" }, { currency: "USD", required_minor: 0 }).ok).toBe(false);
  });
});

describe("funding.capacity — money rules", () => {
  it("rejects mixed currency instead of converting", () => {
    expect(codeOf(() => capacity(base, { currency: "EUR", required_minor: 1 }))).toBe("FUNDING_CURRENCY_MISMATCH");
    expect(codeOf(() => capacity(base, { currency: "usd", required_minor: 1 }))).toBe("FUNDING_INVALID_CURRENCY");
    expect(codeOf(() => capacity({ ...base, currency: "US" }, { currency: "US", required_minor: 1 }))).toBe("FUNDING_INVALID_CURRENCY");
  });

  it("rejects floats, NaN, Infinity, negatives and unsafe integers", () => {
    expect(codeOf(() => capacity(base, { currency: "USD", required_minor: 10.5 }))).toBe("FUNDING_NOT_INTEGER");
    expect(codeOf(() => capacity(base, { currency: "USD", required_minor: Number.NaN }))).toBe("FUNDING_NOT_INTEGER");
    expect(codeOf(() => capacity(base, { currency: "USD", required_minor: Number.POSITIVE_INFINITY }))).toBe("FUNDING_NOT_INTEGER");
    expect(codeOf(() => capacity(base, { currency: "USD", required_minor: -1 }))).toBe("FUNDING_NEGATIVE");
    expect(codeOf(() => capacity(base, { currency: "USD", required_minor: 2 ** 53 }))).toBe("FUNDING_UNSAFE_INTEGER");
    expect(codeOf(() => capacity({ ...base, credit_limit_minor: 1.5 }, { currency: "USD", required_minor: 1 }))).toBe("FUNDING_NOT_INTEGER");
    expect(codeOf(() => capacity({ ...base, used_credit_minor: -1 }, { currency: "USD", required_minor: 1 }))).toBe("FUNDING_NEGATIVE");
    expect(codeOf(() => capacity(prepaid, { currency: "USD", required_minor: 1, prepaid_balance_minor: 0.25 }))).toBe("FUNDING_NOT_INTEGER");
    expect(codeOf(() => capacity({ ...base, funding_model: "GIFT" as never }, { currency: "USD", required_minor: 1 }))).toBe("FUNDING_INVALID_MODEL");
  });
});
