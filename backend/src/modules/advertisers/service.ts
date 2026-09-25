/**
 * Advertiser module — policy layer (Phase 2 Unit 1; PRD §16, §17, §92, §94,
 * §124, §132). SQL lives in `repository.ts`; the lifecycle graph lives in
 * `state-machine.ts`. This class decides WHO may do WHAT and records every
 * accepted lifecycle transition twice: typed
 * (`advertiser_status_transitions`) and generic (`audit_logs`), in the same
 * D1 batch as the status change.
 *
 * Tenant side (`advertisers.read` / `advertisers.manage`, ADVERTISER/AGENCY orgs):
 *   get · create · update · submit · history
 * Platform side (`advertisers.review`, PLATFORM org only):
 *   list · getAny · transition · historyAny
 *
 * Authority rules:
 *   * The tenant is always the resolved `TenantContext` from the path — never
 *     a body value. Only ADVERTISER and AGENCY organizations may own a profile.
 *   * The tenant may only submit (EMAIL_VERIFIED|MORE_INFORMATION_REQUIRED →
 *     BUSINESS_REVIEW); submission requires the PRD §17 fields and a verified
 *     email for the acting user. Nothing the tenant does can approve itself.
 *   * Platform reviewers drive every other edge; restrictive targets require a
 *     reason (PRD §124). Reviewers must act from a PLATFORM organization —
 *     holding the key inside a tenant org (impossible by grants, but checked)
 *     is not enough.
 *   * REGISTERED → EMAIL_VERIFIED is a SYSTEM transition applied automatically
 *     when the profile is created or read by a user whose email is verified
 *     (signup already requires verification before login, so in practice a
 *     profile starts at EMAIL_VERIFIED; the REGISTERED edge is kept for
 *     imported/legacy rows).
 *
 * Error codes: ADVERTISER_PROFILE_NOT_FOUND 404 · ADVERTISER_PROFILE_EXISTS 409 ·
 *   ORG_TYPE_NOT_ADVERTISER 400 · INVALID_TRANSITION 409 · REASON_REQUIRED 400 ·
 *   PROFILE_INCOMPLETE 400 · FORBIDDEN 403 · VALIDATION_ERROR 400
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type {
  AdvertiserProfileField,
  AdvertiserProfileInput,
  AdvertiserProfileRow,
  AdvertiserProfileWithOrgRow,
  AdvertiserRepository,
  AdvertiserTransitionRow,
} from "./repository";
import {
  allowedTargets,
  canTransition,
  isAdvertiserStatus,
  missingSubmissionFields,
  requiresReason,
  SUBMITTABLE_STATUSES,
  type ActorKind,
  type AdvertiserStatus,
} from "./state-machine";

/** Organization types that may own an advertiser profile (PRD §8). */
export const ADVERTISER_ORG_TYPES = ["ADVERTISER", "AGENCY"] as const;

export interface PublicAdvertiserProfile {
  id: string;
  organization_id: string;
  status: AdvertiserStatus;
  company_name: string;
  website_url: string | null;
  business_category: string | null;
  legal_name: string | null;
  registration_number: string | null;
  tax_id: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country_code: string | null;
  };
  contact: { name: string | null; email: string | null; phone: string | null };
  billing_contact_email: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Lifecycle targets the CALLER may move this profile to (UI hint only). */
  allowed_transitions: AdvertiserStatus[];
  /** PRD §17 fields still missing before submission (tenant view). */
  missing_fields: string[];
}

export interface PublicAdvertiserListItem extends PublicAdvertiserProfile {
  organization: { id: string; name: string; slug: string; type: string };
}

export interface PublicTransition {
  id: string;
  from_status: AdvertiserStatus | null;
  to_status: AdvertiserStatus;
  actor_kind: ActorKind;
  actor_user_id: string | null;
  reason: string | null;
  created_at: string;
}

