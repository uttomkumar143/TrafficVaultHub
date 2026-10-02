/**
 * Reserves — Phase 5 Unit 6 (PRD §60). Persistence + workflow over migration
 * 0010 `reserves`.
 *
 * A reserve holds money back from an organization's AVAILABLE balance. It is
 * independent from the ledger: placing or releasing a reserve writes NO
 * journal_entries / ledger_entries rows — the ledger balance is untouched and
 * only the derived "available" figure moves.
 *
 *   available = ledger balance (AFFILIATE_PAYABLE for the currency, computed
 *               from ledger_entries — never from a snapshot)
 *             − commissions under an ACTIVE CONVERSION_HOLD / PAYOUT_HOLD
 *             − ACTIVE reserves in the SAME currency
 *
 * Other-currency reserves are IGNORED by the computation (filtered by
 * currency); placing one is allowed — it only affects that currency's
 * available figure. COMPLIANCE_BLOCK holds are not money holds and are not
 * subtracted.
 *
 * A reserve may exceed the balance (risk reserve on an org that has not
 * earned yet): `available_minor` goes negative, `payable_minor` is
 * max(0, available) and `shortfall_minor` reports the uncovered part. A
 * caller that must not over-reserve passes `require_coverage: true` → 409
 * RESERVE_EXCEEDS_AVAILABLE and nothing is written.
 *
 * Lifecycle: ACTIVE → RELEASED is the ONLY update, done by a guarded UPDATE
 * (a stale/released row fails the status CHECK or the 0010
 * RESERVE_ALREADY_RELEASED trigger and the whole batch rolls back). There is
 * no edit path: money columns are frozen by trg_reserves_frozen_money and
 * rows cannot be deleted.
 *
 * Permissions: place/release need `ledger.reserve`, reads need `ledger.read`;
 * hasPermission runs synchronously before any async work (403 FORBIDDEN).
 * Every write lands with its audit_logs row in ONE db.batch.
 */

import { AppError } from "../../lib/errors";
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { PermissionKey } from "../rbac/permissions";
import { assertCurrency, assertMinorAmount } from "./money";
import { classifyLedgerWriteError, type LedgerActorType, type LedgerRepository } from "./repository";

// ---------------------------------------------------------------------------
// Types (mirror 0010_ledger_core.sql)
// ---------------------------------------------------------------------------

export const RESERVE_TYPES = ["AFFILIATE", "ADVERTISER", "CHARGEBACK", "RISK"] as const;
export type ReserveType = (typeof RESERVE_TYPES)[number];

export const RESERVE_REFERENCE_TYPES = ["CONVERSION", "PAYOUT", "FRAUD_CASE", "COMPLIANCE_CASE", "RECONCILIATION_CASE", "FUNDING", "OTHER"] as const;
export type ReserveReferenceType = (typeof RESERVE_REFERENCE_TYPES)[number];

export type ReserveStatus = "ACTIVE" | "RELEASED";

/** Hold types that actually withhold commission money (COMPLIANCE_BLOCK is a workflow block, not a money hold). */
export const MONEY_HOLD_TYPES = ["CONVERSION_HOLD", "PAYOUT_HOLD"] as const;

/** The account whose balance an org's "available" is derived from. */
export const AVAILABLE_ACCOUNT_CODE = "AFFILIATE_PAYABLE";

export interface ReserveRow {
  readonly id: string;
  readonly organization_id: string;
  readonly reserve_type: ReserveType;
  readonly currency: string;
  readonly amount_minor: number;
  readonly status: ReserveStatus;
  readonly reason_code: string;
  readonly reference_type: ReserveReferenceType | null;
  readonly reference_id: string | null;
  readonly actor_type: LedgerActorType;
  readonly created_by_user_id: string | null;
  readonly released_at: string | null;
  readonly released_by_user_id: string | null;
  readonly release_reason: string | null;
  readonly request_id: string | null;
  readonly created_at: string;
}

export interface PlaceReserveInput {
  readonly reserve_type: ReserveType;
  readonly currency: string;
  readonly amount_minor: number;
  /** `[A-Z0-9_]{1,64}` — matches the 0010 CHECK. */
  readonly reason_code: string;
  readonly reference_type?: ReserveReferenceType | null;
  readonly reference_id?: string | null;
  /** When true the reserve is refused (409 RESERVE_EXCEEDS_AVAILABLE) if amount > available. Default false. */
  readonly require_coverage?: boolean;
}

