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
  applyBps,
  assertCurrency,
  assertPositive,
  money,
  subtract,
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

// ---------------------------------------------------------------------------
// Balanced journal builder
// ---------------------------------------------------------------------------

/**
 * Builds and validates a balanced journal draft. Throws JournalError /
 * MoneyError with a stable reason code on the FIRST defect found. Checks, in
 * order: header fields, idempotency key, each leg (positive integer amount,
 * direction, memo, account exists / same tenant / OPEN / same currency),
 * then the double-entry invariants: ≥ 2 legs, both sides present, no account
 * on both sides, Σdebit == Σcredit, total_minor == Σdebit > 0.
 */
export function buildJournal(
  input: JournalDraftInput,
  accounts: ReadonlyMap<string, LedgerAccountRef>,
): JournalDraft {
  const organization_id = assertNonEmpty(input.organization_id, "JOURNAL_ACCOUNT_TENANT_MISMATCH", "organization_id");
  if (!(JOURNAL_TYPES as readonly string[]).includes(input.journal_type)) {
    throw new JournalError("JOURNAL_INVALID_TYPE", `journal_type=${String(input.journal_type)}`);
  }
  if (!(REFERENCE_TYPES as readonly string[]).includes(input.reference_type)) {
    throw new JournalError("JOURNAL_INVALID_REFERENCE_TYPE", `reference_type=${String(input.reference_type)}`);
  }
  const reference_id = assertNonEmpty(input.reference_id, "JOURNAL_MISSING_REFERENCE_ID", "reference_id");
  const currency = assertCurrency(input.currency);

  const key = input.idempotency_key;
  if (typeof key !== "string" || key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
    throw new JournalError("JOURNAL_INVALID_IDEMPOTENCY_KEY", `length=${typeof key === "string" ? key.length : "n/a"}`);
  }

  const isReversalType = Object.values(REVERSAL_OF).includes(input.journal_type);
  const reverses_journal_id = input.reverses_journal_id ?? null;
  if (isReversalType !== (reverses_journal_id !== null)) {
    throw new JournalError("JOURNAL_INVALID_TYPE", `${input.journal_type} requires reverses_journal_id=${isReversalType}`);
  }

  const description = input.description ?? null;
  if (description !== null && description.length > MAX_DESCRIPTION) {
    throw new JournalError("JOURNAL_DESCRIPTION_TOO_LONG", `length=${description.length}`);
  }

  if (!Array.isArray(input.legs) || input.legs.length === 0) {
    throw new JournalError("JOURNAL_NO_LEGS");
  }
  if (input.legs.length < 2) {
    throw new JournalError("JOURNAL_TOO_FEW_LEGS", `legs=${input.legs.length}`);
  }

  const legs: JournalLeg[] = [];
  const debitAccounts = new Set<string>();
  const creditAccounts = new Set<string>();
  input.legs.forEach((raw, entry_index) => {
    if (raw.direction !== "DEBIT" && raw.direction !== "CREDIT") {
      throw new JournalError("JOURNAL_LEG_INVALID_DIRECTION", `legs[${entry_index}].direction=${String(raw.direction)}`);
    }
    // Leg money: integer, > 0, journal currency. MoneyError codes bubble up.
    const amount = assertPositive(money(raw.amount_minor, currency));
    const account_id = assertNonEmpty(raw.account_id, "JOURNAL_ACCOUNT_NOT_FOUND", `legs[${entry_index}].account_id`);
    resolveAccount(accounts, account_id, organization_id, currency);
    const memo = raw.memo ?? null;
    if (memo !== null && memo.length > MAX_MEMO) {
      throw new JournalError("JOURNAL_MEMO_TOO_LONG", `legs[${entry_index}] length=${memo.length}`);
    }
    (raw.direction === "DEBIT" ? debitAccounts : creditAccounts).add(account_id);
    legs.push(Object.freeze({
      entry_index,
      account_id,
      direction: raw.direction,
      amount_minor: amount.amount_minor,
      currency,
      memo,
    }));
  });

  for (const id of debitAccounts) {
    if (creditAccounts.has(id)) {
      throw new JournalError("JOURNAL_SAME_ACCOUNT_BOTH_SIDES", `account_id=${id}`);
    }
  }
  const debit = sumSide(legs, "DEBIT");
  const credit = sumSide(legs, "CREDIT");
  if (debit === 0n || credit === 0n) {
    throw new JournalError("JOURNAL_ONE_SIDED", `debit=${debit} credit=${credit}`);
  }
  if (debit !== credit) {
    throw new JournalError("JOURNAL_UNBALANCED", `debit=${debit} credit=${credit}`);
  }
  if (debit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError("MONEY_OVERFLOW", `total=${debit}`);
  }

  return Object.freeze({
    organization_id,
    journal_type: input.journal_type,
    currency,
    total_minor: Number(debit),
    reference_type: input.reference_type,
    reference_id,
    idempotency_key: key,
    reverses_journal_id,
    description,
    legs: Object.freeze(legs),
  });
}

