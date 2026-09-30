/**
 * LedgerRepository — Phase 5 Unit 3 (PRD §56–§58, §114, §131).
 *
 * Persistence over migration 0010. Everything financial here is INSERT-only:
 *
 *   - postJournal() writes the journal_entries row, every ledger_entries leg
 *     and any caller-supplied statements (commissions row, audit row, the
 *     conversion's guarded LEDGER_POSTED transition) in ONE db.batch. Either
 *     all of it lands or none of it does.
 *   - Idempotency is the UNIQUE journal_entries.idempotency_key: the same
 *     business event can never post twice, even across concurrent retries —
 *     the second batch fails at the DB and is mapped to a stable 409 code.
 *   - Balances are ALWAYS computed from ledger_entries. balance_snapshots is
 *     a cache that snapshotBalance() appends to; it is never read to decide
 *     anything.
 *   - There is no update/delete method for journals, legs, commissions,
 *     snapshots or processing errors, and the 0010 triggers refuse them even
 *     if someone bypasses this class (repository.test.ts proves it).
 *
 * Tenant scoping: every read goes through scopedQuery (organization_id = ?
 * first). Inserts bind the tenant id explicitly.
 */

import { AppError } from "../../lib/errors";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import {
  assertBalanced,
  type AccountCode,
  type CommissionDraft,
  type JournalDraft,
  type JournalLeg,
  type LedgerAccountRef,
  type PinnedOfferVersion,
  type PostedJournalRef,
  type PostingFacts,
} from "./journal";

// ---------------------------------------------------------------------------
// Row types (mirror 0010_ledger_core.sql)
// ---------------------------------------------------------------------------

export type AccountType = "ASSET" | "LIABILITY" | "REVENUE" | "EXPENSE" | "EQUITY";

export interface LedgerAccountRow extends LedgerAccountRef {
  readonly account_type: AccountType;
  readonly name: string;
  readonly closed_at: string | null;
  readonly created_at: string;
}

export interface JournalRow {
  readonly id: string;
  readonly organization_id: string;
  readonly journal_type: string;
  readonly currency: string;
  readonly total_minor: number;
  readonly reference_type: string;
  readonly reference_id: string;
  readonly reverses_journal_id: string | null;
  readonly idempotency_key: string;
  readonly actor_type: string;
  readonly posted_by_user_id: string | null;
  readonly description: string | null;
  readonly request_id: string | null;
  readonly posted_at: string;
  readonly created_at: string;
}

export interface LedgerEntryRow extends JournalLeg {
  readonly id: string;
  readonly journal_id: string;
  readonly organization_id: string;
  readonly created_at: string;
}

export interface CommissionRow extends CommissionDraft {
  readonly id: string;
  readonly journal_id: string;
  readonly created_at: string;
}

/** Σ over ledger_entries for one account — the source of truth for a balance. */
export interface AccountBalance {
  readonly account_id: string;
  readonly organization_id: string;
  readonly currency: string;
  readonly debit_total_minor: number;
  readonly credit_total_minor: number;
  /** credit − debit (matches balance_snapshots CHECK; interpret by account_type). */
  readonly balance_minor: number;
  readonly entry_count: number;
  readonly last_entry_id: string | null;
}

export interface BalanceSnapshotRow extends AccountBalance {
  readonly id: string;
  readonly as_of: string;
  readonly created_at: string;
}

export type LedgerActorType = "TENANT" | "PLATFORM" | "SYSTEM" | "INTERNAL";

export const PROCESSING_OPERATIONS = [
  "POST_CONVERSION_COMMISSION",
  "POST_CONVERSION_REVERSAL",
  "POST_ADJUSTMENT",
  "POST_PAYOUT",
  "POST_PAYOUT_REVERSAL",
  "POST_FUNDING",
  "RECONCILE_LEDGER",
] as const;
export type ProcessingOperation = (typeof PROCESSING_OPERATIONS)[number];

export type ProcessingReferenceType =
  | "CONVERSION"
  | "CONVERSION_REVERSAL"
  | "FINANCIAL_ADJUSTMENT"
  | "PAYOUT"
  | "FUNDING"
  | "RECONCILIATION_RUN";

