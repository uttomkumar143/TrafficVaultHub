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

describe("buildCompensatingJournal", () => {
  function posted(over: Partial<PostedJournalRef> = {}): PostedJournalRef {
    const j = buildJournal(draft(), ACCOUNTS);
    return { id: "j_1", organization_id: j.organization_id, journal_type: j.journal_type, currency: j.currency,
      total_minor: j.total_minor, reverses_journal_id: null, already_reversed: false, legs: j.legs, ...over };
  }
  const rev = (o: PostedJournalRef, accounts = ACCOUNTS) =>
    buildCompensatingJournal({ original: o, reference_type: "CONVERSION_REVERSAL", reference_id: "conv_1", idempotency_key: "CONVERSION_REVERSAL:conv_1" }, accounts);

  it("mirrors every leg, keeps order/total/currency/tenant, points at the original", () => {
    const r = rev(posted());
    expect(r.journal_type).toBe("CONVERSION_REVERSAL");
    expect(r.reverses_journal_id).toBe("j_1");
    expect(r.total_minor).toBe(1000);
    expect(r.currency).toBe("USD");
    expect(r.organization_id).toBe(ORG);
    expect(r.legs.map((l) => [l.account_id, l.direction, l.amount_minor])).toEqual([
      ["a_recv", "CREDIT", 1000], ["a_pay", "DEBIT", 700], ["a_rev", "DEBIT", 300],
    ]);
  });
  it("refuses: already reversed, reversal-of-reversal, non-reversible type, no legs, tampered total", () => {
    expect(code(() => rev(posted({ already_reversed: true })))).toBe("REVERSAL_ALREADY_REVERSED");
    expect(code(() => rev(posted({ journal_type: "CONVERSION_REVERSAL", reverses_journal_id: "j_0" })))).toBe("REVERSAL_ORIGINAL_IS_REVERSAL");
    expect(code(() => rev(posted({ journal_type: "ADJUSTMENT" })))).toBe("REVERSAL_NOT_REVERSIBLE_TYPE");
    expect(code(() => rev(posted({ legs: [] })))).toBe("REVERSAL_ORIGINAL_HAS_NO_LEGS");
    expect(code(() => rev(posted({ total_minor: 1 })))).toBe("JOURNAL_TOTAL_MISMATCH");
  });
  it("refuses when an account has been CLOSED since the original posting", () => {
    const closedNow = new Map(ACCOUNTS);
    closedNow.set("a_pay", acct("a_pay", "AFFILIATE_PAYABLE", "USD", "CLOSED"));
    expect(code(() => rev(posted(), closedNow))).toBe("JOURNAL_ACCOUNT_CLOSED");
  });
});

