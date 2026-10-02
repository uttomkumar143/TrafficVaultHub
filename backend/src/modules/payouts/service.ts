/**
 * PayoutService — Phase 5 Unit 12 (PRD §65–§66, §114, §115, §132).
 *
 * Lifecycle (0011 trigger + state-machine.ts):
 *   request()        → REQUESTED                       (payouts.request, idempotency_key replay returns the same row)
 *   runEligibility() REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW | FAILED   (payouts.review; never auto-approves)
 *   approve()        UNDER_REVIEW → APPROVED            (payouts.approve, approver ≠ requester, eligibility re-checked)
 *   process()        APPROVED | FAILED → PROCESSING → PAID | FAILED | (stays PROCESSING on PENDING)
 *                    PROCESSING → PAID | FAILED (reconcile / poll)          (payouts.release)
 *   cancel()         REQUESTED | ELIGIBILITY_CHECK | UNDER_REVIEW | APPROVED | FAILED → CANCELLED (payouts.review)
 *
 * Every mutation is ONE db.batch: guarded status UPDATE (stale expected status
 * → sentinel → CHECK failure → whole batch rolls back → 409 PAYOUT_STATE_CONFLICT)
 * + INSERT-only payout_status_history + audit_logs [+ payout_attempts, + ledger journal].
 *
 * Ledger (§114 "duplicate payout → no duplicate payout"): the ONLY ledger effect is on
 * PAID — one journal built with the existing verified builder (buildJournal → DEBIT
 * AFFILIATE_PAYABLE / CREDIT PAYOUT_CLEARING, idempotency_key PAYOUT:<payout_id>,
 * UNIQUE in 0010) and written with LedgerRepository.journalStatements in the same
 * batch that moves the payout to PAID and sets journal_id. FAILED has no ledger effect
 * (nothing was posted before PAID). If the provider reports PAID but the journal cannot
 * be built (e.g. no PAYOUT_CLEARING account), the attempt + a financial_processing_errors
 * row (POST_PAYOUT) are written, the payout stays PROCESSING and the call fails 500 —
 * money is never silently lost; process() on a PROCESSING payout replays the provider
 * call (same idempotency key) and retries the posting.
 *
 * Faces (Unit 13b): payouts belong to the AFFILIATE organization; finance staff are
 * PLATFORM organization members. The public tenant methods (request / runEligibility /
 * approve / process / cancel / getPayout / list) act on the caller's own tenant with a
 * `sameTenantActor`. The `*For` methods are the PLATFORM face: `assertPlatform` +
 * permission, then the SAME private `*As(tenantId, actor, …)` core runs against the
 * affiliate tenant with a `platformActor` (history/attempt actor PLATFORM, audit row on
 * the affiliate organization, metadata carries actor_organization_id + actor_type).
 * `listAll` is the one deliberately unscoped read (finance work queue, payouts.review).
 *
 * Provider idempotency: payouts.idempotency_key is the provider idempotency key; the
 * same key always yields the same provider_reference (0011 freezes it once set).
 * Money: INTEGER minor units + ISO currency; no floats, no cross-currency math.
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import { buildJournal, captureLedger, findAccountByCode, type JournalDraft } from "../ledger/journal";
import type { LedgerRepository } from "../ledger/repository";
import type { AvailableBalance, ReserveService } from "../ledger/reserves";
import type { PermissionKey } from "../rbac/permissions";
import { evaluatePayoutEligibility, type PayoutEligibilityResult } from "./eligibility";
import { ProviderError, type CreatePayoutResult, type PaymentProvider } from "./provider";
import {
  type PayoutAttemptActor,
  type PayoutAttemptOutcome,
  type PayoutAttemptRow,
  type PayoutHistoryActor,
  type PayoutRepository,
  type PayoutRequestedActor,
  type PayoutRow,
  type PayoutStatusExtra,
  type PayoutStatusHistoryRow,
} from "./repository";
import { checkPayoutTransition, type PayoutStatus } from "./state-machine";

// ---- public shapes -------------------------------------------------------------------------

export interface PayoutPolicy {
  /** Conversions must be at least this many whole days past EARNED (default 0). */
  readonly holding_period_days: number;
  /** Minimum payout per currency in minor units; missing currency = 0. */
  readonly minimum_minor: Readonly<Record<string, number>>;
}

export interface PayoutServiceOptions {
  readonly now?: () => Date;
  readonly policy?: Partial<PayoutPolicy>;
}

export interface RequestPayoutInput {
  readonly payout_method_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  /** Caller-supplied replay key (1..256). Same key ⇒ same payout, never a second one. */
  readonly idempotency_key: string;
  readonly period_start?: string | null;
  readonly period_end?: string | null;
}

export interface PayoutDetail {
  readonly payout: PayoutRow;
  readonly history: PayoutStatusHistoryRow[];
  readonly attempts: PayoutAttemptRow[];
}

