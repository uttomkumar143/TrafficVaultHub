/**
 * PayoutRepository — Phase 5 Unit 11 (PRD §65, §66, §114, §132).
 *
 * Persistence ONLY for `payouts`, `payout_status_history`, `payout_attempts`
 * (migration 0011) plus the read-side facts that feed the pure
 * `evaluatePayoutEligibility()` (eligibility.ts). No service / HTTP here.
 *
 * Tenant model: a payout belongs to the AFFILIATE organization
 * (`payouts.organization_id` == `payout_methods.organization_id`). The facts
 * that decide eligibility (conversions, holds, fraud / compliance cases) are
 * rows owned by ADVERTISER tenants that reference the affiliate through
 * `affiliate_organization_id`. Those reads are therefore scoped
 * `organization_id = ? OR affiliate_organization_id = ?` with the SAME
 * affiliate tenant id bound twice, which keeps the `scopedQuery` guard
 * (organization_id = ? must be the first placeholder) and cannot leak another
 * affiliate's rows. `organizations.status` is read by primary key (the tenant
 * row itself has no organization_id column).
 *
 * Writes are exposed as statement builders. A future service composes them
 * (INSERT payout / guarded status UPDATE / history INSERT / attempt INSERT /
 * audit rows) into ONE `db.batch`. The status UPDATE is guarded: a stale
 * `expectedFrom` writes the out-of-CHECK sentinel, which 0011 rejects
 * (CHECK or trg_payouts_legal_transition), so the whole batch rolls back and
 * nothing — not even the history row — is persisted (same pattern as
 * fraud/repository.ts and conversions/repository.ts).
 *
 * Money: INTEGER minor units + ISO-4217 code only; never floats, never
 * cross-currency arithmetic. Builders refuse non-integer / unsafe amounts
 * before any SQL runs.
 *
 * Known gap: there is no disputes / chargebacks table yet, so
 * `openDisputeCount()` returns 0 (documented, see below).
 */
import { AppError } from "../../lib/errors";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import type { ComplianceCaseStatus } from "../compliance/repository";
import type { HoldFacts, HoldType } from "../conversions/state-machine";
import { isHoldType } from "../conversions/state-machine";
import type { FraudCaseStatus } from "../fraud/repository";
import { OPEN_COMPLIANCE_CASE_STATUSES, OPEN_FRAUD_CASE_STATUSES, type OrgStatus, type PayoutMethodStatus } from "./eligibility";
import type { PayoutStatus } from "./state-machine";

// ---- row shapes (mirror 0011 columns) ----------------------------------------------------

export type PayoutRequestedActor = "TENANT" | "PLATFORM" | "SYSTEM";
export type PayoutHistoryActor = "TENANT" | "PLATFORM" | "SYSTEM" | "INTERNAL" | "PROVIDER";
export type PayoutAttemptActor = "PLATFORM" | "SYSTEM" | "INTERNAL";

export const PAYOUT_ATTEMPT_OUTCOMES = ["SUBMITTED", "ACCEPTED", "SUCCEEDED", "FAILED", "TIMEOUT", "REJECTED"] as const;
export type PayoutAttemptOutcome = (typeof PAYOUT_ATTEMPT_OUTCOMES)[number];

