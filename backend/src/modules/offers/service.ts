/**
 * Offers module — policy layer (Phase 2 Units 3–7; PRD §22–§30, §92, §94,
 * §116, §124, §132). SQL lives in `repository.ts`; the lifecycle/access graph
 * in `state-machine.ts`. Mirrors `modules/advertisers/service.ts` and
 * `modules/affiliates/service.ts`: it decides WHO may do WHAT and records
 * every accepted lifecycle transition twice — typed
 * (`offer_status_transitions`) and generic (`audit_logs`) — in the same D1
 * batch as the status change.
 *
 * Three faces, all enforced SERVER-SIDE (the frontend is never the boundary):
 *   Advertiser/owner (`offers.create|update|pause|read`, ADVERTISER/AGENCY):
 *     list · get · create · update · createVersion · listVersions · getVersion
 *     · submit · transition · history · access-grant management
 *   Platform reviewers (`offers.approve|pause|read`, PLATFORM org):
 *     listAll · getAny · versionsAny · historyAny · transition
 *   Affiliate marketplace (`offers.read`, any tenant; access enforced by grant):
 *     searchMarketplace · getMarketplaceOffer · apply
 *
 * Money is ALWAYS integer minor units + currency (PRD §25) — validated at the
 * route with zod and re-checked here for cross-field sanity. Every immutable
 * version is INSERT-only; history is never overwritten (PRD §24). Advertiser
 * payout / network margin / budget are advertiser-confidential and are dropped
 * from every affiliate-facing projection (PRD §29, §116).
 *
 * Error codes: OFFER_NOT_FOUND 404 · ORG_TYPE_NOT_ADVERTISER 400 ·
 *   ADVERTISER_PROFILE_REQUIRED 400 · INVALID_TRANSITION 409 · REASON_REQUIRED 400 ·
 *   OFFER_INCOMPLETE 400 · VALIDATION_ERROR 400 · FORBIDDEN 403 ·
 *   AFFILIATE_ORG_INVALID 400 · ACCESS_NOT_APPLICABLE 409 · ACCESS_GRANT_NOT_FOUND 404
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { PermissionKey } from "../rbac/permissions";
import { AuditRepository } from "../audit/repository";
import type { AdvertiserRepository } from "../advertisers/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type {
  AffiliateOfferAccessRow,
  OfferRepository,
  OfferRow,
  OfferTargetingRow,
  OfferTransitionRow,
  OfferVersionInput,
  OfferVersionRow,
  OfferWithMarketplaceRow,
  OfferWithOrgRow,
  TargetingInput,
} from "./repository";
import {
  allowedTargets,
  canTransition,
  isOfferStatus,
  requiresReason,
  VERSIONABLE_STATUSES,
  type AccessGrantStatus,
  type AccessMode,
  type ActorKind,
  type OfferStatus,
  type PayoutType,
  type TargetingDimension,
} from "./state-machine";

/** Organization types that may own offers (PRD §8). */
export const OFFER_ORG_TYPES = ["ADVERTISER", "AGENCY"] as const;

/** Access-grant statuses an affiliate may see confidential-safe joinable detail under. */
const JOINABLE_GRANT_STATUSES: ReadonlySet<AccessGrantStatus> = new Set<AccessGrantStatus>(["APPROVED"]);

export interface PublicTargeting {
  dimension: TargetingDimension;
  value: string;
}

export interface PublicOfferVersion {
  id: string;
  offer_id: string;
  version_number: number;
  payout_type: PayoutType;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor: number;
  revshare_percent_bps: number | null;
  daily_conversion_cap: number | null;
  total_conversion_cap: number | null;
  budget_minor: number | null;
  attribution_window_seconds: number;
  conversion_event: string;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string;
  targeting: PublicTargeting[];
}

export interface PublicOfferSummary {
  id: string;
  organization_id: string;
  advertiser_profile_id: string;
  status: OfferStatus;
  access_mode: AccessMode;
  name: string;
  vertical: string | null;
  description: string | null;
  current_version_id: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Lifecycle targets the CALLER may move this offer to (UI hint only). */
  allowed_transitions: OfferStatus[];
}

export interface PublicOffer extends PublicOfferSummary {
  current_version: PublicOfferVersion | null;
}

export interface PublicOfferListItem extends PublicOfferSummary {
  organization: { id: string; name: string; slug: string; type: string };
}

export interface PublicOfferPlatform extends PublicOffer {
  organization: { id: string; name: string; slug: string; type: string };
}

