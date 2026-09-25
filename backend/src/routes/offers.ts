/**
 * Offer routes (Phase 2 Units 3–7; PRD §22–§30, §92, §124, §127). Three
 * sub-routers, all mounted by `routes/organizations.ts` UNDER `/:orgId`, so
 * they inherit the mandatory `requireAuth → requireOrg` chain and add
 * `requirePermission`. Mirrors `routes/advertisers.ts` / `routes/affiliates.ts`.
 *
 * Advertiser/owner (`:orgId` = ADVERTISER / AGENCY org):
 *   GET    /organizations/:orgId/offers                                 offers.read    → 200 { items, next_cursor }  ?limit=&cursor=
 *   POST   /organizations/:orgId/offers                                 offers.create  → 201 { offer }
 *   GET    /organizations/:orgId/offers/:offerId                        offers.read    → 200 { offer }
 *   PATCH  /organizations/:orgId/offers/:offerId                        offers.update  → 200 { offer }
 *   POST   /organizations/:orgId/offers/:offerId/submit                 offers.update  → 200 { offer }
 *   POST   /organizations/:orgId/offers/:offerId/transition { to, reason? }  offers.update|offers.pause → 200 { offer }
 *   GET    /organizations/:orgId/offers/:offerId/versions                offers.read    → 200 { versions }
 *   POST   /organizations/:orgId/offers/:offerId/versions                offers.update  → 201 { version }
 *   GET    /organizations/:orgId/offers/:offerId/versions/:versionId     offers.read    → 200 { version }
 *   GET    /organizations/:orgId/offers/:offerId/history                 offers.read    → 200 { transitions }
 *   GET    /organizations/:orgId/offers/:offerId/access                  offers.read    → 200 { grants }
 *   PUT    /organizations/:orgId/offers/:offerId/access                  offers.update  → 201|200 { grant }
 *
 * Affiliate marketplace (`:orgId` = AFFILIATE / PARTNER org; `offers.read`):
 *   GET    /organizations/:orgId/marketplace                            → 200 { items, next_cursor }
 *          ?vertical=&country=&payout_type=&device=&traffic_source=&access_mode=&limit=&cursor=
 *   GET    /organizations/:orgId/marketplace/:offerId                   → 200 { offer }
 *   POST   /organizations/:orgId/marketplace/:offerId/apply             → 201|200 { grant }
 *
 * Platform review (`:orgId` = PLATFORM org; `offers.approve`/`offers.pause`):
 *   GET    /organizations/:orgId/platform/offers                        → 200 { items, next_cursor }  ?status=&limit=&cursor=
 *   GET    /organizations/:orgId/platform/offers/:offerId               → 200 { offer }
 *   GET    /organizations/:orgId/platform/offers/:offerId/versions      → 200 { versions }
 *   GET    /organizations/:orgId/platform/offers/:offerId/history       → 200 { transitions }
 *   POST   /organizations/:orgId/platform/offers/:offerId/transition { to, reason?, review_notes? } → 200 { offer }
 *
 * Money is integer minor units + a 3-letter currency at every boundary
 * (PRD §25): `z.number().int()` rejects a float before any service code runs,
 * and the cross-field relationships (commission ≤ payout, revshare basis
 * points) are re-checked in the service.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import {
  ACCESS_MODES,
  OFFER_STATUSES,
  PAYOUT_TYPES,
  TARGETING_DIMENSIONS,
} from "../modules/offers/state-machine";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();

/**
 * Money / count bound (PRD §25, §88). A JS integer is exact up to 2^53; the
 * ceiling here is far below that and still far above any real payout, so a
 * value that passes validation can never have lost precision in transit.
 */
const MINOR_MAX = 1_000_000_000_000_000;

const versionFields = {
  payout_type: z.enum(PAYOUT_TYPES),
  currency: z.string().trim().toUpperCase().length(3),
  advertiser_payout_minor: z.number().int().min(0).max(MINOR_MAX),
  affiliate_commission_minor: z.number().int().min(0).max(MINOR_MAX),
  network_margin_minor: z.number().int().min(0).max(MINOR_MAX).optional(),
  revshare_percent_bps: z.number().int().min(0).max(10000).nullable().optional(),
  daily_conversion_cap: z.number().int().min(0).max(MINOR_MAX).nullable().optional(),
  total_conversion_cap: z.number().int().min(0).max(MINOR_MAX).nullable().optional(),
  budget_minor: z.number().int().min(0).max(MINOR_MAX).nullable().optional(),
  attribution_window_seconds: z.number().int().min(1).max(315_360_000).optional(),
  conversion_event: text(120).min(1),
  destination_url: text(2048).url().nullable().optional(),
  targeting_starts_at: optionalText(40),
  targeting_ends_at: optionalText(40),
  change_summary: optionalText(2000),
};