export interface PayoutRow {
  id: string;
  organization_id: string;
  payout_method_id: string;
  amount_minor: number;
  currency: string;
  fee_minor: number;
  status: PayoutStatus;
  idempotency_key: string;
  provider: string | null;
  provider_reference: string | null;
  period_start: string | null;
  period_end: string | null;
  eligibility_snapshot: string | null;
  requested_by_user_id: string | null;
  requested_actor_type: PayoutRequestedActor;
  approved_by_user_id: string | null;
  approved_at: string | null;
  approval_note: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  journal_id: string | null;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutStatusHistoryRow {
  id: string;
  payout_id: string;
  organization_id: string;
  from_status: PayoutStatus | null;
  to_status: PayoutStatus;
  actor_user_id: string | null;
  actor_type: PayoutHistoryActor;
  reason_code: string | null;
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export interface PayoutAttemptRow {
  id: string;
  payout_id: string;
  organization_id: string;
  attempt_number: number;
  provider: string;
  provider_idempotency_key: string;
  provider_reference: string | null;
  amount_minor: number;
  currency: string;
  outcome: PayoutAttemptOutcome;
  response_code: string | null;
  error_code: string | null;
  error_message: string | null;
  request_hash: string | null;
  actor_type: PayoutAttemptActor;
  actor_user_id: string | null;
  request_id: string | null;
  created_at: string;
}

export interface PayoutMethodRow {
  id: string;
  organization_id: string;
  affiliate_profile_id: string;
  method_type: string;
  provider: string;
  provider_token: string;
  display_label: string;
  currency: string;
  country_code: string | null;
  status: PayoutMethodStatus;
  is_default: number;
  verified_at: string | null;
  disabled_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---- insert shapes -------------------------------------------------------------------------

export interface PayoutInsert {
  id: string;
  payout_method_id: string;
  amount_minor: number;
  currency: string;
  fee_minor?: number;
  idempotency_key: string;
  period_start?: string | null;
  period_end?: string | null;
  eligibility_snapshot?: string | null;
  requested_by_user_id: string | null;
  requested_actor_type: PayoutRequestedActor;
  request_id?: string | null;
}

export interface PayoutHistoryInsert {
  id: string;
  payout_id: string;
  from_status: PayoutStatus | null;
  to_status: PayoutStatus;
  actor_user_id?: string | null;
  actor_type: PayoutHistoryActor;
  reason_code?: string | null;
  note?: string | null;
  request_id?: string | null;
}

export interface PayoutAttemptInsert {
  id: string;
  payout_id: string;
  attempt_number: number;
  provider: string;
  provider_idempotency_key: string;
  provider_reference?: string | null;
  amount_minor: number;
  currency: string;
  outcome: PayoutAttemptOutcome;
  response_code?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  request_hash?: string | null;
  actor_type: PayoutAttemptActor;
  actor_user_id?: string | null;
  request_id?: string | null;
}

/** Columns the guarded status UPDATE may set alongside `status` (all optional). */
export interface PayoutStatusExtra {
  approved_by_user_id?: string | null;
  approved_at?: string | null;
  approval_note?: string | null;
  failure_code?: string | null;
  failure_reason?: string | null;
  paid_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  provider?: string | null;
  provider_reference?: string | null;
  journal_id?: string | null;
  eligibility_snapshot?: string | null;
}

/** Everything the repository can supply to `PayoutEligibilityInput` (balance / threshold come from the ledger). */
export interface PayoutEligibilityFacts {
  organization: { id: string; status: OrgStatus } | null;
  payout_method: PayoutMethodRow | null;
  compliance_case_statuses: readonly ComplianceCaseStatus[];
  fraud_case_statuses: readonly FraudCaseStatus[];
  active_hold_types: readonly HoldType[];
  newest_earned_age_days: number | null;
  open_dispute_count: number;
}

// ---- guards --------------------------------------------------------------------------------

/** Out-of-CHECK sentinel: a stale expected status makes the UPDATE fail and the batch roll back. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";
const CURRENCY_RE = /^[A-Z]{3}$/;
const OPEN_FRAUD_SQL = OPEN_FRAUD_CASE_STATUSES.map((s) => `'${s}'`).join(",");
const OPEN_COMPLIANCE_SQL = OPEN_COMPLIANCE_CASE_STATUSES.map((s) => `'${s}'`).join(",");
const MS_PER_DAY = 86_400_000;

export function isCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CHECK constraint failed/i.test(msg);
}

/**
 * True when the batch failed because the guarded status UPDATE met a stale
 * row: the sentinel either trips the status CHECK or (since BEFORE triggers run
 * first) `trg_payouts_legal_transition` / `trg_payouts_terminal`.
 */
export function isStateConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return isCheckViolation(err) || /PAYOUT_ILLEGAL_TRANSITION|PAYOUT_FINAL/.test(msg);
}

function assertMinor(amount: unknown, field: string): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new AppError(400, "INVALID_MONEY", `${field} must be an integer amount in minor units`);
  }
}

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
    throw new AppError(400, "INVALID_CURRENCY", "currency must be a 3-letter upper-case ISO-4217 code");
  }
}