export interface PayoutListFilter {
  readonly status?: PayoutStatus;
}

export type EligibilityRunResult =
  | { readonly outcome: "ELIGIBLE"; readonly payout: PayoutRow; readonly result: PayoutEligibilityResult }
  | { readonly outcome: "REJECTED"; readonly payout: PayoutRow; readonly result: PayoutEligibilityResult };

export type ProcessOutcome = "PAID" | "FAILED" | "PENDING";

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly payout: PayoutRow;
  readonly attempt: PayoutAttemptRow;
}

/**
 * Who performs a mutation and where its trail is written. `tenant` is the CALLER's
 * organization (permissions, actor organization); `audit_organization_id` is the
 * organization that owns the payout (the affiliate) so its audit trail is complete.
 */
export interface PayoutActor {
  readonly ctx: AuthenticatedContext;
  readonly tenant: TenantContext;
  readonly audit_organization_id: string;
  readonly history_actor: PayoutHistoryActor;
  readonly attempt_actor: PayoutAttemptActor;
}

const MAX_ORG_ID_LENGTH = 64;
const DEFAULT_POLICY: PayoutPolicy = { holding_period_days: 0, minimum_minor: {} };
const CURRENCY_RE = /^[A-Z]{3}$/;
const FAILURE_CODE_RE = /^[A-Z0-9_]{1,64}$/;
export const ELIGIBILITY_FAILURE_CODE = "INELIGIBLE";
export const CANCELLABLE_PAYOUT_STATUSES: readonly PayoutStatus[] = ["REQUESTED", "ELIGIBILITY_CHECK", "UNDER_REVIEW", "APPROVED", "FAILED"];

export function payoutJournalIdempotencyKey(payoutId: string): string {
  return `PAYOUT:${payoutId}`;
}

// ---- pure helpers --------------------------------------------------------------------------

function requestedActorOf(tenant: TenantContext): PayoutRequestedActor {
  return tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT";
}

/** The caller acts on its OWN tenant's payout (affiliate face). */
export function sameTenantActor(ctx: AuthenticatedContext, tenant: TenantContext): PayoutActor {
  const platform = tenant.organization.type === "PLATFORM";
  return {
    ctx,
    tenant,
    audit_organization_id: tenant.organization.id,
    history_actor: platform ? "PLATFORM" : "TENANT",
    // payout_attempts forbids TENANT; a non-platform release is recorded as SYSTEM with the user id kept.
    attempt_actor: platform ? "PLATFORM" : "SYSTEM",
  };
}

/** PLATFORM staff act on an AFFILIATE organization's payout (platform face). */
export function platformActor(ctx: AuthenticatedContext, tenant: TenantContext, affiliateOrgId: string): PayoutActor {
  return { ctx, tenant, audit_organization_id: affiliateOrgId, history_actor: "PLATFORM", attempt_actor: "PLATFORM" };
}

function isPlatformActor(actor: PayoutActor): boolean {
  return actor.audit_organization_id !== actor.tenant.organization.id;
}

function assertMoney(amount: number, currency: string): void {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new AppError(400, "INVALID_AMOUNT", "amount_minor must be an integer number of minor units");
  }
  if (amount <= 0) throw new AppError(400, "INVALID_AMOUNT", "amount_minor must be > 0");
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
    throw new AppError(400, "INVALID_CURRENCY", "currency must be an upper-case 3-letter code");
  }
}

function checkNote(note: string | null | undefined, max = 1000): string | null {
  if (note === undefined || note === null || note === "") return null;
  if (note.length > max) throw new AppError(400, "NOTE_TOO_LONG", `note must be at most ${max} characters`);
  return note;
}

function safeFailureCode(code: string | undefined, fallback: string): string {
  return code !== undefined && FAILURE_CODE_RE.test(code) ? code : fallback;
}

