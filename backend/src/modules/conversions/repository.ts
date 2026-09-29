/**
 * ConversionRepository — Phase 4 Unit 5a (PRD §38, §40, §115).
 *
 * Persistence for the conversion lifecycle on top of migration 0009:
 *
 *   - conversions.lifecycle_status (12-state) is the ONLY column a transition
 *     mutates on the original row; commission_* are set ONCE at APPROVED.
 *   - conversion_status_history is INSERT-only (one row per transition).
 *   - conversion_reversals is INSERT-only (UNIQUE conversion_id) — the
 *     compensating record; the original conversion is never edited.
 *   - conversion_holds: ACTIVE/RELEASED, scoped per conversion or per affiliate.
 *
 * Atomic guarded transition
 * -------------------------
 * `transition()` runs the UPDATE, the history INSERT and any extra statements
 * (audit, reversal, commission) in ONE db.batch. The UPDATE is written so a
 * stale `expected_from` cannot silently succeed: when the live status differs
 * it sets the column to an out-of-CHECK sentinel, which makes SQLite reject
 * the statement and roll back the whole batch — history and audit rows are
 * never written for a lost race. The caller receives 409 CONVERSION_STATE_CONFLICT.
 *
 * Tenant scoping: every read goes through `scopedQuery` (organization_id = ?
 * first). INSERTs and SET-first UPDATEs bind the tenant id explicitly.
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { slicePage } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import type { ConversionActor, ConversionStatus, HoldFacts, HoldType } from "./state-machine";
import { isHoldType } from "./state-machine";

export interface ConversionRecord {
  id: string;
  organization_id: string;
  offer_id: string;
  offer_version_id: string | null;
  click_id: string | null;
  affiliate_organization_id: string | null;
  external_conversion_id: string;
  transaction_id: string | null;
  event_id: string | null;
  conversion_event: string;
  status: string;
  lifecycle_status: ConversionStatus;
  idempotency_key: string | null;
  source: string;
  sale_amount_minor: number | null;
  currency: string | null;
  commission_amount_minor: number | null;
  commission_currency: string | null;
  occurred_at: string;
  received_at: string;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatusHistoryRow {
  id: string;
  organization_id: string;
  conversion_id: string;
  from_status: ConversionStatus | null;
  to_status: ConversionStatus;
  actor_type: ConversionActor;
  actor_user_id: string | null;
  reason_code: string;
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export const REVERSAL_REASON_CODES = [
  "REFUND",
  "CHARGEBACK",
  "FRAUD_CONFIRMED",
  "ADVERTISER_DISPUTE",
  "DUPLICATE_DETECTED_LATE",
  "COMPLIANCE_VIOLATION",
  "MANUAL_CORRECTION",
] as const;
export type ReversalReasonCode = (typeof REVERSAL_REASON_CODES)[number];

export interface ReversalRow {
  id: string;
  organization_id: string;
  conversion_id: string;
  reason_code: ReversalReasonCode;
  amount_minor: number;
  currency: string;
  reversed_by_user_id: string | null;
  actor_type: "TENANT" | "PLATFORM" | "SYSTEM";
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export const HOLD_SOURCE_TYPES = ["FRAUD_CASE", "FRAUD_ACTION", "COMPLIANCE_CASE", "MANUAL", "SYSTEM"] as const;
export type HoldSourceType = (typeof HOLD_SOURCE_TYPES)[number];

export interface HoldRow {
  id: string;
  organization_id: string;
  conversion_id: string | null;
  affiliate_organization_id: string | null;
  hold_type: HoldType;
  status: "ACTIVE" | "RELEASED";
  reason_code: string;
  source_type: HoldSourceType;
  source_id: string | null;
  created_by_user_id: string | null;
  released_by_user_id: string | null;
  released_reason_code: string | null;
  released_at: string | null;
  created_at: string;
}

export interface TransitionInput {
  conversion_id: string;
  /** Live status the caller observed; the batch fails if it no longer matches. */
  expected_from: ConversionStatus;
  to: ConversionStatus;
  actor_type: ConversionActor;
  actor_user_id: string | null;
  reason_code: string;
  note: string | null;
  request_id: string | null;
  /** ISO timestamp used for updated_at (service clock, testable). */
  now: string;
}

export interface ReversalInsert {
  id: string;
  conversion_id: string;
  reason_code: ReversalReasonCode;
  amount_minor: number;
  currency: string;
  reversed_by_user_id: string | null;
  actor_type: "TENANT" | "PLATFORM" | "SYSTEM";
  note: string | null;
  request_id: string | null;
}