export class AdvertiserService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: AdvertiserRepository,
    db: D1Database,
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- tenant side ---------------------------------------------------------

  /** `advertisers.read`. 404 when the org has no profile yet. */
  async get(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Promise<PublicAdvertiserProfile> {
    this.assertAdvertiserOrg(tenant);
    let row = await this.requireTenantProfile(tenant);
    row = await this.autoVerify(ctx, row, meta);
    return toPublic(row, "TENANT");
  }

  /** `advertisers.manage`. One profile per organization. */
  async create(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: AdvertiserProfileInput,
    meta: RequestMeta,
  ): Promise<PublicAdvertiserProfile> {
    this.assertAdvertiserOrg(tenant);
    const tid = tenantIdOf(tenant);
    if (await this.repo.findByTenant(tid)) {
      throw new AppError(409, "ADVERTISER_PROFILE_EXISTS", "This organization already has an advertiser profile");
    }
    const id = crypto.randomUUID();
    // Login already requires a verified email, so a self-created profile
    // starts at EMAIL_VERIFIED (SYSTEM fact), otherwise REGISTERED.
    const status: AdvertiserStatus = ctx.user.email_verified ? "EMAIL_VERIFIED" : "REGISTERED";
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
        action: "advertiser.created",
        target_type: "advertiser_profile",
        target_id: id,
        metadata: { status, company_name: input.company_name },
        meta,
      }),
    ]);
    const row = await this.repo.findByTenant(tid);
    if (!row) throw new Error("advertiser profile vanished after insert");
    return toPublic(row, "TENANT");
  }

  /** `advertisers.manage`. Partial update of onboarding fields; status untouched. */
  async update(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    patch: Partial<Record<AdvertiserProfileField, string | null>>,
    meta: RequestMeta,
  ): Promise<PublicAdvertiserProfile> {
    this.assertAdvertiserOrg(tenant);
    const tid = tenantIdOf(tenant);
    const before = await this.requireTenantProfile(tenant);
    if (before.status === "TERMINATED") {
      throw new AppError(409, "INVALID_TRANSITION", "A terminated advertiser profile cannot be edited");
    }
    const changed = Object.keys(patch).filter((k) => patch[k as AdvertiserProfileField] !== undefined);
    if (changed.length > 0) {
      await this.repo.updateFields(tid, patch, [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "advertiser.updated",
          target_type: "advertiser_profile",
          target_id: before.id,
          metadata: { fields: changed },
          meta,
        }),
      ]);
    }
    const row = await this.repo.findByTenant(tid);
    if (!row) throw new Error("advertiser profile vanished after update");
    return toPublic(row, "TENANT");
  }

  /** `advertisers.manage`. EMAIL_VERIFIED|MORE_INFORMATION_REQUIRED → BUSINESS_REVIEW. */
  async submit(ctx: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Promise<PublicAdvertiserProfile> {
    this.assertAdvertiserOrg(tenant);
    let row = await this.requireTenantProfile(tenant);
    row = await this.autoVerify(ctx, row, meta);
    if (!SUBMITTABLE_STATUSES.includes(row.status) || !canTransition(row.status, "BUSINESS_REVIEW", "TENANT")) {
      throw new AppError(409, "INVALID_TRANSITION", `Profile cannot be submitted from status ${row.status}`);
    }
    const missing = missingSubmissionFields(row);
    if (missing.length > 0) {
      throw new AppError(400, "PROFILE_INCOMPLETE", `Missing required fields: ${missing.join(", ")}`);
    }
    await this.applyAudited(ctx.user.id, row, "BUSINESS_REVIEW", "TENANT", null, undefined, meta);
    return toPublic(await this.requireTenantProfile(tenant), "TENANT");
  }

  /** `advertisers.read`. Own lifecycle history. */
  async history(tenant: TenantContext): Promise<PublicTransition[]> {
    this.assertAdvertiserOrg(tenant);
    await this.requireTenantProfile(tenant);
    return (await this.repo.listTransitionsByTenant(tenantIdOf(tenant))).map(toPublicTransition);
  }

  // ---- platform side (advertisers.review) ---------------------------------

  async list(tenant: TenantContext, page: PageRequest, statusFilter?: string): Promise<Page<PublicAdvertiserListItem>> {
    this.assertPlatform(tenant);
    let status: AdvertiserStatus | undefined;
    if (statusFilter !== undefined && statusFilter !== "") {
      if (!isAdvertiserStatus(statusFilter)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      status = statusFilter;
    }
    const result = await this.repo.listAll(page, { status });
    return { items: result.items.map(toPublicListItem), next_cursor: result.next_cursor };
  }

  async getAny(tenant: TenantContext, profileId: string): Promise<PublicAdvertiserListItem> {
    this.assertPlatform(tenant);
    return toPublicListItem(await this.requireAnyProfile(profileId));
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
  ): Promise<PublicAdvertiserListItem> {
    this.assertPlatform(tenant);
    const row = await this.requireAnyProfile(profileId);
    if (!isAdvertiserStatus(input.to)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: to");
    if (!canTransition(row.status, input.to, "PLATFORM")) {
      throw new AppError(409, "INVALID_TRANSITION", `Cannot move advertiser from ${row.status} to ${input.to}`);
    }
    const reason = input.reason?.trim() || null;
    if (requiresReason(input.to) && !reason) {
      throw new AppError(400, "REASON_REQUIRED", `A reason is required when moving an advertiser to ${input.to}`);
    }
    await this.applyAudited(ctx.user.id, row, input.to, "PLATFORM", reason, input.review_notes, meta);
    return toPublicListItem(await this.requireAnyProfile(profileId));
  }

  // ---- internals -----------------------------------------------------------

  /** SYSTEM edge: REGISTERED → EMAIL_VERIFIED once the acting user's email is verified. */
  private async autoVerify(ctx: AuthenticatedContext, row: AdvertiserProfileRow, meta: RequestMeta): Promise<AdvertiserProfileRow> {
    if (row.status !== "REGISTERED" || !ctx.user.email_verified) return row;
    if (!canTransition("REGISTERED", "EMAIL_VERIFIED", "SYSTEM")) return row;
    await this.applyAudited(ctx.user.id, row, "EMAIL_VERIFIED", "SYSTEM", null, undefined, meta);
    return { ...row, status: "EMAIL_VERIFIED" };
  }

  private async applyAudited(
    actorUserId: string,
    row: AdvertiserProfileRow,
    to: AdvertiserStatus,
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
          action: "advertiser.status_changed",
          target_type: "advertiser_profile",
          target_id: row.id,
          metadata: { from: row.status, to, actor_kind: actor, reason },
          meta,
        }),
      ],
    );
  }

  private assertAdvertiserOrg(tenant: TenantContext): void {
    if (!(ADVERTISER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_ADVERTISER", "Only advertiser or agency organizations have an advertiser profile");
    }
  }

  /** Review routes are mounted under a PLATFORM organization only. */
  private assertPlatform(tenant: TenantContext): void {
    if (tenant.organization.type !== "PLATFORM") {
      throw new AppError(403, "FORBIDDEN", "Advertiser review is a platform operation");
    }
  }

  private async requireTenantProfile(tenant: TenantContext): Promise<AdvertiserProfileRow> {
    const row = await this.repo.findByTenant(tenantIdOf(tenant));
    if (!row) throw new AppError(404, "ADVERTISER_PROFILE_NOT_FOUND", "Advertiser profile not found");
    return row;
  }

  private async requireAnyProfile(profileId: string): Promise<AdvertiserProfileWithOrgRow> {
    const row = await this.repo.findAnyById(profileId);
    if (!row) throw new AppError(404, "ADVERTISER_PROFILE_NOT_FOUND", "Advertiser profile not found");
    return row;
  }
}

