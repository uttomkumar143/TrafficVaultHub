/**
 * Organizations & membership (Phase 1 Unit 3; PRD §7–§9, §94, §124;
 * ADR-002). Policy lives here; SQL lives in the repository.
 *
 * Authority rules (all server-side, PRD §5, §94):
 *   * The organization a request acts on is ALWAYS resolved through the
 *     caller's own ACTIVE membership. An id the caller is not a member of —
 *     or that does not exist — is `404 ORGANIZATION_NOT_FOUND`. Never 403,
 *     so tenant ids cannot be enumerated.
 *   * Management operations (update org, add/change/remove members) require
 *     the caller to hold the owner role of that organization (Unit 4 refines
 *     this into permission keys on the same data).
 *   * Clients never supply `user_id`, `organization_id` for themselves, or
 *     `role_id`. Members are addressed by email; roles by PRD §9 key and
 *     validated against `role_org_types`.
 *
 * Error codes (uniform envelope, PRD §72):
 *   ORGANIZATION_NOT_FOUND 404 · MEMBER_NOT_FOUND 404 · USER_NOT_FOUND 404 ·
 *   SLUG_ALREADY_EXISTS 409 · ALREADY_MEMBER 409 · FORBIDDEN 403 ·
 *   ROLE_NOT_ALLOWED_FOR_ORG_TYPE 400 · LAST_OWNER 409 · SELF_MODIFICATION 400
 */
import { AppError } from "../../lib/errors";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type {
  MemberRow,
  OrganizationRepository,
  OrganizationType,
  OrganizationWithMembershipRow,
  RoleRow,
} from "./repository";

/** Types a signed-in user may create for themselves (ADR-002 §2). */
export const SELF_SERVICE_ORG_TYPES = ["ADVERTISER", "AFFILIATE", "PARTNER", "AGENCY"] as const;
export type SelfServiceOrgType = (typeof SELF_SERVICE_ORG_TYPES)[number];

export interface PublicRole {
  key: string;
  name: string;
  is_owner: boolean;
}

export interface PublicOrganization {
  id: string;
  type: OrganizationType;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** The caller's own membership in this organization. */
  membership: { id: string; role: PublicRole; joined_at: string | null };
}

export interface PublicMember {
  id: string;
  user: { id: string; email: string; display_name: string | null };
  role: PublicRole;
  status: string;
  joined_at: string | null;
  created_at: string;
}

