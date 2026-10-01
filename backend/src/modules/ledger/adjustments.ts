/**
 * Financial adjustments — Phase 5 Unit 5 (PRD §59, §114 "manual adjustment →
 * audited", §131 fail-safe). Persistence + workflow over migration 0010
 * (financial_adjustments, financial_adjustment_history).
 *
 * Workflow (enforced, not merely recorded):
 *
 *   request  → row REQUESTED. Needs `ledger.adjust`. Captures before_state
 *              (the target account's balance computed from ledger_entries).
 *   approve  → REQUESTED → APPROVED. Needs `ledger.approve` AND a PLATFORM
 *              organization context. Approver must differ from the requester
 *              (checked here and by the 0010 CHECK constraint).
 *   reject   → REQUESTED → REJECTED (final). Same authority as approve.
 *   post     → APPROVED → POSTED. Needs `ledger.adjust`. The ADJUSTMENT
 *              journal is built by the verified journal builder
 *              (buildJournal: balanced, same currency, OPEN accounts, same
 *              tenant). Journal + legs + the guarded status update (with
 *              journal_id / posted_at / after_state) + history + audit land
 *              in ONE db.batch. A row that is not APPROVED cannot post.
 *
 * Fail-safe (§131): if the journal cannot be verified (unbalanced, currency
 * mismatch, closed/missing account, amount drift) NOTHING is posted — one
 * financial_processing_errors row (+ audit) is written and the adjustment
 * stays APPROVED for investigation.
 *
 * Posting twice is impossible: the guarded UPDATE only moves APPROVED →
 * POSTED (a stale row makes the batch fail its CHECK and roll back), the
 * 0010 terminal trigger refuses any status change off POSTED, and the
 * journal idempotency key `ADJUSTMENT:<id>` is UNIQUE.
 *
 * Every state change also appends a financial_adjustment_history row
 * (INSERT-only) and an audit_logs row in the same batch.
 */

import { AppError } from "../../lib/errors";
import { scopedQuery, tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { PermissionKey } from "../rbac/permissions";
import { assertCurrency, assertMinorAmount } from "./money";
import { buildJournal, captureLedger, type Direction, type JournalDraft } from "./journal";
import {
  classifyLedgerWriteError,
  type AccountBalance,
  type JournalHeader,
  type JournalRow,
  type LedgerActorType,
  type LedgerRepository,
  type ProcessingErrorRow,
} from "./repository";

// ---------------------------------------------------------------------------
// Types (mirror 0010_ledger_core.sql)
// ---------------------------------------------------------------------------

export const ADJUSTMENT_REASON_CODES = [
  "BONUS",
  "CORRECTION",
  "CLAWBACK",
  "GOODWILL",
  "FEE",
  "DISPUTE_SETTLEMENT",
  "CHARGEBACK",
  "MANUAL_CORRECTION",
  "OTHER",
] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

export const ADJUSTMENT_REFERENCE_TYPES = [
  "CONVERSION",
  "PAYOUT",
  "FRAUD_CASE",
  "COMPLIANCE_CASE",
  "RECONCILIATION_CASE",
  "TICKET",
  "OTHER",
] as const;
export type AdjustmentReferenceType = (typeof ADJUSTMENT_REFERENCE_TYPES)[number];

export const ADJUSTMENT_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "POSTED", "CANCELLED"] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

