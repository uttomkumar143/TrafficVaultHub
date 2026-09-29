/**
 * Attribution routes (Phase 3 Unit 7e; PRD §35–§37, §39, §74, §94, §115).
 *
 * Two faces:
 *
 * 1. Authenticated tenant sub-routers, mounted by `routes/organizations.ts`
 *    UNDER `/:orgId` (inherit `requireAuth → requireOrg`, add `requirePermission`):
 *
 *    Advertiser / agency (`:orgId` owns the offers):
 *      GET    /organizations/:orgId/offers/:offerId/attribution-policy           attribution.read    → 200 { policy }
 *      GET    /organizations/:orgId/offers/:offerId/attribution-policy/versions  attribution.read    → 200 { items }
 *      POST   /organizations/:orgId/offers/:offerId/attribution-policy           attribution.manage  → 201 { policy }
 *      GET    /organizations/:orgId/postback-secrets                             attribution.read    → 200 { items }   (no ciphertext, no plaintext)
 *      POST   /organizations/:orgId/postback-secrets                             attribution.manage  → 201 { secret }  (plaintext ONCE)
 *      POST   /organizations/:orgId/postback-secrets/:secretId/rotate            attribution.manage  → 201 { secret }  (plaintext ONCE)
 *      POST   /organizations/:orgId/postback-secrets/:secretId/revoke            attribution.manage  → 200 { secret }
 *      GET    /organizations/:orgId/conversions                                  attribution.read    → 200 { items, next_cursor }  ?offer_id=&status=&limit=&cursor=
 *      GET    /organizations/:orgId/conversions/:conversionId                    attribution.read    → 200 { conversion, attribution }
 *      GET    /organizations/:orgId/attributions                                 attribution.read    → 200 { items, next_cursor }  ?offer_id=&decision=&limit=&cursor=
 *
 *    Affiliate / partner (`:orgId` is the attributed party):
 *      GET    /organizations/:orgId/attributions                                 attribution.read    → 200 { items, next_cursor }  ?offer_id=&limit=&cursor=
 *
 *    The org type decides which face `GET /attributions` serves; the service
 *    enforces it (ADVERTISER/AGENCY vs AFFILIATE/PARTNER) — a route can never
 *    read another tenant's decisions.
 *
 * 2. Public server-to-server postback, mounted at the ROOT by `app.ts`
 *    (outside `/api/v1`, outside `wireServices` and every auth middleware,
 *    exactly like `routes/redirect.ts`):
 *      POST   /postback/v1/conversions                                           → 200 { conversion_id, attribution_id, decision, reason_code, duplicate, duplicate_of }
 *    Authentication is the HMAC envelope (X-TVH-Timestamp / Nonce / Key-Id /
 *    Signature) over the RAW body bytes; the body is read as text and handed
 *    to the service untouched so the signature covers what was actually sent.
 *    401 SIGNATURE_* / TIMESTAMP_SKEW, 409 REPLAY_DETECTED, 404 for offers the
 *    key holder does not own, 400 POSTBACK_INVALID, 503 when the vault master
 *    key is unavailable (fail closed). Always `Cache-Control: no-store`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError, requestId } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { AdvertiserRepository } from "../modules/advertisers/repository";
import { OfferRepository } from "../modules/offers/repository";
import { ATTRIBUTION_DECISIONS, type AttributionDecision } from "../modules/tracking/attribution";
import { AttributionRepository, CONVERSION_STATUSES, type ConversionStatus } from "../modules/tracking/attribution-repository";
import { AttributionService, ATTRIBUTION_OWNER_ORG_TYPES } from "../modules/tracking/attribution-service";

/** Canonical public postback path — the exact string advertisers sign (PRD §74). */
export const POSTBACK_PATH = "/postback/v1/conversions";

/** Largest postback body accepted (bytes). Well above any legitimate conversion payload. */
export const POSTBACK_BODY_MAX_BYTES = 16 * 1024;

const idSchema = z.string().uuid();

/**
 * Policy input: every field is optional (inherit-from-current defaults) and
 * typed loosely so the service's `POLICY_INVALID` can name the offending field
 * with the domain rule (window bounds, known model, …) — the route only
 * rejects unknown keys.
 */
const policySchema = z
  .object({
    model: z.unknown().optional(),
    window_seconds: z.unknown().optional(),
    dedup_scope: z.unknown().optional(),
    fallback_rule: z.unknown().optional(),
    require_signature: z.unknown().optional(),
    change_summary: z.unknown().optional(),
  })
  .strict();

const secretCreateSchema = z.object({ label: z.string().trim().max(120).nullable().optional() }).strict();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function param(c: ParamCtx, name: string, code: string, message: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError(404, code, message);
  return parsed.data;
}
const offerId = (c: ParamCtx) => param(c, "offerId", "OFFER_NOT_FOUND", "Offer not found");
const secretId = (c: ParamCtx) => param(c, "secretId", "POSTBACK_SECRET_NOT_FOUND", "Postback secret not found");
const conversionId = (c: ParamCtx) => param(c, "conversionId", "CONVERSION_NOT_FOUND", "Conversion not found");

function offerFilter(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: offer_id");
  return parsed.data;
}