const targetingSchema = z
  .array(
    z
      .object({
        dimension: z.enum(TARGETING_DIMENSIONS),
        value: text(200).min(1),
      })
      .strict(),
  )
  .max(500)
  .optional();

const createSchema = z
  .object({
    name: text(200).min(2),
    vertical: optionalText(120),
    description: optionalText(4000),
    access_mode: z.enum(ACCESS_MODES).optional(),
    version: z.object(versionFields).strict(),
    targeting: targetingSchema,
  })
  .strict();

const updateSchema = z
  .object({
    name: text(200).min(2).optional(),
    vertical: optionalText(120),
    description: optionalText(4000),
    access_mode: z.enum(ACCESS_MODES).optional(),
  })
  .strict();

const versionSchema = z.object({ ...versionFields, targeting: targetingSchema }).strict();

const transitionSchema = z
  .object({
    to: z.enum(OFFER_STATUSES),
    reason: text(1000).nullable().optional(),
  })
  .strict();

const reviewTransitionSchema = z
  .object({
    to: z.enum(OFFER_STATUSES),
    reason: text(1000).nullable().optional(),
    review_notes: text(4000).nullable().optional(),
  })
  .strict();

const accessGrantSchema = z
  .object({
    affiliate_organization_id: z.string().uuid(),
    status: z.enum(["INVITED", "APPROVED", "REJECTED", "REVOKED"]),
    reason: text(1000).nullable().optional(),
  })
  .strict();

const idSchema = z.string().uuid();

type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function offerId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("offerId"));
  if (!parsed.success) throw notFoundOffer();
  return parsed.data;
}

function versionId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("versionId"));
  if (!parsed.success) throw new AppError(404, "OFFER_VERSION_NOT_FOUND", "Offer version not found");
  return parsed.data;
}

function notFoundOffer(): AppError {
  return new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
}

// ---- advertiser / owner ------------------------------------------------------

export const offerRoutes = new Hono<AppEnv>();

offerRoutes.get("/", requirePermission("offers.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("offerService").list(c.get("tenant"), page);
  return c.json(result, 200);
});

offerRoutes.post("/", requirePermission("offers.create"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const offer = await c.get("offerService").create(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ offer }, 201);
});

offerRoutes.get("/:offerId", requirePermission("offers.read"), async (c) => {
  const offer = await c.get("offerService").get(c.get("tenant"), offerId(c));
  return c.json({ offer }, 200);
});

offerRoutes.patch("/:offerId", requirePermission("offers.update"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const offer = await c.get("offerService").update(c.get("auth"), c.get("tenant"), offerId(c), body, meta(c));
  return c.json({ offer }, 200);
});

offerRoutes.post("/:offerId/submit", requirePermission("offers.update"), async (c) => {
  const offer = await c.get("offerService").submit(c.get("auth"), c.get("tenant"), offerId(c), meta(c));
  return c.json({ offer }, 200);
});

/**
 * Lifecycle transition. The route guards `offers.read` (every actor here holds
 * it) and the SERVICE enforces the fine-grained key for the specific edge —
 * `offers.pause` for pause/resume, `offers.update` otherwise — because the
 * required key depends on the target status, which the guard cannot see.
 */
offerRoutes.post("/:offerId/transition", requirePermission("offers.read"), async (c) => {
  const body = await parseJsonBody(c, transitionSchema);
  const offer = await c.get("offerService").transition(c.get("auth"), c.get("tenant"), offerId(c), body, meta(c));
  return c.json({ offer }, 200);
});

offerRoutes.get("/:offerId/versions", requirePermission("offers.read"), async (c) => {
  const versions = await c.get("offerService").listVersions(c.get("tenant"), offerId(c));
  return c.json({ versions }, 200);
});