export interface PublicTransition {
  id: string;
  from_status: OfferStatus | null;
  to_status: OfferStatus;
  actor_kind: ActorKind;
  actor_user_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface PublicAccessGrant {
  id: string;
  offer_id: string;
  affiliate_organization_id: string;
  status: AccessGrantStatus;
  reason: string | null;
  requested_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Affiliate-facing marketplace projection — confidential fields removed (PRD §29). */
export interface PublicMarketplaceOffer {
  id: string;
  name: string;
  vertical: string | null;
  description: string | null;
  access_mode: AccessMode;
  status: OfferStatus;
  advertiser: { name: string; slug: string; type: string };
  version: {
    version_number: number;
    payout_type: PayoutType;
    currency: string;
    affiliate_commission_minor: number;
    revshare_percent_bps: number | null;
    daily_conversion_cap: number | null;
    total_conversion_cap: number | null;
    attribution_window_seconds: number;
    conversion_event: string;
  };
  /** Present on detail only, and only once the affiliate may actually join. */
  destination_url?: string | null;
  /** Present on detail only. Allow-list targeting the affiliate must satisfy. */
  targeting?: PublicTargeting[];
  /** The caller's access-grant state for this offer, if any. */
  my_access: { status: AccessGrantStatus } | null;
  /** True when the caller may promote this offer right now (LIVE + granted/public). */
  can_join: boolean;
  /** True when the caller may lodge an application (APPLICATION_REQUIRED/PRIVATE, no live grant). */
  can_apply: boolean;
}

/** Input the tenant supplies when creating an offer: identity + its first version. */
export interface CreateOfferInput {
  name: string;
  vertical?: string | null;
  description?: string | null;
  access_mode?: AccessMode;
  version: OfferVersionInput;
  targeting?: TargetingInput[];
}
export class OfferService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: OfferRepository,
    private readonly advertisers: AdvertiserRepository,
    db: D1Database,
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- tenant (advertiser/owner) reads -------------------------------------

  /** `offers.read`. Cursor-paginated list of the org's own offers. */
  async list(tenant: TenantContext, page: PageRequest): Promise<Page<PublicOfferSummary>> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    const result = await this.repo.listByTenant(tenantIdOf(tenant), page);
    return { items: result.items.map((r) => toSummary(r, "TENANT")), next_cursor: result.next_cursor };
  }

