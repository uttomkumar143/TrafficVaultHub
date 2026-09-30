/**
 * Ledger — Money primitive (Phase 5 Unit 2a).
 *
 * Pure module: no D1, no I/O, no Date. Every amount is an INTEGER number of
 * minor units (cents, paisa, …) paired with an ISO-4217 currency code.
 *
 * Invariants (PRD §58 / §131):
 *  - amount_minor is a safe integer ≥ 0 — never a float, never negative.
 *  - currency is exactly 3 upper-case ASCII letters (matches the DB CHECKs).
 *  - No cross-currency arithmetic: add/sub/compare refuse mismatched codes.
 *  - Percentages are integer basis points (0..10000); the share is computed
 *    as floor(amount * bps / 10000) in BigInt so no float ever touches money.
 *  - Nothing here guesses: an invalid input is a MoneyError with a stable
 *    reason code suitable for financial_processing_errors.reason_code.
 */

export interface Money {
  readonly amount_minor: number;
  readonly currency: string;
}

export const MONEY_REASON_CODES = [
  "MONEY_NOT_INTEGER",
  "MONEY_NEGATIVE",
  "MONEY_UNSAFE_INTEGER",
  "MONEY_INVALID_CURRENCY",
  "MONEY_CURRENCY_MISMATCH",
  "MONEY_INSUFFICIENT",
  "MONEY_OVERFLOW",
  "MONEY_INVALID_BPS",
] as const;

export type MoneyReasonCode = (typeof MONEY_REASON_CODES)[number];

export class MoneyError extends Error {
  readonly reason_code: MoneyReasonCode;
  readonly detail: string | undefined;