/** Non-throwing variant of buildJournal. */
export function validateJournal(
  input: JournalDraftInput,
  accounts: ReadonlyMap<string, LedgerAccountRef>,
): LedgerResult<JournalDraft> {
  return capture(() => buildJournal(input, accounts));
}

/**
 * Re-checks the double-entry invariants on an already-built draft or a
 * journal read back from the DB (defence in depth: a repository must call
 * this before trusting a row set). Does not need the account map.
 */
export function assertBalanced(
  journal: Pick<JournalDraft, "currency" | "total_minor" | "legs">,
): void {
  if (journal.legs.length < 2) throw new JournalError("JOURNAL_TOO_FEW_LEGS", `legs=${journal.legs.length}`);
  const seen = new Set<number>();
  for (const leg of journal.legs) {
    if (!Number.isInteger(leg.entry_index) || leg.entry_index < 0) {
      throw new JournalError("JOURNAL_LEG_INVALID_INDEX", `entry_index=${String(leg.entry_index)}`);
    }
    if (seen.has(leg.entry_index)) throw new JournalError("JOURNAL_LEG_DUPLICATE_INDEX", `entry_index=${leg.entry_index}`);
    seen.add(leg.entry_index);
    if (leg.direction !== "DEBIT" && leg.direction !== "CREDIT") {
      throw new JournalError("JOURNAL_LEG_INVALID_DIRECTION", String(leg.direction));
    }
    assertPositive(money(leg.amount_minor, leg.currency));
    if (leg.currency !== journal.currency) {
      throw new JournalError("JOURNAL_LEG_CURRENCY_MISMATCH", `${leg.currency} vs ${journal.currency}`);
    }
  }
  const debit = sumSide(journal.legs, "DEBIT");
  const credit = sumSide(journal.legs, "CREDIT");
  if (debit === 0n || credit === 0n) throw new JournalError("JOURNAL_ONE_SIDED", `debit=${debit} credit=${credit}`);
  if (debit !== credit) throw new JournalError("JOURNAL_UNBALANCED", `debit=${debit} credit=${credit}`);
  assertPositive(money(journal.total_minor, journal.currency));
  if (BigInt(journal.total_minor) !== debit) {
    throw new JournalError("JOURNAL_TOTAL_MISMATCH", `total_minor=${journal.total_minor} debit=${debit}`);
  }
}

// ---------------------------------------------------------------------------
// Compensating (reversal) journal builder
// ---------------------------------------------------------------------------

/** What we need to know about the journal being reversed. */
export interface PostedJournalRef {
  readonly id: string;
  readonly organization_id: string;
  readonly journal_type: JournalType | string;
  readonly currency: string;
  readonly total_minor: number;
  readonly reverses_journal_id: string | null;
  /** true when some journal already has reverses_journal_id = this.id */
  readonly already_reversed: boolean;
  readonly legs: readonly JournalLeg[];
}

export interface ReversalInput {
  readonly original: PostedJournalRef;
  readonly reference_type: JournalReferenceType;
  readonly reference_id: string;
  readonly idempotency_key: string;
  readonly description?: string | null;
}

/**
 * Builds the compensating journal for a posted journal: same tenant, same
 * currency, same total, every leg mirrored (DEBIT↔CREDIT) in the same order.
 * A journal can be reversed at most once, a reversal can never be reversed,
 * and only CONVERSION_COMMISSION / PAYOUT / FUNDING are reversible.
 */
