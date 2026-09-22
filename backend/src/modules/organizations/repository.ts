/**
 * Organizations persistence over D1 (tables from migrations 0001 + 0003;
 * ADR-002). Pure data access — no policy decisions here.
 *
 * Tenant-safety rule: every read of an organization or its members that is
 * performed on behalf of a caller goes through a query that JOINs the
 * caller's own ACTIVE membership (`…ForMember(userId, …)`). A row the caller
 * is not a member of is indistinguishable from a non-existent one.
 */
import { nowIso } from "../../lib/time";

export type OrganizationType = "PLATFORM" | "ADVERTISER" | "AFFILIATE" | "PARTNER" | "AGENCY";
export type OrganizationStatus = "ACTIVE" | "RESTRICTED" | "SUSPENDED" | "TERMINATED";
export type MembershipStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "REMOVED";

export interface OrganizationRow {
  id: string;
  type: OrganizationType;
  name: string;
  slug: string;
  status: OrganizationStatus;
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  is_owner: number;
}

/** Organization joined with the caller's own membership. */
export interface OrganizationWithMembershipRow extends OrganizationRow {
  membership_id: string;
  role_id: string;
  role_key: string;
  role_is_owner: number;
  joined_at: string | null;
}

/** A member row joined with user + role display fields (no credentials). */
export interface MemberRow {
  id: string;
  organization_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role_id: string;
  role_key: string;
  role_is_owner: number;
  status: MembershipStatus;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
}

const ORG_COLUMNS = "o.id, o.type, o.name, o.slug, o.status, o.created_at, o.updated_at";
const MEMBER_SELECT = `
  SELECT m.id, m.organization_id, m.user_id, u.email, u.display_name,
         m.role_id, r.key AS role_key, r.is_owner AS role_is_owner,
         m.status, m.joined_at, m.created_at, m.updated_at
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    JOIN roles r ON r.id = m.role_id`;

export class OrganizationRepository {
  constructor(private readonly db: D1Database) {}

  // ---- roles ---------------------------------------------------------------