  /** `offers.read`. Full detail incl. the current immutable version + targeting. */
  async get(tenant: TenantContext, offerId: string): Promise<PublicOffer> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    const row = await this.requireTenantOffer(tenant, offerId);
    return this.tenantView(tenant, row);
  }

  /** `offers.read`. Immutable version history, oldest first (PRD §24). */
  async listVersions(tenant: TenantContext, offerId: string): Promise<PublicOfferVersion[]> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    await this.requireTenantOffer(tenant, offerId);
    const tid = tenantIdOf(tenant);
    const versions = await this.repo.listVersions(tid, offerId);
    return Promise.all(versions.map(async (v) => toVersion(v, await this.repo.listTargeting(tid, v.id))));
  }
  /** `offers.read`. One version with its targeting. */
  async getVersion(tenant: TenantContext, offerId: string, versionId: string): Promise<PublicOfferVersion> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    await this.requireTenantOffer(tenant, offerId);
    const tid = tenantIdOf(tenant);
    const version = await this.repo.findVersion(tid, versionId);
    if (!version || version.offer_id !== offerId) throw notFoundOffer();
    return toVersion(version, await this.repo.listTargeting(tid, versionId));
  }

  /** `offers.read`. Own lifecycle history (append-only). */
  async history(tenant: TenantContext, offerId: string): Promise<PublicTransition[]> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    await this.requireTenantOffer(tenant, offerId);
    return (await this.repo.listTransitionsByTenant(tenantIdOf(tenant), offerId)).map(toTransition);
  }

  /** `offers.read`. Access grants/applications on one of the org's offers. */
  async listAccessGrants(tenant: TenantContext, offerId: string): Promise<PublicAccessGrant[]> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    await this.requireTenantOffer(tenant, offerId);
    return (await this.repo.listAccessGrants(tenantIdOf(tenant), offerId)).map(toAccessGrant);
  }

  // ---- tenant writes -------------------------------------------------------

  /**
   * `offers.create`. New DRAFT offer + its immutable version 1 (PRD §22, §24).
   * Requires the org to have an advertiser profile. Economics are validated
   * for cross-field sanity before either row is written.
   */
  async create(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: CreateOfferInput,
    meta: RequestMeta,
  ): Promise<PublicOffer> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.create");
    const tid = tenantIdOf(tenant);
    const profile = await this.advertisers.findByTenant(tid);
    if (!profile) {
      throw new AppError(400, "ADVERTISER_PROFILE_REQUIRED", "Create an advertiser profile before creating offers");
    }
    validateEconomics(input.version);
    const targeting = normalizeTargeting(input.targeting);
    const offerId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const accessMode = input.access_mode ?? "PUBLIC";
    await this.repo.insert(
      tid,
      {
        id: offerId,
        advertiser_profile_id: profile.id,
        status: "DRAFT",
        name: input.name,
        vertical: input.vertical ?? null,
        description: input.description ?? null,
        access_mode: accessMode,
      },
      [
        this.repo.initialTransitionStatement({
          offer_id: offerId,
          organization_id: tenant.organization.id,
          to: "DRAFT",
          actor_user_id: ctx.user.id,
          actor_kind: "TENANT",
          request_id: meta.request_id,
        }),
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "offer.created",
          target_type: "offer",
          target_id: offerId,
          metadata: { name: input.name, access_mode: accessMode },
          meta,
        }),
      ],
    );
    await this.repo.insertVersion(
      tid,
      { id: versionId, offer_id: offerId, version_number: 1, created_by_user_id: ctx.user.id, ...input.version },
      targeting.map((t) => ({ id: crypto.randomUUID(), ...t })),
      [this.versionAudit(tenant, ctx.user.id, offerId, versionId, 1, meta)],
    );
    return this.tenantView(tenant, await this.requireTenantOffer(tenant, offerId));
  }
  /** `offers.update`. Patch identity/access-mode only; never status or economics. */
  async update(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    patch: { name?: string; vertical?: string | null; description?: string | null; access_mode?: AccessMode },
    meta: RequestMeta,
  ): Promise<PublicOffer> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.update");
    const tid = tenantIdOf(tenant);
    const before = await this.requireTenantOffer(tenant, offerId);
    if (before.status === "ARCHIVED") {
      throw new AppError(409, "INVALID_TRANSITION", "An archived offer cannot be edited");
    }
    const changed = (["name", "vertical", "description", "access_mode"] as const).filter((k) => patch[k] !== undefined);
    if (changed.length > 0) {
      await this.repo.updateFields(tid, offerId, patch, [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "offer.updated",
          target_type: "offer",
          target_id: offerId,
          metadata: { fields: changed },
          meta,
        }),
      ]);
    }
    return this.tenantView(tenant, await this.requireTenantOffer(tenant, offerId));
  }

  /**
   * `offers.update`. Append a new immutable version (PRD §24). Allowed in any
   * non-ARCHIVED status; `version_number` is MAX()+1 guarded by the table's
   * UNIQUE (offer_id, version_number). Moves the offer's current pointer.
   */
  async createVersion(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    input: OfferVersionInput,
    targeting: TargetingInput[] | undefined,
    meta: RequestMeta,
  ): Promise<PublicOfferVersion> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.update");
    const tid = tenantIdOf(tenant);
    const offer = await this.requireTenantOffer(tenant, offerId);
    if (!VERSIONABLE_STATUSES.has(offer.status)) {
      throw new AppError(409, "INVALID_TRANSITION", `A new version cannot be created while the offer is ${offer.status}`);
    }
    validateEconomics(input);
    const versions = await this.repo.listVersions(tid, offerId);
    const nextNumber = versions.reduce((m, v) => Math.max(m, v.version_number), 0) + 1;
    const versionId = crypto.randomUUID();
    await this.repo.insertVersion(
      tid,
      { id: versionId, offer_id: offerId, version_number: nextNumber, created_by_user_id: ctx.user.id, ...input },
      normalizeTargeting(targeting).map((t) => ({ id: crypto.randomUUID(), ...t })),
      [this.versionAudit(tenant, ctx.user.id, offerId, versionId, nextNumber, meta)],
    );
    const v = await this.repo.findVersion(tid, versionId);
    if (!v) throw new Error("version vanished after insert");
    return toVersion(v, await this.repo.listTargeting(tid, versionId));
  }
  /** `offers.update`. DRAFT → SUBMITTED. Requires at least one version (PRD §22). */
  async submit(ctx: AuthenticatedContext, tenant: TenantContext, offerId: string, meta: RequestMeta): Promise<PublicOffer> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.update");
    const offer = await this.requireTenantOffer(tenant, offerId);
    if (!canTransition(offer.status, "SUBMITTED", "TENANT")) {
      throw new AppError(409, "INVALID_TRANSITION", `An offer cannot be submitted from ${offer.status}`);
    }
    if (!offer.current_version_id) {
      throw new AppError(400, "OFFER_INCOMPLETE", "An offer needs at least one version before submission");
    }
    await this.applyAudited(ctx.user.id, offer, "SUBMITTED", "TENANT", null, undefined, meta);
    return this.tenantView(tenant, await this.requireTenantOffer(tenant, offerId));
  }

  /**
   * Tenant-driven lifecycle transition. `to` must be a TENANT edge from the
   * current status; the fine-grained permission depends on the target
   * (pause/resume → `offers.pause`, everything else → `offers.update`).
   * Restrictive targets require a reason (PRD §124).
   */
  async transition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    input: { to: string; reason?: string | null },
    meta: RequestMeta,
  ): Promise<PublicOffer> {
    this.assertOfferOrg(tenant);
    const offer = await this.requireTenantOffer(tenant, offerId);
    if (!isOfferStatus(input.to)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: to");
    if (!canTransition(offer.status, input.to, "TENANT")) {
      throw new AppError(409, "INVALID_TRANSITION", `Cannot move offer from ${offer.status} to ${input.to}`);
    }
    this.ensurePermission(tenant, requiredPermissionFor(offer.status, input.to, "TENANT"));
    const reason = input.reason?.trim() || null;
    if (requiresReason(input.to) && !reason) {
      throw new AppError(400, "REASON_REQUIRED", `A reason is required when moving an offer to ${input.to}`);
    }
    await this.applyAudited(ctx.user.id, offer, input.to, "TENANT", reason, undefined, meta);
    return this.tenantView(tenant, await this.requireTenantOffer(tenant, offerId));
  }
  /**
   * `offers.update`. Advertiser/owner grant management (PRD §92): INVITE or
   * APPROVE an affiliate, or REJECT/REVOKE an existing grant. REQUESTED is
   * affiliate-initiated only (via `apply`) and is rejected here. Grants make no
   * sense on a PUBLIC offer. The target affiliate org must exist, be ACTIVE and
   * be an AFFILIATE/PARTNER organization.
   */
  async setAccessGrant(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    input: { affiliate_organization_id: string; status: string; reason?: string | null },
    meta: RequestMeta,
  ): Promise<PublicAccessGrant> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "offers.update");
    const tid = tenantIdOf(tenant);
    const offer = await this.requireTenantOffer(tenant, offerId);
    if (offer.access_mode === "PUBLIC") {
      throw new AppError(409, "ACCESS_NOT_APPLICABLE", "A public offer needs no access grants");
    }
    if (!ADVERTISER_SETTABLE_GRANT_STATUSES.has(input.status as AccessGrantStatus)) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
    }
    const status = input.status as AccessGrantStatus;
    const affOrg = await this.repo.findOrganization(input.affiliate_organization_id);
    if (!affOrg || affOrg.status !== "ACTIVE" || !(AFFILIATE_ORG_TYPES as readonly string[]).includes(affOrg.type)) {
      throw new AppError(400, "AFFILIATE_ORG_INVALID", "The affiliate organization is not a valid, active affiliate/partner");
    }
    const existing = await this.repo.findAccessGrant(tid, offerId, input.affiliate_organization_id);
    if ((status === "REJECTED" || status === "REVOKED") && !existing) {
      throw new AppError(404, "ACCESS_GRANT_NOT_FOUND", "No access grant exists for this affiliate");
    }
    const id = existing?.id ?? crypto.randomUUID();
    const reason = input.reason?.trim() || null;
    await this.repo.upsertAccessGrant(
      tid,
      offerId,
      { id, affiliate_organization_id: input.affiliate_organization_id, status, reason, actor_user_id: ctx.user.id },
      [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "offer.access_grant_set",
          target_type: "affiliate_offer_access",
          target_id: id,
          metadata: { offer_id: offerId, affiliate_organization_id: input.affiliate_organization_id, status },
          meta,
        }),
      ],
    );
    const grant = await this.repo.findAccessGrant(tid, offerId, input.affiliate_organization_id);
    if (!grant) throw new Error("access grant vanished after upsert");
    return toAccessGrant(grant);
  }
  // ---- platform reviewers (PLATFORM org) -----------------------------------

  /** `offers.approve`. Cross-tenant review list, optional status filter (PRD §127). */
  async listAll(tenant: TenantContext, page: PageRequest, statusFilter?: string): Promise<Page<PublicOfferListItem>> {
    this.assertPlatform(tenant);
    this.ensurePermission(tenant, "offers.approve");
    let status: OfferStatus | undefined;
    if (statusFilter !== undefined && statusFilter !== "") {
      if (!isOfferStatus(statusFilter)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      status = statusFilter;
    }
    const result = await this.repo.listAll(page, { status });
    return { items: result.items.map((r) => toListItem(r, "PLATFORM")), next_cursor: result.next_cursor };
  }

  /** `offers.approve`. Any offer's full detail incl. current version + targeting. */
  async getAny(tenant: TenantContext, offerId: string): Promise<PublicOfferPlatform> {
    this.assertPlatform(tenant);
    this.ensurePermission(tenant, "offers.approve");
    return this.platformView(await this.requireAnyOffer(offerId));
  }

  /** `offers.approve`. Any offer's immutable version history. */
  async versionsAny(tenant: TenantContext, offerId: string): Promise<PublicOfferVersion[]> {
    this.assertPlatform(tenant);
    this.ensurePermission(tenant, "offers.approve");
    await this.requireAnyOffer(offerId);
    const versions = await this.repo.listVersionsAny(offerId);
    return Promise.all(versions.map(async (v) => toVersion(v, await this.repo.listTargetingAny(v.id))));
  }

  /** `offers.approve`. Any offer's lifecycle history. */
  async historyAny(tenant: TenantContext, offerId: string): Promise<PublicTransition[]> {
    this.assertPlatform(tenant);
    this.ensurePermission(tenant, "offers.approve");
    await this.requireAnyOffer(offerId);
    return (await this.repo.listTransitionsAny(offerId)).map(toTransition);
  }

  /**
   * Reviewer-driven transition (PRD §132: never self-approval — a PLATFORM org
   * is structurally distinct from the owning advertiser). `to` must be a
   * PLATFORM edge from the current status; review/approve targets need
   * `offers.approve`, operational holds/pauses need `offers.pause`. Restrictive
   * targets require a reason; optional `review_notes` are stored on the offer.
   */
  async platformTransition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    input: { to: string; reason?: string | null; review_notes?: string | null },
    meta: RequestMeta,
  ): Promise<PublicOfferPlatform> {
    this.assertPlatform(tenant);
    const offer = await this.requireAnyOffer(offerId);
    if (!isOfferStatus(input.to)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: to");
    if (!canTransition(offer.status, input.to, "PLATFORM")) {
      throw new AppError(409, "INVALID_TRANSITION", `Cannot move offer from ${offer.status} to ${input.to}`);
    }
    this.ensurePermission(tenant, requiredPermissionFor(offer.status, input.to, "PLATFORM"));
    const reason = input.reason?.trim() || null;
    if (requiresReason(input.to) && !reason) {
      throw new AppError(400, "REASON_REQUIRED", `A reason is required when moving an offer to ${input.to}`);
    }
    await this.applyAudited(ctx.user.id, offer, input.to, "PLATFORM", reason, input.review_notes, meta);
    return this.platformView(await this.requireAnyOffer(offerId));
  }
  // ---- affiliate marketplace (PRD §28, §29, §116) --------------------------

  /**
   * `offers.read`. Cross-tenant marketplace search from the CALLER's affiliate
   * organization (taken from the tenant context, never the client). The
   * repository's WHERE clause enforces access-mode visibility; this method
   * shapes each row into the confidential-safe projection and annotates the
   * caller's own grant state.
   */
  async searchMarketplace(
    tenant: TenantContext,
    page: PageRequest,
    filter: {
      vertical?: string;
      country?: string;
      payout_type?: PayoutType;
      device?: string;
      traffic_source?: string;
      access_mode?: AccessMode;
    },
  ): Promise<Page<PublicMarketplaceOffer>> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    const affId = tenant.organization.id;
    const result = await this.repo.searchMarketplace(page, { affiliate_organization_id: affId, ...filter });
    const items = await Promise.all(
      result.items.map(async (row) => {
        const grant = await this.repo.findMyAccessGrant(row.id, affId);
        return toMarketplace(row, grant, undefined, false);
      }),
    );
    return { items, next_cursor: result.next_cursor };
  }

  /**
   * `offers.read`. Marketplace detail for ONE offer, enforcing the same
   * visibility rule as search so a direct id cannot bypass it (PRD §116, IDOR).
   * `destination_url` is included only once the caller may actually join.
   */
  async getMarketplaceOffer(tenant: TenantContext, offerId: string): Promise<PublicMarketplaceOffer> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    const affId = tenant.organization.id;
    const row = await this.repo.findMarketplaceOffer(offerId, affId);
    if (!row) throw notFoundOffer();
    const grant = await this.repo.findMyAccessGrant(offerId, affId);
    const targeting = await this.repo.listTargetingAny(row.version_id);
    return toMarketplace(row, grant, targeting, true);
  }

  /**
   * `offers.read`. Affiliate self-application for a restricted offer (PRD §92).
   * Only APPLICATION_REQUIRED / PRIVATE offers accept applications; the offer
   * must be marketplace-visible to the caller. An already-APPROVED grant is
   * returned unchanged (idempotent).
   */
  async apply(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    meta: RequestMeta,
  ): Promise<PublicAccessGrant> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "offers.read");
    const affId = tenant.organization.id;
    const row = await this.repo.findMarketplaceOffer(offerId, affId);
    if (!row) throw notFoundOffer();
    if (row.access_mode !== "APPLICATION_REQUIRED" && row.access_mode !== "PRIVATE") {
      throw new AppError(409, "ACCESS_NOT_APPLICABLE", "This offer does not accept affiliate applications");
    }
    const existing = await this.repo.findMyAccessGrant(offerId, affId);
    if (existing && existing.status === "APPROVED") return toAccessGrant(existing);
    const id = existing?.id ?? crypto.randomUUID();
    await this.repo.requestAccess(
      { id, offer_id: offerId, owner_organization_id: row.organization_id, affiliate_organization_id: affId },
      [
        this.audit.statement({
          organization_id: row.organization_id,
          actor_user_id: ctx.user.id,
          action: "offer.access_requested",
          target_type: "affiliate_offer_access",
          target_id: id,
          metadata: { offer_id: offerId, affiliate_organization_id: affId },
          meta,
        }),
      ],
    );
    const grant = await this.repo.findMyAccessGrant(offerId, affId);
    if (!grant) throw new Error("access grant vanished after request");
    return toAccessGrant(grant);
  }
  // ---- internals -----------------------------------------------------------

  /** Tenant-scoped full view: offer + its current immutable version + targeting. */
  private async tenantView(tenant: TenantContext, row: OfferRow): Promise<PublicOffer> {
    const tid = tenantIdOf(tenant);
    const version = row.current_version_id ? await this.repo.currentVersion(tid, row.id) : null;
    const targeting = version ? await this.repo.listTargeting(tid, version.id) : [];
    return toOffer(row, version ? toVersion(version, targeting) : null, "TENANT");
  }

  /** Platform full view (cross-tenant): offer + current version + owning org. */
  private async platformView(row: OfferWithOrgRow): Promise<PublicOfferPlatform> {
    const version = row.current_version_id ? await this.repo.findVersionAny(row.current_version_id) : null;
    const targeting = version ? await this.repo.listTargetingAny(version.id) : [];
    return {
      ...toOffer(row, version ? toVersion(version, targeting) : null, "PLATFORM"),
      organization: { id: row.organization_id, name: row.organization_name, slug: row.organization_slug, type: row.organization_type },
    };
  }

  /** Persist an accepted transition + its typed and generic audit rows atomically. */
  private async applyAudited(
    actorUserId: string,
    offer: { id: string; organization_id: string; status: OfferStatus },
    to: OfferStatus,
    actor: ActorKind,
    reason: string | null,
    reviewNotes: string | null | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.repo.applyTransition(
      { id: offer.id, organization_id: offer.organization_id },
      { from: offer.status, to, actor_user_id: actorUserId, actor_kind: actor, reason, request_id: meta.request_id, review_notes: reviewNotes },
      [
        this.audit.statement({
          organization_id: offer.organization_id,
          actor_user_id: actorUserId,
          action: "offer.status_changed",
          target_type: "offer",
          target_id: offer.id,
          metadata: { from: offer.status, to, actor_kind: actor, reason },
          meta,
        }),
      ],
    );
  }

  /** Audit statement for an appended immutable version, batched with the insert. */
  private versionAudit(
    tenant: TenantContext,
    actorUserId: string,
    offerId: string,
    versionId: string,
    versionNumber: number,
    meta: RequestMeta,
  ): D1PreparedStatement {
    return this.audit.statement({
      organization_id: tenant.organization.id,
      actor_user_id: actorUserId,
      action: "offer.version_created",
      target_type: "offer_version",
      target_id: versionId,
      metadata: { offer_id: offerId, version_number: versionNumber },
      meta,
    });
  }
  private assertOfferOrg(tenant: TenantContext): void {
    if (!(OFFER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_ADVERTISER", "Only advertiser or agency organizations can own offers");
    }
  }

  private assertAffiliateOrg(tenant: TenantContext): void {
    if (!(AFFILIATE_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "AFFILIATE_ORG_INVALID", "The marketplace is available to affiliate or partner organizations");
    }
  }

  private assertPlatform(tenant: TenantContext): void {
    if (tenant.organization.type !== "PLATFORM") {
      throw new AppError(403, "FORBIDDEN", "Offer review is a platform operation");
    }
  }

  private ensurePermission(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) {
      throw new AppError(403, "FORBIDDEN", `Missing required permission: ${key}`);
    }
  }

  private async requireTenantOffer(tenant: TenantContext, offerId: string): Promise<OfferRow> {
    const row = await this.repo.findById(tenantIdOf(tenant), offerId);
    if (!row) throw notFoundOffer();
    return row;
  }

  private async requireAnyOffer(offerId: string): Promise<OfferWithOrgRow> {
    const row = await this.repo.findAnyById(offerId);
    if (!row) throw notFoundOffer();
    return row;
  }
}

