/**
 * Ledger — Journal builder / validator (Phase 5 Unit 2b).
 *
 * Pure module: no D1, no I/O, no clock. Given plain data (account rows,
 * legs, conversion + pinned offer version) it either returns a fully
 * validated, balanced journal draft, or a stable reason code. The DB
 * triggers in 0010_ledger_core.sql are the last line of defence; this module
 * is the first, and every reject here maps 1:1 to a
 * financial_processing_errors.reason_code (GLOB '[A-Z0-9_]*', ≤ 64 chars).
 *
 * Nothing here mutates inputs and nothing guesses (§131): a missing or
 * ambiguous fact is a reject, never a default.
 */

import {
  MoneyError,
  assertCurrency,
  assertPositive,
  money,
  type Money,
  type MoneyReasonCode,
} from "./money";

export const ACCOUNT_CODES = [
  "CASH",
  "ADVERTISER_RECEIVABLE",
  "ADVERTISER_PREPAID",
  "AFFILIATE_PAYABLE",
  "PLATFORM_REVENUE",
  "PLATFORM_ADJUSTMENT",
  "PAYOUT_CLEARING",
  "PAYOUT_FEES",
] as const;
export type AccountCode = (typeof ACCOUNT_CODES)[number];

export const JOURNAL_TYPES = [
  "CONVERSION_COMMISSION",
  "CONVERSION_REVERSAL",
  "ADJUSTMENT",
  "PAYOUT",
  "PAYOUT_REVERSAL",
  "FUNDING",
  "FUNDING_REVERSAL",
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const REFERENCE_TYPES = [
  "CONVERSION",
  "CONVERSION_REVERSAL",
  "FINANCIAL_ADJUSTMENT",
  "PAYOUT",
  "FUNDING",
] as const;
export type JournalReferenceType = (typeof REFERENCE_TYPES)[number];

export type Direction = "DEBIT" | "CREDIT";

/** Which journal types are compensating (reverses_journal_id NOT NULL). */
export const REVERSAL_OF: Readonly<Partial<Record<JournalType, JournalType>>> = Object.freeze({
  CONVERSION_COMMISSION: "CONVERSION_REVERSAL",
  PAYOUT: "PAYOUT_REVERSAL",
  FUNDING: "FUNDING_REVERSAL",
});

export const JOURNAL_REASON_CODES = [
  "JOURNAL_NO_LEGS",
  "JOURNAL_TOO_FEW_LEGS",
  "JOURNAL_ONE_SIDED",
  "JOURNAL_UNBALANCED",
  "JOURNAL_TOTAL_MISMATCH",
  "JOURNAL_INVALID_TYPE",
  "JOURNAL_INVALID_REFERENCE_TYPE",
  "JOURNAL_MISSING_REFERENCE_ID",
  "JOURNAL_INVALID_IDEMPOTENCY_KEY",
  "JOURNAL_CURRENCY_MISMATCH",
  "JOURNAL_LEG_CURRENCY_MISMATCH",
  "JOURNAL_LEG_INVALID_DIRECTION",
  "JOURNAL_LEG_INVALID_INDEX",
  "JOURNAL_LEG_DUPLICATE_INDEX",
  "JOURNAL_ACCOUNT_NOT_FOUND",
  "JOURNAL_ACCOUNT_CLOSED",
  "JOURNAL_ACCOUNT_CURRENCY_MISMATCH",
  "JOURNAL_ACCOUNT_TENANT_MISMATCH",
  "JOURNAL_SAME_ACCOUNT_BOTH_SIDES",
  "JOURNAL_MEMO_TOO_LONG",
  "JOURNAL_DESCRIPTION_TOO_LONG",
  "REVERSAL_NOT_REVERSIBLE_TYPE",
  "REVERSAL_ALREADY_REVERSED",
  "REVERSAL_ORIGINAL_IS_REVERSAL",
  "REVERSAL_TENANT_MISMATCH",
  "REVERSAL_ORIGINAL_HAS_NO_LEGS",
] as const;
export type JournalReasonCode = (typeof JOURNAL_REASON_CODES)[number];

export type LedgerReasonCode = JournalReasonCode | MoneyReasonCode;

export class JournalError extends Error {
  readonly reason_code: LedgerReasonCode;
  readonly detail: string | undefined;
  constructor(reason_code: LedgerReasonCode, detail?: string) {
    super(detail ? `${reason_code}: ${detail}` : reason_code);
    this.name = "JournalError";
    this.reason_code = reason_code;
    this.detail = detail;
  }
}

/** Discriminated result: never throw across a module boundary for a reject. */
export type LedgerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason_code: LedgerReasonCode; detail?: string };

