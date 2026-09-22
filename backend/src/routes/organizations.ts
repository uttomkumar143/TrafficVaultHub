/**
 * /api/v1/organizations — organizations & membership (Phase 1 Unit 3, ADR-002).
 * Every route requires authentication. The acting organization is always
 * resolved through the caller's own membership (PRD §94) — see service.
 *
 * POST   /                                → 201 { organization }        create (type ∈ ADVERTISER|AFFILIATE|PARTNER|AGENCY); creator seated as owner
 * GET    /                                → 200 { organizations }       organizations the caller belongs to
 * GET    /:orgId                          → 200 { organization }        member only; else 404 ORGANIZATION_NOT_FOUND
 * PATCH  /:orgId                          → 200 { organization }        owner only (403 FORBIDDEN)
 * GET    /:orgId/roles                    → 200 { roles }               roles assignable in this org's type
 * GET    /:orgId/members                  → 200 { members }             member only
 * POST   /:orgId/members                  → 201 { member }              owner only; body { email, role }
 * PATCH  /:orgId/members/:memberId        → 200 { member }              owner only; body { role }; LAST_OWNER guard
 * DELETE /:orgId/members/:memberId        → 204                         owner only; LAST_OWNER + SELF_MODIFICATION guards
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError, requestId } from "../lib/errors";
import { parseJsonBody } from "../lib/validation";
import { requireAuth } from "../middleware/require-auth";
import type { RequestMeta } from "../modules/auth/repository";
import { SELF_SERVICE_ORG_TYPES } from "../modules/organizations/service";

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

function meta(c: { req: { header(name: string): string | undefined } }): RequestMeta {
  return {
    ip_address: c.req.header("cf-connecting-ip") ?? null,
    user_agent: c.req.header("user-agent")?.slice(0, 512) ?? null,
    request_id: requestId(c as never),
  };
}

/** Malformed ids can never match a row → same 404 as unknown ids (no oracle). */
function orgId(c: { req: { param(name: string): string | undefined } }): string {
  const parsed = idSchema.safeParse(c.req.param("orgId"));
  if (!parsed.success) throw new AppError(404, "ORGANIZATION_NOT_FOUND", "Organization not found");
  return parsed.data;
}
function memberId(c: { req: { param(name: string): string | undefined } }): string {
  const parsed = idSchema.safeParse(c.req.param("memberId"));
  if (!parsed.success) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  return parsed.data;
}

export const organizationRoutes = new Hono<AppEnv>();

// Every route in this module is protected — no exceptions (PRD §116).
organizationRoutes.use("*", requireAuth);

organizationRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const organization = await c.get("organizationService").create(c.get("auth"), body, meta(c));
  return c.json({ organization }, 201);
});

organizationRoutes.get("/", async (c) => {
  const organizations = await c.get("organizationService").listMine(c.get("auth"));
  return c.json({ organizations }, 200);
});

organizationRoutes.get("/:orgId", async (c) => {
  const organization = await c.get("organizationService").get(c.get("auth"), orgId(c));
  return c.json({ organization }, 200);
});

organizationRoutes.patch("/:orgId", async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const organization = await c.get("organizationService").update(c.get("auth"), orgId(c), body, meta(c));
  return c.json({ organization }, 200);
});

organizationRoutes.get("/:orgId/roles", async (c) => {
  const roles = await c.get("organizationService").listAssignableRoles(c.get("auth"), orgId(c));
  return c.json({ roles }, 200);
});

organizationRoutes.get("/:orgId/members", async (c) => {
  const members = await c.get("organizationService").listMembers(c.get("auth"), orgId(c));
  return c.json({ members }, 200);
});

organizationRoutes.post("/:orgId/members", async (c) => {
  const body = await parseJsonBody(c, addMemberSchema);
  const member = await c.get("organizationService").addMember(c.get("auth"), orgId(c), body, meta(c));
  return c.json({ member }, 201);
});

organizationRoutes.patch("/:orgId/members/:memberId", async (c) => {
  const body = await parseJsonBody(c, changeRoleSchema);
  const member = await c
    .get("organizationService")
    .changeMemberRole(c.get("auth"), orgId(c), memberId(c), body, meta(c));
  return c.json({ member }, 200);
});

organizationRoutes.delete("/:orgId/members/:memberId", async (c) => {
  await c.get("organizationService").removeMember(c.get("auth"), orgId(c), memberId(c), meta(c));
  return c.body(null, 204);
});
