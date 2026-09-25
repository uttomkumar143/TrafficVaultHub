/**
 * Advertiser routes (Phase 2 Unit 1; PRD §16, §17, §124). Two sub-routers,
 * both mounted by `routes/organizations.ts` UNDER `/:orgId`, so they inherit
 * the mandatory `requireAuth → requireOrg` chain and add `requirePermission`.
 *
 * Tenant (ADVERTISER / AGENCY organization = `:orgId`):
 *   GET    /organizations/:orgId/advertiser           advertisers.read    → 200 { profile }
 *   POST   /organizations/:orgId/advertiser           advertisers.manage  → 201 { profile }
 *   PATCH  /organizations/:orgId/advertiser           advertisers.manage  → 200 { profile }
 *   POST   /organizations/:orgId/advertiser/submit    advertisers.manage  → 200 { profile }
 *   GET    /organizations/:orgId/advertiser/history   advertisers.read    → 200 { transitions }
 *
 * Platform review (PLATFORM organization = `:orgId`; `advertisers.review`):
 *   GET    /organizations/:orgId/platform/advertisers                    → 200 { items, next_cursor }  ?status=&limit=&cursor=
 *   GET    /organizations/:orgId/platform/advertisers/:profileId         → 200 { profile }
 *   GET    /organizations/:orgId/platform/advertisers/:profileId/history → 200 { transitions }
 *   POST   /organizations/:orgId/platform/advertisers/:profileId/transition { to, reason?, review_notes? } → 200 { profile }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { ADVERTISER_STATUSES } from "../modules/advertisers/state-machine";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();

const profileFields = {
  website_url: text(2048).url().nullable().optional(),
  business_category: optionalText(120),
  legal_name: optionalText(200),
  registration_number: optionalText(100),
  tax_id: optionalText(100),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(120),
  region: optionalText(120),
  postal_code: optionalText(32),
  country_code: z.string().trim().toUpperCase().length(2).nullable().optional(),
  contact_name: optionalText(200),
  contact_email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  contact_phone: optionalText(40),
  billing_contact_email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
};
const createSchema = z.object({ company_name: text(200).min(2), ...profileFields }).strict();
const updateSchema = z.object({ company_name: text(200).min(2).optional(), ...profileFields }).strict();
const transitionSchema = z
  .object({
    to: z.enum(ADVERTISER_STATUSES),
    reason: text(1000).nullable().optional(),
    review_notes: text(4000).nullable().optional(),
  })
  .strict();
const idSchema = z.string().uuid();

function profileId(c: { req: { param(name: string): string | undefined } }): string {
  const parsed = idSchema.safeParse(c.req.param("profileId"));
  if (!parsed.success) throw new AppError(404, "ADVERTISER_PROFILE_NOT_FOUND", "Advertiser profile not found");
  return parsed.data;
}

// ---- tenant ------------------------------------------------------------------

export const advertiserRoutes = new Hono<AppEnv>();

advertiserRoutes.get("/", requirePermission("advertisers.read"), async (c) => {
  const profile = await c.get("advertiserService").get(c.get("auth"), c.get("tenant"), meta(c));
  return c.json({ profile }, 200);
});

advertiserRoutes.post("/", requirePermission("advertisers.manage"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const profile = await c.get("advertiserService").create(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ profile }, 201);
});

advertiserRoutes.patch("/", requirePermission("advertisers.manage"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const profile = await c.get("advertiserService").update(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ profile }, 200);
});

advertiserRoutes.post("/submit", requirePermission("advertisers.manage"), async (c) => {
  const profile = await c.get("advertiserService").submit(c.get("auth"), c.get("tenant"), meta(c));
  return c.json({ profile }, 200);
});

advertiserRoutes.get("/history", requirePermission("advertisers.read"), async (c) => {
  const transitions = await c.get("advertiserService").history(c.get("tenant"));
  return c.json({ transitions }, 200);
});

// ---- platform review ---------------------------------------------------------

export const advertiserReviewRoutes = new Hono<AppEnv>();
advertiserReviewRoutes.use("*", requirePermission("advertisers.review"));

advertiserReviewRoutes.get("/", async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("advertiserService").list(c.get("tenant"), page, c.req.query("status"));
  return c.json(result, 200);
});

advertiserReviewRoutes.get("/:profileId", async (c) => {
  const profile = await c.get("advertiserService").getAny(c.get("tenant"), profileId(c));
  return c.json({ profile }, 200);
});

advertiserReviewRoutes.get("/:profileId/history", async (c) => {
  const transitions = await c.get("advertiserService").historyAny(c.get("tenant"), profileId(c));
  return c.json({ transitions }, 200);
});

advertiserReviewRoutes.post("/:profileId/transition", async (c) => {
  const body = await parseJsonBody(c, transitionSchema);
  const profile = await c
    .get("advertiserService")
    .transition(c.get("auth"), c.get("tenant"), profileId(c), body, meta(c));
  return c.json({ profile }, 200);
});