export function ok<T>(value: T): LedgerResult<T> {
  return { ok: true, value };
}
export function reject<T = never>(reason_code: LedgerReasonCode, detail?: string): LedgerResult<T> {
  return detail === undefined ? { ok: false, reason_code } : { ok: false, reason_code, detail };
}

/** Wraps a throwing validator into a LedgerResult; unknown errors re-throw. */
export function capture<T>(fn: () => T): LedgerResult<T> {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof JournalError || err instanceof MoneyError) {
      return reject(err.reason_code, err.detail);
    }
    throw err;
  }
}

/** Minimal projection of a ledger_accounts row this module needs. */
export interface LedgerAccountRef {
  readonly id: string;
  readonly organization_id: string;
  readonly code: AccountCode | string;
  readonly currency: string;
  readonly status: "OPEN" | "CLOSED" | string;
}

/** A leg as supplied by a caller (before validation). */
export interface JournalLegInput {
  readonly account_id: string;
  readonly direction: Direction;
  readonly amount_minor: number;
  readonly memo?: string | null;
}

/** A validated leg, ready to become a ledger_entries row. */
export interface JournalLeg {
  readonly entry_index: number;
  readonly account_id: string;
  readonly direction: Direction;
  readonly amount_minor: number;
  readonly currency: string;
  readonly memo: string | null;
}

export interface JournalDraftInput {
  readonly organization_id: string;
  readonly journal_type: JournalType;
  readonly currency: string;
  readonly reference_type: JournalReferenceType;
  readonly reference_id: string;
  readonly idempotency_key: string;
  readonly reverses_journal_id?: string | null;
  readonly description?: string | null;
  readonly legs: readonly JournalLegInput[];
}

/** A validated, balanced journal — the ONLY thing the repository may insert. */
export interface JournalDraft {
  readonly organization_id: string;
  readonly journal_type: JournalType;
  readonly currency: string;
  readonly total_minor: number;
  readonly reference_type: JournalReferenceType;
  readonly reference_id: string;
  readonly idempotency_key: string;
  readonly reverses_journal_id: string | null;
  readonly description: string | null;
  readonly legs: readonly JournalLeg[];
}

export const MAX_MEMO = 200;
export const MAX_DESCRIPTION = 500;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 256;

function assertNonEmpty(value: unknown, code: LedgerReasonCode, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JournalError(code, `${label} is required`);
  }
  return value;
}

function sumSide(legs: readonly JournalLeg[], direction: Direction): bigint {
  let total = 0n;
  for (const leg of legs) if (leg.direction === direction) total += BigInt(leg.amount_minor);
  return total;
}

function resolveAccount(
  accounts: ReadonlyMap<string, LedgerAccountRef>,
  account_id: string,
  organization_id: string,
  currency: string,
): LedgerAccountRef {
  const account = accounts.get(account_id);
  if (!account) throw new JournalError("JOURNAL_ACCOUNT_NOT_FOUND", `account_id=${account_id}`);
  if (account.organization_id !== organization_id) {
    throw new JournalError("JOURNAL_ACCOUNT_TENANT_MISMATCH", `account_id=${account_id}`);
  }
  if (account.status !== "OPEN") {
    throw new JournalError("JOURNAL_ACCOUNT_CLOSED", `account_id=${account_id} status=${account.status}`);
  }
  if (account.currency !== currency) {
    throw new JournalError(
      "JOURNAL_ACCOUNT_CURRENCY_MISMATCH",
      `account_id=${account_id} ${account.currency} vs journal ${currency}`,
    );
  }
  return account;
}