/** Whole days between `earnedAt` and `now` (floored, never negative). */
export function wholeDaysBetween(earnedAt: string, now: string): number {
  const a = Date.parse(earnedAt);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new AppError(500, "INVALID_TIMESTAMP", "unparseable timestamp");
  return Math.max(0, Math.floor((b - a) / MS_PER_DAY));
}

// ---- repository ----------------------------------------------------------------------------

export class PayoutRepository {
  constructor(private readonly db: D1Database) {}

  // ---- payout reads --------------------------------------------------------------------------

  async findById(tenantId: TenantId, id: string): Promise<PayoutRow | null> {
    return scopedQuery(this.db, `SELECT * FROM payouts WHERE organization_id = ? AND id = ?`, tenantId, id).first<PayoutRow>();
  }

  /** Idempotency lookup (§66): same key → same payout, never a second one. */
  async findByIdempotencyKey(tenantId: TenantId, idempotencyKey: string): Promise<PayoutRow | null> {
    return scopedQuery(this.db, `SELECT * FROM payouts WHERE organization_id = ? AND idempotency_key = ?`, tenantId, idempotencyKey).first<PayoutRow>();
  }

  async listByStatus(tenantId: TenantId, status: PayoutStatus, limit = 100): Promise<PayoutRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM payouts WHERE organization_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      tenantId,
      status,
      limit,
    ).all<PayoutRow>();
    return res.results;
  }

  async listStatusHistory(tenantId: TenantId, payoutId: string): Promise<PayoutStatusHistoryRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM payout_status_history WHERE organization_id = ? AND payout_id = ? ORDER BY created_at ASC, id ASC`,
      tenantId,
      payoutId,
    ).all<PayoutStatusHistoryRow>();
    return res.results;
  }

  async listAttempts(tenantId: TenantId, payoutId: string): Promise<PayoutAttemptRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM payout_attempts WHERE organization_id = ? AND payout_id = ? ORDER BY attempt_number ASC`,
      tenantId,
      payoutId,
    ).all<PayoutAttemptRow>();
    return res.results;
  }

  /** 1 + highest attempt_number so far (UNIQUE (payout_id, attempt_number) catches races). */
  async nextAttemptNumber(tenantId: TenantId, payoutId: string): Promise<number> {
    const row = await scopedQuery(
      this.db,
      `SELECT COALESCE(MAX(attempt_number), 0) AS n FROM payout_attempts WHERE organization_id = ? AND payout_id = ?`,
      tenantId,
      payoutId,
    ).first<{ n: number }>();
    return (row?.n ?? 0) + 1;
  }

  // ---- eligibility fact reads ----------------------------------------------------------------

  async findPayoutMethod(tenantId: TenantId, payoutMethodId: string): Promise<PayoutMethodRow | null> {
    return scopedQuery(this.db, `SELECT * FROM payout_methods WHERE organization_id = ? AND id = ?`, tenantId, payoutMethodId).first<PayoutMethodRow>();
  }

  /** The tenant's own `organizations` row (keyed by primary key — it is the tenant). */
  async organizationStatus(tenantId: TenantId): Promise<{ id: string; status: OrgStatus } | null> {
    return this.db.prepare(`SELECT id, status FROM organizations WHERE id = ?`).bind(tenantId).first<{ id: string; status: OrgStatus }>();
  }

  /** Statuses of OPEN fraud cases that target this affiliate (any advertiser tenant). */
  async openFraudCaseStatuses(tenantId: TenantId): Promise<FraudCaseStatus[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT status FROM fraud_cases
        WHERE (organization_id = ? OR affiliate_organization_id = ?) AND status IN (${OPEN_FRAUD_SQL})
        ORDER BY created_at ASC, id ASC`,
      tenantId,
      tenantId,
    ).all<{ status: FraudCaseStatus }>();
    return res.results.map((r) => r.status);
  }

  /** Statuses of OPEN compliance cases that target this affiliate (any advertiser tenant). */
  async openComplianceCaseStatuses(tenantId: TenantId): Promise<ComplianceCaseStatus[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT status FROM compliance_cases
        WHERE (organization_id = ? OR affiliate_organization_id = ?) AND status IN (${OPEN_COMPLIANCE_SQL})
        ORDER BY created_at ASC, id ASC`,
      tenantId,
      tenantId,
    ).all<{ status: ComplianceCaseStatus }>();
    return res.results.map((r) => r.status);
  }

  /**
   * Affiliate-wide equivalent of `ConversionRepository.holdFacts` (which is
   * scoped to ONE advertiser tenant + one conversion). Collects the hold_type of
   * every ACTIVE `conversion_holds` row that targets this affiliate directly
   * (`affiliate_organization_id`) or through one of its conversions, across
   * all advertiser tenants. Same `HoldFacts` shape so `isPayoutBlockedBy` applies.
   */
  async affiliateHoldFacts(tenantId: TenantId): Promise<HoldFacts> {
    const res = await scopedQuery(
      this.db,
      `SELECT DISTINCT h.hold_type AS hold_type
         FROM conversion_holds h
         LEFT JOIN conversions c ON c.id = h.conversion_id
        WHERE (h.organization_id = ? OR h.affiliate_organization_id = ? OR c.affiliate_organization_id = ?)
          AND h.status = 'ACTIVE'
        ORDER BY h.hold_type ASC`,
      tenantId,
      tenantId,
      tenantId,
    ).all<{ hold_type: string }>();
    const activeHoldTypes: HoldType[] = [];
    for (const r of res.results) if (isHoldType(r.hold_type) && !activeHoldTypes.includes(r.hold_type)) activeHoldTypes.push(r.hold_type);
    const fraud = await this.openFraudCaseStatuses(tenantId);
    return { activeHoldTypes, fraudReviewOpen: fraud.length > 0 };
  }

  /**
   * Age in whole days of the NEWEST conversion still in the payable balance
   * (lifecycle EARNED / PAYOUT_ELIGIBLE), measured from its most recent
   * `conversion_status_history` row with to_status = 'EARNED'. `null` when the
   * affiliate has no such conversion (eligibility then lets the amount check decide).
   * Conversions that reached EARNED without a history row are not counted
   * (history is the only authoritative EARNED timestamp).
   */
  async newestEarnedAgeDays(tenantId: TenantId, now: string): Promise<number | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT MAX(h.created_at) AS newest
         FROM conversion_status_history h
         JOIN conversions c ON c.id = h.conversion_id
        WHERE (c.organization_id = ? OR c.affiliate_organization_id = ?)
          AND h.to_status = 'EARNED'
          AND c.lifecycle_status IN ('EARNED','PAYOUT_ELIGIBLE')`,
      tenantId,
      tenantId,
    ).first<{ newest: string | null }>();
    if (!row?.newest) return null;
    return wholeDaysBetween(row.newest, now);
  }

  /**
   * KNOWN GAP: no disputes / chargebacks table exists in migrations 0001–0011,
   * so there is nothing to count. Returns 0 until that table lands; eligibility
   * therefore cannot reject on OPEN_DISPUTES yet.
   */
  async openDisputeCount(_tenantId: TenantId): Promise<number> {
    return 0;
  }

  /** One call collecting every repository-sourced eligibility fact. */
  async eligibilityFacts(tenantId: TenantId, payoutMethodId: string, now: string): Promise<PayoutEligibilityFacts> {
    const [organization, payout_method, compliance_case_statuses, fraud_case_statuses, holds, newest_earned_age_days, open_dispute_count] =
      await Promise.all([
        this.organizationStatus(tenantId),
        this.findPayoutMethod(tenantId, payoutMethodId),
        this.openComplianceCaseStatuses(tenantId),
        this.openFraudCaseStatuses(tenantId),
        this.affiliateHoldFacts(tenantId),
        this.newestEarnedAgeDays(tenantId, now),
        this.openDisputeCount(tenantId),
      ]);
    return {
      organization,
      payout_method,
      compliance_case_statuses,
      fraud_case_statuses,
      active_hold_types: holds.activeHoldTypes,
      newest_earned_age_days,
      open_dispute_count,
    };
  }

  // ---- statements (composed into one batch by the service) -----------------------------------

  /** INSERT payouts (status REQUESTED, 0011 defaults). Refuses non-integer money before SQL. */
  insertStatement(tenantId: TenantId, p: PayoutInsert, now: string): D1PreparedStatement {
    assertMinor(p.amount_minor, "amount_minor");
    const fee = p.fee_minor ?? 0;
    assertMinor(fee, "fee_minor");
    assertCurrency(p.currency);
    return this.db
      .prepare(
        `INSERT INTO payouts (id, organization_id, payout_method_id, amount_minor, currency, fee_minor, status, idempotency_key,
                              period_start, period_end, eligibility_snapshot, requested_by_user_id, requested_actor_type, request_id,
                              created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.id,
        tenantId,
        p.payout_method_id,
        p.amount_minor,
        p.currency,
        fee,
        p.idempotency_key,
        p.period_start ?? null,
        p.period_end ?? null,
        p.eligibility_snapshot ?? null,
        p.requested_by_user_id,
        p.requested_actor_type,
        p.request_id ?? null,
        now,
        now,
      );
  }

  /** Guarded status UPDATE: stale `expectedFrom` → sentinel → 0011 rejects → whole batch rolls back. */
  statusStatement(
    tenantId: TenantId,
    payoutId: string,
    expectedFrom: PayoutStatus,
    to: PayoutStatus,
    now: string,
    extra: PayoutStatusExtra = {},
  ): D1PreparedStatement {
    const sets: string[] = ["status = CASE WHEN status = ? THEN ? ELSE ? END", "updated_at = ?"];
    const binds: unknown[] = [expectedFrom, to, CONFLICT_SENTINEL, now];
    for (const [col, val] of Object.entries(extra) as [keyof PayoutStatusExtra, string | null | undefined][]) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      binds.push(val);
    }
    return this.db.prepare(`UPDATE payouts SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`).bind(...binds, tenantId, payoutId);
  }

  /** INSERT-only payout_status_history (0011 rejects UPDATE / DELETE). */
  historyStatement(tenantId: TenantId, h: PayoutHistoryInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO payout_status_history (id, payout_id, organization_id, from_status, to_status, actor_user_id, actor_type, reason_code, note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(h.id, h.payout_id, tenantId, h.from_status, h.to_status, h.actor_user_id ?? null, h.actor_type, h.reason_code ?? null, h.note ?? null, h.request_id ?? null, now);
  }

  /** INSERT-only payout_attempts; money must equal the payout's (trg_payout_attempts_payout_guard). */
  attemptStatement(tenantId: TenantId, a: PayoutAttemptInsert, now: string): D1PreparedStatement {
    assertMinor(a.amount_minor, "amount_minor");
    assertCurrency(a.currency);
    if (!Number.isSafeInteger(a.attempt_number) || a.attempt_number < 1) {
      throw new AppError(400, "INVALID_ATTEMPT_NUMBER", "attempt_number must be a positive integer");
    }
    return this.db
      .prepare(
        `INSERT INTO payout_attempts (id, payout_id, organization_id, attempt_number, provider, provider_idempotency_key, provider_reference,
                                      amount_minor, currency, outcome, response_code, error_code, error_message, request_hash,
                                      actor_type, actor_user_id, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        a.id,
        a.payout_id,
        tenantId,
        a.attempt_number,
        a.provider,
        a.provider_idempotency_key,
        a.provider_reference ?? null,
        a.amount_minor,
        a.currency,
        a.outcome,
        a.response_code ?? null,
        a.error_code ?? null,
        a.error_message ?? null,
        a.request_hash ?? null,
        a.actor_type,
        a.actor_user_id ?? null,
        a.request_id ?? null,
        now,
      );
  }

  // ---- mutations -----------------------------------------------------------------------------

  /**
   * Runs statements atomically. A stale status guard (sentinel → CHECK /
   * transition trigger) is mapped to `false` with nothing written; every other
   * error (FK, UNIQUE, money mismatch, append-only triggers…) is re-thrown.
   */
  async batch(statements: D1PreparedStatement[]): Promise<boolean> {
    try {
      await this.db.batch(statements);
      return true;
    } catch (err) {
      if (isStateConflict(err)) return false;
      throw err;
    }
  }
}