export interface AdjustmentRow {
  readonly id: string;
  readonly organization_id: string;
  readonly account_id: string;
  readonly counter_account_id: string;
  readonly direction: Direction;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reason_code: AdjustmentReasonCode;
  readonly reason_note: string;
  readonly reference_type: AdjustmentReferenceType | null;
  readonly reference_id: string | null;
  readonly status: AdjustmentStatus;
  /** JSON (AdjustmentState) captured at request time. */
  readonly before_state: string;
  /** JSON (AdjustmentState) captured at posting time; null until POSTED. */
  readonly after_state: string | null;
  readonly requested_by_user_id: string;
  readonly approved_by_user_id: string | null;
  readonly approval_note: string | null;
  readonly approved_at: string | null;
  readonly posted_at: string | null;
  readonly journal_id: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AdjustmentHistoryRow {
  readonly id: string;
  readonly adjustment_id: string;
  readonly organization_id: string;
  readonly from_status: AdjustmentStatus | null;
  readonly to_status: AdjustmentStatus;
  readonly actor_user_id: string | null;
  readonly actor_type: LedgerActorType;
  readonly note: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
}

/** What before_state / after_state hold (JSON). Balances are credit − debit (see AccountBalance). */
export interface AdjustmentState {
  readonly captured_at: string;
  readonly account: { readonly id: string; readonly balance_minor: number; readonly entry_count: number };
  readonly counter_account: { readonly id: string; readonly balance_minor: number; readonly entry_count: number };
  /** Only on after_state: projected balances once the journal legs are applied. */
  readonly projected?: { readonly account_balance_minor: number; readonly counter_account_balance_minor: number };
}

export interface RequestAdjustmentInput {
  readonly account_id: string;
  readonly counter_account_id: string;
  readonly direction: Direction;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reason_code: AdjustmentReasonCode;
  readonly reason_note: string;
  readonly reference_type?: AdjustmentReferenceType | null;
  readonly reference_id?: string | null;
}

export type PostAdjustmentResult =
  | { readonly outcome: "POSTED"; readonly adjustment: AdjustmentRow; readonly journal: JournalRow }
  | { readonly outcome: "REJECTED"; readonly reason_code: string; readonly processing_error: ProcessingErrorRow; readonly adjustment: AdjustmentRow };

interface Actor {
  readonly actor_type: "TENANT" | "PLATFORM";
  readonly user_id: string;
  readonly meta: RequestMeta;
}

/** Out-of-CHECK sentinel: a guarded UPDATE on a stale status fails the row CHECK and rolls the batch back. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";
const MAX_NOTE = 1000;

export function adjustmentIdempotencyKey(adjustmentId: string): string {
  return `ADJUSTMENT:${adjustmentId}`;
}

function opposite(d: Direction): Direction {
  return d === "DEBIT" ? "CREDIT" : "DEBIT";
}

/** Projected credit − debit after applying one leg of `direction` for `amount`. */
function project(balance: number, direction: Direction, amount: number): number {
  return direction === "CREDIT" ? balance + amount : balance - amount;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AdjustmentRepository {
  constructor(private readonly db: D1Database) {}

  findById(tenantId: TenantId, id: string): Promise<AdjustmentRow | null> {
    return scopedQuery(this.db, `SELECT * FROM financial_adjustments WHERE organization_id = ? AND id = ?`, tenantId, id).first<AdjustmentRow>();
  }

  async history(tenantId: TenantId, id: string): Promise<AdjustmentHistoryRow[]> {
    const { results } = await scopedQuery(
      this.db,
      `SELECT * FROM financial_adjustment_history WHERE organization_id = ? AND adjustment_id = ? ORDER BY created_at, rowid`,
      tenantId,
      id,
    ).all<AdjustmentHistoryRow>();
    return results;
  }

  insertStatement(row: Omit<AdjustmentRow, "status" | "after_state" | "approved_by_user_id" | "approval_note" | "approved_at" | "posted_at" | "journal_id">): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO financial_adjustments
           (id, organization_id, account_id, counter_account_id, direction, amount_minor, currency, reason_code, reason_note,
            reference_type, reference_id, status, before_state, requested_by_user_id, request_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.organization_id,
        row.account_id,
        row.counter_account_id,
        row.direction,
        row.amount_minor,
        row.currency,
        row.reason_code,
        row.reason_note,
        row.reference_type,
        row.reference_id,
        row.before_state,
        row.requested_by_user_id,
        row.request_id,
        row.created_at,
        row.updated_at,
      );
  }

  historyStatement(tenantId: TenantId, h: Omit<AdjustmentHistoryRow, "id" | "organization_id" | "created_at">, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO financial_adjustment_history
           (id, adjustment_id, organization_id, from_status, to_status, actor_user_id, actor_type, note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), h.adjustment_id, tenantId, h.from_status, h.to_status, h.actor_user_id, h.actor_type, h.note, h.request_id, now);
  }