offerRoutes.post("/:offerId/versions", requirePermission("offers.update"), async (c) => {
  const body = await parseJsonBody(c, versionSchema);
  const { targeting, ...version } = body;
  const created = await c
    .get("offerService")
    .createVersion(c.get("auth"), c.get("tenant"), offerId(c), version, targeting, meta(c));
  return c.json({ version: created }, 201);
});

offerRoutes.get("/:offerId/versions/:versionId", requirePermission("offers.read"), async (c) => {
  const version = await c.get("offerService").getVersion(c.get("tenant"), offerId(c), versionId(c));
  return c.json({ version }, 200);
});

offerRoutes.get("/:offerId/history", requirePermission("offers.read"), async (c) => {
  const transitions = await c.get("offerService").history(c.get("tenant"), offerId(c));
  return c.json({ transitions }, 200);
});

offerRoutes.get("/:offerId/access", requirePermission("offers.read"), async (c) => {
  const grants = await c.get("offerService").listAccessGrants(c.get("tenant"), offerId(c));
  return c.json({ grants }, 200);
});

offerRoutes.put("/:offerId/access", requirePermission("offers.update"), async (c) => {
  const body = await parseJsonBody(c, accessGrantSchema);
  const existing = await c.get("offerService").listAccessGrants(c.get("tenant"), offerId(c));
  const created = !existing.some((g) => g.affiliate_organization_id === body.affiliate_organization_id);
  const grant = await c.get("offerService").setAccessGrant(c.get("auth"), c.get("tenant"), offerId(c), body, meta(c));
  return c.json({ grant }, created ? 201 : 200);
});

// ---- affiliate marketplace ---------------------------------------------------

export const marketplaceRoutes = new Hono<AppEnv>();

marketplaceRoutes.get("/", requirePermission("offers.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter = {
    vertical: c.req.query("vertical") || undefined,
    country: c.req.query("country")?.toUpperCase() || undefined,
    payout_type: payoutType(c.req.query("payout_type")),
    device: c.req.query("device")?.toUpperCase() || undefined,
    traffic_source: c.req.query("traffic_source")?.toUpperCase() || undefined,
    access_mode: accessMode(c.req.query("access_mode")),
  };
  const result = await c.get("offerService").searchMarketplace(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

marketplaceRoutes.get("/:offerId", requirePermission("offers.read"), async (c) => {
  const offer = await c.get("offerService").getMarketplaceOffer(c.get("tenant"), offerId(c));
  return c.json({ offer }, 200);
});

marketplaceRoutes.post("/:offerId/apply", requirePermission("offers.read"), async (c) => {
  const grant = await c.get("offerService").apply(c.get("auth"), c.get("tenant"), offerId(c), meta(c));
  return c.json({ grant }, 201);
});

function payoutType(raw: string | undefined) {
  if (!raw) return undefined;
  if (!(PAYOUT_TYPES as readonly string[]).includes(raw)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: payout_type");
  }
  return raw as (typeof PAYOUT_TYPES)[number];
}

function accessMode(raw: string | undefined) {
  if (!raw) return undefined;
  if (!(ACCESS_MODES as readonly string[]).includes(raw)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: access_mode");
  }
  return raw as (typeof ACCESS_MODES)[number];
}

// ---- platform review ---------------------------------------------------------

export const offerReviewRoutes = new Hono<AppEnv>();
offerReviewRoutes.use("*", requirePermission("offers.approve"));

offerReviewRoutes.get("/", async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("offerService").listAll(c.get("tenant"), page, c.req.query("status"));
  return c.json(result, 200);
});

offerReviewRoutes.get("/:offerId", async (c) => {
  const offer = await c.get("offerService").getAny(c.get("tenant"), offerId(c));
  return c.json({ offer }, 200);
});

offerReviewRoutes.get("/:offerId/versions", async (c) => {
  const versions = await c.get("offerService").versionsAny(c.get("tenant"), offerId(c));
  return c.json({ versions }, 200);
});

offerReviewRoutes.get("/:offerId/history", async (c) => {
  const transitions = await c.get("offerService").historyAny(c.get("tenant"), offerId(c));
  return c.json({ transitions }, 200);
});

offerReviewRoutes.post("/:offerId/transition", async (c) => {
  const body = await parseJsonBody(c, reviewTransitionSchema);
  const offer = await c
    .get("offerService")
    .platformTransition(c.get("auth"), c.get("tenant"), offerId(c), body, meta(c));
  return c.json({ offer }, 200);
});