export interface HoldInsert {
  id: string;
  conversion_id: string | null;
  affiliate_organization_id: string | null;
  hold_type: HoldType;
  reason_code: string;
  source_type: HoldSourceType;
  source_id: string | null;
  created_by_user_id: string | null;
}

export interface ConversionListFilter {
  offer_id?: string;
  lifecycle_status?: ConversionStatus;
  affiliate_organization_id?: string;
}

/** Fraud case statuses that count as "review open" for the payout guard. */
const OPEN_FRAUD_CASE_STATUSES = "'OPEN','UNDER_REVIEW','APPEALED'";

/** Out-of-CHECK sentinel: forces the guarded UPDATE to fail on a stale expected_from. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";

function isCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CHECK constraint failed/i.test(msg);
}

export class ConversionRepository {
  constructor(private readonly db: D1Database) {}

  // ---- reads ---------------------------------------------------------------

  async findById(tenantId: TenantId, id: string): Promise<ConversionRecord | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM conversions WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<ConversionRecord>();
    return row ?? null;
  }

  async list(tenantId: TenantId, page: PageRequest, filter: ConversionListFilter): Promise<Page<ConversionRecord>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.offer_id) {
      where.push("offer_id = ?");
      binds.push(filter.offer_id);
    }
    if (filter.lifecycle_status) {
      where.push("lifecycle_status = ?");
      binds.push(filter.lifecycle_status);
    }
    if (filter.affiliate_organization_id) {
      where.push("affiliate_organization_id = ?");
      binds.push(filter.affiliate_organization_id);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM conversions WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ConversionRecord>();
    return slicePage(res.results, page.limit);
  }

  async listHistory(tenantId: TenantId, conversionId: string): Promise<StatusHistoryRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM conversion_status_history WHERE organization_id = ? AND conversion_id = ? ORDER BY created_at ASC, id ASC`,
      tenantId,
      conversionId,
    ).all<StatusHistoryRow>();
    return res.results;
  }

  async findReversal(tenantId: TenantId, conversionId: string): Promise<ReversalRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM conversion_reversals WHERE organization_id = ? AND conversion_id = ?`,
      tenantId,
      conversionId,
    ).first<ReversalRow>();
    return row ?? null;
  }

  async findHold(tenantId: TenantId, holdId: string): Promise<HoldRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM conversion_holds WHERE organization_id = ? AND id = ?`,
      tenantId,
      holdId,
    ).first<HoldRow>();
    return row ?? null;
  }

  /**
   * ACTIVE holds that apply to a conversion: holds pinned to the conversion
   * itself plus affiliate-scoped holds for its affiliate (when known).
   */
  async listActiveHolds(
    tenantId: TenantId,
    scope: { conversion_id: string; affiliate_organization_id: string | null },
  ): Promise<HoldRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM conversion_holds
        WHERE organization_id = ? AND status = 'ACTIVE'
          AND (conversion_id = ? OR (affiliate_organization_id IS NOT NULL AND affiliate_organization_id = ?))
        ORDER BY created_at ASC, id ASC`,
      tenantId,
      scope.conversion_id,
      scope.affiliate_organization_id,
    ).all<HoldRow>();
    return res.results;
  }

  /** Facts consumed by the pure state-machine guard (`guardTransition`, `isPayoutBlockedBy`). */
  async holdFacts(tenantId: TenantId, scope: { conversion_id: string; affiliate_organization_id: string | null }): Promise<HoldFacts> {
    const holds = await this.listActiveHolds(tenantId, scope);
    const activeHoldTypes: HoldType[] = [];
    for (const h of holds) if (isHoldType(h.hold_type) && !activeHoldTypes.includes(h.hold_type)) activeHoldTypes.push(h.hold_type);
    const open = await scopedQuery(
      this.db,
      `SELECT COUNT(*) AS n FROM fraud_cases
        WHERE organization_id = ? AND status IN (${OPEN_FRAUD_CASE_STATUSES})
          AND (conversion_id = ? OR (affiliate_organization_id IS NOT NULL AND affiliate_organization_id = ?))`,
      tenantId,
      scope.conversion_id,
      scope.affiliate_organization_id,
    ).first<{ n: number }>();
    return { activeHoldTypes, fraudReviewOpen: (open?.n ?? 0) > 0 };
  }

  // ---- statements (composed into one batch by the service) -----------------

  /** Guarded UPDATE: stale expected_from → CHECK violation → whole batch rolls back. */
  private guardedUpdateStatement(tenantId: TenantId, input: TransitionInput): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE conversions
            SET lifecycle_status = CASE WHEN lifecycle_status = ? THEN ? ELSE ? END,
                updated_at = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(input.expected_from, input.to, CONFLICT_SENTINEL, input.now, tenantId, input.conversion_id);
  }

  private historyStatement(tenantId: TenantId, input: TransitionInput): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO conversion_status_history
           (organization_id, id, conversion_id, from_status, to_status, actor_type, actor_user_id, reason_code, note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        crypto.randomUUID(),
        input.conversion_id,
        input.expected_from,
        input.to,
        input.actor_type,
        input.actor_user_id,
        input.reason_code,
        input.note,
        input.request_id,
        input.now,
      );
  }

  reversalStatement(tenantId: TenantId, r: ReversalInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO conversion_reversals
           (organization_id, id, conversion_id, reason_code, amount_minor, currency, reversed_by_user_id, actor_type, note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        r.id,
        r.conversion_id,
        r.reason_code,
        r.amount_minor,
        r.currency,
        r.reversed_by_user_id,
        r.actor_type,
        r.note,
        r.request_id,
        now,
      );
  }

  /**
   * Commission is written ONCE (at APPROVED). The `IS NULL` guard makes a
   * second write a no-op instead of silently changing money already recorded.
   */
  commissionStatement(tenantId: TenantId, conversionId: string, amountMinor: number, currency: string): D1PreparedStatement {
    if (!Number.isInteger(amountMinor) || amountMinor < 0)
      throw new AppError(400, "INVALID_AMOUNT", "commission must be a non-negative integer (minor units)");
    return this.db
      .prepare(
        `UPDATE conversions SET commission_amount_minor = ?, commission_currency = ?
          WHERE organization_id = ? AND id = ? AND commission_amount_minor IS NULL`,
      )
      .bind(amountMinor, currency, tenantId, conversionId);
  }

  holdStatement(tenantId: TenantId, h: HoldInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO conversion_holds
           (organization_id, id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type, source_id,
            created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        h.id,
        h.conversion_id,
        h.affiliate_organization_id,
        h.hold_type,
        h.reason_code,
        h.source_type,
        h.source_id,
        h.created_by_user_id,
        now,
      );
  }

  releaseHoldStatement(
    tenantId: TenantId,
    holdId: string,
    releasedBy: string | null,
    reasonCode: string,
    now: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE conversion_holds
            SET status = 'RELEASED', released_by_user_id = ?, released_reason_code = ?, released_at = ?
          WHERE organization_id = ? AND id = ? AND status = 'ACTIVE'`,
      )
      .bind(releasedBy, reasonCode, now, tenantId, holdId);
  }

  // ---- mutations -------------------------------------------------------------

  /**
   * Apply one lifecycle transition atomically with its history row and any
   * extra statements (audit / reversal / commission / hold).
   * Throws 404 when the conversion is not visible to the tenant and
   * 409 CONVERSION_STATE_CONFLICT when `expected_from` is stale.
   */
  async transition(tenantId: TenantId, input: TransitionInput, extra: D1PreparedStatement[] = []): Promise<void> {
    // Visibility check BEFORE the batch: a 0-row UPDATE is not an error in SQL, and the
    // history/extra statements must never be written for a conversion this tenant cannot see.
    // Conversions are never deleted (ON DELETE RESTRICT), so this cannot race with removal.
    const visible = await scopedQuery(
      this.db,
      `SELECT 1 AS one FROM conversions WHERE organization_id = ? AND id = ?`,
      tenantId,
      input.conversion_id,
    ).first<{
      one: number;
    }>();
    if (!visible) throw new AppError(404, "NOT_FOUND", "conversion not found");
    try {
      await this.db.batch([this.guardedUpdateStatement(tenantId, input), this.historyStatement(tenantId, input), ...extra]);
    } catch (err) {
      if (isCheckViolation(err)) {
        throw new AppError(409, "CONVERSION_STATE_CONFLICT", `conversion is no longer ${input.expected_from}`);
      }
      throw err;
    }
  }

  async insertHold(tenantId: TenantId, h: HoldInsert, now: string, extra: D1PreparedStatement[] = []): Promise<void> {
    await this.db.batch([this.holdStatement(tenantId, h, now), ...extra]);
  }

  /** Returns false when the hold was not ACTIVE (or not visible) — nothing written. */
  async releaseHold(
    tenantId: TenantId,
    holdId: string,
    releasedBy: string | null,
    reasonCode: string,
    now: string,
    extra: D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const results = await this.db.batch([this.releaseHoldStatement(tenantId, holdId, releasedBy, reasonCode, now), ...extra]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }
}