export function buildCompensatingJournal(
  input: ReversalInput,
  accounts: ReadonlyMap<string, LedgerAccountRef>,
): JournalDraft {
  const { original } = input;
  // A reversal can never itself be reversed — check this before the type map
  // so the precise reason code wins over the generic "not reversible type".
  if (original.reverses_journal_id !== null) {
    throw new JournalError("REVERSAL_ORIGINAL_IS_REVERSAL", `journal_id=${original.id}`);
  }
  const reversalType = REVERSAL_OF[original.journal_type as JournalType];
  if (!reversalType) {
    throw new JournalError("REVERSAL_NOT_REVERSIBLE_TYPE", `journal_type=${String(original.journal_type)}`);
  }
  if (original.already_reversed) {
    throw new JournalError("REVERSAL_ALREADY_REVERSED", `journal_id=${original.id}`);
  }
  if (!original.legs || original.legs.length === 0) {
    throw new JournalError("REVERSAL_ORIGINAL_HAS_NO_LEGS", `journal_id=${original.id}`);
  }
  assertBalanced(original);

  const draft = buildJournal(
    {
      organization_id: original.organization_id,
      journal_type: reversalType,
      currency: original.currency,
      reference_type: input.reference_type,
      reference_id: input.reference_id,
      idempotency_key: input.idempotency_key,
      reverses_journal_id: original.id,
      description: input.description ?? null,
      legs: [...original.legs]
        .sort((a, b) => a.entry_index - b.entry_index)
        .map((leg) => ({
          account_id: leg.account_id,
          direction: leg.direction === "DEBIT" ? "CREDIT" : "DEBIT",
          amount_minor: leg.amount_minor,
          memo: leg.memo,
        })),
    },
    accounts,
  );

  // Belt and braces: the DB trigger enforces these too, but we never rely on it.
  if (draft.organization_id !== original.organization_id) {
    throw new JournalError("REVERSAL_TENANT_MISMATCH", `journal_id=${original.id}`);
  }
  if (draft.currency !== original.currency) {
    throw new JournalError("JOURNAL_CURRENCY_MISMATCH", `${draft.currency} vs ${original.currency}`);
  }
  if (draft.total_minor !== original.total_minor) {
    throw new JournalError("JOURNAL_TOTAL_MISMATCH", `${draft.total_minor} vs ${original.total_minor}`);
  }
  return draft;
}

export function validateCompensatingJournal(
  input: ReversalInput,
  accounts: ReadonlyMap<string, LedgerAccountRef>,
): LedgerResult<JournalDraft> {
  return capture(() => buildCompensatingJournal(input, accounts));
}

// ---------------------------------------------------------------------------
// Conversion → commission posting verification (§58, §131)
// ---------------------------------------------------------------------------

export const PAYOUT_TYPES = ["CPA", "CPL", "CPC", "CPI", "CPM", "CPS", "REVSHARE"] as const;
export type CommissionPayoutType = (typeof PAYOUT_TYPES)[number];

export const POSTING_REASON_CODES = [
  "POSTING_CONVERSION_NOT_APPROVED",
  "POSTING_CONVERSION_REVERSED",
  "POSTING_ALREADY_POSTED",
  "POSTING_NO_PINNED_VERSION",
  "POSTING_VERSION_MISMATCH",
  "POSTING_TENANT_MISMATCH",
  "POSTING_NO_AFFILIATE",
  "POSTING_INVALID_PAYOUT_TYPE",
  "POSTING_COMMISSION_MISSING",
  "POSTING_COMMISSION_MISMATCH",
  "POSTING_CURRENCY_MISMATCH",
  "POSTING_REVSHARE_NO_SALE_AMOUNT",
  "POSTING_REVSHARE_NO_BPS",
  "POSTING_ADVERTISER_BELOW_COMMISSION",
  "POSTING_ACCOUNT_MISSING",
] as const;
export type PostingReasonCode = (typeof POSTING_REASON_CODES)[number];

export class PostingError extends Error {
  readonly reason_code: PostingReasonCode;
  readonly detail: string | undefined;
  constructor(reason_code: PostingReasonCode, detail?: string) {
    super(detail ? `${reason_code}: ${detail}` : reason_code);
    this.name = "PostingError";
    this.reason_code = reason_code;
    this.detail = detail;
  }
}

/** Projection of a conversions row (see conversions/repository ConversionRecord). */
export interface ConversionForPosting {
  readonly id: string;
  readonly organization_id: string;
  readonly offer_id: string;
  readonly offer_version_id: string | null;
  readonly affiliate_organization_id: string | null;
  readonly lifecycle_status: string;
  readonly sale_amount_minor: number | null;
  readonly currency: string | null;
  readonly commission_amount_minor: number | null;
  readonly commission_currency: string | null;
}

/** Projection of the offer_versions row pinned at click time (never "current"). */
export interface PinnedOfferVersion {
  readonly id: string;
  readonly offer_id: string;
  readonly organization_id: string;
  readonly payout_type: CommissionPayoutType | string;
  readonly currency: string;
  readonly advertiser_payout_minor: number;
  readonly affiliate_commission_minor: number;
  readonly revshare_percent_bps: number | null;
}