function truncate(s: string | undefined | null, max: number): string | null {
  if (s === undefined || s === null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function snapshotOf(result: PayoutEligibilityResult, balance: AvailableBalance, at: string): string {
  return JSON.stringify({
    evaluated_at: at,
    eligible: result.eligible,
    reasons: result.eligible ? [] : result.reasons,
    payable_minor: result.payable_minor,
    currency: result.currency,
    balance: {
      balance_minor: balance.balance_minor,
      held_commission_minor: balance.held_commission_minor,
      reserved_minor: balance.reserved_minor,
      available_minor: balance.available_minor,
    },
  });
}

// ---- service -------------------------------------------------------------------------------

export class PayoutService {
  private readonly audit: AuditRepository;
  private readonly now: () => Date;
  private readonly policy: PayoutPolicy;

  constructor(
    private readonly repo: PayoutRepository,
    private readonly ledger: LedgerRepository,
    private readonly reserves: ReserveService,
    private readonly provider: PaymentProvider,
    db: D1Database,
    options: PayoutServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.now = options.now ?? (() => new Date());
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  }

  // ---- reads -------------------------------------------------------------------------------

  async getPayout(tenant: TenantContext, payoutId: string): Promise<PayoutDetail> {
    this.require(tenant, "payouts.read");
    return this.getPayoutAs(tenantIdOf(tenant), payoutId);
  }

  async list(tenant: TenantContext, page: PageRequest, filter: PayoutListFilter = {}): Promise<Page<PayoutRow>> {
    this.require(tenant, "payouts.read");
    return this.listAs(tenantIdOf(tenant), page, filter);
  }

  // ---- platform face (PLATFORM org acting on an AFFILIATE org's payout) -------------------

  /** PLATFORM + payouts.read; one affiliate's payout. */
  async getPayoutFor(tenant: TenantContext, affiliateOrgId: string, payoutId: string): Promise<PayoutDetail> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.read");
    return this.getPayoutAs(this.targetTenantId(affiliateOrgId), payoutId);
  }

  /** PLATFORM + payouts.read; one affiliate's payouts. */
  async listFor(tenant: TenantContext, affiliateOrgId: string, page: PageRequest, filter: PayoutListFilter = {}): Promise<Page<PayoutRow>> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.read");
    return this.listAs(this.targetTenantId(affiliateOrgId), page, filter);
  }

  /** PLATFORM + payouts.review; the finance work queue across ALL affiliates (the only unscoped read). */
  async listAll(tenant: TenantContext, page: PageRequest, filter: PayoutListFilter = {}): Promise<Page<PayoutRow>> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.review");
    return this.repo.listPageAll(page, filter.status === undefined ? {} : { status: filter.status });
  }

  /** PLATFORM + payouts.review. */
  async runEligibilityFor(ctx: AuthenticatedContext, tenant: TenantContext, affiliateOrgId: string, payoutId: string, meta: RequestMeta): Promise<EligibilityRunResult> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.review");
    return this.runEligibilityAs(this.targetTenantId(affiliateOrgId), platformActor(ctx, tenant, affiliateOrgId), payoutId, meta);
  }

  /** PLATFORM + payouts.approve; approver ≠ requester (§132) exactly as on the tenant face. */
  async approveFor(ctx: AuthenticatedContext, tenant: TenantContext, affiliateOrgId: string, payoutId: string, note: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.approve");
    return this.approveAs(this.targetTenantId(affiliateOrgId), platformActor(ctx, tenant, affiliateOrgId), payoutId, note, meta);
  }

  /** PLATFORM + payouts.release. */
  async processFor(ctx: AuthenticatedContext, tenant: TenantContext, affiliateOrgId: string, payoutId: string, meta: RequestMeta): Promise<ProcessResult> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.release");
    return this.processAs(this.targetTenantId(affiliateOrgId), platformActor(ctx, tenant, affiliateOrgId), payoutId, meta);
  }

  /** PLATFORM + payouts.review. */
  async cancelFor(ctx: AuthenticatedContext, tenant: TenantContext, affiliateOrgId: string, payoutId: string, reason: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    this.assertPlatform(tenant);
    this.require(tenant, "payouts.review");
    return this.cancelAs(this.targetTenantId(affiliateOrgId), platformActor(ctx, tenant, affiliateOrgId), payoutId, reason, meta);
  }

  private async getPayoutAs(tenantId: TenantId, payoutId: string): Promise<PayoutDetail> {
    const payout = await this.mustFind(tenantId, payoutId);
    const [history, attempts] = await Promise.all([this.repo.listStatusHistory(tenantId, payoutId), this.repo.listAttempts(tenantId, payoutId)]);
    return { payout, history, attempts };
  }

  private listAs(tenantId: TenantId, page: PageRequest, filter: PayoutListFilter): Promise<Page<PayoutRow>> {
    return this.repo.listPage(tenantId, page, filter.status === undefined ? {} : { status: filter.status });
  }

  // ---- request -----------------------------------------------------------------------------

  /**
   * Read-only §66 replay probe for the HTTP layer (201 vs 200): the payout a
   * previous `request()` with this idempotency key created in THIS tenant, or
   * null. Same permission as `request()`; writes nothing.
   */
  async peekIdempotencyKey(tenant: TenantContext, idempotencyKey: string): Promise<PayoutRow | null> {
    this.require(tenant, "payouts.request");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256) return null;
    return this.repo.findByIdempotencyKey(tenantIdOf(tenant), idempotencyKey);
  }

  async request(ctx: AuthenticatedContext, tenant: TenantContext, input: RequestPayoutInput, meta: RequestMeta): Promise<PayoutRow> {
    this.require(tenant, "payouts.request");
    assertMoney(input.amount_minor, input.currency);
    if (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > 256) {
      throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "idempotency_key must be 1..256 characters");
    }
    if (typeof input.payout_method_id !== "string" || input.payout_method_id.length === 0) {
      throw new AppError(400, "PAYOUT_METHOD_REQUIRED", "payout_method_id is required");
    }
    const tenantId = tenantIdOf(tenant);

    // §66 replay: same key ⇒ same payout, nothing written.
    const existing = await this.repo.findByIdempotencyKey(tenantId, input.idempotency_key);
    if (existing) return existing;

    const method = await this.repo.findPayoutMethod(tenantId, input.payout_method_id);
    if (!method) throw new AppError(404, "PAYOUT_METHOD_NOT_FOUND", "payout method not found in this organization");
    if (method.currency !== input.currency) {
      throw new AppError(400, "CURRENCY_MISMATCH_METHOD", `payout method is ${method.currency}; request is ${input.currency}`);
    }

    const now = this.now().toISOString();
    const id = crypto.randomUUID();
    const actor = requestedActorOf(tenant);
    const by = sameTenantActor(ctx, tenant);
    try {
      await this.repo.batch([
        this.repo.insertStatement(
          tenantId,
          {
            id,
            payout_method_id: method.id,
            amount_minor: input.amount_minor,
            currency: input.currency,
            idempotency_key: input.idempotency_key,
            period_start: input.period_start ?? null,
            period_end: input.period_end ?? null,
            requested_by_user_id: ctx.user.id,
            requested_actor_type: actor,
            request_id: meta.request_id ?? null,
          },
          now,
        ),
        this.historyStatement(tenantId, id, null, "REQUESTED", by, "REQUESTED", null, meta, now),
        this.auditStatement(by, "payout.requested", id, meta, {
          amount_minor: input.amount_minor,
          currency: input.currency,
          payout_method_id: method.id,
          idempotency_key: input.idempotency_key,
        }),
      ]);
    } catch (err) {
      // Concurrent replay of the same key: the UNIQUE index won; return the winner.
      const replay = await this.repo.findByIdempotencyKey(tenantId, input.idempotency_key);
      if (replay) return replay;
      // 0011: payouts.idempotency_key is UNIQUE network-wide. A key already used
      // by ANOTHER tenant is refused (never replayed across tenants, never 500).
      if (err instanceof Error && /UNIQUE constraint failed: payouts\.idempotency_key/.test(err.message)) {
        throw new AppError(409, "IDEMPOTENCY_KEY_CONFLICT", "idempotency_key is already in use");
      }
      throw err;
    }
    return this.mustFind(tenantId, id);
  }

  // ---- eligibility -------------------------------------------------------------------------

  async runEligibility(ctx: AuthenticatedContext, tenant: TenantContext, payoutId: string, meta: RequestMeta): Promise<EligibilityRunResult> {
    this.require(tenant, "payouts.review");
    return this.runEligibilityAs(tenantIdOf(tenant), sameTenantActor(ctx, tenant), payoutId, meta);
  }

  private async runEligibilityAs(tenantId: TenantId, by: PayoutActor, payoutId: string, meta: RequestMeta): Promise<EligibilityRunResult> {
    const row = await this.mustFind(tenantId, payoutId);
    this.assertEdge(row, "ELIGIBILITY_CHECK");
    const now = this.now().toISOString();
    const { result, balance } = await this.evaluate(tenantId, row, now);
    const snapshot = snapshotOf(result, balance, now);
    const to: PayoutStatus = result.eligible ? "UNDER_REVIEW" : "FAILED";
    const reasons = result.eligible ? [] : result.reasons.map((r) => r.code);
    const extra: PayoutStatusExtra = result.eligible
      ? { eligibility_snapshot: snapshot, failure_code: null, failure_reason: null }
      : { eligibility_snapshot: snapshot, failure_code: ELIGIBILITY_FAILURE_CODE, failure_reason: truncate(reasons.join(","), 1000) };

    // REQUESTED → ELIGIBILITY_CHECK → (UNDER_REVIEW | FAILED) in ONE batch; history for both edges.
    const ok = await this.repo.batch([
      this.repo.statusStatement(tenantId, payoutId, "REQUESTED", "ELIGIBILITY_CHECK", now),
      this.historyStatement(tenantId, payoutId, "REQUESTED", "ELIGIBILITY_CHECK", by, "ELIGIBILITY_RUN", null, meta, now),
      this.repo.statusStatement(tenantId, payoutId, "ELIGIBILITY_CHECK", to, now, extra),
      this.historyStatement(
        tenantId,
        payoutId,
        "ELIGIBILITY_CHECK",
        to,
        by,
        result.eligible ? "ELIGIBLE" : ELIGIBILITY_FAILURE_CODE,
        result.eligible ? null : truncate(reasons.join(","), 1000),
        meta,
        now,
      ),
      this.auditStatement(by, result.eligible ? "payout.eligible" : "payout.ineligible", payoutId, meta, {
        from: "REQUESTED",
        to,
        reasons,
        payable_minor: result.payable_minor,
        currency: result.currency,
      }),
    ]);
    if (!ok) throw new AppError(409, "PAYOUT_STATE_CONFLICT", `payout is no longer ${row.status}`);
    const payout = await this.mustFind(tenantId, payoutId);
    return result.eligible ? { outcome: "ELIGIBLE", payout, result } : { outcome: "REJECTED", payout, result };
  }

  // ---- approve -----------------------------------------------------------------------------

  async approve(ctx: AuthenticatedContext, tenant: TenantContext, payoutId: string, note: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    this.require(tenant, "payouts.approve");
    return this.approveAs(tenantIdOf(tenant), sameTenantActor(ctx, tenant), payoutId, note, meta);
  }

  private async approveAs(tenantId: TenantId, by: PayoutActor, payoutId: string, note: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    const { ctx } = by;
    const row = await this.mustFind(tenantId, payoutId);
    this.assertEdge(row, "APPROVED", { approved_by_user_id: ctx.user.id, requested_by_user_id: row.requested_by_user_id });
    const approvalNote = checkNote(note);
    const now = this.now().toISOString();

    // Re-check at approval time: a hold / case placed after review blocks the approval (nothing written).
    const { result } = await this.evaluate(tenantId, row, now);
    if (!result.eligible) {
      throw new AppError(409, "PAYOUT_NOT_ELIGIBLE", `payout is no longer eligible: ${result.reasons.map((r) => r.code).join(",")}`);
    }

    const ok = await this.repo.batch([
      this.repo.statusStatement(tenantId, payoutId, "UNDER_REVIEW", "APPROVED", now, {
        approved_by_user_id: ctx.user.id,
        approved_at: now,
        approval_note: approvalNote,
      }),
      this.historyStatement(tenantId, payoutId, "UNDER_REVIEW", "APPROVED", by, "APPROVED", approvalNote, meta, now),
      this.auditStatement(by, "payout.approved", payoutId, meta, {
        from: "UNDER_REVIEW",
        to: "APPROVED",
        approved_by_user_id: ctx.user.id,
        requested_by_user_id: row.requested_by_user_id,
        payable_minor: result.payable_minor,
      }),
    ]);
    if (!ok) throw new AppError(409, "PAYOUT_STATE_CONFLICT", `payout is no longer ${row.status}`);
    return this.mustFind(tenantId, payoutId);
  }

  // ---- process -----------------------------------------------------------------------------

  async process(ctx: AuthenticatedContext, tenant: TenantContext, payoutId: string, meta: RequestMeta): Promise<ProcessResult> {
    this.require(tenant, "payouts.release");
    return this.processAs(tenantIdOf(tenant), sameTenantActor(ctx, tenant), payoutId, meta);
  }

  private async processAs(tenantId: TenantId, by: PayoutActor, payoutId: string, meta: RequestMeta): Promise<ProcessResult> {
    const { ctx } = by;
    const row = await this.mustFind(tenantId, payoutId);
    const from = row.status;
    if (from !== "APPROVED" && from !== "FAILED" && from !== "PROCESSING") {
      throw new AppError(409, "INVALID_PAYOUT_TRANSITION", `cannot process a payout in status ${from}`);
    }
    if (from !== "PROCESSING") this.assertEdge(row, "PROCESSING");
    // FAILED is recoverable only after an approval: a payout that failed its
    // eligibility check was never approved and must be re-requested (0011
    // CHECK: PROCESSING requires approved_at). Refuse here with 409, not 500.
    if (from === "FAILED" && row.approved_at === null) {
      throw new AppError(409, "INVALID_PAYOUT_TRANSITION", "cannot process a payout that failed eligibility (never approved); cancel and re-request");
    }
    const method = await this.repo.findPayoutMethod(tenantId, row.payout_method_id);
    if (!method) throw new AppError(409, "PAYOUT_METHOD_NOT_FOUND", "payout method no longer exists");
    if (method.currency !== row.currency) throw new AppError(409, "CURRENCY_MISMATCH_METHOD", "payout method currency changed");

    const now = this.now().toISOString();
    const attemptId = crypto.randomUUID();
    const attemptNumber = await this.repo.nextAttemptNumber(tenantId, payoutId);
    const attemptActor = by.attempt_actor;
    const statements: D1PreparedStatement[] = [];
    if (from !== "PROCESSING") {
      statements.push(
        this.repo.statusStatement(tenantId, payoutId, from, "PROCESSING", now, from === "FAILED" ? { failure_code: null, failure_reason: null } : {}),
        this.historyStatement(tenantId, payoutId, from, "PROCESSING", by, from === "FAILED" ? "RETRY" : "RELEASED", null, meta, now),
      );
    }

    // Provider call — the payout's own idempotency key, so a retry can never create a second provider payout.
    let result: CreatePayoutResult | null = null;
    let providerErr: ProviderError | null = null;
    try {
      result = await this.provider.createPayout({
        idempotency_key: row.idempotency_key,
        method_token: method.provider_token,
        amount_minor: row.amount_minor,
        currency: row.currency,
        description: `payout ${row.id}`,
      });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      providerErr = err;
    }

    const attemptBase = {
      id: attemptId,
      payout_id: payoutId,
      attempt_number: attemptNumber,
      provider: result?.provider ?? this.provider.name,
      provider_idempotency_key: row.idempotency_key,
      provider_reference: result?.provider_reference ?? row.provider_reference ?? null,
      amount_minor: row.amount_minor,
      currency: row.currency,
      actor_type: attemptActor,
      actor_user_id: ctx.user.id,
      request_id: meta.request_id ?? null,
    };

    // Provider threw → PROCESSING → FAILED (recoverable), attempt outcome FAILED, no ledger effect.
    if (providerErr) {
      const failure_code = safeFailureCode(providerErr.code, "PROVIDER_ERROR");
      const failure_reason = truncate(providerErr.message, 1000);
      statements.push(
        this.repo.attemptStatement(tenantId, { ...attemptBase, outcome: "FAILED", error_code: failure_code, error_message: failure_reason }, now),
        this.repo.statusStatement(tenantId, payoutId, "PROCESSING", "FAILED", now, { failure_code, failure_reason }),
        this.historyStatement(tenantId, payoutId, "PROCESSING", "FAILED", by, failure_code, failure_reason, meta, now, "PROVIDER"),
        this.auditStatement(by, "payout.failed", payoutId, meta, { from, failure_code, attempt_number: attemptNumber, retryable: providerErr.retryable }),
      );
      return this.finish(tenantId, payoutId, attemptId, row.status, statements, "FAILED");
    }

    const res = result as CreatePayoutResult;
    const providerExtra: PayoutStatusExtra = { provider: res.provider, provider_reference: res.provider_reference };
    const auditBase = { from, provider: res.provider, provider_reference: res.provider_reference, replayed: res.replayed, attempt_number: attemptNumber };

    if (res.status === "FAILED" || res.status === "CANCELLED") {
      const failure_code = safeFailureCode(res.failure_code, res.status === "CANCELLED" ? "PROVIDER_CANCELLED" : "PROVIDER_DECLINED");
      const failure_reason = truncate(res.failure_reason ?? null, 1000);
      statements.push(
        this.repo.attemptStatement(tenantId, { ...attemptBase, outcome: "REJECTED", error_code: failure_code, error_message: failure_reason }, now),
        this.repo.statusStatement(tenantId, payoutId, "PROCESSING", "FAILED", now, { ...providerExtra, failure_code, failure_reason }),
        this.historyStatement(tenantId, payoutId, "PROCESSING", "FAILED", by, failure_code, failure_reason, meta, now, "PROVIDER"),
        this.auditStatement(by, "payout.failed", payoutId, meta, { ...auditBase, failure_code }),
      );
      return this.finish(tenantId, payoutId, attemptId, row.status, statements, "FAILED");
    }

    if (res.status === "PENDING") {
      statements.push(
        this.repo.attemptStatement(tenantId, { ...attemptBase, outcome: "ACCEPTED", response_code: "PENDING" }, now),
        this.repo.statusStatement(tenantId, payoutId, "PROCESSING", "PROCESSING", now, providerExtra),
        this.auditStatement(by, "payout.pending", payoutId, meta, auditBase),
      );
      return this.finish(tenantId, payoutId, attemptId, row.status, statements, "PENDING");
    }

    // PAID — the only ledger effect: one verified journal AFFILIATE_PAYABLE → PAYOUT_CLEARING, same batch.
    const built = await this.buildPayoutJournal(tenantId, row);
    if (!built.ok) {
      // Money left the provider but the ledger refused: record everything, stay PROCESSING, fail loudly.
      statements.push(
        this.repo.attemptStatement(tenantId, { ...attemptBase, outcome: "SUCCEEDED", response_code: "PAID" }, now),
        this.repo.statusStatement(tenantId, payoutId, "PROCESSING", "PROCESSING", now, providerExtra),
        this.ledger.processingErrorStatement({
          organization_id: tenantId,
          operation: "POST_PAYOUT",
          reference_type: "PAYOUT",
          reference_id: payoutId,
          reason_code: built.reason_code,
          detail: built.detail ?? null,
          request_id: meta.request_id ?? null,
        }),
        this.auditStatement(by, "payout.ledger_posting_failed", payoutId, meta, { ...auditBase, reason_code: built.reason_code }),
      );
      const ok = await this.repo.batch(statements);
      if (!ok) throw new AppError(409, "PAYOUT_STATE_CONFLICT", `payout is no longer ${row.status}`);
      throw new AppError(500, "PAYOUT_LEDGER_POSTING_FAILED", `provider paid but the ledger journal was refused (${built.reason_code}); payout left PROCESSING`);
    }
    const journalId = crypto.randomUUID();
    const journal = this.ledger.journalStatements(built.value, {
      id: journalId,
      actor_type: attemptActor === "PLATFORM" ? "PLATFORM" : "SYSTEM",
      posted_by_user_id: ctx.user.id,
      request_id: meta.request_id ?? null,
      posted_at: now,
    });
    statements.push(
      ...journal.statements,
      this.repo.attemptStatement(tenantId, { ...attemptBase, outcome: "SUCCEEDED", response_code: "PAID" }, now),
      this.repo.statusStatement(tenantId, payoutId, "PROCESSING", "PAID", now, { ...providerExtra, paid_at: now, journal_id: journalId, failure_code: null, failure_reason: null }),
      this.historyStatement(tenantId, payoutId, "PROCESSING", "PAID", by, "PAID", null, meta, now, "PROVIDER"),
      this.auditStatement(by, "payout.paid", payoutId, meta, { ...auditBase, journal_id: journalId, amount_minor: row.amount_minor, currency: row.currency }),
    );
    return this.finish(tenantId, payoutId, attemptId, row.status, statements, "PAID");
  }

  // ---- cancel ------------------------------------------------------------------------------

  async cancel(ctx: AuthenticatedContext, tenant: TenantContext, payoutId: string, reason: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    this.require(tenant, "payouts.review");
    return this.cancelAs(tenantIdOf(tenant), sameTenantActor(ctx, tenant), payoutId, reason, meta);
  }

  private async cancelAs(tenantId: TenantId, by: PayoutActor, payoutId: string, reason: string | null | undefined, meta: RequestMeta): Promise<PayoutRow> {
    const row = await this.mustFind(tenantId, payoutId);
    if (!CANCELLABLE_PAYOUT_STATUSES.includes(row.status)) {
      throw new AppError(409, "INVALID_PAYOUT_TRANSITION", `cannot cancel a payout in status ${row.status}`);
    }
    this.assertEdge(row, "CANCELLED");
    const cancelReason = checkNote(reason);
    const now = this.now().toISOString();
    const ok = await this.repo.batch([
      this.repo.statusStatement(tenantId, payoutId, row.status, "CANCELLED", now, { cancelled_at: now, cancel_reason: cancelReason }),
      this.historyStatement(tenantId, payoutId, row.status, "CANCELLED", by, "CANCELLED", cancelReason, meta, now),
      this.auditStatement(by, "payout.cancelled", payoutId, meta, { from: row.status, to: "CANCELLED", reason: cancelReason }),
    ]);
    if (!ok) throw new AppError(409, "PAYOUT_STATE_CONFLICT", `payout is no longer ${row.status}`);
    return this.mustFind(tenantId, payoutId);
  }

  // ---- internals ---------------------------------------------------------------------------

  private async evaluate(tenantId: TenantId, row: PayoutRow, now: string): Promise<{ result: PayoutEligibilityResult; balance: AvailableBalance }> {
    const [facts, balance] = await Promise.all([this.repo.eligibilityFacts(tenantId, row.payout_method_id, now), this.reserves.computeAvailable(tenantId, row.currency)]);
    const organization = facts.organization ?? { id: tenantId, status: "TERMINATED" as const };
    const payout_method = facts.payout_method
      ? { id: facts.payout_method.id, organization_id: facts.payout_method.organization_id, status: facts.payout_method.status, currency: facts.payout_method.currency }
      : { id: row.payout_method_id, organization_id: "", status: "DISABLED" as const, currency: row.currency };
    const result = evaluatePayoutEligibility({
      request: { organization_id: tenantId, amount_minor: row.amount_minor, currency: row.currency },
      balance: { currency: balance.currency, available_minor: balance.available_minor, payable_minor: balance.payable_minor },
      threshold: { currency: row.currency, minimum_minor: this.policy.minimum_minor[row.currency] ?? 0 },
      holding: { holding_period_days: this.policy.holding_period_days, newest_earned_age_days: facts.newest_earned_age_days },
      organization,
      payout_method,
      compliance_case_statuses: facts.compliance_case_statuses,
      fraud_case_statuses: facts.fraud_case_statuses,
      active_hold_types: facts.active_hold_types,
      open_dispute_count: facts.open_dispute_count,
    });
    return { result, balance };
  }

  private async buildPayoutJournal(tenantId: TenantId, row: PayoutRow): Promise<ReturnType<typeof captureLedger<JournalDraft>>> {
    const accounts = await this.ledger.accountsOf(tenantId);
    return captureLedger(() => {
      const payable = findAccountByCode(accounts, tenantId, "AFFILIATE_PAYABLE", row.currency);
      const clearing = findAccountByCode(accounts, tenantId, "PAYOUT_CLEARING", row.currency);
      return buildJournal(
        {
          organization_id: tenantId,
          journal_type: "PAYOUT",
          currency: row.currency,
          reference_type: "PAYOUT",
          reference_id: row.id,
          idempotency_key: payoutJournalIdempotencyKey(row.id),
          description: `payout ${row.id}`,
          legs: [
            { account_id: payable.id, direction: "DEBIT", amount_minor: row.amount_minor, memo: "PAYOUT" },
            { account_id: clearing.id, direction: "CREDIT", amount_minor: row.amount_minor, memo: "PAYOUT" },
          ],
        },
        accounts,
      );
    });
  }

  private async finish(
    tenantId: TenantId,
    payoutId: string,
    attemptId: string,
    expected: PayoutStatus,
    statements: D1PreparedStatement[],
    outcome: ProcessOutcome,
  ): Promise<ProcessResult> {
    const ok = await this.repo.batch(statements);
    if (!ok) throw new AppError(409, "PAYOUT_STATE_CONFLICT", `payout is no longer ${expected}`);
    const payout = await this.mustFind(tenantId, payoutId);
    const attempt = (await this.repo.listAttempts(tenantId, payoutId)).find((a) => a.id === attemptId);
    if (!attempt) throw new AppError(500, "PAYOUT_ATTEMPT_NOT_RECORDED", "payout attempt did not persist");
    return { outcome, payout, attempt };
  }

  private assertEdge(row: PayoutRow, to: PayoutStatus, facts: Parameters<typeof checkPayoutTransition>[2] = {}): void {
    const check = checkPayoutTransition(row.status, to, to === "FAILED" ? { failure_code: "X", ...facts } : facts);
    if (check.ok) return;
    if (check.error.code === "PAYOUT_APPROVER_IS_REQUESTER") throw new AppError(403, "APPROVER_IS_REQUESTER", check.error.message);
    throw new AppError(409, "INVALID_PAYOUT_TRANSITION", check.error.message);
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private assertPlatform(tenant: TenantContext): void {
    if (tenant.organization.type !== "PLATFORM") throw new AppError(403, "FORBIDDEN", "platform organization required");
  }

  /** The affiliate organization a platform call targets; malformed ids can never match → 404 (no oracle). */
  private targetTenantId(affiliateOrgId: string): TenantId {
    if (typeof affiliateOrgId !== "string" || affiliateOrgId.length === 0 || affiliateOrgId.length > MAX_ORG_ID_LENGTH) {
      throw new AppError(404, "PAYOUT_NOT_FOUND", "payout not found");
    }
    return affiliateOrgId as TenantId;
  }

  private async mustFind(tenantId: TenantId, payoutId: string): Promise<PayoutRow> {
    const row = await this.repo.findById(tenantId, payoutId);
    if (!row) throw new AppError(404, "PAYOUT_NOT_FOUND", "payout not found");
    return row;
  }

  private historyStatement(
    tenantId: TenantId,
    payoutId: string,
    from: PayoutStatus | null,
    to: PayoutStatus,
    by: PayoutActor,
    reasonCode: string | null,
    note: string | null,
    meta: RequestMeta,
    now: string,
    actorOverride?: PayoutHistoryActor,
  ): D1PreparedStatement {
    return this.repo.historyStatement(
      tenantId,
      {
        id: crypto.randomUUID(),
        payout_id: payoutId,
        from_status: from,
        to_status: to,
        actor_user_id: by.ctx.user.id,
        actor_type: actorOverride ?? by.history_actor,
        reason_code: reasonCode !== null && FAILURE_CODE_RE.test(reasonCode) ? reasonCode : null,
        note,
        request_id: meta.request_id ?? null,
      },
      now,
    );
  }

  /**
   * Audit row on the organization that OWNS the payout. A platform actor is
   * recorded with its own organization + actor_type so the affiliate's trail
   * shows who (outside the tenant) acted.
   */
  private auditStatement(by: PayoutActor, action: string, payoutId: string, meta: RequestMeta, metadata: Record<string, unknown>): D1PreparedStatement {
    return this.audit.statement({
      organization_id: by.audit_organization_id,
      actor_user_id: by.ctx.user.id,
      action,
      target_type: "payout",
      target_id: payoutId,
      metadata: isPlatformActor(by) ? { ...metadata, actor_organization_id: by.tenant.organization.id, actor_type: "PLATFORM" } : metadata,
      meta,
    });
  }
}

export type { PayoutAttemptOutcome };