// ---- mappers (explicit allow-lists) -----------------------------------------

function toPublic(r: AdvertiserProfileRow, viewer: ActorKind): PublicAdvertiserProfile {
  return {
    id: r.id,
    organization_id: r.organization_id,
    status: r.status,
    company_name: r.company_name,
    website_url: r.website_url,
    business_category: r.business_category,
    legal_name: r.legal_name,
    registration_number: r.registration_number,
    tax_id: r.tax_id,
    address: {
      line1: r.address_line1,
      line2: r.address_line2,
      city: r.city,
      region: r.region,
      postal_code: r.postal_code,
      country_code: r.country_code,
    },
    contact: { name: r.contact_name, email: r.contact_email, phone: r.contact_phone },
    billing_contact_email: r.billing_contact_email,
    review_notes: r.review_notes,
    submitted_at: r.submitted_at,
    approved_at: r.approved_at,
    activated_at: r.activated_at,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    allowed_transitions: allowedTargets(r.status, viewer),
    missing_fields: missingSubmissionFields(r),
  };
}

function toPublicListItem(r: AdvertiserProfileWithOrgRow): PublicAdvertiserListItem {
  return {
    ...toPublic(r, "PLATFORM"),
    organization: { id: r.organization_id, name: r.organization_name, slug: r.organization_slug, type: r.organization_type },
  };
}

function toPublicTransition(t: AdvertiserTransitionRow): PublicTransition {
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
