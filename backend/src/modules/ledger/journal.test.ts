/**
 * Phase 5 Unit 2c — break-attempt tests for money.ts + journal.ts.
 * Pure: no D1, no I/O. Every rejection must surface a stable reason code.
 */
import { describe, expect, it } from "vitest";
import { MoneyError, add, applyBps, compare, money, subtract, sum } from "./money";
import {
  JournalError,
  PostingError,
  assertBalanced,
  buildCompensatingJournal,
  buildConversionCommissionJournal,
  buildJournal,
  captureLedger,
  recomputeCommission,
  validateJournal,
  verifyConversionPosting,
  type ConversionForPosting,
  type JournalDraftInput,
  type LedgerAccountRef,
  type PinnedOfferVersion,
  type PostedJournalRef,
} from "./journal";

const ORG = "org_adv_1";
const OTHER_ORG = "org_adv_2";

function acct(id: string, code: string, currency = "USD", status = "OPEN", organization_id = ORG): LedgerAccountRef {
  return { id, organization_id, code, currency, status };
}
const ACCOUNTS = new Map<string, LedgerAccountRef>(
  [
    acct("a_recv", "ADVERTISER_RECEIVABLE"),
    acct("a_pay", "AFFILIATE_PAYABLE"),
    acct("a_rev", "PLATFORM_REVENUE"),
    acct("a_cash", "CASH"),
    acct("a_closed", "PLATFORM_ADJUSTMENT", "USD", "CLOSED"),
    acct("a_eur", "ADVERTISER_RECEIVABLE", "EUR"),
    acct("a_foreign", "CASH", "USD", "OPEN", OTHER_ORG),
  ].map((a) => [a.id, a]),
);

