/**
 * RBAC + tenant-scope middleware (Phase 1 Unit 4; PRD §5, §7, §10, §94, §116).
 *
 * Resolution chain, performed server-side on EVERY request to a tenant-scoped
 * route (after `requireAuth`):
 *
 *   authenticated user
 *     → ACTIVE membership in the organization named by the `:orgId` route param
 *     → the membership's role
 *     → the role's permission keys (`role_permissions`, migration 0004)
 *
 * The result is stored on the context as `tenant` (`TenantContext`).
 *
 * Rules:
 *   * The organization is taken ONLY from the route path. `organization_id`
 *     in a body, query string or header is never consulted (PRD §94).
 *   * Not an ACTIVE member — or the org does not exist / is soft-deleted — →
 *     404 ORGANIZATION_NOT_FOUND. Never 403, so tenant ids cannot be
 *     enumerated (PRD §99 IDOR). Malformed ids get the same 404.
 *   * `requirePermission(key)` → 403 FORBIDDEN when the resolved role lacks
 *     the key. Role escalation (a VIEWER calling a management endpoint) is
 *     rejected here, before any service code runs.
 *   * Authority is read from D1 on each request — never cached, never trusted
 *     from the client.
 *
 * Usage:
 *   routes.use("/:orgId/*", requireOrg);           // or requireOrg on a route
 *   routes.patch("/:orgId", requireOrg, requirePermission("organizations.update"), handler);
 *   const { organization, membership, role, permissions } = c.get("tenant");
 */
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import type { OrganizationType } from "../modules/organizations/repository";
import type { PermissionKey } from "../modules/rbac/permissions";

export interface TenantContext {
  organization: {
    id: string;
    type: OrganizationType;
    name: string;
    slug: string;
    status: string;
  };
  membership: { id: string; joined_at: string | null };
  role: { id: string; key: string; is_owner: boolean };
  /** Permission keys granted to `role`, as stored in D1. */
  permissions: ReadonlySet<string>;
}

/** Route param carrying the tenant id. Kept configurable for nested mounts. */
export const ORG_PARAM = "orgId";

const idSchema = z.string().uuid();

function notFound(): AppError {
  return new AppError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
}

/**
 * Resolve the caller's tenant context for `:orgId`. Requires `requireAuth`
 * to have run first (it throws 401 otherwise, never falls through).
 */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) {
    // Defensive: a route wired without requireAuth must still fail closed.
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const parsed = idSchema.safeParse(c.req.param(ORG_PARAM));
  if (!parsed.success) throw notFound();

  const tenant = await c.get("organizationService").resolveTenant(auth, parsed.data);
  if (!tenant) throw notFound();

  c.set("tenant", tenant);
  await next();
};

/**
 * Guard factory: the resolved role must hold `key`. Must be placed after
 * `requireOrg` in the chain; if the tenant is missing it fails closed.
 */
export function requirePermission(key: PermissionKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenant = c.get("tenant");
    if (!tenant) {
      throw new AppError(500, "INTERNAL_ERROR", "Tenant context was not resolved before permission check");
    }
    if (!tenant.permissions.has(key)) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to perform this action");
    }
    await next();
  };
}

/** Non-middleware helper for service-level checks on an already-resolved tenant. */
export function hasPermission(tenant: TenantContext, key: PermissionKey): boolean {
  return tenant.permissions.has(key);
}