export interface ProcessingErrorInsert {
  readonly organization_id: string | null;
  readonly operation: ProcessingOperation;
  readonly reference_type: ProcessingReferenceType;
  readonly reference_id: string;
  readonly reason_code: string;
  readonly detail?: string | null;
  readonly request_id?: string | null;
}

export interface ProcessingErrorRow {
  readonly id: string;
  readonly organization_id: string | null;
  readonly operation: ProcessingOperation;
  readonly reference_type: ProcessingReferenceType;
  readonly reference_id: string;
  readonly reason_code: string;
  readonly detail: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AccountInsert {
  readonly id?: string;
  readonly organization_id: string;
  readonly code: AccountCode;
  readonly account_type: AccountType;
  readonly currency: string;
  readonly name: string;
}

/** Who/when for a journal; the WHAT is the validated JournalDraft. */
export interface JournalHeader {
  /** Pre-generated id so callers can reference the journal in same-batch rows (commission, audit). */
  readonly id?: string;
  readonly actor_type: LedgerActorType;
  readonly posted_by_user_id: string | null;
  readonly request_id: string | null;
  /** ISO timestamp from the service clock. */
  readonly posted_at: string;
}

export interface PostedJournal {
  readonly journal_id: string;
  readonly entry_ids: readonly string[];
}

/** The statements postJournal() batches, exposed so a caller can place them inside its own batch. */
export interface JournalStatements extends PostedJournal {
  readonly statements: readonly D1PreparedStatement[];
}

// ---------------------------------------------------------------------------
// DB error classification (D1 / SQLite messages)
// ---------------------------------------------------------------------------

const REASON_CODE = /^[A-Z0-9_]{1,64}$/;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Maps a failed batch to a stable AppError. Every code here means "nothing
 * was written" — the batch rolled back as a whole.
 */
export function classifyLedgerWriteError(err: unknown): AppError {
  const msg = messageOf(err);
  if (/UNIQUE constraint failed: journal_entries\.idempotency_key/i.test(msg)) {
    return new AppError(409, "JOURNAL_DUPLICATE_IDEMPOTENCY_KEY", "a journal with this idempotency key is already posted");
  }
  if (/UNIQUE constraint failed: commissions\.conversion_id/i.test(msg)) {
    return new AppError(409, "COMMISSION_ALREADY_POSTED", "a commission is already posted for this conversion");
  }
  if (/UNIQUE constraint failed: commissions\.journal_id/i.test(msg)) {
    return new AppError(409, "COMMISSION_JOURNAL_REUSED", "this journal already backs a commission");
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new AppError(409, "LEDGER_STATE_CONFLICT", "a row changed underneath the ledger batch; nothing was written");
  }
  const trigger = /^(?:.*?:\s*)?([A-Z][A-Z0-9_]{2,63})\b/.exec(msg.trim());
  if (trigger && REASON_CODE.test(trigger[1] ?? "")) {
    return new AppError(409, trigger[1] as string, `ledger write refused by the database: ${trigger[1]}`);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new AppError(409, "LEDGER_REFERENCE_MISSING", "a referenced row does not exist; nothing was written");
  }
  return new AppError(500, "LEDGER_WRITE_FAILED", `ledger write failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class LedgerRepository {
  constructor(private readonly db: D1Database) {}

  // ---- chart of accounts ----------------------------------------------------

  async createAccount(a: AccountInsert): Promise<LedgerAccountRow> {
    const id = a.id ?? crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO ledger_accounts (id, organization_id, code, account_type, currency, name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, a.organization_id, a.code, a.account_type, a.currency, a.name)
      .run();
    const row = await this.findAccount(a.organization_id as TenantId, id);
    if (!row) throw new AppError(500, "LEDGER_ACCOUNT_NOT_CREATED", "ledger account insert did not persist");
    return row;
  }

  /** Closing is the only permitted change; the DB refuses everything else. Returns false when not OPEN / not visible. */
  async closeAccount(tenantId: TenantId, accountId: string, now: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE ledger_accounts SET status = 'CLOSED', closed_at = ?
          WHERE organization_id = ? AND id = ? AND status = 'OPEN'`,
      )
      .bind(now, tenantId, accountId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  findAccount(tenantId: TenantId, accountId: string): Promise<LedgerAccountRow | null> {
    return scopedQuery(
      this.db,
      `SELECT id, organization_id, code, account_type, currency, name, status, closed_at, created_at
         FROM ledger_accounts WHERE organization_id = ? AND id = ?`,
      tenantId,
      accountId,
    ).first<LedgerAccountRow>();
  }

  /** Every account of the tenant, keyed by id — the map journal.ts validates against. */
  async accountsOf(tenantId: TenantId): Promise<Map<string, LedgerAccountRow>> {
    const { results } = await scopedQuery(
      this.db,
      `SELECT id, organization_id, code, account_type, currency, name, status, closed_at, created_at
         FROM ledger_accounts WHERE organization_id = ? ORDER BY created_at, id`,
      tenantId,
    ).all<LedgerAccountRow>();
    return new Map(results.map((r) => [r.id, r]));
  }

  // ---- journals (append-only) ----------------------------------------------

  /**
   * Posts a validated, balanced journal atomically with its legs and any
   * extra statements. Re-runs assertBalanced() so a tampered draft can never
   * reach the DB. On any failure the whole batch is rolled back and a stable
   * AppError is thrown (see classifyLedgerWriteError).
   */
  async postJournal(draft: JournalDraft, header: JournalHeader, extra: readonly D1PreparedStatement[] = []): Promise<PostedJournal> {
    const { journal_id, entry_ids, statements } = this.journalStatements(draft, header, extra);
    try {
      await this.db.batch([...statements]);
    } catch (err) {
      throw classifyLedgerWriteError(err);
    }
    return { journal_id, entry_ids };
  }

  /**
   * Builds (does NOT run) the statements postJournal() batches: the
   * journal_entries row, one ledger_entries row per leg, then `extra` in
   * order. Re-runs assertBalanced() so a tampered draft never produces
   * statements. Callers that own a larger batch (e.g. the conversion's
   * guarded LEDGER_POSTED transition) append these to it so journal, legs,
   * commission, audit and state transition land — or roll back — together.
   */
  journalStatements(draft: JournalDraft, header: JournalHeader, extra: readonly D1PreparedStatement[] = []): JournalStatements {
    assertBalanced(draft);
    const journal_id = header.id ?? crypto.randomUUID();
    const entry_ids = draft.legs.map(() => crypto.randomUUID());

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO journal_entries
             (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, reverses_journal_id,
              idempotency_key, actor_type, posted_by_user_id, description, request_id, posted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          journal_id,
          draft.organization_id,
          draft.journal_type,
          draft.currency,
          draft.total_minor,
          draft.reference_type,
          draft.reference_id,
          draft.reverses_journal_id,
          draft.idempotency_key,
          header.actor_type,
          header.posted_by_user_id,
          draft.description,
          header.request_id,
          header.posted_at,
        ),
      ...draft.legs.map((leg, i) =>
        this.db
          .prepare(
            `INSERT INTO ledger_entries (id, journal_id, organization_id, account_id, entry_index, direction, amount_minor, currency, memo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(entry_ids[i], journal_id, draft.organization_id, leg.account_id, leg.entry_index, leg.direction, leg.amount_minor, leg.currency, leg.memo),
      ),
      ...extra,
    ];
    return { journal_id, entry_ids, statements };
  }

  findJournal(tenantId: TenantId, journalId: string): Promise<JournalRow | null> {
    return scopedQuery(this.db, `SELECT * FROM journal_entries WHERE organization_id = ? AND id = ?`, tenantId, journalId).first<JournalRow>();
  }

  findJournalByIdempotencyKey(tenantId: TenantId, key: string): Promise<JournalRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM journal_entries WHERE organization_id = ? AND idempotency_key = ?`,
      tenantId,
      key,
    ).first<JournalRow>();
  }

  async listEntries(tenantId: TenantId, journalId: string): Promise<LedgerEntryRow[]> {
    const { results } = await scopedQuery(
      this.db,
      `SELECT id, journal_id, organization_id, account_id, entry_index, direction, amount_minor, currency, memo, created_at
         FROM ledger_entries WHERE organization_id = ? AND journal_id = ? ORDER BY entry_index`,
      tenantId,
      journalId,
    ).all<LedgerEntryRow>();
    return results;
  }

  /** The journal that reverses `journalId`, if any. */
  findReversalOf(tenantId: TenantId, journalId: string): Promise<JournalRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM journal_entries WHERE organization_id = ? AND reverses_journal_id = ?`,
      tenantId,
      journalId,
    ).first<JournalRow>();
  }

  /**
   * Journal + legs + reversed-flag as journal.ts needs it for a compensating
   * entry. Re-checks the double-entry invariants on what was read back.
   */
  async getPostedJournal(tenantId: TenantId, journalId: string): Promise<PostedJournalRef | null> {
    const journal = await this.findJournal(tenantId, journalId);
    if (!journal) return null;
    const [legs, reversal] = await Promise.all([this.listEntries(tenantId, journalId), this.findReversalOf(tenantId, journalId)]);
    const ref: PostedJournalRef = {
      id: journal.id,
      organization_id: journal.organization_id,
      journal_type: journal.journal_type,
      currency: journal.currency,
      total_minor: journal.total_minor,
      reverses_journal_id: journal.reverses_journal_id,
      already_reversed: reversal !== null,
      legs,
    };
    assertBalanced(ref);
    return ref;
  }

  // ---- commissions -----------------------------------------------------------

  commissionStatement(commission: CommissionDraft, journalId: string, id: string = crypto.randomUUID()): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO commissions
           (id, organization_id, conversion_id, affiliate_organization_id, offer_id, offer_version_id, payout_type, currency,
            affiliate_commission_minor, advertiser_payout_minor, platform_margin_minor, journal_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        commission.organization_id,
        commission.conversion_id,
        commission.affiliate_organization_id,
        commission.offer_id,
        commission.offer_version_id,
        commission.payout_type,
        commission.currency,
        commission.affiliate_commission_minor,
        commission.advertiser_payout_minor,
        commission.platform_margin_minor,
        journalId,
      );
  }

  findCommissionByConversion(tenantId: TenantId, conversionId: string): Promise<CommissionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM commissions WHERE organization_id = ? AND conversion_id = ?`,
      tenantId,
      conversionId,
    ).first<CommissionRow>();
  }

  /** Facts verifyConversionPosting() must be told; never inferred by the pure layer. */
  async postingFacts(tenantId: TenantId, conversionId: string): Promise<PostingFacts> {
    // CONVERSION_REVERSAL journals reference the CONVERSION id (reference_type
    // CONVERSION_REVERSAL) so every ledger fact about a conversion is keyed
    // by the same id.
    const row = await scopedQuery(
      this.db,
      `SELECT
         (SELECT COUNT(*) FROM commissions WHERE organization_id = ? AND conversion_id = ?)
       + (SELECT COUNT(*) FROM journal_entries WHERE organization_id = ? AND journal_type = 'CONVERSION_COMMISSION'
             AND reference_type = 'CONVERSION' AND reference_id = ?) AS posted,
         (SELECT COUNT(*) FROM conversion_reversals WHERE organization_id = ? AND conversion_id = ?)
       + (SELECT COUNT(*) FROM journal_entries WHERE organization_id = ? AND journal_type = 'CONVERSION_REVERSAL'
             AND reference_type = 'CONVERSION_REVERSAL' AND reference_id = ?) AS reversed`,
      tenantId,
      conversionId,
      tenantId,
      conversionId,
      tenantId,
      conversionId,
      tenantId,
      conversionId,
    ).first<{ posted: number; reversed: number }>();
    return { already_posted: (row?.posted ?? 0) > 0, reversed: (row?.reversed ?? 0) > 0 };
  }

  /** The offer version pinned on the conversion — looked up by id, never "current". */
  pinnedOfferVersion(tenantId: TenantId, versionId: string): Promise<PinnedOfferVersion | null> {
    return scopedQuery(
      this.db,
      `SELECT id, offer_id, organization_id, payout_type, currency, advertiser_payout_minor, affiliate_commission_minor, revshare_percent_bps
         FROM offer_versions WHERE organization_id = ? AND id = ?`,
      tenantId,
      versionId,
    ).first<PinnedOfferVersion>();
  }

  // ---- balances (computed from ledger_entries; snapshots are a cache) --------

  async computeBalance(tenantId: TenantId, accountId: string): Promise<AccountBalance> {
    const account = await this.findAccount(tenantId, accountId);
    if (!account) throw new AppError(404, "LEDGER_ACCOUNT_NOT_FOUND", "ledger account not found");
    const sums = await scopedQuery(
      this.db,
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'DEBIT'  THEN amount_minor ELSE 0 END), 0) AS debit_total_minor,
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END), 0) AS credit_total_minor,
         COUNT(*) AS entry_count
       FROM ledger_entries WHERE organization_id = ? AND account_id = ?`,
      tenantId,
      accountId,
    ).first<{ debit_total_minor: number; credit_total_minor: number; entry_count: number }>();
    const last = await scopedQuery(
      this.db,
      `SELECT id FROM ledger_entries WHERE organization_id = ? AND account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      tenantId,
      accountId,
    ).first<{ id: string }>();
    const debit = Number(sums?.debit_total_minor ?? 0);
    const credit = Number(sums?.credit_total_minor ?? 0);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
      throw new AppError(500, "MONEY_OVERFLOW", "account totals exceed the safe integer range");
    }
    return {
      account_id: accountId,
      organization_id: account.organization_id,
      currency: account.currency,
      debit_total_minor: debit,
      credit_total_minor: credit,
      balance_minor: credit - debit,
      entry_count: Number(sums?.entry_count ?? 0),
      last_entry_id: last?.id ?? null,
    };
  }

  /** Computes the balance from ledger_entries and appends it to the cache. */
  async snapshotBalance(tenantId: TenantId, accountId: string, asOf: string): Promise<BalanceSnapshotRow> {
    const balance = await this.computeBalance(tenantId, accountId);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO balance_snapshots
           (id, account_id, organization_id, currency, debit_total_minor, credit_total_minor, balance_minor, entry_count, last_entry_id, as_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        accountId,
        balance.organization_id,
        balance.currency,
        balance.debit_total_minor,
        balance.credit_total_minor,
        balance.balance_minor,
        balance.entry_count,
        balance.last_entry_id,
        asOf,
      )
      .run();
    const row = await this.latestSnapshot(tenantId, accountId);
    if (!row || row.id !== id) throw new AppError(500, "BALANCE_SNAPSHOT_NOT_WRITTEN", "balance snapshot did not persist");
    return row;
  }

  latestSnapshot(tenantId: TenantId, accountId: string): Promise<BalanceSnapshotRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM balance_snapshots WHERE organization_id = ? AND account_id = ? ORDER BY as_of DESC, created_at DESC, rowid DESC LIMIT 1`,
      tenantId,
      accountId,
    ).first<BalanceSnapshotRow>();
  }

  // ---- §131 fail-safe --------------------------------------------------------

  processingErrorStatement(e: ProcessingErrorInsert, id: string = crypto.randomUUID()): D1PreparedStatement {
    if (!REASON_CODE.test(e.reason_code)) {
      throw new AppError(500, "INVALID_PROCESSING_REASON_CODE", `reason_code must match ^[A-Z0-9_]{1,64}$: ${e.reason_code}`);
    }
    return this.db
      .prepare(
        `INSERT INTO financial_processing_errors (id, organization_id, operation, reference_type, reference_id, reason_code, detail, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, e.organization_id, e.operation, e.reference_type, e.reference_id, e.reason_code, e.detail ?? null, e.request_id ?? null);
  }

  /** Writes the processing error (+ caller extras such as an audit row) in one batch. Never touches ledger tables. */
  async recordProcessingError(e: ProcessingErrorInsert, extra: readonly D1PreparedStatement[] = []): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.batch([this.processingErrorStatement(e, id), ...extra]);
    return id;
  }

  async listProcessingErrors(tenantId: TenantId, referenceType: ProcessingReferenceType, referenceId: string): Promise<ProcessingErrorRow[]> {
    const { results } = await scopedQuery(
      this.db,
      `SELECT * FROM financial_processing_errors
        WHERE organization_id = ? AND reference_type = ? AND reference_id = ? ORDER BY created_at, rowid`,
      tenantId,
      referenceType,
      referenceId,
    ).all<ProcessingErrorRow>();
    return results;
  }
}