// ---- organization types allowed on the affiliate (marketplace) side ---------
const AFFILIATE_ORG_TYPES = ["AFFILIATE", "PARTNER"] as const;

/** Grant statuses the advertiser/owner may set directly (REQUESTED is affiliate-only). */
const ADVERTISER_SETTABLE_GRANT_STATUSES: ReadonlySet<AccessGrantStatus> = new Set<AccessGrantStatus>([
  "INVITED",
  "APPROVED",
  "REJECTED",
  "REVOKED",
]);

function notFoundOffer(): AppError {
  return new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
}
/**
 * Cross-field economic sanity (PRD §25). Money is already validated at the
 * route as integer minor units + a 3-letter currency; here we enforce the
 * relationships zod cannot express on its own:
 *   * REVSHARE  → a basis-points share (1..10000) is required, and the fixed
 *                 payout/commission may be 0 (a pure revshare offer).
 *   * fixed     → no basis-points share; the affiliate commission may not
 *                 exceed the advertiser payout (the network margin is the
 *                 non-negative spread), and any explicitly-declared
 *                 network_margin_minor must fit within that spread.
 *   * a bounded targeting window must not end before it starts.
 */
function validateEconomics(v: OfferVersionInput): void {
  if (v.payout_type === "REVSHARE") {
    const bps = v.revshare_percent_bps;
    if (bps == null || bps < 1 || bps > 10000) {
      throw new AppError(400, "VALIDATION_ERROR", "REVSHARE offers require revshare_percent_bps between 1 and 10000");
    }
  } else {
    if (v.revshare_percent_bps != null) {
      throw new AppError(400, "VALIDATION_ERROR", "revshare_percent_bps is only valid for REVSHARE offers");
    }
    if (v.affiliate_commission_minor > v.advertiser_payout_minor) {
      throw new AppError(400, "VALIDATION_ERROR", "affiliate_commission_minor cannot exceed advertiser_payout_minor");
    }
    if (v.network_margin_minor != null && v.affiliate_commission_minor + v.network_margin_minor > v.advertiser_payout_minor) {
      throw new AppError(400, "VALIDATION_ERROR", "affiliate_commission_minor + network_margin_minor cannot exceed advertiser_payout_minor");
    }
  }
  if (v.targeting_starts_at && v.targeting_ends_at && v.targeting_ends_at <= v.targeting_starts_at) {
    throw new AppError(400, "VALIDATION_ERROR", "targeting_ends_at must be after targeting_starts_at");
  }
}