describe("verifyConversionPosting", () => {
  const version: PinnedOfferVersion = { id: "v_7", offer_id: "offer_1", organization_id: ORG, payout_type: "CPA",
    currency: "USD", advertiser_payout_minor: 1000, affiliate_commission_minor: 700, revshare_percent_bps: null };
  const conv = (over: Partial<ConversionForPosting> = {}): ConversionForPosting => ({
    id: "conv_1", organization_id: ORG, offer_id: "offer_1", offer_version_id: "v_7", affiliate_organization_id: "org_aff_1",
    lifecycle_status: "APPROVED", sale_amount_minor: null, currency: null, commission_amount_minor: 700, commission_currency: "USD", ...over });
  const facts = { already_posted: false, reversed: false };

  it("accepts an APPROVED, unposted conversion whose stored commission equals the pinned version", () => {
    const c = verifyConversionPosting(conv(), version, facts);
    expect(c).toMatchObject({ conversion_id: "conv_1", offer_version_id: "v_7", payout_type: "CPA", currency: "USD",
      affiliate_commission_minor: 700, advertiser_payout_minor: 1000, platform_margin_minor: 300 });
    const j = buildConversionCommissionJournal(c, ACCOUNTS);
    expect(j.idempotency_key).toBe("CONVERSION_COMMISSION:conv_1");
    expect(j.total_minor).toBe(1000);
    expect(j.legs.map((l) => [l.account_id, l.direction, l.amount_minor])).toEqual([
      ["a_recv", "DEBIT", 1000], ["a_pay", "CREDIT", 700], ["a_rev", "CREDIT", 300],
    ]);
  });
  it("rejects every lifecycle / dedupe break with a stable code", () => {
    for (const s of ["PENDING", "HELD", "REJECTED", "REVERSED", "LEDGER_POSTED", "PAID"]) {
      expect(code(() => verifyConversionPosting(conv({ lifecycle_status: s }), version, facts))).toBe("POSTING_CONVERSION_NOT_APPROVED");
    }
    expect(code(() => verifyConversionPosting(conv(), version, { ...facts, reversed: true }))).toBe("POSTING_CONVERSION_REVERSED");
    expect(code(() => verifyConversionPosting(conv(), version, { ...facts, already_posted: true }))).toBe("POSTING_ALREADY_POSTED");
    expect(code(() => verifyConversionPosting(conv({ offer_version_id: null }), version, facts))).toBe("POSTING_NO_PINNED_VERSION");
    expect(code(() => verifyConversionPosting(conv(), null, facts))).toBe("POSTING_VERSION_MISMATCH");
    expect(code(() => verifyConversionPosting(conv(), { ...version, id: "v_8" }, facts))).toBe("POSTING_VERSION_MISMATCH");
    expect(code(() => verifyConversionPosting(conv(), { ...version, offer_id: "offer_2" }, facts))).toBe("POSTING_VERSION_MISMATCH");
    expect(code(() => verifyConversionPosting(conv(), { ...version, organization_id: OTHER_ORG }, facts))).toBe("POSTING_TENANT_MISMATCH");
    expect(code(() => verifyConversionPosting(conv({ affiliate_organization_id: null }), version, facts))).toBe("POSTING_NO_AFFILIATE");
  });
  it("rejects commission mismatch (amount tampered, missing, wrong currency) — pinned version wins", () => {
    expect(code(() => verifyConversionPosting(conv({ commission_amount_minor: 701 }), version, facts))).toBe("POSTING_COMMISSION_MISMATCH");
    expect(code(() => verifyConversionPosting(conv({ commission_amount_minor: 699 }), version, facts))).toBe("POSTING_COMMISSION_MISMATCH");
    expect(code(() => verifyConversionPosting(conv({ commission_amount_minor: null }), version, facts))).toBe("POSTING_COMMISSION_MISSING");
    expect(code(() => verifyConversionPosting(conv({ commission_currency: "EUR" }), version, facts))).toBe("POSTING_CURRENCY_MISMATCH");
    expect(code(() => verifyConversionPosting(conv({ commission_amount_minor: -700 }), version, facts))).toBe("MONEY_NEGATIVE");
    // a "current" version with a higher payout must not be trusted: it is not the pinned one
    expect(code(() => verifyConversionPosting(conv({ commission_amount_minor: 900 }), { ...version, id: "v_9", affiliate_commission_minor: 900 }, facts))).toBe("POSTING_VERSION_MISMATCH");
  });
  it("REVSHARE recomputes floor(sale × bps / 10000), never guesses advertiser/margin", () => {
    const rs: PinnedOfferVersion = { ...version, payout_type: "REVSHARE", revshare_percent_bps: 3333, advertiser_payout_minor: 0, affiliate_commission_minor: 0 };
    const c = verifyConversionPosting(conv({ sale_amount_minor: 999, currency: "USD", commission_amount_minor: 332 }), rs, facts);
    expect(c.affiliate_commission_minor).toBe(332);
    expect(c.advertiser_payout_minor).toBeNull();
    expect(c.platform_margin_minor).toBeNull();
    const j = buildConversionCommissionJournal(c, ACCOUNTS);
    expect(j.legs.length).toBe(2);
    expect(j.total_minor).toBe(332);
    expect(code(() => verifyConversionPosting(conv({ sale_amount_minor: 999, currency: "USD", commission_amount_minor: 333 }), rs, facts))).toBe("POSTING_COMMISSION_MISMATCH");
    expect(code(() => recomputeCommission(conv({ sale_amount_minor: null }), rs))).toBe("POSTING_REVSHARE_NO_SALE_AMOUNT");
    expect(code(() => recomputeCommission(conv({ sale_amount_minor: 999, currency: "EUR" }), rs))).toBe("POSTING_CURRENCY_MISMATCH");
    expect(code(() => recomputeCommission(conv({ sale_amount_minor: 999, currency: "USD" }), { ...rs, revshare_percent_bps: null }))).toBe("POSTING_REVSHARE_NO_BPS");
    expect(code(() => recomputeCommission(conv({ sale_amount_minor: 1, currency: "USD" }), rs))).toBe("MONEY_NEGATIVE"); // floor → 0 is not a commission
    expect(code(() => recomputeCommission(conv(), { ...version, payout_type: "CPX" }))).toBe("POSTING_INVALID_PAYOUT_TYPE");
    expect(code(() => recomputeCommission(conv(), { ...version, advertiser_payout_minor: 699 }))).toBe("POSTING_ADVERTISER_BELOW_COMMISSION");
  });
  it("commission journal needs the tenant's accounts in the right currency; captureLedger yields the code", () => {
    const c = verifyConversionPosting(conv(), version, facts);
    const noRevenue = new Map(ACCOUNTS); noRevenue.delete("a_rev");
    expect(code(() => buildConversionCommissionJournal(c, noRevenue))).toBe("POSTING_ACCOUNT_MISSING");
    const closedPayable = new Map(ACCOUNTS); closedPayable.set("a_pay", acct("a_pay", "AFFILIATE_PAYABLE", "USD", "CLOSED"));
    expect(captureLedger(() => buildConversionCommissionJournal(c, closedPayable))).toMatchObject({ ok: false, reason_code: "JOURNAL_ACCOUNT_CLOSED" });
    expect(captureLedger(() => verifyConversionPosting(conv({ commission_currency: "EUR" }), version, facts))).toMatchObject({ ok: false, reason_code: "POSTING_CURRENCY_MISMATCH" });
    expect(() => captureLedger(() => { throw new TypeError("bug"); })).toThrow(TypeError);
  });
});