function draft(over: Partial<JournalDraftInput> = {}): JournalDraftInput {
  return {
    organization_id: ORG,
    journal_type: "CONVERSION_COMMISSION",
    currency: "USD",
    reference_type: "CONVERSION",
    reference_id: "conv_1",
    idempotency_key: "CONVERSION_COMMISSION:conv_1",
    legs: [
      { account_id: "a_recv", direction: "DEBIT", amount_minor: 1000 },
      { account_id: "a_pay", direction: "CREDIT", amount_minor: 700 },
      { account_id: "a_rev", direction: "CREDIT", amount_minor: 300 },
    ],
    ...over,
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MoneyError || err instanceof JournalError || err instanceof PostingError) return err.reason_code;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("money", () => {
  it("accepts integer minor units with upper-case ISO code and freezes", () => {
    const m = money(1234, "USD");
    expect(m).toEqual({ amount_minor: 1234, currency: "USD" });
    expect(Object.isFrozen(m)).toBe(true);
    expect(money(0, "BDT").amount_minor).toBe(0);
  });
  it("rejects negatives, floats, NaN, Infinity, -0, unsafe ints, bad currency", () => {
    expect(code(() => money(-1, "USD"))).toBe("MONEY_NEGATIVE");
    expect(code(() => money(-0, "USD"))).toBe("MONEY_NEGATIVE");
    expect(code(() => money(10.5, "USD"))).toBe("MONEY_NOT_INTEGER");
    expect(code(() => money(Number.NaN, "USD"))).toBe("MONEY_NOT_INTEGER");
    expect(code(() => money(Number.POSITIVE_INFINITY, "USD"))).toBe("MONEY_NOT_INTEGER");
    expect(code(() => money("100" as unknown as number, "USD"))).toBe("MONEY_NOT_INTEGER");
    expect(code(() => money(2 ** 53, "USD"))).toBe("MONEY_UNSAFE_INTEGER");
    expect(code(() => money(1, "usd"))).toBe("MONEY_INVALID_CURRENCY");
    expect(code(() => money(1, "US"))).toBe("MONEY_INVALID_CURRENCY");
    expect(code(() => money(1, "USDT"))).toBe("MONEY_INVALID_CURRENCY");
  });
  it("refuses cross-currency arithmetic and going below zero", () => {
    expect(code(() => add(money(1, "USD"), money(1, "EUR")))).toBe("MONEY_CURRENCY_MISMATCH");
    expect(code(() => subtract(money(1, "USD"), money(1, "EUR")))).toBe("MONEY_CURRENCY_MISMATCH");
    expect(code(() => compare(money(1, "USD"), money(1, "EUR")))).toBe("MONEY_CURRENCY_MISMATCH");
    expect(code(() => sum([money(1, "USD"), money(1, "EUR")], "USD"))).toBe("MONEY_CURRENCY_MISMATCH");
    expect(code(() => subtract(money(5, "USD"), money(6, "USD")))).toBe("MONEY_INSUFFICIENT");
    expect(add(money(5, "USD"), money(6, "USD")).amount_minor).toBe(11);
    expect(code(() => add(money(Number.MAX_SAFE_INTEGER, "USD"), money(1, "USD")))).toBe("MONEY_OVERFLOW");
  });
  it("applyBps floors in BigInt and validates bps", () => {
    expect(applyBps(money(999, "USD"), 3333).amount_minor).toBe(332); // 332.9667 → 332
    expect(applyBps(money(1, "USD"), 9999).amount_minor).toBe(0);
    expect(applyBps(money(Number.MAX_SAFE_INTEGER, "USD"), 10000).amount_minor).toBe(Number.MAX_SAFE_INTEGER);
    expect(applyBps(money(100, "USD"), 0).amount_minor).toBe(0);
    expect(code(() => applyBps(money(100, "USD"), 10001))).toBe("MONEY_INVALID_BPS");
    expect(code(() => applyBps(money(100, "USD"), -1))).toBe("MONEY_INVALID_BPS");
    expect(code(() => applyBps(money(100, "USD"), 12.5))).toBe("MONEY_INVALID_BPS");
  });
});

describe("buildJournal", () => {
  it("builds a balanced 3-leg journal with indexed legs and total = Σdebit", () => {
    const j = buildJournal(draft(), ACCOUNTS);
    expect(j.total_minor).toBe(1000);
    expect(j.legs.map((l) => l.entry_index)).toEqual([0, 1, 2]);
    expect(j.legs.every((l) => l.currency === "USD")).toBe(true);
    expect(j.reverses_journal_id).toBeNull();
    expect(Object.isFrozen(j)).toBe(true);
    expect(() => assertBalanced(j)).not.toThrow();
  });
  it("rejects negative / zero / float leg amounts", () => {
    const legs = (amt: number) => [
      { account_id: "a_recv", direction: "DEBIT" as const, amount_minor: amt },
      { account_id: "a_pay", direction: "CREDIT" as const, amount_minor: amt },
    ];
    expect(code(() => buildJournal(draft({ legs: legs(-100) }), ACCOUNTS))).toBe("MONEY_NEGATIVE");
    expect(code(() => buildJournal(draft({ legs: legs(0) }), ACCOUNTS))).toBe("MONEY_NEGATIVE");
    expect(code(() => buildJournal(draft({ legs: legs(1.5) }), ACCOUNTS))).toBe("MONEY_NOT_INTEGER");
  });
  it("rejects unbalanced, one-sided, too-few, empty, same-account-both-sides", () => {
    expect(code(() => buildJournal(draft({ legs: [
      { account_id: "a_recv", direction: "DEBIT", amount_minor: 1000 },
      { account_id: "a_pay", direction: "CREDIT", amount_minor: 999 },
    ] }), ACCOUNTS))).toBe("JOURNAL_UNBALANCED");
    expect(code(() => buildJournal(draft({ legs: [
      { account_id: "a_recv", direction: "DEBIT", amount_minor: 500 },
      { account_id: "a_cash", direction: "DEBIT", amount_minor: 500 },
    ] }), ACCOUNTS))).toBe("JOURNAL_ONE_SIDED");
    expect(code(() => buildJournal(draft({ legs: [{ account_id: "a_recv", direction: "DEBIT", amount_minor: 5 }] }), ACCOUNTS))).toBe("JOURNAL_TOO_FEW_LEGS");
    expect(code(() => buildJournal(draft({ legs: [] }), ACCOUNTS))).toBe("JOURNAL_NO_LEGS");
    expect(code(() => buildJournal(draft({ legs: [
      { account_id: "a_recv", direction: "DEBIT", amount_minor: 5 },
      { account_id: "a_recv", direction: "CREDIT", amount_minor: 5 },
    ] }), ACCOUNTS))).toBe("JOURNAL_SAME_ACCOUNT_BOTH_SIDES");
  });
  it("rejects currency mismatches: journal vs account, invalid journal currency", () => {
    expect(code(() => buildJournal(draft({ legs: [
      { account_id: "a_eur", direction: "DEBIT", amount_minor: 5 },
      { account_id: "a_pay", direction: "CREDIT", amount_minor: 5 },
    ] }), ACCOUNTS))).toBe("JOURNAL_ACCOUNT_CURRENCY_MISMATCH");
    expect(code(() => buildJournal(draft({ currency: "usd" }), ACCOUNTS))).toBe("MONEY_INVALID_CURRENCY");
    expect(code(() => buildJournal(draft({ currency: "EUR" }), ACCOUNTS))).toBe("JOURNAL_ACCOUNT_CURRENCY_MISMATCH");
  });
  it("rejects closed, unknown and foreign-tenant accounts", () => {
    const two = (id: string) => [
      { account_id: id, direction: "DEBIT" as const, amount_minor: 5 },
      { account_id: "a_pay", direction: "CREDIT" as const, amount_minor: 5 },
    ];
    expect(code(() => buildJournal(draft({ legs: two("a_closed") }), ACCOUNTS))).toBe("JOURNAL_ACCOUNT_CLOSED");
    expect(code(() => buildJournal(draft({ legs: two("nope") }), ACCOUNTS))).toBe("JOURNAL_ACCOUNT_NOT_FOUND");
    expect(code(() => buildJournal(draft({ legs: two("a_foreign") }), ACCOUNTS))).toBe("JOURNAL_ACCOUNT_TENANT_MISMATCH");
  });
  it("rejects bad header fields and enforces the reversal ↔ reverses_journal_id pairing", () => {
    expect(code(() => buildJournal(draft({ journal_type: "BOGUS" as never }), ACCOUNTS))).toBe("JOURNAL_INVALID_TYPE");
    expect(code(() => buildJournal(draft({ reference_type: "BOGUS" as never }), ACCOUNTS))).toBe("JOURNAL_INVALID_REFERENCE_TYPE");
    expect(code(() => buildJournal(draft({ reference_id: " " }), ACCOUNTS))).toBe("JOURNAL_MISSING_REFERENCE_ID");
    expect(code(() => buildJournal(draft({ idempotency_key: "short" }), ACCOUNTS))).toBe("JOURNAL_INVALID_IDEMPOTENCY_KEY");
    expect(code(() => buildJournal(draft({ idempotency_key: "x".repeat(257) }), ACCOUNTS))).toBe("JOURNAL_INVALID_IDEMPOTENCY_KEY");
    expect(code(() => buildJournal(draft({ journal_type: "CONVERSION_REVERSAL" }), ACCOUNTS))).toBe("JOURNAL_INVALID_TYPE");
    expect(code(() => buildJournal(draft({ reverses_journal_id: "j_0" }), ACCOUNTS))).toBe("JOURNAL_INVALID_TYPE");
    expect(code(() => buildJournal(draft({ legs: [
      { account_id: "a_recv", direction: "UP" as never, amount_minor: 5 },
      { account_id: "a_pay", direction: "CREDIT", amount_minor: 5 },
    ] }), ACCOUNTS))).toBe("JOURNAL_LEG_INVALID_DIRECTION");
    expect(code(() => buildJournal(draft({ description: "d".repeat(501) }), ACCOUNTS))).toBe("JOURNAL_DESCRIPTION_TOO_LONG");
  });
  it("validateJournal returns a LedgerResult instead of throwing", () => {
    const r = validateJournal(draft({ legs: [] }), ACCOUNTS);
    expect(r).toEqual({ ok: false, reason_code: "JOURNAL_NO_LEGS" });
    expect(validateJournal(draft(), ACCOUNTS).ok).toBe(true);
  });
  it("assertBalanced catches tampered rows (total mismatch, dup index, leg currency)", () => {
    const j = buildJournal(draft(), ACCOUNTS);
    expect(code(() => assertBalanced({ ...j, total_minor: 999 }))).toBe("JOURNAL_TOTAL_MISMATCH");
    expect(code(() => assertBalanced({ ...j, legs: [j.legs[0]!, { ...j.legs[1]!, entry_index: 0 }, j.legs[2]!] }))).toBe("JOURNAL_LEG_DUPLICATE_INDEX");
    expect(code(() => assertBalanced({ ...j, legs: [j.legs[0]!, { ...j.legs[1]!, currency: "EUR" }, j.legs[2]!] }))).toBe("JOURNAL_LEG_CURRENCY_MISMATCH");
    expect(code(() => assertBalanced({ ...j, legs: [j.legs[0]!, { ...j.legs[1]!, amount_minor: -700 }, j.legs[2]!] }))).toBe("MONEY_NEGATIVE");
  });
});