/** Drop empty/whitespace targeting values; the DB UNIQUE guards true duplicates. */
function normalizeTargeting(targeting: TargetingInput[] | undefined): TargetingInput[] {
  if (!targeting) return [];
  const seen = new Set<string>();
  const out: TargetingInput[] = [];
  for (const t of targeting) {
    const value = t.value?.trim();
    if (!value) continue;
    const key = `${t.dimension}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dimension: t.dimension, value });
  }
  return out;
}

/**
 * Fine-grained permission for a lifecycle edge. Pause/resume operations are
 * gated on `offers.pause`; review/approve/withdraw/archive on `offers.approve`
 * (platform) or `offers.update` (tenant). The route guards a single key; this
 * lets the service enforce the exact authority the specific transition needs.
 */
function requiredPermissionFor(from: OfferStatus, to: OfferStatus, actor: ActorKind): PermissionKey {
  if (actor === "TENANT") {
    if (to === "PAUSED") return "offers.pause";
    if (to === "LIVE" && from !== "APPROVED") return "offers.pause"; // resume from a halted state
    return "offers.update";
  }
  // PLATFORM
  if (to === "APPROVED" || to === "UNDER_REVIEW" || to === "DRAFT" || to === "ARCHIVED") return "offers.approve";
  return "offers.pause"; // PAUSED, LIVE (reinstate), COMPLIANCE_HOLD, TRACKING_ISSUE
}
// ---- mappers (explicit allow-lists — the security boundary, PRD §116) -------

function toSummary(r: OfferRow, viewer: ActorKind): PublicOfferSummary {
  return {
    id: r.id,
    organization_id: r.organization_id,
    advertiser_profile_id: r.advertiser_profile_id,
    status: r.status,
    access_mode: r.access_mode,
    name: r.name,
    vertical: r.vertical,
    description: r.description,
    current_version_id: r.current_version_id,
    review_notes: r.review_notes,
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
    activated_at: r.activated_at,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    allowed_transitions: allowedTargets(r.status, viewer),
  };
}

function toOffer(r: OfferRow, currentVersion: PublicOfferVersion | null, viewer: ActorKind): PublicOffer {
  return { ...toSummary(r, viewer), current_version: currentVersion };
}

function toListItem(r: OfferWithOrgRow, viewer: ActorKind): PublicOfferListItem {
  return {
    ...toSummary(r, viewer),
    organization: { id: r.organization_id, name: r.organization_name, slug: r.organization_slug, type: r.organization_type },
  };
}

function toVersion(v: OfferVersionRow, targeting: readonly OfferTargetingRow[]): PublicOfferVersion {
  return {
    id: v.id,
    offer_id: v.offer_id,
    version_number: v.version_number,
    payout_type: v.payout_type,
    currency: v.currency,
    advertiser_payout_minor: v.advertiser_payout_minor,
    affiliate_commission_minor: v.affiliate_commission_minor,
    network_margin_minor: v.network_margin_minor,
    revshare_percent_bps: v.revshare_percent_bps,
    daily_conversion_cap: v.daily_conversion_cap,
    total_conversion_cap: v.total_conversion_cap,
    budget_minor: v.budget_minor,
    attribution_window_seconds: v.attribution_window_seconds,
    conversion_event: v.conversion_event,
    destination_url: v.destination_url,
    targeting_starts_at: v.targeting_starts_at,
    targeting_ends_at: v.targeting_ends_at,
    change_summary: v.change_summary,
    created_by_user_id: v.created_by_user_id,
    created_at: v.created_at,
    targeting: targeting.map(toTargeting),
  };
}

function toTargeting(t: OfferTargetingRow | { dimension: TargetingDimension; value: string }): PublicTargeting {
  return { dimension: t.dimension, value: t.value };
}

function toTransition(t: OfferTransitionRow): PublicTransition {
  return {
    id: t.id,
    from_status: t.from_status,
    to_status: t.to_status,
    actor_kind: t.actor_kind,
    actor_user_id: t.actor_user_id,
    reason: t.reason,
    created_at: t.created_at,
  };
}

function toAccessGrant(g: AffiliateOfferAccessRow): PublicAccessGrant {
  return {
    id: g.id,
    offer_id: g.offer_id,
    affiliate_organization_id: g.affiliate_organization_id,
    status: g.status,
    reason: g.reason,
    requested_at: g.requested_at,
    decided_at: g.decided_at,
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}
/**
 * Affiliate-facing marketplace projection (PRD §29, §116). Built from
 * `OfferWithMarketplaceRow`, which the repository already restricts to
 * affiliate-safe columns — advertiser_payout_minor / network_margin_minor /
 * budget_minor are never selected, so they cannot leak here. `destination_url`
 * is surfaced only on the detail view AND only once the caller may actually
 * join; `targeting` is surfaced on the detail view (allow-list the affiliate
 * must satisfy).
 */
function toMarketplace(
  row: OfferWithMarketplaceRow,
  grant: AffiliateOfferAccessRow | null,
  targeting: readonly OfferTargetingRow[] | undefined,
  detail: boolean,
): PublicMarketplaceOffer {
  const isApproved = grant?.status === "APPROVED";
  const canJoin = row.status === "LIVE" && (row.access_mode === "PUBLIC" || isApproved);
  const canApply =
    !canJoin &&
    (row.access_mode === "APPLICATION_REQUIRED" || row.access_mode === "PRIVATE") &&
    (!grant || grant.status === "REJECTED" || grant.status === "REVOKED");
  const projection: PublicMarketplaceOffer = {
    id: row.id,
    name: row.name,
    vertical: row.vertical,
    description: row.description,
    access_mode: row.access_mode,
    status: row.status,
    advertiser: { name: row.organization_name, slug: row.organization_slug, type: row.organization_type },
    version: {
      version_number: row.version_number,
      payout_type: row.payout_type,
      currency: row.currency,
      affiliate_commission_minor: row.affiliate_commission_minor,
      revshare_percent_bps: row.revshare_percent_bps,
      daily_conversion_cap: row.daily_conversion_cap,
      total_conversion_cap: row.total_conversion_cap,
      attribution_window_seconds: row.attribution_window_seconds,
      conversion_event: row.conversion_event,
    },
    my_access: grant ? { status: grant.status } : null,
    can_join: canJoin,
    can_apply: canApply,
  };
  if (detail) {
    projection.targeting = (targeting ?? []).map(toTargeting);
    // Destination is the joinable payload; only expose it when the caller may join.
    if (canJoin) projection.destination_url = row.destination_url;
  }
  return projection;
}