/** Facts the repository must look up before posting; this module never guesses them. */
export interface PostingFacts {
  /** A commissions row or CONVERSION_COMMISSION journal already references this conversion. */
  readonly already_posted: boolean;
  /** The conversion has been REVERSED/REJECTED or a CONVERSION_REVERSAL exists for it. */
  readonly reversed: boolean;
}

/** Mirrors the commissions table (minus ids/journal). */
export interface CommissionDraft {
  readonly conversion_id: string;
  readonly organization_id: string;
  readonly affiliate_organization_id: string;
  readonly offer_id: string;
  readonly offer_version_id: string;
  readonly payout_type: CommissionPayoutType;
  readonly currency: string;
  readonly affiliate_commission_minor: number;
  readonly advertiser_payout_minor: number | null;
  readonly platform_margin_minor: number | null;
}

/**
 * Recomputes the affiliate commission strictly from the pinned version:
 * fixed types → version.affiliate_commission_minor; REVSHARE →
 * floor(sale_amount × bps / 10000). Returns null advertiser/margin for
 * REVSHARE (unverifiable, never guessed).
 */
export function recomputeCommission(
  conversion: ConversionForPosting,
  version: PinnedOfferVersion,
): Pick<CommissionDraft, "payout_type" | "currency" | "affiliate_commission_minor" | "advertiser_payout_minor" | "platform_margin_minor"> {
  if (!(PAYOUT_TYPES as readonly string[]).includes(version.payout_type)) {
    throw new PostingError("POSTING_INVALID_PAYOUT_TYPE", `payout_type=${String(version.payout_type)}`);
  }
  const payout_type = version.payout_type as CommissionPayoutType;
  const currency = assertCurrency(version.currency);

  if (payout_type === "REVSHARE") {
    if (version.revshare_percent_bps === null || version.revshare_percent_bps === undefined) {
      throw new PostingError("POSTING_REVSHARE_NO_BPS", `version_id=${version.id}`);
    }
    if (conversion.sale_amount_minor === null) {
      throw new PostingError("POSTING_REVSHARE_NO_SALE_AMOUNT", `conversion_id=${conversion.id}`);
    }
    if (conversion.currency !== currency) {
      throw new PostingError("POSTING_CURRENCY_MISMATCH", `sale ${String(conversion.currency)} vs version ${currency}`);
    }
    const share = applyBps(money(conversion.sale_amount_minor, currency), version.revshare_percent_bps);
    assertPositive(share);
    return { payout_type, currency, affiliate_commission_minor: share.amount_minor, advertiser_payout_minor: null, platform_margin_minor: null };
  }

  const commission = assertPositive(money(version.affiliate_commission_minor, currency));
  const advertiser = money(version.advertiser_payout_minor, currency);
  if (advertiser.amount_minor < commission.amount_minor) {
    throw new PostingError("POSTING_ADVERTISER_BELOW_COMMISSION", `${advertiser.amount_minor} < ${commission.amount_minor}`);
  }
  return {
    payout_type,
    currency,
    affiliate_commission_minor: commission.amount_minor,
    advertiser_payout_minor: advertiser.amount_minor,
    platform_margin_minor: subtract(advertiser, commission).amount_minor,
  };
}

/**
 * Gate for POST_CONVERSION_COMMISSION. Every reject is a stable reason code.
 * Order: tenant, APPROVED, not reversed, not already posted, pinned version
 * present and matching (id + offer + tenant), affiliate present, stored
 * commission present and EQUAL to the recomputed one, currency match.
 */