export interface AvailableBalance {
  readonly organization_id: string;
  readonly currency: string;
  /** AFFILIATE_PAYABLE account for the currency; null when the org has no such account (balance is then 0). */
  readonly account_id: string | null;
  /** Ledger balance (credit − debit) computed from ledger_entries. */
  readonly balance_minor: number;
  /** Commissions whose conversion/affiliate is under an ACTIVE CONVERSION_HOLD / PAYOUT_HOLD. */
  readonly held_commission_minor: number;
  readonly held_commission_count: number;
  /** Σ ACTIVE reserves in this currency. */
  readonly reserved_minor: number;
  readonly active_reserve_count: number;
  /** balance − held − reserved. MAY be negative. */
  readonly available_minor: number;
  /** max(0, available). */
  readonly payable_minor: number;
  /** max(0, −available): the part of holds + reserves the balance does not cover. */
  readonly shortfall_minor: number;
  readonly computed_at: string;
}

export interface PlaceReserveResult {
  readonly reserve: ReserveRow;
  readonly available_before: AvailableBalance;
  readonly available_after: AvailableBalance;
}

interface Actor {
  readonly actor_type: "TENANT" | "PLATFORM";
  readonly user_id: string;
  readonly meta: RequestMeta;
}

/** Out-of-CHECK sentinel: the guarded UPDATE on a non-ACTIVE row fails the status CHECK and rolls the batch back. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";
const REASON_CODE = /^[A-Z0-9_]{1,64}$/;
const MAX_RELEASE_REASON = 500;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ReserveRepository {
  constructor(private readonly db: D1Database) {}

  findById(tenantId: TenantId, id: string): Promise<ReserveRow | null> {
    return scopedQuery(this.db, `SELECT * FROM reserves WHERE organization_id = ? AND id = ?`, tenantId, id).first<ReserveRow>();
  }

  async list(tenantId: TenantId, filter: { status?: ReserveStatus; currency?: string } = {}): Promise<ReserveRow[]> {
    const clauses = ["organization_id = ?"];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.currency) {
      clauses.push("currency = ?");
      params.push(filter.currency);
    }
    const { results } = await scopedQuery(this.db, `SELECT * FROM reserves WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`, tenantId, ...params).all<ReserveRow>();
    return results;
  }

  /**
   * Cursor page (PRD §71/§127): newest first, `(created_at, id)` keyset, LIMIT n+1
   * in SQL so the table is never pulled into memory.
   */
  async listPage(tenantId: TenantId, page: PageRequest, filter: { status?: ReserveStatus; currency?: string } = {}): Promise<Page<ReserveRow>> {
    const clauses = ["organization_id = ?"];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.currency) {
      clauses.push("currency = ?");
      params.push(filter.currency);
    }
    if (page.cursor) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const { results } = await scopedQuery(
      this.db,
      `SELECT * FROM reserves WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...params,
      page.limit + 1,
    ).all<ReserveRow>();
    return slicePage(results, page.limit);
  }

  /** Σ ACTIVE reserves in `currency` only — other currencies never enter the computation. */
  async activeReserveTotal(tenantId: TenantId, currency: string): Promise<{ reserved_minor: number; active_reserve_count: number }> {
    const row = await scopedQuery(
      this.db,
      `SELECT COALESCE(SUM(amount_minor), 0) AS reserved_minor, COUNT(*) AS active_reserve_count
         FROM reserves WHERE organization_id = ? AND status = 'ACTIVE' AND currency = ?`,
      tenantId,
      currency,
    ).first<{ reserved_minor: number; active_reserve_count: number }>();
    return { reserved_minor: safeInt(row?.reserved_minor), active_reserve_count: Number(row?.active_reserve_count ?? 0) };
  }

  /**
   * Commissions withheld by ACTIVE money holds: a hold on the conversion itself, or an
   * affiliate-level hold (conversion_id NULL) covering every commission of that affiliate.
   * EXISTS keeps a commission counted once even when several holds cover it.
   */
  async heldCommissions(tenantId: TenantId, currency: string): Promise<{ held_commission_minor: number; held_commission_count: number }> {
    const row = await scopedQuery(
      this.db,
      `SELECT COALESCE(SUM(c.affiliate_commission_minor), 0) AS held_commission_minor, COUNT(*) AS held_commission_count
         FROM commissions c
        WHERE c.organization_id = ? AND c.currency = ?
          AND EXISTS (
            SELECT 1 FROM conversion_holds h
             WHERE h.organization_id = c.organization_id
               AND h.status = 'ACTIVE'
               AND h.hold_type IN ('CONVERSION_HOLD', 'PAYOUT_HOLD')
               AND (h.conversion_id = c.conversion_id
                    OR (h.conversion_id IS NULL AND h.affiliate_organization_id = c.affiliate_organization_id)))`,
      tenantId,
      currency,
    ).first<{ held_commission_minor: number; held_commission_count: number }>();
    return { held_commission_minor: safeInt(row?.held_commission_minor), held_commission_count: Number(row?.held_commission_count ?? 0) };
  }

  insertStatement(row: Omit<ReserveRow, "status" | "released_at" | "released_by_user_id" | "release_reason">): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO reserves
           (id, organization_id, reserve_type, currency, amount_minor, status, reason_code, reference_type, reference_id,
            actor_type, created_by_user_id, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.organization_id,
        row.reserve_type,
        row.currency,
        row.amount_minor,
        row.reason_code,
        row.reference_type,
        row.reference_id,
        row.actor_type,
        row.created_by_user_id,
        row.request_id,
        row.created_at,
      );
  }

  /** ACTIVE → RELEASED, guarded. The only UPDATE this module issues. */
  releaseStatement(tenantId: TenantId, id: string, userId: string, reason: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE reserves
            SET status = CASE WHEN status = 'ACTIVE' THEN 'RELEASED' ELSE ? END,
                released_at = ?, released_by_user_id = ?, release_reason = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(CONFLICT_SENTINEL, now, userId, reason, tenantId, id);
  }

  async batch(statements: readonly D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch([...statements]);
    } catch (err) {
      throw classifyReserveWriteError(err);
    }
  }
}

export function classifyReserveWriteError(err: unknown): AppError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/RESERVE_ALREADY_RELEASED/i.test(msg)) {
    return new AppError(409, "RESERVE_ALREADY_RELEASED", "the reserve is already released; nothing was written");
  }
  if (/RESERVE_IMMUTABLE/i.test(msg)) {
    return new AppError(409, "RESERVE_IMMUTABLE", "reserve money columns cannot be edited; nothing was written");
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new AppError(409, "RESERVE_STATE_CONFLICT", "the reserve changed underneath this request; nothing was written");
  }
  return classifyLedgerWriteError(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReserveServiceOptions {
  readonly now?: () => Date;
}

export class ReserveService {
  private readonly now: () => Date;

  constructor(
    private readonly reserves: ReserveRepository,
    private readonly ledger: LedgerRepository,
    private readonly audit: AuditRepository,
    options: ReserveServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---- HTTP entry points: permission checks run synchronously, before any I/O ----

  place(ctx: AuthenticatedContext, tenant: TenantContext, input: PlaceReserveInput, meta: RequestMeta): Promise<PlaceReserveResult> {
    this.require(tenant, "ledger.reserve");
    return this.doPlace(tenantIdOf(tenant), input, actorFrom(ctx, tenant, meta));
  }

  release(ctx: AuthenticatedContext, tenant: TenantContext, reserveId: string, reason: string | null, meta: RequestMeta): Promise<ReserveRow> {
    this.require(tenant, "ledger.reserve");
    return this.doRelease(tenantIdOf(tenant), reserveId, reason, actorFrom(ctx, tenant, meta));
  }

  get(tenant: TenantContext, reserveId: string): Promise<ReserveRow | null> {
    this.require(tenant, "ledger.read");
    return this.reserves.findById(tenantIdOf(tenant), reserveId);
  }

  list(tenant: TenantContext, filter: { status?: ReserveStatus; currency?: string } = {}): Promise<ReserveRow[]> {
    this.require(tenant, "ledger.read");
    return this.reserves.list(tenantIdOf(tenant), filter);
  }

  listPage(tenant: TenantContext, page: PageRequest, filter: { status?: ReserveStatus; currency?: string } = {}): Promise<Page<ReserveRow>> {
    this.require(tenant, "ledger.read");
    return this.reserves.listPage(tenantIdOf(tenant), page, filter);
  }

  available(tenant: TenantContext, currency: string): Promise<AvailableBalance> {
    this.require(tenant, "ledger.read");
    return this.computeAvailable(tenantIdOf(tenant), checkCurrency(currency));
  }

  // ---- available --------------------------------------------------------------------

  /**
   * available = ledger balance − held commissions − active same-currency reserves.
   * Pure read: nothing is written, no snapshot is consulted.
   */
  async computeAvailable(tenantId: TenantId, currency: string): Promise<AvailableBalance> {
    const accounts = await this.ledger.accountsOf(tenantId);
    const account = [...accounts.values()].find((a) => a.code === AVAILABLE_ACCOUNT_CODE && a.currency === currency) ?? null;
    const [balance, held, reserved] = await Promise.all([
      account ? this.ledger.computeBalance(tenantId, account.id).then((b) => b.balance_minor) : Promise.resolve(0),
      this.reserves.heldCommissions(tenantId, currency),
      this.reserves.activeReserveTotal(tenantId, currency),
    ]);
    const available = balance - held.held_commission_minor - reserved.reserved_minor;
    if (!Number.isSafeInteger(available)) throw new AppError(500, "MONEY_OVERFLOW", "available balance exceeds the safe integer range");
    return {
      organization_id: tenantId,
      currency,
      account_id: account?.id ?? null,
      balance_minor: balance,
      held_commission_minor: held.held_commission_minor,
      held_commission_count: held.held_commission_count,
      reserved_minor: reserved.reserved_minor,
      active_reserve_count: reserved.active_reserve_count,
      available_minor: available,
      payable_minor: Math.max(0, available),
      shortfall_minor: Math.max(0, -available),
      computed_at: this.now().toISOString(),
    };
  }

  // ---- place -----------------------------------------------------------------------

  private async doPlace(tenantId: TenantId, input: PlaceReserveInput, actor: Actor): Promise<PlaceReserveResult> {
    const v = validatePlace(input);
    const before = await this.computeAvailable(tenantId, v.currency);
    if (v.require_coverage && v.amount_minor > before.available_minor) {
      throw new AppError(
        409,
        "RESERVE_EXCEEDS_AVAILABLE",
        `reserve of ${v.amount_minor} ${v.currency} exceeds available ${before.available_minor} ${v.currency}; nothing was written`,
      );
    }
    const nowIso = this.now().toISOString();
    const id = crypto.randomUUID();
    const requestId = actor.meta.request_id ?? null;
    await this.reserves.batch([
      this.reserves.insertStatement({
        id,
        organization_id: tenantId,
        reserve_type: v.reserve_type,
        currency: v.currency,
        amount_minor: v.amount_minor,
        reason_code: v.reason_code,
        reference_type: v.reference_type,
        reference_id: v.reference_id,
        actor_type: actor.actor_type,
        created_by_user_id: actor.user_id,
        request_id: requestId,
        created_at: nowIso,
      }),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.reserve.placed",
        target_type: "reserve",
        target_id: id,
        metadata: {
          reserve_type: v.reserve_type,
          amount_minor: v.amount_minor,
          currency: v.currency,
          reason_code: v.reason_code,
          reference_type: v.reference_type,
          reference_id: v.reference_id,
          require_coverage: v.require_coverage,
          available_before_minor: before.available_minor,
          available_after_minor: before.available_minor - v.amount_minor,
          actor: actor.actor_type,
        },
        meta: actor.meta,
      }),
    ]);
    const [reserve, after] = await Promise.all([this.mustFind(tenantId, id), this.computeAvailable(tenantId, v.currency)]);
    return { reserve, available_before: before, available_after: after };
  }

  // ---- release ---------------------------------------------------------------------

  private async doRelease(tenantId: TenantId, id: string, reasonIn: string | null, actor: Actor): Promise<ReserveRow> {
    const reason = checkReleaseReason(reasonIn);
    const row = await this.mustFind(tenantId, id);
    if (row.status !== "ACTIVE") {
      throw new AppError(409, "RESERVE_ALREADY_RELEASED", `reserve is ${row.status}; only ACTIVE reserves can be released`);
    }
    const nowIso = this.now().toISOString();
    await this.reserves.batch([
      this.reserves.releaseStatement(tenantId, id, actor.user_id, reason, nowIso),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.reserve.released",
        target_type: "reserve",
        target_id: id,
        metadata: {
          reserve_type: row.reserve_type,
          amount_minor: row.amount_minor,
          currency: row.currency,
          reason_code: row.reason_code,
          release_reason: reason,
          placed_by_user_id: row.created_by_user_id,
          actor: actor.actor_type,
        },
        meta: actor.meta,
      }),
    ]);
    return this.mustFind(tenantId, id);
  }

  // ---- helpers ---------------------------------------------------------------------

  private async mustFind(tenantId: TenantId, id: string): Promise<ReserveRow> {
    const row = await this.reserves.findById(tenantId, id);
    if (!row) throw new AppError(404, "NOT_FOUND", "reserve not found");
    return row;
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidPlace {
  readonly reserve_type: ReserveType;
  readonly currency: string;
  readonly amount_minor: number;
  readonly reason_code: string;
  readonly reference_type: ReserveReferenceType | null;
  readonly reference_id: string | null;
  readonly require_coverage: boolean;
}

function validatePlace(input: PlaceReserveInput): ValidPlace {
  const bad = (code: string, msg: string) => new AppError(400, code, msg);
  if (!(RESERVE_TYPES as readonly string[]).includes(input.reserve_type)) {
    throw bad("RESERVE_INVALID_TYPE", `reserve_type must be one of ${RESERVE_TYPES.join(", ")}`);
  }
  let amount_minor: number;
  let currency: string;
  try {
    amount_minor = assertMinorAmount(input.amount_minor);
    currency = assertCurrency(input.currency);
  } catch (err) {
    throw bad("RESERVE_INVALID_MONEY", err instanceof Error ? err.message : "invalid amount or currency");
  }
  if (amount_minor <= 0) throw bad("RESERVE_INVALID_MONEY", "amount_minor must be > 0");
  const reason_code = typeof input.reason_code === "string" ? input.reason_code.trim() : "";
  if (!REASON_CODE.test(reason_code)) throw bad("RESERVE_INVALID_REASON", "reason_code must match [A-Z0-9_]{1,64}");
  const reference_type = input.reference_type ?? null;
  const reference_id = nonEmpty(input.reference_id ?? null);
  if ((reference_type === null) !== (reference_id === null)) throw bad("RESERVE_REFERENCE_INCOMPLETE", "reference_type and reference_id must be given together");
  if (reference_type !== null && !(RESERVE_REFERENCE_TYPES as readonly string[]).includes(reference_type)) {
    throw bad("RESERVE_INVALID_REFERENCE_TYPE", `reference_type must be one of ${RESERVE_REFERENCE_TYPES.join(", ")}`);
  }
  if (input.require_coverage !== undefined && typeof input.require_coverage !== "boolean") {
    throw bad("RESERVE_INVALID_COVERAGE_FLAG", "require_coverage must be a boolean");
  }
  return { reserve_type: input.reserve_type, currency, amount_minor, reason_code, reference_type, reference_id, require_coverage: input.require_coverage === true };
}

function checkCurrency(currency: string): string {
  try {
    return assertCurrency(currency);
  } catch (err) {
    throw new AppError(400, "RESERVE_INVALID_MONEY", err instanceof Error ? err.message : "invalid currency");
  }
}

function checkReleaseReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const t = String(reason).trim();
  if (t.length === 0) return null;
  if (t.length > MAX_RELEASE_REASON) throw new AppError(400, "RESERVE_RELEASE_REASON_TOO_LONG", `release_reason must be at most ${MAX_RELEASE_REASON} characters`);
  return t;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function safeInt(v: unknown): number {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new AppError(500, "MONEY_OVERFLOW", "sum exceeds the safe integer range");
  return n;
}

function actorFrom(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Actor {
  return { actor_type: tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT", user_id: ctx.user.id, meta };
}