  /** REQUESTED → APPROVED, guarded. Sets approver fields (the CHECK requires them for APPROVED). */
  approveStatement(tenantId: TenantId, id: string, approverId: string, note: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE financial_adjustments
            SET status = CASE WHEN status = 'REQUESTED' THEN 'APPROVED' ELSE ? END,
                approved_by_user_id = ?, approved_at = ?, approval_note = ?, updated_at = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(CONFLICT_SENTINEL, approverId, now, note, now, tenantId, id);
  }

  /** REQUESTED → REJECTED, guarded. Approver columns stay NULL (CHECK: only APPROVED/POSTED carry them). */
  rejectStatement(tenantId: TenantId, id: string, note: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE financial_adjustments
            SET status = CASE WHEN status = 'REQUESTED' THEN 'REJECTED' ELSE ? END,
                approval_note = ?, updated_at = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(CONFLICT_SENTINEL, note, now, tenantId, id);
  }

  /** APPROVED → POSTED, guarded; journal_id / posted_at / after_state are set in the same statement (CHECK demands all three). */
  postStatement(tenantId: TenantId, id: string, journalId: string, afterState: string, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE financial_adjustments
            SET status = CASE WHEN status = 'APPROVED' THEN 'POSTED' ELSE ? END,
                journal_id = ?, posted_at = ?, after_state = ?, updated_at = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(CONFLICT_SENTINEL, journalId, now, afterState, now, tenantId, id);
  }

  async batch(statements: readonly D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch([...statements]);
    } catch (err) {
      throw classifyAdjustmentWriteError(err);
    }
  }
}

