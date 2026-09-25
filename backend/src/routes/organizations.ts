/**
 * /api/v1/organizations — organizations & membership (Phase 1 Unit 3 + Unit 4
 * RBAC; ADR-002). Every route requires authentication. Every `:orgId` route
 * additionally goes through `requireOrg` (user → ACTIVE membership → role →
 * permissions; non-member → 404 no-enumeration) and a `requirePermission`
 * guard (403 FORBIDDEN). The acting organization is ALWAYS the path param —
 * never a body/query value (PRD §94).
 *
 * POST   /                                → 201 { organization }   create (type ∈ ADVERTISER|AFFILIATE|PARTNER|AGENCY); creator seated as owner
 * GET    /                                → 200 { organizations }  organizations the caller belongs to
 * GET    /:orgId                          → 200 { organization }   organizations.read
 * GET    /:orgId/me                       → 200 { membership, role, permissions }  (any ACTIVE member)
 * PATCH  /:orgId                          → 200 { organization }   organizations.update
 * GET    /:orgId/roles                    → 200 { roles }          organizations.read
 * GET    /:orgId/members                  → 200 { members }        members.read
 * POST   /:orgId/members                  → 201 { member }         members.manage; owner role required to grant an owner seat
 * PATCH  /:orgId/members/:memberId        → 200 { member }         members.manage; owner role required to touch an owner seat; LAST_OWNER guard
 * DELETE /:orgId/members/:memberId        → 204                    members.manage; owner role required to remove an owner; LAST_OWNER + SELF_MODIFICATION guards
 *
 * Sub-modules mounted under `/:orgId` (inherit requireAuth + requireOrg):
 *   /:orgId/advertiser(/*)              → routes/advertisers.ts  advertiserRoutes        (Phase 2 Unit 1, tenant)
 *   /:orgId/platform/advertisers(/*)    → routes/advertisers.ts  advertiserReviewRoutes  (Phase 2 Unit 1, PLATFORM org)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requireAuth } from "../middleware/require-auth";
import { requireOrg, requirePermission } from "../middleware/require-org";
import { SELF_SERVICE_ORG_TYPES } from "../modules/organizations/service";
import { advertiserReviewRoutes, advertiserRoutes } from "./advertisers";

const nameSchema = z.string().trim().min(2).max(120);
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, digits and single hyphens");
/** PRD §9 role keys are UPPER_SNAKE_CASE identifiers. */
const roleKeySchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z_]{1,63}$/);
const idSchema = z.string().uuid();

const createSchema = z.object({
  type: z.enum(SELF_SERVICE_ORG_TYPES),
  name: nameSchema,
  slug: slugSchema.optional(),
});
const updateSchema = z.object({ name: nameSchema });
const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: roleKeySchema,
});
const changeRoleSchema = z.object({ role: roleKeySchema });

/** Malformed member ids can never match a row → same 404 as unknown ids (no oracle). */
function memberId(c: { req: { param(name: string): string | undefined } }): string {
  const parsed = idSchema.safeParse(c.req.param("memberId"));
  if (!parsed.success) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  return parsed.data;
}

export const organizationRoutes = new Hono<AppEnv>();

// Every route in this module is protected — no exceptions (PRD §116).
organizationRoutes.use("*", requireAuth);
// Every tenant-scoped route resolves RBAC + tenant scope before its handler.
organizationRoutes.use("/:orgId", requireOrg);
organizationRoutes.use("/:orgId/*", requireOrg);

// Phase 2 sub-modules (each route adds its own requirePermission).
organizationRoutes.route("/:orgId/advertiser", advertiserRoutes);
organizationRoutes.route("/:orgId/platform/advertisers", advertiserReviewRoutes);

organizationRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const organization = await c.get("organizationService").create(c.get("auth"), body, meta(c));
  return c.json({ organization }, 201);
});

organizationRoutes.get("/", async (c) => {
  const organizations = await c.get("organizationService").listMine(c.get("auth"));
  return c.json({ organizations }, 200);
});

organizationRoutes.get("/:orgId", requirePermission("organizations.read"), async (c) => {
  const organization = await c.get("organizationService").get(c.get("auth"), c.get("tenant"));
  return c.json({ organization }, 200);
});

/**
 * The caller's own authority inside this organization — what the frontend
 * uses to render/hide actions. Purely informational: the server re-checks
 * every permission on every request regardless of what the client saw here.
 */
organizationRoutes.get("/:orgId/me", async (c) => {
  const t = c.get("tenant");
  return c.json(
    {
      organization: { id: t.organization.id, type: t.organization.type, name: t.organization.name },
      membership: { id: t.membership.id, joined_at: t.membership.joined_at },
      role: { key: t.role.key, is_owner: t.role.is_owner },
      permissions: [...t.permissions].sort(),
    },
    200,
  );
});

organizationRoutes.patch("/:orgId", requirePermission("organizations.update"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const organization = await c.get("organizationService").update(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ organization }, 200);
});

organizationRoutes.get("/:orgId/roles", requirePermission("organizations.read"), async (c) => {
  const roles = await c.get("organizationService").listAssignableRoles(c.get("tenant"));
  return c.json({ roles }, 200);
});

organizationRoutes.get("/:orgId/members", requirePermission("members.read"), async (c) => {
  const members = await c.get("organizationService").listMembers(c.get("tenant"));
  return c.json({ members }, 200);
});

organizationRoutes.post("/:orgId/members", requirePermission("members.manage"), async (c) => {
  const body = await parseJsonBody(c, addMemberSchema);
  const member = await c.get("organizationService").addMember(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ member }, 201);
});

organizationRoutes.patch("/:orgId/members/:memberId", requirePermission("members.manage"), async (c) => {
  const body = await parseJsonBody(c, changeRoleSchema);
  const member = await c
    .get("organizationService")
    .changeMemberRole(c.get("auth"), c.get("tenant"), memberId(c), body, meta(c));
  return c.json({ member }, 200);
});

organizationRoutes.delete("/:orgId/members/:memberId", requirePermission("members.manage"), async (c) => {
  await c.get("organizationService").removeMember(c.get("auth"), c.get("tenant"), memberId(c), meta(c));
  return c.body(null, 204);
});