function enumFilter<T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (!raw) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${name}`);
  return raw as T;
}

/** Per-request service over the bound D1 + the optional vault master key (absent ⇒ secret ops fail closed). */
export function buildAttributionService(c: Ctx): AttributionService {
  const db = c.env.DB;
  return new AttributionService(new AttributionRepository(db), new OfferRepository(db), new AdvertiserRepository(db), db, {
    masterKey: c.env.POSTBACK_SECRET_KEY,
  });
}

// ---- advertiser: /:orgId/offers/:offerId/attribution-policy --------------------

export const attributionPolicyRoutes = new Hono<AppEnv>();

attributionPolicyRoutes.get("/:offerId/attribution-policy", requirePermission("attribution.read"), async (c) => {
  const policy = await buildAttributionService(c).getCurrentPolicy(c.get("tenant"), offerId(c));
  return c.json({ policy }, 200);
});

attributionPolicyRoutes.get("/:offerId/attribution-policy/versions", requirePermission("attribution.read"), async (c) => {
  const items = await buildAttributionService(c).listPolicyVersions(c.get("tenant"), offerId(c));
  return c.json({ items }, 200);
});

attributionPolicyRoutes.post("/:offerId/attribution-policy", requirePermission("attribution.manage"), async (c) => {
  const body = await parseJsonBody(c, policySchema);
  const policy = await buildAttributionService(c).createPolicyVersion(c.get("auth"), c.get("tenant"), offerId(c), body, meta(c));
  return c.json({ policy }, 201);
});

// ---- advertiser: /:orgId/postback-secrets ---------------------------------------

export const postbackSecretRoutes = new Hono<AppEnv>();

postbackSecretRoutes.get("/", requirePermission("attribution.read"), async (c) => {
  const items = await buildAttributionService(c).listSecrets(c.get("tenant"));
  return c.json({ items }, 200);
});

postbackSecretRoutes.post("/", requirePermission("attribution.manage"), async (c) => {
  const body = await parseJsonBody(c, secretCreateSchema);
  const secret = await buildAttributionService(c).createSecret(c.get("auth"), c.get("tenant"), body, meta(c));
  c.header("cache-control", "no-store");
  return c.json({ secret }, 201);
});

postbackSecretRoutes.post("/:secretId/rotate", requirePermission("attribution.manage"), async (c) => {
  const secret = await buildAttributionService(c).rotateSecret(c.get("auth"), c.get("tenant"), secretId(c), meta(c));
  c.header("cache-control", "no-store");
  return c.json({ secret }, 201);
});

postbackSecretRoutes.post("/:secretId/revoke", requirePermission("attribution.manage"), async (c) => {
  const secret = await buildAttributionService(c).revokeSecret(c.get("auth"), c.get("tenant"), secretId(c), meta(c));
  return c.json({ secret }, 200);
});

// ---- advertiser: /:orgId/conversions ----------------------------------------------

export const conversionRoutes = new Hono<AppEnv>();

conversionRoutes.get("/", requirePermission("attribution.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: { offer_id?: string; status?: ConversionStatus } = {};
  const offer = offerFilter(c.req.query("offer_id"));
  if (offer) filter.offer_id = offer;
  const status = enumFilter(c.req.query("status"), CONVERSION_STATUSES, "status");
  if (status) filter.status = status;
  const result = await buildAttributionService(c).listConversions(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

conversionRoutes.get("/:conversionId", requirePermission("attribution.read"), async (c) => {
  const result = await buildAttributionService(c).getConversion(c.get("tenant"), conversionId(c));
  return c.json(result, 200);
});

// ---- both faces: /:orgId/attributions ---------------------------------------------

export const attributionRoutes = new Hono<AppEnv>();

attributionRoutes.get("/", requirePermission("attribution.read"), async (c) => {
  const tenant = c.get("tenant");
  const page = parsePageRequest((n) => c.req.query(n));
  const svc = buildAttributionService(c);
  const offer = offerFilter(c.req.query("offer_id"));
  if ((ATTRIBUTION_OWNER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
    const filter: { offer_id?: string; decision?: AttributionDecision } = {};
    if (offer) filter.offer_id = offer;
    const decision = enumFilter(c.req.query("decision"), ATTRIBUTION_DECISIONS, "decision");
    if (decision) filter.decision = decision;
    return c.json(await svc.listAttributions(tenant, page, filter), 200);
  }
  const filter: { offer_id?: string } = {};
  if (offer) filter.offer_id = offer;
  return c.json(await svc.listAttributionsForAffiliate(tenant, page, filter), 200);
});

// ---- public S2S: POST /postback/v1/conversions ------------------------------------

export function postbackRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post(POSTBACK_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!c.env?.DB) {
      return c.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", request_id: requestId(c) } }, 503);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > POSTBACK_BODY_MAX_BYTES) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "Postback body too large");
    }
    // Raw text — the exact bytes the advertiser signed. Never re-serialised.
    const body = await c.req.text();
    if (body.length > POSTBACK_BODY_MAX_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Postback body too large");

    const outcome = await buildAttributionService(c).processPostback({
      method: "POST",
      path: POSTBACK_PATH,
      body,
      header: (name) => c.req.header(name),
      meta: meta(c),
    });
    return c.json(outcome, 200);
  });

  return routes;
}