  /** The single owner role permitted for an organization type (ADR-002 §2). */
  findOwnerRoleForType(type: OrganizationType): Promise<RoleRow | null> {
    return this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.is_owner
           FROM roles r JOIN role_org_types t ON t.role_id = r.id
          WHERE r.organization_id IS NULL AND r.is_system = 1 AND r.is_owner = 1 AND t.org_type = ?`,
      )
      .bind(type)
      .first<RoleRow>();
  }

  /** A system role by key, only if it may be granted in organizations of `type`. */
  findSystemRoleForType(key: string, type: OrganizationType): Promise<RoleRow | null> {
    return this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.is_owner
           FROM roles r JOIN role_org_types t ON t.role_id = r.id
          WHERE r.organization_id IS NULL AND r.is_system = 1 AND r.key = ? AND t.org_type = ?`,
      )
      .bind(key, type)
      .first<RoleRow>();
  }

  /** Roles assignable within organizations of `type` (for UI pickers / validation). */
  async listSystemRolesForType(type: OrganizationType): Promise<RoleRow[]> {
    const res = await this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.is_owner
           FROM roles r JOIN role_org_types t ON t.role_id = r.id
          WHERE r.organization_id IS NULL AND r.is_system = 1 AND t.org_type = ?
          ORDER BY r.is_owner DESC, r.key`,
      )
      .bind(type)
      .all<RoleRow>();
    return res.results;
  }

  /**
   * Permission keys granted to a role (Unit 4 RBAC). Read per request so a
   * grant change via migration takes effect immediately; no caching of
   * authority decisions.
   */
  async listPermissionKeysForRole(roleId: string): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT p.key
           FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ?
          ORDER BY p.key`,
      )
      .bind(roleId)
      .all<{ key: string }>();
    return res.results.map((r) => r.key);
  }

  // ---- organizations -------------------------------------------------------

  slugExists(slug: string): Promise<boolean> {
    return this.db
      .prepare("SELECT 1 AS x FROM organizations WHERE slug = ?")
      .bind(slug)
      .first<{ x: number }>()
      .then((r) => r !== null);
  }

  /**
   * Create the organization and seat the creator as an ACTIVE owner-role
   * member in one transaction, together with the audit rows supplied.
   */
  async createWithOwner(
    input: { type: OrganizationType; name: string; slug: string; creator_user_id: string; owner_role_id: string },
    audit: D1PreparedStatement[],
    ids: { organizationId: string; membershipId: string },
  ): Promise<{ organization_id: string; membership_id: string }> {
    const { organizationId, membershipId } = ids;
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare("INSERT INTO organizations (id, type, name, slug) VALUES (?, ?, ?, ?)")
        .bind(organizationId, input.type, input.name, input.slug),
      this.db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role_id, status, joined_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .bind(membershipId, organizationId, input.creator_user_id, input.owner_role_id, now),
      ...audit,
    ]);
    return { organization_id: organizationId, membership_id: membershipId };
  }

  /** Organizations the user is an ACTIVE member of, with their role. */
  async listForMember(userId: string): Promise<OrganizationWithMembershipRow[]> {
    const res = await this.db
      .prepare(
        `SELECT ${ORG_COLUMNS}, m.id AS membership_id, m.role_id, r.key AS role_key,
                r.is_owner AS role_is_owner, m.joined_at
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = ? AND m.status = 'ACTIVE' AND o.deleted_at IS NULL
          ORDER BY o.created_at ASC`,
      )
      .bind(userId)
      .all<OrganizationWithMembershipRow>();
    return res.results;
  }

  /** One organization, only if `userId` is an ACTIVE member; otherwise null. */
  findForMember(userId: string, organizationId: string): Promise<OrganizationWithMembershipRow | null> {
    return this.db
      .prepare(
        `SELECT ${ORG_COLUMNS}, m.id AS membership_id, m.role_id, r.key AS role_key,
                r.is_owner AS role_is_owner, m.joined_at
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'ACTIVE' AND o.deleted_at IS NULL`,
      )
      .bind(userId, organizationId)
      .first<OrganizationWithMembershipRow>();
  }

  async updateName(organizationId: string, name: string, audit: D1PreparedStatement[]): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(name, nowIso(), organizationId),
      ...audit,
    ]);
  }

  // ---- members -------------------------------------------------------------

  async listMembers(organizationId: string): Promise<MemberRow[]> {
    const res = await this.db
      .prepare(
        `${MEMBER_SELECT}
          WHERE m.organization_id = ? AND m.status <> 'REMOVED'
          ORDER BY r.is_owner DESC, m.created_at ASC`,
      )
      .bind(organizationId)
      .all<MemberRow>();
    return res.results;
  }

  /** Any membership row (including REMOVED) for this org + user, or null. */
  findMembership(organizationId: string, userId: string): Promise<MemberRow | null> {
    return this.db
      .prepare(`${MEMBER_SELECT} WHERE m.organization_id = ? AND m.user_id = ?`)
      .bind(organizationId, userId)
      .first<MemberRow>();
  }

  /** A non-removed membership by its own id, scoped to the organization. */
  findMemberById(organizationId: string, membershipId: string): Promise<MemberRow | null> {
    return this.db
      .prepare(`${MEMBER_SELECT} WHERE m.organization_id = ? AND m.id = ? AND m.status <> 'REMOVED'`)
      .bind(organizationId, membershipId)
      .first<MemberRow>();
  }

  findUserIdByEmail(email: string): Promise<{ id: string; status: string } | null> {
    return this.db
      .prepare("SELECT id, status FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL")
      .bind(email)
      .first<{ id: string; status: string }>();
  }

  async insertMember(
    input: { id: string; organization_id: string; user_id: string; role_id: string; invited_by_user_id: string },
    audit: D1PreparedStatement[],
  ): Promise<string> {
    const { id } = input;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role_id, status, invited_by_user_id, joined_at)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(id, input.organization_id, input.user_id, input.role_id, input.invited_by_user_id, nowIso()),
      ...audit,
    ]);
    return id;
  }

  /** Re-activate a previously REMOVED membership with a new role (ADR-002 §3). */
  async reactivateMember(
    input: { membership_id: string; role_id: string; invited_by_user_id: string },
    audit: D1PreparedStatement[],
  ): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE organization_members
              SET role_id = ?, status = 'ACTIVE', invited_by_user_id = ?, joined_at = ?, removed_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'REMOVED'`,
        )
        .bind(input.role_id, input.invited_by_user_id, now, now, input.membership_id),
      ...audit,
    ]);
  }

  async updateMemberRole(membershipId: string, roleId: string, audit: D1PreparedStatement[]): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE organization_members SET role_id = ?, updated_at = ? WHERE id = ? AND status <> 'REMOVED'")
        .bind(roleId, nowIso(), membershipId),
      ...audit,
    ]);
  }

  async removeMember(membershipId: string, audit: D1PreparedStatement[]): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE organization_members SET status = 'REMOVED', removed_at = ?, updated_at = ? WHERE id = ? AND status <> 'REMOVED'",
        )
        .bind(now, now, membershipId),
      ...audit,
    ]);
  }

  /** Number of ACTIVE members holding an owner role. */
  countActiveOwners(organizationId: string): Promise<number> {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM organization_members m JOIN roles r ON r.id = m.role_id
          WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND r.is_owner = 1`,
      )
      .bind(organizationId)
      .first<{ n: number }>()
      .then((r) => r?.n ?? 0);
  }
}
