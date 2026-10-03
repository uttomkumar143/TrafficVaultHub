/**
 * Who is acting, on which tenant, through which face (PRD §81 7a, §116).
 *
 *   * TENANT face  — `/:orgId/support|disputes|appeals`: the target tenant IS
 *     the resolved `TenantContext`; permission keys come from the member's role.
 *   * PLATFORM face — `/:orgId/platform/.../tenants/:tenantOrgId/...`: the
 *     resolved context must be a PLATFORM organization (else 403) and the
 *     target tenant comes from the path. Restricted platform roles (every role
 *     except SUPER_ADMIN / OPERATIONS_ADMIN) only see tenants granted to them
 *     in `support_agent_tenant_access`; a missing grant, an unknown tenant and
 *     a malformed id are all answered 404 (no enumeration oracle).
 *
 * `tenantId` is derived from the resolved context or the validated path param
 * — never from a body (PRD §116).
 */
import { AppError } from "../../lib/errors";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { PermissionKey } from "../rbac/permissions";
import type { AuthenticatedContext } from "../auth/service";
import type { SupportRepository } from "./repository";

export type Face = "TENANT" | "PLATFORM";

/** Platform roles that act on every tenant without a `support_agent_tenant_access` grant. */
export const UNRESTRICTED_PLATFORM_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "OPERATIONS_ADMIN"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Actor {
  auth: AuthenticatedContext;
  /** Resolved `/:orgId` context (tenant org on the tenant face, PLATFORM org on the platform face). */
  ctx: TenantContext;
  /** Target tenant whose records are read or written. */
  tenantId: TenantId;
  face: Face;
}

export function notFound(what = "Record"): AppError {
  return new AppError(404, "NOT_FOUND", `${what} not found`);
}

export function forbidden(message: string): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

/** Malformed ids are answered like missing records (404), never 400. */
export function assertRecordId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw notFound(what);
  return id;
}

export function tenantActor(auth: AuthenticatedContext, tenant: TenantContext): Actor {
  return { auth, ctx: tenant, tenantId: tenantIdOf(tenant), face: "TENANT" };
}

/** Builds a platform-face actor; the context must be a PLATFORM org and the target id well-formed. */
export function platformActor(auth: AuthenticatedContext, platform: TenantContext, tenantOrgId: string): Actor {
  if (platform.organization.type !== "PLATFORM") throw forbidden("platform organization required");
  if (!UUID_RE.test(tenantOrgId)) throw notFound("Organization");
  return { auth, ctx: platform, tenantId: tenantOrgId as TenantId, face: "PLATFORM" };
}

export function isUnrestrictedPlatformRole(ctx: TenantContext): boolean {
  return ctx.role.is_owner || UNRESTRICTED_PLATFORM_ROLES.has(ctx.role.key);
}

export class SupportAccess {
  constructor(
    private readonly repo: SupportRepository,
    private readonly clock: () => Date,
  ) {}

  /**
   * Permission gate (403) plus, on the platform face, the tenant-restriction
   * gate (404). Call at the top of every service method.
   */
  async ensure(actor: Actor, key: PermissionKey): Promise<void> {
    if (!hasPermission(actor.ctx, key)) throw forbidden(`Missing permission: ${key}`);
    if (actor.face === "TENANT") return;
    if (actor.ctx.organization.type !== "PLATFORM") throw forbidden("platform organization required");
    const target = await this.repo.findOrganizationType(actor.tenantId);
    if (!target || target.type === "PLATFORM") throw notFound("Organization");
    if (isUnrestrictedPlatformRole(actor.ctx)) return;
    const ok = await this.repo.agentHasAccess(actor.auth.user.id, actor.tenantId, this.clock().toISOString());
    if (!ok) throw notFound("Organization");
  }

  /** Grant administration: PLATFORM org, `support.manage`, and an unrestricted role (agents cannot self-grant). */
  ensureGrantAdmin(actor: Actor): void {
    if (actor.face !== "PLATFORM" || actor.ctx.organization.type !== "PLATFORM") throw forbidden("platform organization required");
    if (!hasPermission(actor.ctx, "support.manage")) throw forbidden("Missing permission: support.manage");
    if (!isUnrestrictedPlatformRole(actor.ctx)) throw forbidden("Agent access is administered by platform administrators");
  }
}