export function verifyConversionPosting(
  conversion: ConversionForPosting,
  version: PinnedOfferVersion | null | undefined,
  facts: PostingFacts,
): CommissionDraft {
  if (conversion.lifecycle_status !== "APPROVED") {
    throw new PostingError("POSTING_CONVERSION_NOT_APPROVED", `lifecycle_status=${conversion.lifecycle_status}`);
  }
  if (facts.reversed) throw new PostingError("POSTING_CONVERSION_REVERSED", `conversion_id=${conversion.id}`);
  if (facts.already_posted) throw new PostingError("POSTING_ALREADY_POSTED", `conversion_id=${conversion.id}`);
  if (!conversion.offer_version_id) throw new PostingError("POSTING_NO_PINNED_VERSION", `conversion_id=${conversion.id}`);
  if (!version || version.id !== conversion.offer_version_id || version.offer_id !== conversion.offer_id) {
    throw new PostingError("POSTING_VERSION_MISMATCH", `expected version ${conversion.offer_version_id} of offer ${conversion.offer_id}`);
  }
  if (version.organization_id !== conversion.organization_id) {
    throw new PostingError("POSTING_TENANT_MISMATCH", `version org ${version.organization_id} vs conversion org ${conversion.organization_id}`);
  }
  if (!conversion.affiliate_organization_id) throw new PostingError("POSTING_NO_AFFILIATE", `conversion_id=${conversion.id}`);

  const recomputed = recomputeCommission(conversion, version);
  if (conversion.commission_amount_minor === null || conversion.commission_currency === null) {
    throw new PostingError("POSTING_COMMISSION_MISSING", `conversion_id=${conversion.id}`);
  }
  if (conversion.commission_currency !== recomputed.currency) {
    throw new PostingError("POSTING_CURRENCY_MISMATCH", `stored ${conversion.commission_currency} vs version ${recomputed.currency}`);
  }
  const stored = money(conversion.commission_amount_minor, conversion.commission_currency);
  if (stored.amount_minor !== recomputed.affiliate_commission_minor) {
    throw new PostingError("POSTING_COMMISSION_MISMATCH", `stored ${stored.amount_minor} vs recomputed ${recomputed.affiliate_commission_minor}`);
  }

  return Object.freeze({
    conversion_id: conversion.id,
    organization_id: conversion.organization_id,
    affiliate_organization_id: conversion.affiliate_organization_id,
    offer_id: conversion.offer_id,
    offer_version_id: version.id,
    ...recomputed,
  });
}

export function findAccountByCode(
  accounts: ReadonlyMap<string, LedgerAccountRef>,
  organization_id: string,
  code: AccountCode,
  currency: string,
): LedgerAccountRef {
  for (const account of accounts.values()) {
    if (account.organization_id === organization_id && account.code === code && account.currency === currency) return account;
  }
  throw new PostingError("POSTING_ACCOUNT_MISSING", `${code}/${currency} for org ${organization_id}`);
}

/**
 * Journal for a verified commission:
 *   DEBIT  ADVERTISER_RECEIVABLE  advertiser_payout (or commission for REVSHARE)
 *   CREDIT AFFILIATE_PAYABLE      affiliate_commission
 *   CREDIT PLATFORM_REVENUE       margin (only when > 0)
 * Idempotency key is derived from the conversion id so a retry can never post twice.
 */
export function buildConversionCommissionJournal(
  commission: CommissionDraft,
  accounts: ReadonlyMap<string, LedgerAccountRef>,
): JournalDraft {
  const { organization_id, currency } = commission;
  const receivable = findAccountByCode(accounts, organization_id, "ADVERTISER_RECEIVABLE", currency);
  const payable = findAccountByCode(accounts, organization_id, "AFFILIATE_PAYABLE", currency);
  const debitAmount = commission.advertiser_payout_minor ?? commission.affiliate_commission_minor;
  const legs: JournalLegInput[] = [
    { account_id: receivable.id, direction: "DEBIT", amount_minor: debitAmount, memo: `conversion ${commission.conversion_id}` },
    { account_id: payable.id, direction: "CREDIT", amount_minor: commission.affiliate_commission_minor, memo: `affiliate ${commission.affiliate_organization_id}` },
  ];
  if (commission.platform_margin_minor !== null && commission.platform_margin_minor > 0) {
    const revenue = findAccountByCode(accounts, organization_id, "PLATFORM_REVENUE", currency);
    legs.push({ account_id: revenue.id, direction: "CREDIT", amount_minor: commission.platform_margin_minor, memo: "platform margin" });
  }
  return buildJournal(
    {
      organization_id,
      journal_type: "CONVERSION_COMMISSION",
      currency,
      reference_type: "CONVERSION",
      reference_id: commission.conversion_id,
      idempotency_key: conversionCommissionIdempotencyKey(commission.conversion_id),
      legs,
    },
    accounts,
  );
}

export function conversionCommissionIdempotencyKey(conversion_id: string): string {
  return `CONVERSION_COMMISSION:${conversion_id}`;
}

export function conversionReversalIdempotencyKey(conversion_id: string): string {
  return `CONVERSION_REVERSAL:${conversion_id}`;
}

/** Non-throwing wrapper covering Money/Journal/Posting errors. */
export function captureLedger<T>(fn: () => T): { ok: true; value: T } | { ok: false; reason_code: string; detail?: string } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof PostingError || err instanceof JournalError || err instanceof MoneyError) {
      return err.detail === undefined ? { ok: false, reason_code: err.reason_code } : { ok: false, reason_code: err.reason_code, detail: err.detail };
    }
    throw err;
  }
}
