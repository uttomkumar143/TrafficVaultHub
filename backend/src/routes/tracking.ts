/**
 * Tracking routes (Phase 3 Unit 1; PRD §31–§34, §94, §116, §124). Two thin
 * sub-routers mounted by `routes/organizations.ts` UNDER `/:orgId`, so they
 * inherit the mandatory `requireAuth → requireOrg` chain and add
 * `requirePermission`. Mirrors `routes/offers.ts`.
 *
 * Affiliate (`:orgId` = AFFILIATE / PARTNER org):
 *   GET    /organizations/:orgId/tracking-links                        tracking.read    → 200 { items, next_cursor }  ?offer_id=&status=&limit=&cursor=
 *   POST   /organizations/:orgId/tracking-links                        tracking.manage  → 201 { tracking_link }
 *   GET    /organizations/:orgId/tracking-links/:linkId                tracking.read    → 200 { tracking_link }
 *   PATCH  /organizations/:orgId/tracking-links/:linkId                tracking.manage  → 200 { tracking_link }
 *   POST   /organizations/:orgId/tracking-links/:linkId/transition { to } tracking.manage → 200 { tracking_link }
 *   GET    /organizations/:orgId/tracking-links/:linkId/clicks         tracking.read    → 200 { items, next_cursor }
 *
 * Advertiser/owner (`:orgId` = ADVERTISER / AGENCY org):
 *   GET    /organizations/:orgId/offers/:offerId/clicks                tracking.read    → 200 { items, next_cursor }
 *
 * The affiliate organization on every link is the resolved tenant — a body
 * `organization_id` / `affiliate_id` is rejected by `.strict()` before any
 * service code runs (PRD §94).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { TRACKING_LINK_STATUSES, type TrackingLinkStatus } from "../modules/tracking/repository";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();
const idSchema = z.string().uuid();

/**
 * Sub-ID defaults: any JSON value is accepted at the schema level so that the
 * service's `sanitizeSubIds` can name the slot AND the reason (TOO_LONG /
 * PERSONAL_DATA / INVALID_TYPE) instead of a generic validation error.
 */
const defaultsSchema = z
  .object({
    sub1: z.unknown().optional(),
    sub2: z.unknown().optional(),
    sub3: z.unknown().optional(),
    sub4: z.unknown().optional(),
    sub5: z.unknown().optional(),
  })
  .strict()
  .nullable()
  .optional();

const createSchema = z
  .object({
    offer_id: idSchema,
    traffic_source_id: idSchema.nullable().optional(),
    name: optionalText(200),
    creative_id: optionalText(120),
    defaults: defaultsSchema,
  })
  .strict();

const updateSchema = z
  .object({
    traffic_source_id: idSchema.nullable().optional(),
    name: optionalText(200),
    creative_id: optionalText(120),
    defaults: defaultsSchema,
  })
  .strict();

const transitionSchema = z.object({ to: z.enum(TRACKING_LINK_STATUSES) }).strict();

type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function linkId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("linkId"));
  if (!parsed.success) throw new AppError(404, "TRACKING_LINK_NOT_FOUND", "Tracking link not found");
  return parsed.data;
}

function offerId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("offerId"));
  if (!parsed.success) throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
  return parsed.data;
}

function linkStatus(raw: string | undefined): TrackingLinkStatus | undefined {
  if (!raw) return undefined;
  if (!(TRACKING_LINK_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
  }
  return raw as TrackingLinkStatus;
}

/** `offer_id` filter must at least be id-shaped; a malformed value simply matches nothing. */
function offerFilter(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: offer_id");
  return parsed.data;
}

// ---- affiliate: /:orgId/tracking-links ----------------------------------------

export const trackingLinkRoutes = new Hono<AppEnv>();

trackingLinkRoutes.get("/", requirePermission("tracking.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter = { offer_id: offerFilter(c.req.query("offer_id")), status: linkStatus(c.req.query("status")) };
  const result = await c.get("trackingService").list(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

trackingLinkRoutes.post("/", requirePermission("tracking.manage"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const tracking_link = await c.get("trackingService").create(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ tracking_link }, 201);
});

trackingLinkRoutes.get("/:linkId", requirePermission("tracking.read"), async (c) => {
  const tracking_link = await c.get("trackingService").get(c.get("tenant"), linkId(c));
  return c.json({ tracking_link }, 200);
});

trackingLinkRoutes.patch("/:linkId", requirePermission("tracking.manage"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const tracking_link = await c
    .get("trackingService")
    .update(c.get("auth"), c.get("tenant"), linkId(c), body, meta(c));
  return c.json({ tracking_link }, 200);
});

trackingLinkRoutes.post("/:linkId/transition", requirePermission("tracking.manage"), async (c) => {
  const body = await parseJsonBody(c, transitionSchema);
  const tracking_link = await c
    .get("trackingService")
    .transition(c.get("auth"), c.get("tenant"), linkId(c), body.to, meta(c));
  return c.json({ tracking_link }, 200);
});

trackingLinkRoutes.get("/:linkId/clicks", requirePermission("tracking.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("trackingService").listClicks(c.get("tenant"), linkId(c), page);
  return c.json(result, 200);
});

// ---- advertiser: /:orgId/offers/:offerId/clicks --------------------------------

export const offerClickRoutes = new Hono<AppEnv>();

offerClickRoutes.get("/:offerId/clicks", requirePermission("tracking.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("trackingService").listOfferClicks(c.get("tenant"), offerId(c), page);
  return c.json(result, 200);
});