export function classifyAdjustmentWriteError(err: unknown): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: financial_adjustments\.journal_id/i.test(msg)) {
    return new AppError(409, "ADJUSTMENT_JOURNAL_REUSED", "this journal already backs an adjustment");
  }
  if (/FINANCIAL_ADJUSTMENT_FINAL/i.test(msg)) {
    return new AppError(409, "ADJUSTMENT_FINAL", "the adjustment is in a terminal state; nothing was written");
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new AppError(409, "ADJUSTMENT_STATE_CONFLICT", "the adjustment changed underneath this request; nothing was written");
  }
  return classifyLedgerWriteError(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdjustmentServiceOptions {
  readonly now?: () => Date;
}

export class AdjustmentService {
  private readonly now: () => Date;

  constructor(
    private readonly adjustments: AdjustmentRepository,
    private readonly ledger: LedgerRepository,
    private readonly audit: AuditRepository,
    options: AdjustmentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---- HTTP entry points: permission checks run synchronously, before any I/O ----

  request(ctx: AuthenticatedContext, tenant: TenantContext, input: RequestAdjustmentInput, meta: RequestMeta): Promise<AdjustmentRow> {
    this.require(tenant, "ledger.adjust");
    return this.doRequest(tenantIdOf(tenant), input, actorFrom(ctx, tenant, meta));
  }

  approve(ctx: AuthenticatedContext, tenant: TenantContext, adjustmentId: string, note: string | null, meta: RequestMeta): Promise<AdjustmentRow> {
    this.require(tenant, "ledger.approve");
    this.requirePlatform(tenant, "only platform staff can approve financial adjustments");
    return this.decide(tenantIdOf(tenant), adjustmentId, "APPROVED", note, actorFrom(ctx, tenant, meta));
  }

  reject(ctx: AuthenticatedContext, tenant: TenantContext, adjustmentId: string, note: string | null, meta: RequestMeta): Promise<AdjustmentRow> {
    this.require(tenant, "ledger.approve");
    this.requirePlatform(tenant, "only platform staff can reject financial adjustments");
    return this.decide(tenantIdOf(tenant), adjustmentId, "REJECTED", note, actorFrom(ctx, tenant, meta));
  }

  post(ctx: AuthenticatedContext, tenant: TenantContext, adjustmentId: string, meta: RequestMeta): Promise<PostAdjustmentResult> {
    this.require(tenant, "ledger.adjust");
    return this.doPost(tenantIdOf(tenant), adjustmentId, actorFrom(ctx, tenant, meta));
  }

  get(tenant: TenantContext, adjustmentId: string): Promise<AdjustmentRow | null> {
    this.require(tenant, "ledger.read");
    return this.adjustments.findById(tenantIdOf(tenant), adjustmentId);
  }

  history(tenant: TenantContext, adjustmentId: string): Promise<AdjustmentHistoryRow[]> {
    this.require(tenant, "ledger.read");
    return this.adjustments.history(tenantIdOf(tenant), adjustmentId);
  }

  // ---- request -------------------------------------------------------------------

  private async doRequest(tenantId: TenantId, input: RequestAdjustmentInput, actor: Actor): Promise<AdjustmentRow> {
    const v = validateRequest(input);
    const [account, counter] = await Promise.all([this.ledger.findAccount(tenantId, v.account_id), this.ledger.findAccount(tenantId, v.counter_account_id)]);
    if (!account) throw new AppError(404, "LEDGER_ACCOUNT_NOT_FOUND", "account not found");
    if (!counter) throw new AppError(404, "LEDGER_ACCOUNT_NOT_FOUND", "counter account not found");
    for (const a of [account, counter]) {
      if (a.status !== "OPEN") throw new AppError(409, "LEDGER_ACCOUNT_NOT_OPEN", `account ${a.id} is not OPEN`);
      if (a.currency !== v.currency) {
        throw new AppError(400, "ADJUSTMENT_CURRENCY_MISMATCH", `account ${a.id} is ${a.currency}, adjustment is ${v.currency}`);
      }
    }

    const nowIso = this.now().toISOString();
    const before = await this.captureState(tenantId, v.account_id, v.counter_account_id, nowIso);
    const id = crypto.randomUUID();
    const requestId = actor.meta.request_id ?? null;
    await this.adjustments.batch([
      this.adjustments.insertStatement({
        id,
        organization_id: tenantId,
        account_id: v.account_id,
        counter_account_id: v.counter_account_id,
        direction: v.direction,
        amount_minor: v.amount_minor,
        currency: v.currency,
        reason_code: v.reason_code,
        reason_note: v.reason_note,
        reference_type: v.reference_type,
        reference_id: v.reference_id,
        before_state: JSON.stringify(before),
        requested_by_user_id: actor.user_id,
        request_id: requestId,
        created_at: nowIso,
        updated_at: nowIso,
      }),
      this.adjustments.historyStatement(
        tenantId,
        { adjustment_id: id, from_status: null, to_status: "REQUESTED", actor_user_id: actor.user_id, actor_type: actor.actor_type, note: v.reason_note, request_id: requestId },
        nowIso,
      ),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.adjustment.requested",
        target_type: "financial_adjustment",
        target_id: id,
        metadata: {
          account_id: v.account_id,
          counter_account_id: v.counter_account_id,
          direction: v.direction,
          amount_minor: v.amount_minor,
          currency: v.currency,
          reason_code: v.reason_code,
          reference_type: v.reference_type,
          reference_id: v.reference_id,
          actor: actor.actor_type,
        },
        meta: actor.meta,
      }),
    ]);
    return this.mustFind(tenantId, id);
  }

  // ---- approve / reject ------------------------------------------------------------

  private async decide(tenantId: TenantId, id: string, to: "APPROVED" | "REJECTED", noteIn: string | null, actor: Actor): Promise<AdjustmentRow> {
    const note = checkNote(noteIn);
    const row = await this.mustFind(tenantId, id);
    if (row.status !== "REQUESTED") {
      throw new AppError(409, "ADJUSTMENT_NOT_REQUESTED", `adjustment is ${row.status}; only REQUESTED adjustments can be ${to.toLowerCase()}`);
    }
    if (to === "APPROVED" && row.requested_by_user_id === actor.user_id) {
      throw new AppError(409, "ADJUSTMENT_SELF_APPROVAL", "an adjustment cannot be approved by the user who requested it");
    }
    const nowIso = this.now().toISOString();
    const requestId = actor.meta.request_id ?? null;
    const update =
      to === "APPROVED"
        ? this.adjustments.approveStatement(tenantId, id, actor.user_id, note, nowIso)
        : this.adjustments.rejectStatement(tenantId, id, note, nowIso);
    await this.adjustments.batch([
      update,
      this.adjustments.historyStatement(
        tenantId,
        { adjustment_id: id, from_status: "REQUESTED", to_status: to, actor_user_id: actor.user_id, actor_type: actor.actor_type, note, request_id: requestId },
        nowIso,
      ),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: to === "APPROVED" ? "ledger.adjustment.approved" : "ledger.adjustment.rejected",
        target_type: "financial_adjustment",
        target_id: id,
        metadata: { from_status: "REQUESTED", to_status: to, note, requested_by_user_id: row.requested_by_user_id, actor: actor.actor_type },
        meta: actor.meta,
      }),
    ]);
    return this.mustFind(tenantId, id);
  }

  // ---- post --------------------------------------------------------------------------

  private async doPost(tenantId: TenantId, id: string, actor: Actor): Promise<PostAdjustmentResult> {
    const row = await this.mustFind(tenantId, id);
    if (row.status !== "APPROVED") {
      const code = row.status === "POSTED" ? "ADJUSTMENT_ALREADY_POSTED" : "ADJUSTMENT_NOT_APPROVED";
      throw new AppError(409, code, `adjustment is ${row.status}; only APPROVED adjustments can be posted`);
    }
    if (!row.approved_by_user_id || row.approved_by_user_id === row.requested_by_user_id) {
      // Defence in depth — the DB CHECK already forbids both; never post on a corrupted approval.
      return this.failSafe(tenantId, row, "ADJUSTMENT_APPROVAL_INVALID", "approval record is missing or self-approved", actor);
    }

    // Verified journal: buildJournal enforces balance, currency, OPEN accounts, tenant ownership.
    const accounts = await this.ledger.accountsOf(tenantId);
    const built = captureLedger(() =>
      buildJournal(
        {
          organization_id: tenantId,
          journal_type: "ADJUSTMENT",
          currency: row.currency,
          reference_type: "FINANCIAL_ADJUSTMENT",
          reference_id: row.id,
          idempotency_key: adjustmentIdempotencyKey(row.id),
          description: row.reason_note.slice(0, 500),
          legs: [
            { account_id: row.account_id, direction: row.direction, amount_minor: row.amount_minor, memo: row.reason_code },
            { account_id: row.counter_account_id, direction: opposite(row.direction), amount_minor: row.amount_minor, memo: row.reason_code },
          ],
        },
        accounts,
      ),
    );
    if (!built.ok) return this.failSafe(tenantId, row, built.reason_code, built.detail ?? null, actor);
    const draft: JournalDraft = built.value;
    if (draft.total_minor !== row.amount_minor || draft.currency !== row.currency || draft.legs.length !== 2) {
      return this.failSafe(tenantId, row, "ADJUSTMENT_AMOUNT_DRIFT", `journal ${draft.total_minor} ${draft.currency} vs adjustment ${row.amount_minor} ${row.currency}`, actor);
    }

    const nowIso = this.now().toISOString();
    const requestId = actor.meta.request_id ?? null;
    const state = await this.captureState(tenantId, row.account_id, row.counter_account_id, nowIso);
    const after: AdjustmentState = {
      ...state,
      projected: {
        account_balance_minor: project(state.account.balance_minor, row.direction, row.amount_minor),
        counter_account_balance_minor: project(state.counter_account.balance_minor, opposite(row.direction), row.amount_minor),
      },
    };
    const journalId = crypto.randomUUID();
    const header: JournalHeader = { id: journalId, actor_type: actor.actor_type, posted_by_user_id: actor.user_id, request_id: requestId, posted_at: nowIso };
    // ONE batch: journal + legs + guarded APPROVED→POSTED (journal_id, posted_at, after_state) + history + audit.
    const { statements } = this.ledger.journalStatements(draft, header, [
      this.adjustments.postStatement(tenantId, row.id, journalId, JSON.stringify(after), nowIso),
      this.adjustments.historyStatement(
        tenantId,
        { adjustment_id: row.id, from_status: "APPROVED", to_status: "POSTED", actor_user_id: actor.user_id, actor_type: actor.actor_type, note: null, request_id: requestId },
        nowIso,
      ),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.adjustment.posted",
        target_type: "financial_adjustment",
        target_id: row.id,
        metadata: {
          journal_id: journalId,
          amount_minor: row.amount_minor,
          currency: row.currency,
          direction: row.direction,
          account_id: row.account_id,
          counter_account_id: row.counter_account_id,
          requested_by_user_id: row.requested_by_user_id,
          approved_by_user_id: row.approved_by_user_id,
          actor: actor.actor_type,
        },
        meta: actor.meta,
      }),
    ]);
    await this.adjustments.batch(statements);

    const [adjustment, journal] = await Promise.all([this.mustFind(tenantId, row.id), this.ledger.findJournal(tenantId, journalId)]);
    if (!journal) throw new AppError(500, "JOURNAL_NOT_WRITTEN", "adjustment journal did not persist");
    return { outcome: "POSTED", adjustment, journal };
  }

  /** §131: record the failure, post nothing. The adjustment row is untouched (still APPROVED). */
  private async failSafe(tenantId: TenantId, row: AdjustmentRow, reasonCode: string, detail: string | null, actor: Actor): Promise<PostAdjustmentResult> {
    const requestId = actor.meta.request_id ?? null;
    const errorId = await this.ledger.recordProcessingError(
      { organization_id: tenantId, operation: "POST_ADJUSTMENT", reference_type: "FINANCIAL_ADJUSTMENT", reference_id: row.id, reason_code: reasonCode, detail, request_id: requestId },
      [
        this.audit.statement({
          organization_id: tenantId,
          actor_user_id: actor.user_id,
          action: "ledger.adjustment.post_rejected",
          target_type: "financial_adjustment",
          target_id: row.id,
          metadata: { reason_code: reasonCode, detail, actor: actor.actor_type },
          meta: actor.meta,
        }),
      ],
    );
    const errors = await this.ledger.listProcessingErrors(tenantId, "FINANCIAL_ADJUSTMENT", row.id);
    const processing_error = errors.find((e) => e.id === errorId);
    if (!processing_error) throw new AppError(500, "PROCESSING_ERROR_NOT_WRITTEN", "processing error did not persist");
    return { outcome: "REJECTED", reason_code: reasonCode, processing_error, adjustment: row };
  }

  // ---- helpers -----------------------------------------------------------------------

  private async captureState(tenantId: TenantId, accountId: string, counterId: string, capturedAt: string): Promise<AdjustmentState> {
    const [a, c]: [AccountBalance, AccountBalance] = await Promise.all([this.ledger.computeBalance(tenantId, accountId), this.ledger.computeBalance(tenantId, counterId)]);
    return {
      captured_at: capturedAt,
      account: { id: a.account_id, balance_minor: a.balance_minor, entry_count: a.entry_count },
      counter_account: { id: c.account_id, balance_minor: c.balance_minor, entry_count: c.entry_count },
    };
  }

  private async mustFind(tenantId: TenantId, id: string): Promise<AdjustmentRow> {
    const row = await this.adjustments.findById(tenantId, id);
    if (!row) throw new AppError(404, "NOT_FOUND", "financial adjustment not found");
    return row;
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private requirePlatform(tenant: TenantContext, message: string): void {
    if (actorOf(tenant) !== "PLATFORM") throw new AppError(403, "PLATFORM_ONLY", message);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidRequest {
  readonly account_id: string;
  readonly counter_account_id: string;
  readonly direction: Direction;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reason_code: AdjustmentReasonCode;
  readonly reason_note: string;
  readonly reference_type: AdjustmentReferenceType | null;
  readonly reference_id: string | null;
}

function validateRequest(input: RequestAdjustmentInput): ValidRequest {
  const bad = (code: string, msg: string) => new AppError(400, code, msg);
  const account_id = nonEmpty(input.account_id);
  const counter_account_id = nonEmpty(input.counter_account_id);
  if (!account_id || !counter_account_id) throw bad("ADJUSTMENT_ACCOUNT_REQUIRED", "account_id and counter_account_id are required");
  if (account_id === counter_account_id) throw bad("ADJUSTMENT_SAME_ACCOUNT", "account_id and counter_account_id must differ");
  if (input.direction !== "DEBIT" && input.direction !== "CREDIT") throw bad("ADJUSTMENT_INVALID_DIRECTION", "direction must be DEBIT or CREDIT");
  let amount_minor: number;
  let currency: string;
  try {
    amount_minor = assertMinorAmount(input.amount_minor);
    currency = assertCurrency(input.currency);
  } catch (err) {
    throw bad("ADJUSTMENT_INVALID_MONEY", err instanceof Error ? err.message : "invalid amount or currency");
  }
  if (amount_minor <= 0) throw bad("ADJUSTMENT_INVALID_MONEY", "amount_minor must be > 0");
  if (!(ADJUSTMENT_REASON_CODES as readonly string[]).includes(input.reason_code)) {
    throw bad("ADJUSTMENT_INVALID_REASON", `reason_code must be one of ${ADJUSTMENT_REASON_CODES.join(", ")}`);
  }
  const reason_note = typeof input.reason_note === "string" ? input.reason_note.trim() : "";
  if (reason_note.length < 1 || reason_note.length > MAX_NOTE) throw bad("ADJUSTMENT_REASON_NOTE_REQUIRED", `reason_note must be 1–${MAX_NOTE} characters`);
  const reference_type = input.reference_type ?? null;
  const reference_id = nonEmpty(input.reference_id ?? null);
  if ((reference_type === null) !== (reference_id === null)) throw bad("ADJUSTMENT_REFERENCE_INCOMPLETE", "reference_type and reference_id must be given together");
  if (reference_type !== null && !(ADJUSTMENT_REFERENCE_TYPES as readonly string[]).includes(reference_type)) {
    throw bad("ADJUSTMENT_INVALID_REFERENCE_TYPE", `reference_type must be one of ${ADJUSTMENT_REFERENCE_TYPES.join(", ")}`);
  }
  return { account_id, counter_account_id, direction: input.direction, amount_minor, currency, reason_code: input.reason_code, reason_note, reference_type, reference_id };
}

function checkNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const t = String(note).trim();
  if (t.length === 0) return null;
  if (t.length > MAX_NOTE) throw new AppError(400, "ADJUSTMENT_NOTE_TOO_LONG", `note must be at most ${MAX_NOTE} characters`);
  return t;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function actorOf(tenant: TenantContext): "TENANT" | "PLATFORM" {
  return tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT";
}

function actorFrom(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Actor {
  return { actor_type: actorOf(tenant), user_id: ctx.user.id, meta };
}
