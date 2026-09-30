/**
 * ConversionService — Phase 4 Unit 5b (PRD §38–§40, §115, §124).
 *
 * Every lifecycle change goes through the pure state machine
 * (`canTransition` + `guardTransition`) and is persisted atomically with its
 * status-history row and an audit_logs row (same db.batch).
 *
 * Actor resolution (PRD §115)
 * ---------------------------
 *   tenant.organization.type === "PLATFORM" → PLATFORM, everything else → TENANT.
 *   SYSTEM and INTERNAL are never derived from an HTTP tenant: the internal
 *   ledger/payout transitions (APPROVED→LEDGER_POSTED→EARNED→PAYOUT_ELIGIBLE→PAID)
 *   live behind `internal.*` methods that take no TenantContext and are NOT
 *   wired to routes.
 *
 * approve(): validateConversion over freshly loaded facts (offer liveness,
 *   affiliate status/access, click, attribution, dedup, timestamps, money) →
 *   REJECT blocks (422 VALIDATION_REJECTED), HOLD blocks (409 VALIDATION_HOLD)
 *   → guardTransition (active CONVERSION_HOLD → 409) → commission from the
 *   conversion's offer version (integer minor units) written once.
 * reject()/dispute()/fraudReview(): reason required.
 * reverse(): compensating conversion_reversals row + status REVERSED; the
 *   original row is untouched except lifecycle_status/updated_at.
 * holds: place/release CONVERSION_HOLD / PAYOUT_HOLD (MANUAL source; fraud and
 *   compliance modules write their own holds through the repository).
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { PermissionKey } from "../rbac/permissions";
import {
  type ConversionListFilter,
  type ConversionRecord,
  type ConversionRepository,
  type HoldRow,
  HOLD_SOURCE_TYPES,
  REVERSAL_REASON_CODES,
  type ReversalReasonCode,
  type ReversalRow,
  type StatusHistoryRow,
} from "./repository";
import {
  canTransition,
  type ConversionActor,
  type ConversionStatus,
  guardTransition,
  type HoldFacts,
  type HoldType,
  isInternalOnlyTarget,
  isPayoutBlockedBy,
  requiresReason,
} from "./state-machine";
import { validateConversion, type ValidationFacts, type ValidationResult } from "./validation";

export interface ConversionServiceOptions {
  now?: () => Date;
}

export interface DecisionInput {
  reason_code: string;
  note?: string | null;
}

export interface ReverseInput extends DecisionInput {
  reason_code: ReversalReasonCode;
  /** Amount reversed, integer minor units; defaults to the recorded commission. */
  amount_minor?: number;
}

export interface PlaceHoldInput {
  hold_type: Exclude<HoldType, "COMPLIANCE_BLOCK">;
  reason_code: string;
  conversion_id?: string;
  affiliate_organization_id?: string;
}

export interface ConversionDetail {
  conversion: ConversionRecord;
  history: StatusHistoryRow[];
  reversal: ReversalRow | null;
  active_holds: HoldRow[];
  payout_blocked: boolean;
}

const REASON_CODE = /^[A-Z0-9_]{1,64}$/;

function assertReason(code: string | undefined, required: boolean): string {
  if (code === undefined || code === "") {
    if (required) throw new AppError(400, "REASON_REQUIRED", "reason_code is required for this transition");
    return "OK";
  }
  if (!REASON_CODE.test(code)) throw new AppError(400, "INVALID_REASON_CODE", "reason_code must match ^[A-Z0-9_]{1,64}$");
  return code;
}

function assertNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (note.length > 1000) throw new AppError(400, "NOTE_TOO_LONG", "note must be at most 1000 characters");
  return note;
}

type OfferFactsRow = {
  offer_id: string;
  offer_status: string;
  access_mode: string;
  version_id: string | null;
  conversion_event: string | null;
  affiliate_commission_minor: number | null;
  version_currency: string | null;
  revshare_percent_bps: number | null;
  payout_type: string | null;
};

export class ConversionService {
  private readonly audit: AuditRepository;
  private readonly now: () => Date;
  /** Internal (SYSTEM/INTERNAL actor) transitions — never reachable over HTTP. */
  readonly internal: InternalConversionOps;

  constructor(
    private readonly repo: ConversionRepository,
    private readonly db: D1Database,
    options: ConversionServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.now = options.now ?? (() => new Date());
    this.internal = new InternalConversionOps(repo, this.audit, this.now);
  }

  // ---- reads -----------------------------------------------------------------

