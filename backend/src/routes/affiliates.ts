/**
 * Affiliate routes (Phase 2 Unit 2; PRD §19, §20, §21, §27, §124). Two
 * sub-routers, both mounted by `routes/organizations.ts` UNDER `/:orgId`, so
 * they inherit the mandatory `requireAuth → requireOrg` chain and add
 * `requirePermission`. Mirrors `routes/advertisers.ts`.
 *
 * Tenant (AFFILIATE / PARTNER organization = `:orgId`):
 *   GET    /organizations/:orgId/affiliate                          affiliates.read    → 200 { profile }
 *   POST   /organizations/:orgId/affiliate                          affiliates.manage  → 201 { profile }
 *   PATCH  /organizations/:orgId/affiliate                          affiliates.manage  → 200 { profile }
 *   POST   /organizations/:orgId/affiliate/submit                   affiliates.manage  → 200 { profile }
 *   POST   /organizations/:orgId/affiliate/appeal { reason }        affiliates.manage  → 200 { profile }
 *   GET    /organizations/:orgId/affiliate/history                  affiliates.read    → 200 { transitions }
 *   GET    /organizations/:orgId/affiliate/traffic-sources          affiliates.read    → 200 { sources }
 *   PUT    /organizations/:orgId/affiliate/traffic-sources/:type    affiliates.manage  → 201|200 { source }
 *   DELETE /organizations/:orgId/affiliate/traffic-sources/:type    affiliates.manage  → 204
 *
 * Platform review (PLATFORM organization = `:orgId`; `affiliates.review`):
 *   GET    /organizations/:orgId/platform/affiliates                    → 200 { items, next_cursor }  ?status=&limit=&cursor=
 *   GET    /organizations/:orgId/platform/affiliates/:profileId         → 200 { profile }  (includes traffic_sources)
 *   GET    /organizations/:orgId/platform/affiliates/:profileId/history → 200 { transitions }
 *   POST   /organizations/:orgId/platform/affiliates/:profileId/transition { to, reason?, review_notes? } → 200 { profile }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { ACQUISITION_CHANNELS, AFFILIATE_STATUSES, TRAFFIC_SOURCE_TYPES } from "../modules/affiliates/state-machine";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
const optionalUrl = () => text(2048).url().nullable().optional();
const optionalEmail = () => z.string().trim().toLowerCase().email().max(254).nullable().optional();

const profileFields = {
  legal_name: optionalText(200),
  website_url: optionalUrl(),
  app_url: optionalUrl(),
  promotional_methods: optionalText(2000),
  audience_description: optionalText(2000),
  monthly_traffic_estimate: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(120),
  region: optionalText(120),
  postal_code: optionalText(32),
  country_code: z.string().trim().toUpperCase().length(2).nullable().optional(),
  contact_name: optionalText(200),
  contact_email: optionalEmail(),
  contact_phone: optionalText(40),
  messaging_handle: optionalText(120),
  acquisition_channel: z.enum(ACQUISITION_CHANNELS).optional(),
  referral_code: optionalText(64),
};
const createSchema = z.object({ display_name: text(200).min(2), ...profileFields }).strict();
const updateSchema = z.object({ display_name: text(200).min(2).optional(), ...profileFields }).strict();
const appealSchema = z.object({ reason: text(2000).min(1) }).strict();
const trafficSourceSchema = z
  .object({
    description: optionalText(1000),
    url: optionalUrl(),
    estimated_monthly_volume: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  })
  .strict();
const transitionSchema = z
  .object({
    to: z.enum(AFFILIATE_STATUSES),
    reason: text(1000).nullable().optional(),
    review_notes: text(4000).nullable().optional(),
  })
  .strict();
const idSchema = z.string().uuid();
const sourceTypeSchema = z.enum(TRAFFIC_SOURCE_TYPES);

type ParamCtx = { req: { param(name: string): string | undefined } };

function profileId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("profileId"));
  if (!parsed.success) throw new AppError(404, "AFFILIATE_PROFILE_NOT_FOUND", "Affiliate profile not found");
  return parsed.data;
}

function sourceType(c: ParamCtx) {
  const parsed = sourceTypeSchema.safeParse((c.req.param("type") ?? "").toUpperCase());
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: traffic source type");
  return parsed.data;
}

// ---- tenant ------------------------------------------------------------------

export const affiliateRoutes = new Hono<AppEnv>();

affiliateRoutes.get("/", requirePermission("affiliates.read"), async (c) => {
  const profile = await c.get("affiliateService").get(c.get("auth"), c.get("tenant"), meta(c));
  return c.json({ profile }, 200);
});

affiliateRoutes.post("/", requirePermission("affiliates.manage"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const profile = await c.get("affiliateService").create(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ profile }, 201);
});

affiliateRoutes.patch("/", requirePermission("affiliates.manage"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const profile = await c.get("affiliateService").update(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ profile }, 200);
});

affiliateRoutes.post("/submit", requirePermission("affiliates.manage"), async (c) => {
  const profile = await c.get("affiliateService").submit(c.get("auth"), c.get("tenant"), meta(c));
  return c.json({ profile }, 200);
});

affiliateRoutes.post("/appeal", requirePermission("affiliates.manage"), async (c) => {
  const body = await parseJsonBody(c, appealSchema);
  const profile = await c.get("affiliateService").appeal(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ profile }, 200);
});

affiliateRoutes.get("/history", requirePermission("affiliates.read"), async (c) => {
  const transitions = await c.get("affiliateService").history(c.get("tenant"));
  return c.json({ transitions }, 200);
});

affiliateRoutes.get("/traffic-sources", requirePermission("affiliates.read"), async (c) => {
  const sources = await c.get("affiliateService").listTrafficSources(c.get("tenant"));
  return c.json({ sources }, 200);
});

affiliateRoutes.put("/traffic-sources/:type", requirePermission("affiliates.manage"), async (c) => {
  const body = await parseJsonBody(c, trafficSourceSchema);
  const { source, created } = await c
    .get("affiliateService")
    .declareTrafficSource(c.get("auth"), c.get("tenant"), { source_type: sourceType(c), ...body }, meta(c));
  return c.json({ source }, created ? 201 : 200);
});

affiliateRoutes.delete("/traffic-sources/:type", requirePermission("affiliates.manage"), async (c) => {
  await c.get("affiliateService").removeTrafficSource(c.get("auth"), c.get("tenant"), sourceType(c), meta(c));
  return c.body(null, 204);
});

// ---- platform review ---------------------------------------------------------

export const affiliateReviewRoutes = new Hono<AppEnv>();
affiliateReviewRoutes.use("*", requirePermission("affiliates.review"));

affiliateReviewRoutes.get("/", async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("affiliateService").list(c.get("tenant"), page, c.req.query("status"));
  return c.json(result, 200);
});

affiliateReviewRoutes.get("/:profileId", async (c) => {
  const profile = await c.get("affiliateService").getAny(c.get("tenant"), profileId(c));
  return c.json({ profile }, 200);
});

affiliateReviewRoutes.get("/:profileId/history", async (c) => {
  const transitions = await c.get("affiliateService").historyAny(c.get("tenant"), profileId(c));
  return c.json({ transitions }, 200);
});

affiliateReviewRoutes.post("/:profileId/transition", async (c) => {
  const body = await parseJsonBody(c, transitionSchema);
  const profile = await c
    .get("affiliateService")
    .transition(c.get("auth"), c.get("tenant"), profileId(c), body, meta(c));
  return c.json({ profile }, 200);
});
