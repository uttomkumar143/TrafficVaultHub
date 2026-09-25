/**
 * Affiliate module — policy layer (Phase 2 Unit 2; PRD §19, §20, §21, §27,
 * §92, §94, §124, §132). SQL lives in `repository.ts`; the lifecycle graph in
 * `state-machine.ts`. Mirrors `modules/advertisers/service.ts`: decides WHO
 * may do WHAT and records every accepted lifecycle transition twice — typed
 * (`affiliate_status_transitions`) and generic (`audit_logs`) — in the same
 * D1 batch as the status change.
 *
 * Tenant side (`affiliates.read` / `affiliates.manage`, AFFILIATE/PARTNER orgs):
 *   get · create · update · submit · appeal · history ·
 *   listTrafficSources · declareTrafficSource · removeTrafficSource
 * Platform side (`affiliates.review`, PLATFORM org only):
 *   list · getAny · transition · historyAny
 *
 * Authority rules:
 *   * The tenant is always the resolved `TenantContext` from the path — never
 *     a body value. Only AFFILIATE and PARTNER organizations may own a profile.
 *   * The tenant may submit (EMAIL_VERIFIED|MORE_INFORMATION_REQUIRED →
 *     UNDER_REVIEW) — requires the PRD §21 fields AND at least one declared
 *     traffic source (PRD §27) — and may appeal (RESTRICTED|SUSPENDED → APPEAL,
 *     reason required: the appeal statement). Nothing the tenant does can
 *     approve itself.
 *   * Platform reviewers drive every other edge; restrictive targets require a
 *     reason (PRD §124). Reviewers must act from a PLATFORM organization.
 *   * APPLIED → EMAIL_VERIFIED is a SYSTEM transition applied automatically
 *     when the acting user's email is verified.
 *
 * Error codes: AFFILIATE_PROFILE_NOT_FOUND 404 · AFFILIATE_PROFILE_EXISTS 409 ·
 *   ORG_TYPE_NOT_AFFILIATE 400 · INVALID_TRANSITION 409 · REASON_REQUIRED 400 ·
 *   PROFILE_INCOMPLETE 400 · TRAFFIC_SOURCE_NOT_FOUND 404 · FORBIDDEN 403 ·
 *   VALIDATION_ERROR 400
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type {
  AffiliateProfileInput,
  AffiliateProfilePatch,
  AffiliateProfileRow,
  AffiliateProfileWithOrgRow,
  AffiliateRepository,
  AffiliateTrafficSourceRow,
  AffiliateTransitionRow,
  TrafficSourceInput,
} from "./repository";
import {
  allowedTargets,
  APPEALABLE_STATUSES,
  canTransition,
  isAffiliateStatus,
  missingSubmissionFields,
  requiresReason,
  SUBMITTABLE_STATUSES,
  type AcquisitionChannel,
  type ActorKind,
  type AffiliateStatus,
  type TrafficSourceType,
} from "./state-machine";

/** Organization types that may own an affiliate profile (PRD §8). */
export const AFFILIATE_ORG_TYPES = ["AFFILIATE", "PARTNER"] as const;

export interface PublicTrafficSource {
  id: string;
  source_type: TrafficSourceType;
  description: string | null;
  url: string | null;
  estimated_monthly_volume: number | null;
  created_at: string;
  updated_at: string;
}

export interface PublicAffiliateProfile {
  id: string;
  organization_id: string;
  status: AffiliateStatus;
  display_name: string;
  legal_name: string | null;
  website_url: string | null;
  app_url: string | null;
  promotional_methods: string | null;
  audience_description: string | null;
  monthly_traffic_estimate: number | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country_code: string | null;
  };
  contact: { name: string | null; email: string | null; phone: string | null; messaging_handle: string | null };
  acquisition_channel: AcquisitionChannel;
  referral_code: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Declared traffic sources (PRD §27) — part of the application. */
  traffic_sources: PublicTrafficSource[];
  /** Lifecycle targets the CALLER may move this profile to (UI hint only). */
  allowed_transitions: AffiliateStatus[];
  /** PRD §21/§27 requirements still missing before submission. */
  missing_fields: string[];
}