  async list(tenant: TenantContext, page: PageRequest, filter: ConversionListFilter): Promise<Page<ConversionRecord>> {
    this.require(tenant, "conversions.read");
    return this.repo.list(tenantIdOf(tenant), page, filter);
  }

  async get(tenant: TenantContext, conversionId: string): Promise<ConversionDetail> {
    this.require(tenant, "conversions.read");
    const tenantId = tenantIdOf(tenant);
    const conversion = await this.mustFind(tenantId, conversionId);
    const [history, reversal, active_holds, facts] = await Promise.all([
      this.repo.listHistory(tenantId, conversionId),
      this.repo.findReversal(tenantId, conversionId),
      this.repo.listActiveHolds(tenantId, scopeOf(conversion)),
      this.repo.holdFacts(tenantId, scopeOf(conversion)),
    ]);
    return { conversion, history, reversal, active_holds, payout_blocked: isPayoutBlockedBy(facts) };
  }

  /** True when an active PAYOUT_HOLD / COMPLIANCE_BLOCK or an open fraud review blocks payout. */
  async isPayoutBlocked(tenant: TenantContext, conversionId: string): Promise<{ blocked: boolean; facts: HoldFacts }> {
    this.require(tenant, "conversions.read");
    const tenantId = tenantIdOf(tenant);
    const conversion = await this.mustFind(tenantId, conversionId);
    const facts = await this.repo.holdFacts(tenantId, scopeOf(conversion));
    return { blocked: isPayoutBlockedBy(facts), facts };
  }

  // ---- tenant / platform decisions ---------------------------------------------