export class OrganizationService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: OrganizationRepository,
    db: D1Database,
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- organizations -------------------------------------------------------

  async create(
    ctx: AuthenticatedContext,
    input: { type: SelfServiceOrgType; name: string; slug?: string },
    meta: RequestMeta,
  ): Promise<PublicOrganization> {
    const ownerRole = await this.repo.findOwnerRoleForType(input.type);
    if (!ownerRole) {
      // Catalogue invariant from migration 0003 violated — configuration error, not client error.
      throw new AppError(500, "INTERNAL_ERROR", "Owner role is not configured for this organization type");
    }

    const name = input.name.trim();
    const slug = input.slug ? normalizeSlug(input.slug) : normalizeSlug(name);
    if (!slug) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request: slug");
    }
    if (await this.repo.slugExists(slug)) {
      throw new AppError(409, "SLUG_ALREADY_EXISTS", "An organization with this slug already exists");
    }

    // Ids are allocated here so the audit rows (batched after the inserts in
    // the same transaction) can reference the new organization/membership.
    const organizationId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await this.repo.createWithOwner(
      { type: input.type, name, slug, creator_user_id: ctx.user.id, owner_role_id: ownerRole.id },
      [
        this.audit.statement({
          organization_id: organizationId,
          actor_user_id: ctx.user.id,
          action: "organization.created",
          target_type: "organization",
          target_id: organizationId,
          metadata: { type: input.type, name, slug },
          meta,
        }),
        this.audit.statement({
          organization_id: organizationId,
          actor_user_id: ctx.user.id,
          action: "member.added",
          target_type: "organization_member",
          target_id: membershipId,
          metadata: { user_id: ctx.user.id, role: ownerRole.key, reactivated: false, creator: true },
          meta,
        }),
      ],
      { organizationId, membershipId },
    );

    const org = await this.repo.findForMember(ctx.user.id, organizationId);
    if (!org) throw new Error("organization vanished after insert");
    return toPublicOrganization(org);
  }

  async listMine(ctx: AuthenticatedContext): Promise<PublicOrganization[]> {
    const rows = await this.repo.listForMember(ctx.user.id);
    return rows.map(toPublicOrganization);
  }

  async get(ctx: AuthenticatedContext, organizationId: string): Promise<PublicOrganization> {
    return toPublicOrganization(await this.requireMembership(ctx, organizationId));
  }

  async update(
    ctx: AuthenticatedContext,
    organizationId: string,
    input: { name: string },
    meta: RequestMeta,
  ): Promise<PublicOrganization> {
    const org = await this.requireOwner(ctx, organizationId);
    const name = input.name.trim();
    await this.repo.updateName(org.id, name, [
      this.audit.statement({
        organization_id: org.id,
        actor_user_id: ctx.user.id,
        action: "organization.updated",
        target_type: "organization",
        target_id: org.id,
        metadata: { before: { name: org.name }, after: { name } },
        meta,
      }),
    ]);
    const fresh = await this.repo.findForMember(ctx.user.id, org.id);
    if (!fresh) throw new Error("organization vanished after update");
    return toPublicOrganization(fresh);
  }

  /** Roles a manager may assign inside this organization (type-filtered). */
  async listAssignableRoles(ctx: AuthenticatedContext, organizationId: string): Promise<PublicRole[]> {
    const org = await this.requireMembership(ctx, organizationId);
    return (await this.repo.listSystemRolesForType(org.type)).map(toPublicRole);
  }

  // ---- members -------------------------------------------------------------

  async listMembers(ctx: AuthenticatedContext, organizationId: string): Promise<PublicMember[]> {
    const org = await this.requireMembership(ctx, organizationId);
    return (await this.repo.listMembers(org.id)).map(toPublicMember);
  }

  /**
   * Add an existing registered user (by email) with a role key. A previously
   * removed member is re-activated on the same row.
   */
  async addMember(
    ctx: AuthenticatedContext,
    organizationId: string,
    input: { email: string; role: string },
    meta: RequestMeta,
  ): Promise<PublicMember> {
    const org = await this.requireOwner(ctx, organizationId);
    const role = await this.requireAssignableRole(input.role, org.type);

    const user = await this.repo.findUserIdByEmail(input.email.trim().toLowerCase());
    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "No registered user with this email");
    }

    const existing = await this.repo.findMembership(org.id, user.id);
    if (existing && existing.status !== "REMOVED") {
      throw new AppError(409, "ALREADY_MEMBER", "User is already a member of this organization");
    }

    let membershipId: string;
    const auditRow = (membership_id: string) =>
      this.audit.statement({
        organization_id: org.id,
        actor_user_id: ctx.user.id,
        action: "member.added",
        target_type: "organization_member",
        target_id: membership_id,
        metadata: { user_id: user.id, role: role.key, reactivated: existing !== null },
        meta,
      });

    if (existing) {
      membershipId = existing.id;
      await this.repo.reactivateMember(
        { membership_id: existing.id, role_id: role.id, invited_by_user_id: ctx.user.id },
        [auditRow(existing.id)],
      );
    } else {
      membershipId = crypto.randomUUID();
      await this.repo.insertMember(
        { id: membershipId, organization_id: org.id, user_id: user.id, role_id: role.id, invited_by_user_id: ctx.user.id },
        [auditRow(membershipId)],
      );
    }

    const member = await this.repo.findMemberById(org.id, membershipId);
    if (!member) throw new Error("membership vanished after write");
    return toPublicMember(member);
  }

  async changeMemberRole(
    ctx: AuthenticatedContext,
    organizationId: string,
    membershipId: string,
    input: { role: string },
    meta: RequestMeta,
  ): Promise<PublicMember> {
    const org = await this.requireOwner(ctx, organizationId);
    const member = await this.requireMember(org.id, membershipId);
    const role = await this.requireAssignableRole(input.role, org.type);

    if (member.role_id !== role.id) {
      // Demoting the last owner would orphan the tenant (ADR-002 §2).
      if (member.role_is_owner === 1 && role.is_owner === 0) {
        await this.assertNotLastOwner(org.id);
      }
      await this.repo.updateMemberRole(member.id, role.id, [
        this.audit.statement({
          organization_id: org.id,
          actor_user_id: ctx.user.id,
          action: "member.role_changed",
          target_type: "organization_member",
          target_id: member.id,
          metadata: { user_id: member.user_id, before: { role: member.role_key }, after: { role: role.key } },
          meta,
        }),
      ]);
    }

    const fresh = await this.repo.findMemberById(org.id, member.id);
    if (!fresh) throw new Error("membership vanished after update");
    return toPublicMember(fresh);
  }

  async removeMember(
    ctx: AuthenticatedContext,
    organizationId: string,
    membershipId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const org = await this.requireOwner(ctx, organizationId);
    const member = await this.requireMember(org.id, membershipId);

    if (member.user_id === ctx.user.id) {
      // Leaving is a separate, deliberate flow (not in Unit 3); prevents an
      // owner from accidentally locking themselves out.
      throw new AppError(400, "SELF_MODIFICATION", "You cannot remove your own membership");
    }
    if (member.role_is_owner === 1) {
      await this.assertNotLastOwner(org.id);
    }

    await this.repo.removeMember(member.id, [
      this.audit.statement({
        organization_id: org.id,
        actor_user_id: ctx.user.id,
        action: "member.removed",
        target_type: "organization_member",
        target_id: member.id,
        metadata: { user_id: member.user_id, role: member.role_key },
        meta,
      }),
    ]);
  }

  // ---- guards --------------------------------------------------------------

  /** Caller must be an ACTIVE member; otherwise 404 (no enumeration). */
  private async requireMembership(
    ctx: AuthenticatedContext,
    organizationId: string,
  ): Promise<OrganizationWithMembershipRow> {
    const org = await this.repo.findForMember(ctx.user.id, organizationId);
    if (!org) {
      throw new AppError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
    }
    return org;
  }

  /** Caller must be an ACTIVE member holding the owner role; otherwise 403. */
  private async requireOwner(
    ctx: AuthenticatedContext,
    organizationId: string,
  ): Promise<OrganizationWithMembershipRow> {
    const org = await this.requireMembership(ctx, organizationId);
    if (org.role_is_owner !== 1) {
      throw new AppError(403, "FORBIDDEN", "Only an organization owner may perform this action");
    }
    return org;
  }

  private async requireMember(organizationId: string, membershipId: string): Promise<MemberRow> {
    const member = await this.repo.findMemberById(organizationId, membershipId);
    if (!member) {
      throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
    }
    return member;
  }

  private async requireAssignableRole(key: string, type: OrganizationType): Promise<RoleRow> {
    const role = await this.repo.findSystemRoleForType(key, type);
    if (!role) {
      throw new AppError(
        400,
        "ROLE_NOT_ALLOWED_FOR_ORG_TYPE",
        `Role is not assignable in a ${type} organization`,
      );
    }
    return role;
  }

  private async assertNotLastOwner(organizationId: string): Promise<void> {
    if ((await this.repo.countActiveOwners(organizationId)) <= 1) {
      throw new AppError(409, "LAST_OWNER", "An organization must keep at least one owner");
    }
  }
}

// ---- mappers (explicit allow-lists; no internal ids of roles leak) ----------

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function toPublicRole(r: { key: string; name: string; is_owner: number }): PublicRole {
  return { key: r.key, name: r.name, is_owner: r.is_owner === 1 };
}

function toPublicOrganization(o: OrganizationWithMembershipRow): PublicOrganization {
  return {
    id: o.id,
    type: o.type,
    name: o.name,
    slug: o.slug,
    status: o.status,
    created_at: o.created_at,
    updated_at: o.updated_at,
    membership: {
      id: o.membership_id,
      role: { key: o.role_key, name: roleDisplayName(o.role_key), is_owner: o.role_is_owner === 1 },
      joined_at: o.joined_at,
    },
  };
}

function toPublicMember(m: MemberRow): PublicMember {
  return {
    id: m.id,
    user: { id: m.user_id, email: m.email, display_name: m.display_name },
    role: { key: m.role_key, name: roleDisplayName(m.role_key), is_owner: m.role_is_owner === 1 },
    status: m.status,
    joined_at: m.joined_at,
    created_at: m.created_at,
  };
}

/** Human label derived from the key (avoids an extra join per row). */
function roleDisplayName(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