  constructor(reason_code: MoneyReasonCode, detail?: string) {
    super(detail ? `${reason_code}: ${detail}` : reason_code);
    this.name = "MoneyError";
    this.reason_code = reason_code;
    this.detail = detail;
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const BPS_DENOMINATOR = 10_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function isValidCurrency(code: unknown): code is string {
  return typeof code === "string" && CURRENCY_RE.test(code);
}

export function assertCurrency(code: unknown): string {
  if (!isValidCurrency(code)) {
    throw new MoneyError("MONEY_INVALID_CURRENCY", `currency=${String(code)}`);
  }
  return code;
}

/**
 * Validates a raw minor-unit amount. Rejects floats, NaN, Infinity, negatives
 * and anything outside Number's safe-integer range (SQLite INTEGER is 64-bit
 * but JS Number is not; we refuse to silently lose precision).
 */
export function assertMinorAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new MoneyError("MONEY_NOT_INTEGER", `amount_minor=${String(amount)}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError("MONEY_UNSAFE_INTEGER", `amount_minor=${String(amount)}`);
  }
  if (amount < 0 || Object.is(amount, -0)) {
    throw new MoneyError("MONEY_NEGATIVE", `amount_minor=${String(amount)}`);
  }
  return amount;
}

/** Builds a validated, frozen Money value. Throws MoneyError on any defect. */
export function money(amount_minor: unknown, currency: unknown): Money {
  const amount = assertMinorAmount(amount_minor);
  const code = assertCurrency(currency);
  return Object.freeze({ amount_minor: amount, currency: code });
}

/** Validates an existing Money-shaped object (e.g. from a DB row). */
export function assertMoney(value: unknown): Money {
  if (value === null || typeof value !== "object") {
    throw new MoneyError("MONEY_NOT_INTEGER", "not a Money object");
  }
  const v = value as { amount_minor?: unknown; currency?: unknown };
  return money(v.amount_minor, v.currency);
}

export function isZero(m: Money): boolean {
  return assertMoney(m).amount_minor === 0;
}

export function isPositive(m: Money): boolean {
  return assertMoney(m).amount_minor > 0;
}

/** Asserts amount_minor > 0 (ledger legs / commissions must be strictly positive). */
export function assertPositive(m: Money): Money {
  const v = assertMoney(m);
  if (v.amount_minor <= 0) {
    throw new MoneyError("MONEY_NEGATIVE", "amount_minor must be > 0");
  }
  return v;
}

export function assertSameCurrency(a: Money, b: Money): string {
  const ca = assertCurrency(a.currency);
  const cb = assertCurrency(b.currency);
  if (ca !== cb) {
    throw new MoneyError("MONEY_CURRENCY_MISMATCH", `${ca} vs ${cb}`);
  }
  return ca;
}

function fromBigInt(value: bigint, currency: string): Money {
  if (value < 0n) throw new MoneyError("MONEY_NEGATIVE", value.toString());
  if (value > MAX_SAFE) throw new MoneyError("MONEY_OVERFLOW", value.toString());
  return Object.freeze({ amount_minor: Number(value), currency });
}

export function add(a: Money, b: Money): Money {
  const va = assertMoney(a);
  const vb = assertMoney(b);
  const currency = assertSameCurrency(va, vb);
  return fromBigInt(BigInt(va.amount_minor) + BigInt(vb.amount_minor), currency);
}

/** a − b; refuses to go below zero (MONEY_INSUFFICIENT). Money is never negative. */
export function subtract(a: Money, b: Money): Money {
  const va = assertMoney(a);
  const vb = assertMoney(b);
  const currency = assertSameCurrency(va, vb);
  const diff = BigInt(va.amount_minor) - BigInt(vb.amount_minor);
  if (diff < 0n) {
    throw new MoneyError("MONEY_INSUFFICIENT", `${va.amount_minor} - ${vb.amount_minor} < 0`);
  }
  return fromBigInt(diff, currency);
}

/** Sums a list of same-currency Money values. Empty list → zero in `currency`. */
export function sum(items: readonly Money[], currency: string): Money {
  const code = assertCurrency(currency);
  let total = 0n;
  for (const item of items) {
    const v = assertMoney(item);
    if (v.currency !== code) {
      throw new MoneyError("MONEY_CURRENCY_MISMATCH", `${v.currency} vs ${code}`);
    }
    total += BigInt(v.amount_minor);
  }
  return fromBigInt(total, code);
}

export function equals(a: Money, b: Money): boolean {
  const va = assertMoney(a);
  const vb = assertMoney(b);
  assertSameCurrency(va, vb);
  return va.amount_minor === vb.amount_minor;
}

/** -1 / 0 / 1 like Array.sort comparators; same currency only. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const va = assertMoney(a);
  const vb = assertMoney(b);
  assertSameCurrency(va, vb);
  if (va.amount_minor < vb.amount_minor) return -1;
  if (va.amount_minor > vb.amount_minor) return 1;
  return 0;
}

/** Integer basis points: 0..10000 inclusive, integer only. */
export function assertBps(bps: unknown): number {
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError("MONEY_INVALID_BPS", `bps=${String(bps)}`);
  }
  return bps;
}

/**
 * floor(amount * bps / 10000), computed entirely in BigInt. This is the ONLY
 * sanctioned way to derive a percentage share (e.g. REVSHARE commission from
 * a sale amount). Rounding is always down — the platform never over-pays by a
 * rounding artefact, and the result is reproducible bit-for-bit.
 */
export function applyBps(m: Money, bps: unknown): Money {
  const v = assertMoney(m);
  const b = assertBps(bps);
  const share = (BigInt(v.amount_minor) * BigInt(b)) / BPS_DENOMINATOR;
  return fromBigInt(share, v.currency);
}

/** Multiply by a non-negative integer quantity (e.g. CPM units). BigInt-safe. */
export function multiply(m: Money, quantity: unknown): Money {
  const v = assertMoney(m);
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError("MONEY_NOT_INTEGER", `quantity=${String(quantity)}`);
  }
  return fromBigInt(BigInt(v.amount_minor) * BigInt(quantity), v.currency);
}

export function zero(currency: string): Money {
  return Object.freeze({ amount_minor: 0, currency: assertCurrency(currency) });
}

export function formatMoney(m: Money): string {
  const v = assertMoney(m);
  return `${v.amount_minor} ${v.currency}`;
}