  async approve(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<ConversionRecord> {
    this.require(tenant, "conversions.approve");
    const tenantId = tenantIdOf(tenant);
    const conversion = await this.mustFind(tenantId, conversionId);
    const actor = actorOf(tenant);
    this.assertEdge(conversion.lifecycle_status, "APPROVED", actor);

    const validation = validateConversion(await this.loadValidationFacts(tenantId, conversion));
    if (validation.outcome === "REJECT") {
      throw new AppError(422, "VALIDATION_REJECTED", `conversion fails validation: ${failedCodes(validation)}`);
    }
    if (validation.outcome === "HOLD") {
      throw new AppError(409, "VALIDATION_HOLD", `conversion requires review before approval: ${failedCodes(validation)}`);
    }
    const facts = await this.repo.holdFacts(tenantId, scopeOf(conversion));
    const guard = guardTransition("APPROVED", facts);
    if (!guard.ok) throw new AppError(409, guard.code, guard.message);

    const commission = await this.commissionFor(tenantId, conversion);
    const now = this.now().toISOString();
    const reason = assertReason(input.reason_code, false);
    const note = assertNote(input.note);
    await this.repo.transition(
      tenantId,
      {
        conversion_id: conversionId,
        expected_from: conversion.lifecycle_status,
        to: "APPROVED",
        actor_type: actor,
        actor_user_id: ctx.user.id,
        reason_code: reason,
        note,
        request_id: meta.request_id,
        now,
      },
      [
        this.repo.commissionStatement(tenantId, conversionId, commission.amount_minor, commission.currency),
        this.auditStatement(tenant, ctx, "conversion.approved", conversionId, meta, {
          from: conversion.lifecycle_status,
          reason_code: reason,
          commission_amount_minor: commission.amount_minor,
          commission_currency: commission.currency,
          validation: validation.checks.map((c) => `${c.check}:${c.status}:${c.code}`),
        }),
      ],
    );
    return this.mustFind(tenantId, conversionId);
  }

  reject(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<ConversionRecord> {
    return this.decide(ctx, tenant, conversionId, "REJECTED", "conversions.reject", "conversion.rejected", input, meta);
  }

  dispute(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<ConversionRecord> {
    return this.decide(ctx, tenant, conversionId, "DISPUTED", "conversions.reject", "conversion.disputed", input, meta);
  }

  /** PENDING → FRAUD_REVIEW: platform only (state machine); needs fraud.review. */
  sendToFraudReview(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<ConversionRecord> {
    return this.decide(ctx, tenant, conversionId, "FRAUD_REVIEW", "fraud.review", "conversion.fraud_review", input, meta);
  }

  /**
   * APPROVED → REVERSED with a compensating conversion_reversals row. The
   * original conversion keeps every field except lifecycle_status/updated_at.
   */
  async reverse(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    input: ReverseInput,
    meta: RequestMeta,
  ): Promise<ConversionDetail> {
    this.require(tenant, "conversions.reverse");
    const tenantId = tenantIdOf(tenant);
    const conversion = await this.mustFind(tenantId, conversionId);
    const actor = actorOf(tenant);
    this.assertEdge(conversion.lifecycle_status, "REVERSED", actor);
    if (!REVERSAL_REASON_CODES.includes(input.reason_code)) {
      throw new AppError(400, "INVALID_REASON_CODE", `reason_code must be one of ${REVERSAL_REASON_CODES.join(", ")}`);
    }
    if (await this.repo.findReversal(tenantId, conversionId)) {
      throw new AppError(409, "ALREADY_REVERSED", "a reversal record already exists for this conversion");
    }
    const amount = input.amount_minor ?? conversion.commission_amount_minor ?? 0;
    if (!Number.isInteger(amount) || amount < 0) throw new AppError(400, "INVALID_AMOUNT", "amount_minor must be a non-negative integer");
    const currency = conversion.commission_currency ?? conversion.currency;
    if (!currency) throw new AppError(409, "CURRENCY_UNKNOWN", "conversion has no recorded currency to reverse against");
    const note = assertNote(input.note);
    const now = this.now().toISOString();
    const reversalId = crypto.randomUUID();
    await this.repo.transition(
      tenantId,
      {
        conversion_id: conversionId,
        expected_from: conversion.lifecycle_status,
        to: "REVERSED",
        actor_type: actor,
        actor_user_id: ctx.user.id,
        reason_code: input.reason_code,
        note,
        request_id: meta.request_id,
        now,
      },
      [
        this.repo.reversalStatement(
          tenantId,
          {
            id: reversalId,
            conversion_id: conversionId,
            reason_code: input.reason_code,
            amount_minor: amount,
            currency,
            reversed_by_user_id: ctx.user.id,
            actor_type: actor,
            note,
            request_id: meta.request_id,
          },
          now,
        ),
        this.auditStatement(tenant, ctx, "conversion.reversed", conversionId, meta, {
          reversal_id: reversalId,
          reason_code: input.reason_code,
          amount_minor: amount,
          currency,
        }),
      ],
    );
    return this.get(tenant, conversionId);
  }

  // ---- holds -----------------------------------------------------------------------

  async placeHold(ctx: AuthenticatedContext, tenant: TenantContext, input: PlaceHoldInput, meta: RequestMeta): Promise<HoldRow> {
    this.require(tenant, input.hold_type === "PAYOUT_HOLD" ? "fraud.manage" : "conversions.approve");
    const tenantId = tenantIdOf(tenant);
    if (!input.conversion_id && !input.affiliate_organization_id) {
      throw new AppError(400, "HOLD_SCOPE_REQUIRED", "conversion_id or affiliate_organization_id is required");
    }
    if (input.conversion_id) await this.mustFind(tenantId, input.conversion_id);
    const reason = assertReason(input.reason_code, true);
    const id = crypto.randomUUID();
    const now = this.now().toISOString();
    await this.repo.insertHold(
      tenantId,
      {
        id,
        conversion_id: input.conversion_id ?? null,
        affiliate_organization_id: input.affiliate_organization_id ?? null,
        hold_type: input.hold_type,
        reason_code: reason,
        source_type: HOLD_SOURCE_TYPES[3], // MANUAL
        source_id: null,
        created_by_user_id: ctx.user.id,
      },
      now,
      [
        this.auditStatement(tenant, ctx, "conversion.hold.placed", id, meta, {
          hold_type: input.hold_type,
          reason_code: reason,
          conversion_id: input.conversion_id ?? null,
          affiliate_organization_id: input.affiliate_organization_id ?? null,
        }),
      ],
    );
    const hold = await this.repo.findHold(tenantId, id);
    if (!hold) throw new AppError(500, "HOLD_NOT_PERSISTED", "hold was not persisted");
    return hold;
  }

  async releaseHold(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    holdId: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<HoldRow> {
    const tenantId = tenantIdOf(tenant);
    const hold = await this.repo.findHold(tenantId, holdId);
    if (!hold) throw new AppError(404, "NOT_FOUND", "hold not found");
    if (hold.hold_type === "COMPLIANCE_BLOCK") this.require(tenant, "compliance.resolve");
    else this.require(tenant, hold.hold_type === "PAYOUT_HOLD" ? "fraud.manage" : "conversions.approve");
    if (hold.status !== "ACTIVE") throw new AppError(409, "HOLD_NOT_ACTIVE", "hold is already released");
    const reason = assertReason(input.reason_code, true);
    const released = await this.repo.releaseHold(tenantId, holdId, ctx.user.id, reason, this.now().toISOString(), [
      this.auditStatement(tenant, ctx, "conversion.hold.released", holdId, meta, { hold_type: hold.hold_type, reason_code: reason }),
    ]);
    if (!released) throw new AppError(409, "HOLD_NOT_ACTIVE", "hold is already released");
    const after = await this.repo.findHold(tenantId, holdId);
    if (!after) throw new AppError(404, "NOT_FOUND", "hold not found");
    return after;
  }

  // ---- helpers ---------------------------------------------------------------------

  private async decide(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    conversionId: string,
    to: ConversionStatus,
    permission: PermissionKey,
    auditAction: string,
    input: DecisionInput,
    meta: RequestMeta,
  ): Promise<ConversionRecord> {
    this.require(tenant, permission);
    const tenantId = tenantIdOf(tenant);
    const conversion = await this.mustFind(tenantId, conversionId);
    const actor = actorOf(tenant);
    this.assertEdge(conversion.lifecycle_status, to, actor);
    const reason = assertReason(input.reason_code, requiresReason(to));
    const note = assertNote(input.note);
    const now = this.now().toISOString();
    await this.repo.transition(
      tenantId,
      {
        conversion_id: conversionId,
        expected_from: conversion.lifecycle_status,
        to,
        actor_type: actor,
        actor_user_id: ctx.user.id,
        reason_code: reason,
        note,
        request_id: meta.request_id,
        now,
      },
      [this.auditStatement(tenant, ctx, auditAction, conversionId, meta, { from: conversion.lifecycle_status, to, reason_code: reason })],
    );
    return this.mustFind(tenantId, conversionId);
  }

  private assertEdge(from: ConversionStatus, to: ConversionStatus, actor: ConversionActor): void {
    if (isInternalOnlyTarget(to)) throw new AppError(403, "INTERNAL_TRANSITION", `${to} is an internal-only status`);
    if (!canTransition(from, to, actor)) {
      throw new AppError(409, "INVALID_TRANSITION", `${actor} cannot move a conversion from ${from} to ${to}`);
    }
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private async mustFind(tenantId: TenantId, conversionId: string): Promise<ConversionRecord> {
    const row = await this.repo.findById(tenantId, conversionId);
    if (!row) throw new AppError(404, "NOT_FOUND", "conversion not found");
    return row;
  }

  private auditStatement(
    tenant: TenantContext,
    ctx: AuthenticatedContext,
    action: string,
    targetId: string,
    meta: RequestMeta,
    metadata: Record<string, unknown>,
  ): D1PreparedStatement {
    return this.audit.statement({
      organization_id: tenant.organization.id,
      actor_user_id: ctx.user.id,
      action,
      target_type: action.startsWith("conversion.hold") ? "conversion_hold" : "conversion",
      target_id: targetId,
      metadata,
      meta,
    });
  }

  private async offerFacts(tenantId: TenantId, conversion: ConversionRecord): Promise<OfferFactsRow | null> {
    const row = await this.db
      .prepare(
        `SELECT o.id AS offer_id, o.status AS offer_status, o.access_mode,
                v.id AS version_id, v.conversion_event, v.affiliate_commission_minor, v.currency AS version_currency,
                v.revshare_percent_bps, v.payout_type
           FROM offers o
           LEFT JOIN offer_versions v ON v.id = COALESCE(?, o.current_version_id) AND v.offer_id = o.id
          WHERE o.organization_id = ? AND o.id = ?`,
      )
      .bind(conversion.offer_version_id, tenantId, conversion.offer_id)
      .first<OfferFactsRow>();
    return row ?? null;
  }

  /** Commission from the conversion's offer version: integer minor units only. */
  private async commissionFor(tenantId: TenantId, conversion: ConversionRecord): Promise<{ amount_minor: number; currency: string }> {
    if (conversion.commission_amount_minor !== null && conversion.commission_currency) {
      return { amount_minor: conversion.commission_amount_minor, currency: conversion.commission_currency };
    }
    const offer = await this.offerFacts(tenantId, conversion);
    if (!offer || !offer.version_id || offer.affiliate_commission_minor === null || !offer.version_currency) {
      throw new AppError(409, "OFFER_VERSION_MISSING", "conversion has no offer version to derive commission from");
    }
    if (offer.payout_type === "REVSHARE" && offer.revshare_percent_bps !== null) {
      if (conversion.sale_amount_minor === null)
        throw new AppError(409, "SALE_AMOUNT_REQUIRED", "REVSHARE commission needs sale_amount_minor");
      // integer math only: floor(sale * bps / 10000)
      return {
        amount_minor: Math.floor((conversion.sale_amount_minor * offer.revshare_percent_bps) / 10_000),
        currency: conversion.currency ?? offer.version_currency,
      };
    }
    return { amount_minor: offer.affiliate_commission_minor, currency: offer.version_currency };
  }

  private async loadValidationFacts(tenantId: TenantId, conversion: ConversionRecord): Promise<ValidationFacts> {
    const [advertiser, offer, click, attribution, duplicate] = await Promise.all([
      this.db
        .prepare(`SELECT id, type, status FROM organizations WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; type: string; status: string }>(),
      this.offerFacts(tenantId, conversion),
      conversion.click_id
        ? this.db
            .prepare(
              `SELECT id, offer_id, organization_id AS affiliate_organization_id, clicked_at FROM clicks WHERE offer_organization_id = ? AND id = ?`,
            )
            .bind(tenantId, conversion.click_id)
            .first<{ id: string; offer_id: string; affiliate_organization_id: string | null; clicked_at: string }>()
        : Promise.resolve(null),
      this.db
        .prepare(
          `SELECT decision, reason_code FROM attributions WHERE organization_id = ? AND conversion_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(tenantId, conversion.id)
        .first<{ decision: string; reason_code: string }>(),
      conversion.idempotency_key
        ? this.db
            .prepare(`SELECT id FROM conversions WHERE organization_id = ? AND idempotency_key = ? AND id <> ? AND created_at < ? LIMIT 1`)
            .bind(tenantId, conversion.idempotency_key, conversion.id, conversion.created_at)
            .first<{ id: string }>()
        : Promise.resolve(null),
    ]);

    let affiliate: ValidationFacts["affiliate"] = null;
    if (conversion.affiliate_organization_id) {
      const org = await this.db
        .prepare(`SELECT id, status FROM organizations WHERE id = ?`)
        .bind(conversion.affiliate_organization_id)
        .first<{ id: string; status: string }>();
      if (org) {
        let hasOfferAccess = offer?.access_mode === "PUBLIC";
        if (!hasOfferAccess) {
          const access = await this.db
            .prepare(
              `SELECT status FROM affiliate_offer_access WHERE organization_id = ? AND offer_id = ? AND affiliate_organization_id = ?`,
            )
            .bind(tenantId, conversion.offer_id, conversion.affiliate_organization_id)
            .first<{ status: string }>();
          hasOfferAccess = access?.status === "APPROVED";
        }
        affiliate = { organizationId: org.id, organizationStatus: org.status, hasOfferAccess };
      }
    }

    return {
      advertiser: advertiser
        ? { organizationId: advertiser.id, organizationType: advertiser.type, organizationStatus: advertiser.status }
        : null,
      offer: offer
        ? {
            id: offer.offer_id,
            organizationId: tenantId,
            status: offer.offer_status,
            conversionEvents: offer.conversion_event ? [offer.conversion_event] : [],
            requiresClick: false,
            requiresSaleAmount: offer.payout_type === "REVSHARE" || offer.payout_type === "CPS",
            allowedCurrencies: offer.version_currency ? [offer.version_currency] : [],
            minSaleAmountMinor: null,
          }
        : null,
      click: click
        ? { id: click.id, offerId: click.offer_id, affiliateOrganizationId: click.affiliate_organization_id, occurredAt: click.clicked_at }
        : null,
      affiliate,
      conversion: {
        conversionEvent: conversion.conversion_event,
        saleAmountMinor: conversion.sale_amount_minor,
        currency: conversion.currency,
        occurredAt: conversion.occurred_at,
        receivedAt: conversion.received_at,
      },
      attribution: attribution ? { decision: attribution.decision, reasonCode: attribution.reason_code } : null,
      dedup: { duplicateOfConversionId: duplicate?.id ?? null },
      trafficRules: { affiliateRestricted: affiliate?.organizationStatus === "RESTRICTED", geoAllowed: null, deviceAllowed: null },
      fraud: null,
    };
  }
}

/**
 * SYSTEM/INTERNAL transitions. No TenantContext, no permission check: these are
 * called by trusted internal code paths (ledger posting, payout runs) only and
 * must never be mounted on a route. Every call is still guarded by the state
 * machine, the hold guard, and written with history + audit.
 */
export class InternalConversionOps {
  constructor(
    private readonly repo: ConversionRepository,
    private readonly audit: AuditRepository,
    private readonly now: () => Date,
  ) {}

  /**
   * APPROVED → LEDGER_POSTED. `extra` statements (journal, legs, commission,
   * ledger audit) are appended to the transition's db.batch after the audit
   * row, so the ledger posting and the state transition commit — or roll
   * back — as one unit.
   */
  markLedgerPosted(
    tenantId: TenantId,
    conversionId: string,
    reason = "LEDGER_POSTED",
    requestId: string | null = null,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<ConversionRecord> {
    return this.step(tenantId, conversionId, "LEDGER_POSTED", reason, requestId, extra);
  }
  markEarned(tenantId: TenantId, conversionId: string, reason = "EARNED", requestId: string | null = null): Promise<ConversionRecord> {
    return this.step(tenantId, conversionId, "EARNED", reason, requestId);
  }
  markPayoutEligible(
    tenantId: TenantId,
    conversionId: string,
    reason = "PAYOUT_ELIGIBLE",
    requestId: string | null = null,
  ): Promise<ConversionRecord> {
    return this.step(tenantId, conversionId, "PAYOUT_ELIGIBLE", reason, requestId);
  }
  markPaid(tenantId: TenantId, conversionId: string, reason = "PAID", requestId: string | null = null): Promise<ConversionRecord> {
    return this.step(tenantId, conversionId, "PAID", reason, requestId);
  }

  /** SYSTEM intake transitions (RECEIVED→VALIDATING→PENDING, →REJECTED/FRAUD_REVIEW). */
  async systemTransition(
    tenantId: TenantId,
    conversionId: string,
    to: ConversionStatus,
    reason: string,
    requestId: string | null = null,
  ): Promise<ConversionRecord> {
    return this.apply(tenantId, conversionId, to, "SYSTEM", reason, requestId);
  }

  private step(
    tenantId: TenantId,
    conversionId: string,
    to: ConversionStatus,
    reason: string,
    requestId: string | null,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<ConversionRecord> {
    return this.apply(tenantId, conversionId, to, "INTERNAL", reason, requestId, extra);
  }

  private async apply(
    tenantId: TenantId,
    conversionId: string,
    to: ConversionStatus,
    actor: ConversionActor,
    reason: string,
    requestId: string | null,
    extra: readonly D1PreparedStatement[] = [],
  ): Promise<ConversionRecord> {
    const conversion = await this.repo.findById(tenantId, conversionId);
    if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");
    if (!canTransition(conversion.lifecycle_status, to, actor)) {
      throw new AppError(409, "INVALID_TRANSITION", `${actor} cannot move a conversion from ${conversion.lifecycle_status} to ${to}`);
    }
    const facts = await this.repo.holdFacts(tenantId, scopeOf(conversion));
    const guard = guardTransition(to, facts);
    if (!guard.ok) throw new AppError(409, guard.code, guard.message);
    const reasonCode = assertReason(reason, true);
    const now = this.now().toISOString();
    await this.repo.transition(
      tenantId,
      {
        conversion_id: conversionId,
        expected_from: conversion.lifecycle_status,
        to,
        actor_type: actor,
        actor_user_id: null,
        reason_code: reasonCode,
        note: null,
        request_id: requestId,
        now,
      },
      [
        this.audit.statement({
          organization_id: tenantId,
          actor_user_id: null,
          action: `conversion.${actor.toLowerCase()}.${to.toLowerCase()}`,
          target_type: "conversion",
          target_id: conversionId,
          metadata: { from: conversion.lifecycle_status, to, reason_code: reasonCode, actor },
          meta: { ip_address: null, user_agent: null, request_id: requestId },
        }),
        ...extra,
      ],
    );
    const after = await this.repo.findById(tenantId, conversionId);
    if (!after) throw new AppError(404, "NOT_FOUND", "conversion not found");
    return after;
  }
}

function actorOf(tenant: TenantContext): "TENANT" | "PLATFORM" {
  return tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT";
}

function scopeOf(c: ConversionRecord): { conversion_id: string; affiliate_organization_id: string | null } {
  return { conversion_id: c.id, affiliate_organization_id: c.affiliate_organization_id };
}

function failedCodes(v: ValidationResult): string {
  return v.checks
    .filter((c) => c.status === "FAIL" || c.status === "HOLD")
    .map((c) => `${c.check}=${c.code}`)
    .join(", ");
}