export interface PublicAffiliateListItem extends PublicAffiliateProfile {
  organization: { id: string; name: string; slug: string; type: string };
}

export interface PublicTransition {
  id: string;
  from_status: AffiliateStatus | null;
  to_status: AffiliateStatus;
  actor_kind: ActorKind;
  actor_user_id: string | null;
  reason: string | null;
  created_at: string;
}

const NO_TRAFFIC_SOURCE = "traffic_sources";

export class AffiliateService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: AffiliateRepository,
    db: D1Database,
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- tenant side ---------------------------------------------------------

  /** `affiliates.read`. 404 when the org has no profile yet. */
  async get(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Promise<PublicAffiliateProfile> {
    this.assertAffiliateOrg(tenant);
    let row = await this.requireTenantProfile(tenant);
    row = await this.autoVerify(ctx, row, meta);
    return this.tenantView(tenant, row);
  }

  /** `affiliates.manage`. One profile per organization. */
  async create(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: AffiliateProfileInput,
    meta: RequestMeta,
  ): Promise<PublicAffiliateProfile> {
    this.assertAffiliateOrg(tenant);
    const tid = tenantIdOf(tenant);
    if (await this.repo.findByTenant(tid)) {
      throw new AppError(409, "AFFILIATE_PROFILE_EXISTS", "This organization already has an affiliate profile");
    }
    const id = crypto.randomUUID();
    // Login already requires a verified email, so a self-created profile
    // starts at EMAIL_VERIFIED (SYSTEM fact), otherwise APPLIED.
    const status: AffiliateStatus = ctx.user.email_verified ? "EMAIL_VERIFIED" : "APPLIED";
    await this.repo.insert(tid, { id, status, ...input }, [
      this.repo.initialTransitionStatement({
        profile_id: id,
        organization_id: tenant.organization.id,
        to: status,
        actor_user_id: ctx.user.id,
        actor_kind: "SYSTEM",
        request_id: meta.request_id,
      }),
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "affiliate.created",
        target_type: "affiliate_profile",
        target_id: id,
        metadata: { status, display_name: input.display_name, acquisition_channel: input.acquisition_channel ?? "DIRECT" },
        meta,
      }),
    ]);
    return this.tenantView(tenant, await this.requireTenantProfile(tenant));
  }

  /** `affiliates.manage`. Partial update of application fields; status untouched. */
  async update(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    patch: AffiliateProfilePatch,
    meta: RequestMeta,
  ): Promise<PublicAffiliateProfile> {
    this.assertAffiliateOrg(tenant);
    const tid = tenantIdOf(tenant);
    const before = await this.requireTenantProfile(tenant);
    if (before.status === "TERMINATED") {
      throw new AppError(409, "INVALID_TRANSITION", "A terminated affiliate profile cannot be edited");
    }
    const changed = (Object.keys(patch) as Array<keyof AffiliateProfilePatch>).filter((k) => patch[k] !== undefined);
    if (changed.length > 0) {
      await this.repo.updateFields(tid, patch, [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "affiliate.updated",
          target_type: "affiliate_profile",
          target_id: before.id,
          metadata: { fields: changed },
          meta,
        }),
      ]);
    }
    return this.tenantView(tenant, await this.requireTenantProfile(tenant));
  }

  /** `affiliates.manage`. EMAIL_VERIFIED|MORE_INFORMATION_REQUIRED → UNDER_REVIEW. */
  async submit(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Promise<PublicAffiliateProfile> {
    this.assertAffiliateOrg(tenant);
    let row = await this.requireTenantProfile(tenant);
    row = await this.autoVerify(ctx, row, meta);
    if (!SUBMITTABLE_STATUSES.includes(row.status) || !canTransition(row.status, "UNDER_REVIEW", "TENANT")) {
      throw new AppError(409, "INVALID_TRANSITION", `Application cannot be submitted from status ${row.status}`);
    }
    const sources = await this.repo.listTrafficSources(tenantIdOf(tenant));
    const missing = missingRequirements(row, sources);
    if (missing.length > 0) {
      throw new AppError(400, "PROFILE_INCOMPLETE", `Missing required fields: ${missing.join(", ")}`);
    }
    await this.applyAudited(ctx.user.id, row, "UNDER_REVIEW", "TENANT", null, undefined, meta);
    return this.tenantView(tenant, await this.requireTenantProfile(tenant));
  }

  /**
   * `affiliates.manage`. RESTRICTED|SUSPENDED → APPEAL (PRD §19). The appeal
   * statement is stored as the transition `reason` and is required — an
   * appeal without grounds is not reviewable.
   */
  async appeal(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: { reason?: string | null },
    meta: RequestMeta,
  ): Promise<PublicAffiliateProfile> {
    this.assertAffiliateOrg(tenant);
    const row = await this.requireTenantProfile(tenant);
    if (!APPEALABLE_STATUSES.includes(row.status) || !canTransition(row.status, "APPEAL", "TENANT")) {
      throw new AppError(409, "INVALID_TRANSITION", `An appeal cannot be lodged from status ${row.status}`);
    }
    const reason = input.reason?.trim() || null;
    if (!reason) throw new AppError(400, "REASON_REQUIRED", "An appeal must state its grounds");
    await this.applyAudited(ctx.user.id, row, "APPEAL", "TENANT", reason, undefined, meta);
    return this.tenantView(tenant, await this.requireTenantProfile(tenant));
  }

  /** `affiliates.read`. Own lifecycle history. */
  async history(tenant: TenantContext): Promise<PublicTransition[]> {
    this.assertAffiliateOrg(tenant);
    await this.requireTenantProfile(tenant);
    return (await this.repo.listTransitionsByTenant(tenantIdOf(tenant))).map(toPublicTransition);
  }

  // ---- traffic sources (PRD §27) --------------------------------------------

  /** `affiliates.read`. */
  async listTrafficSources(tenant: TenantContext): Promise<PublicTrafficSource[]> {
    this.assertAffiliateOrg(tenant);
    await this.requireTenantProfile(tenant);
    return (await this.repo.listTrafficSources(tenantIdOf(tenant))).map(toPublicTrafficSource);
  }

  /** `affiliates.manage`. Declare (or re-declare) one source type. Audited. */
  async declareTrafficSource(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: TrafficSourceInput,
    meta: RequestMeta,
  ): Promise<{ source: PublicTrafficSource; created: boolean }> {
    this.assertAffiliateOrg(tenant);
    const tid = tenantIdOf(tenant);
    const profile = await this.requireTenantProfile(tenant);
    if (profile.status === "TERMINATED") {
      throw new AppError(409, "INVALID_TRANSITION", "A terminated affiliate profile cannot be edited");
    }
    const existing = await this.repo.findTrafficSource(tid, input.source_type);
    const id = existing?.id ?? crypto.randomUUID();
    await this.repo.upsertTrafficSource(tid, profile.id, { id, ...input }, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: existing ? "affiliate.traffic_source_updated" : "affiliate.traffic_source_declared",
        target_type: "affiliate_traffic_source",
        target_id: id,
        metadata: { source_type: input.source_type, profile_id: profile.id },
        meta,
      }),
    ]);
    const row = await this.repo.findTrafficSource(tid, input.source_type);
    if (!row) throw new Error("traffic source vanished after upsert");
    return { source: toPublicTrafficSource(row), created: !existing };
  }

  /** `affiliates.manage`. Remove a declaration. Audited. */
  async removeTrafficSource(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    sourceType: TrafficSourceType,
    meta: RequestMeta,
  ): Promise<void> {
    this.assertAffiliateOrg(tenant);
    const tid = tenantIdOf(tenant);
    const profile = await this.requireTenantProfile(tenant);
    if (profile.status === "TERMINATED") {
      throw new AppError(409, "INVALID_TRANSITION", "A terminated affiliate profile cannot be edited");
    }
    const existing = await this.repo.findTrafficSource(tid, sourceType);
    if (!existing) throw new AppError(404, "TRAFFIC_SOURCE_NOT_FOUND", "Traffic source is not declared");
    await this.repo.deleteTrafficSource(tid, sourceType, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "affiliate.traffic_source_removed",
        target_type: "affiliate_traffic_source",
        target_id: existing.id,
        metadata: { source_type: sourceType, profile_id: profile.id },
        meta,
      }),
    ]);
  }

  // ---- platform side (affiliates.review) ----------------------------------

  async list(tenant: TenantContext, page: PageRequest, statusFilter?: string): Promise<Page<PublicAffiliateListItem>> {
    this.assertPlatform(tenant);
    let status: AffiliateStatus | undefined;
    if (statusFilter !== undefined && statusFilter !== "") {
      if (!isAffiliateStatus(statusFilter)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      status = statusFilter;
    }
    const result = await this.repo.listAll(page, { status });
    // List view: traffic sources are fetched on the detail route, not per list row.
    return { items: result.items.map((r) => toPublicListItem(r, [])), next_cursor: result.next_cursor };
  }

  async getAny(tenant: TenantContext, profileId: string): Promise<PublicAffiliateListItem> {
    this.assertPlatform(tenant);
    const row = await this.requireAnyProfile(profileId);
    return toPublicListItem(row, await this.repo.listTrafficSourcesAny(profileId));
  }

  async historyAny(tenant: TenantContext, profileId: string): Promise<PublicTransition[]> {
    this.assertPlatform(tenant);
    await this.requireAnyProfile(profileId);
    return (await this.repo.listTransitionsAny(profileId)).map(toPublicTransition);
  }

  /**
   * Reviewer-driven transition. `to` must be a PLATFORM edge from the current
   * status; restrictive targets require `reason` (PRD §124). Optional
   * `review_notes` are stored on the profile.
   */
  async transition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    profileId: string,
    input: { to: string; reason?: string | null; review_notes?: string | null },
    meta: RequestMeta,
  ): Promise<PublicAffiliateListItem> {
    this.assertPlatform(tenant);
    const row = await this.requireAnyProfile(profileId);
    if (!isAffiliateStatus(input.to)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: to");
    if (!canTransition(row.status, input.to, "PLATFORM")) {
      throw new AppError(409, "INVALID_TRANSITION", `Cannot move affiliate from ${row.status} to ${input.to}`);
    }
    const reason = input.reason?.trim() || null;
    if (requiresReason(input.to) && !reason) {
      throw new AppError(400, "REASON_REQUIRED", `A reason is required when moving an affiliate to ${input.to}`);
    }
    await this.applyAudited(ctx.user.id, row, input.to, "PLATFORM", reason, input.review_notes, meta);
    return toPublicListItem(await this.requireAnyProfile(profileId), await this.repo.listTrafficSourcesAny(profileId));
  }

  // ---- internals -----------------------------------------------------------

  private async tenantView(tenant: TenantContext, row: AffiliateProfileRow): Promise<PublicAffiliateProfile> {
    const sources = await this.repo.listTrafficSources(tenantIdOf(tenant));
    return toPublic(row, sources, "TENANT");
  }

  /** SYSTEM edge: APPLIED → EMAIL_VERIFIED once the acting user's email is verified. */
  private async autoVerify(ctx: AuthenticatedContext, row: AffiliateProfileRow, meta: RequestMeta): Promise<AffiliateProfileRow> {
    if (row.status !== "APPLIED" || !ctx.user.email_verified) return row;
    if (!canTransition("APPLIED", "EMAIL_VERIFIED", "SYSTEM")) return row;
    await this.applyAudited(ctx.user.id, row, "EMAIL_VERIFIED", "SYSTEM", null, undefined, meta);
    return { ...row, status: "EMAIL_VERIFIED" };
  }

  private async applyAudited(
    actorUserId: string,
    row: AffiliateProfileRow,
    to: AffiliateStatus,
    actor: ActorKind,
    reason: string | null,
    reviewNotes: string | null | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.repo.applyTransition(
      { id: row.id, organization_id: row.organization_id },
      {
        from: row.status,
        to,
        actor_user_id: actorUserId,
        actor_kind: actor,
        reason,
        request_id: meta.request_id,
        review_notes: reviewNotes,
      },
      [
        this.audit.statement({
          organization_id: row.organization_id,
          actor_user_id: actorUserId,
          action: "affiliate.status_changed",
          target_type: "affiliate_profile",
          target_id: row.id,
          metadata: { from: row.status, to, actor_kind: actor, reason },
          meta,
        }),
      ],
    );
  }

  private assertAffiliateOrg(tenant: TenantContext): void {
    if (!(AFFILIATE_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_AFFILIATE", "Only affiliate or partner organizations have an affiliate profile");
    }
  }

  /** Review routes are mounted under a PLATFORM organization only. */
  private assertPlatform(tenant: TenantContext): void {
    if (tenant.organization.type !== "PLATFORM") {
      throw new AppError(403, "FORBIDDEN", "Affiliate review is a platform operation");
    }
  }

  private async requireTenantProfile(tenant: TenantContext): Promise<AffiliateProfileRow> {
    const row = await this.repo.findByTenant(tenantIdOf(tenant));
    if (!row) throw new AppError(404, "AFFILIATE_PROFILE_NOT_FOUND", "Affiliate profile not found");
    return row;
  }

  private async requireAnyProfile(profileId: string): Promise<AffiliateProfileWithOrgRow> {
    const row = await this.repo.findAnyById(profileId);
    if (!row) throw new AppError(404, "AFFILIATE_PROFILE_NOT_FOUND", "Affiliate profile not found");
    return row;
  }
}

/** PRD §21 fields + PRD §27 "must declare applicable sources". */
function missingRequirements(row: AffiliateProfileRow, sources: readonly AffiliateTrafficSourceRow[]): string[] {
  const missing = missingSubmissionFields(row);
  if (sources.length === 0) missing.push(NO_TRAFFIC_SOURCE);
  return missing;
}

// ---- mappers (explicit allow-lists) -----------------------------------------

function toPublic(r: AffiliateProfileRow, sources: readonly AffiliateTrafficSourceRow[], viewer: ActorKind): PublicAffiliateProfile {
  return {
    id: r.id,
    organization_id: r.organization_id,
    status: r.status,
    display_name: r.display_name,
    legal_name: r.legal_name,
    website_url: r.website_url,
    app_url: r.app_url,
    promotional_methods: r.promotional_methods,
    audience_description: r.audience_description,
    monthly_traffic_estimate: r.monthly_traffic_estimate,
    address: {
      line1: r.address_line1,
      line2: r.address_line2,
      city: r.city,
      region: r.region,
      postal_code: r.postal_code,
      country_code: r.country_code,
    },
    contact: { name: r.contact_name, email: r.contact_email, phone: r.contact_phone, messaging_handle: r.messaging_handle },
    acquisition_channel: r.acquisition_channel,
    referral_code: r.referral_code,
    review_notes: r.review_notes,
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
    activated_at: r.activated_at,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    traffic_sources: sources.map(toPublicTrafficSource),
    allowed_transitions: allowedTargets(r.status, viewer),
    missing_fields: missingRequirements(r, sources),
  };
}

function toPublicListItem(r: AffiliateProfileWithOrgRow, sources: readonly AffiliateTrafficSourceRow[]): PublicAffiliateListItem {
  return {
    ...toPublic(r, sources, "PLATFORM"),
    organization: { id: r.organization_id, name: r.organization_name, slug: r.organization_slug, type: r.organization_type },
  };
}

function toPublicTrafficSource(s: AffiliateTrafficSourceRow): PublicTrafficSource {
  return {
    id: s.id,
    source_type: s.source_type,
    description: s.description,
    url: s.url,
    estimated_monthly_volume: s.estimated_monthly_volume,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function toPublicTransition(t: AffiliateTransitionRow): PublicTransition {
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
