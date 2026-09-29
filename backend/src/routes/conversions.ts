/**
 * Conversion lifecycle routes (Phase 4 Unit 10a; PRD §38–§40, §115).
 *
 * Authenticated tenant sub-routers, mounted by `routes/organizations.ts`
 * UNDER `/:orgId` (inherit `requireAuth → requireOrg`, add `requirePermission`).
 * `:orgId` is the advertiser / agency that owns the offer (the conversion's
 * `organization_id`); the service scopes every read and write to it.
 *
 * The Phase 3 attribution router already owns `GET /conversions` and
 * `GET /conversions/:conversionId` (intake snapshot + attribution). Phase 4
 * adds ONLY disjoint paths under the same prefix; `conversionLifecycleRoutes`
 * is mounted BEFORE the attribution router so the literal `/lifecycle`
 * segment is never captured by `/:conversionId`.
 *
 *   GET  /organizations/:orgId/conversions/lifecycle                        conversions.read     → 200 { items, next_cursor }
 *        ?lifecycle_status=&offer_id=&affiliate_organization_id=&limit=&cursor=
 *   GET  /organizations/:orgId/conversions/:conversionId/lifecycle          conversions.read     → 200 { conversion, history, reversal, active_holds, payout_blocked }
 *   POST /organizations/:orgId/conversions/:conversionId/approve            conversions.approve  → 200 { conversion }
 *   POST /organizations/:orgId/conversions/:conversionId/reject             conversions.reject   → 200 { conversion }   reason_code required
 *   POST /organizations/:orgId/conversions/:conversionId/dispute            conversions.reject   → 200 { conversion }   reason_code required
 *   POST /organizations/:orgId/conversions/:conversionId/fraud-review       fraud.review         → 200 { conversion }   reason_code required
 *   POST /organizations/:orgId/conversions/:conversionId/reverse            conversions.reverse  → 200 { conversion, history, reversal, active_holds, payout_blocked }
 *
 *   POST /organizations/:orgId/conversion-holds                             conversions.approve (PAYOUT_HOLD: fraud.manage, enforced by the service) → 201 { hold }
 *   POST /organizations/:orgId/conversion-holds/:holdId/release             conversions.read + per-hold-type permission in the service → 200 { hold }
 *
 * There is deliberately NO generic "transition" endpoint and no route for
 * the internal money pipeline: LEDGER_POSTED / EARNED / PAYOUT_ELIGIBLE /
 * PAID are reachable only through `ConversionService.internal` (never
 * exported here). Every mutating route maps to exactly one named domain
 * operation whose target state is fixed in the service. Bodies are `.strict()`
 * so a `to`/`status` field is rejected with 400 before the service runs.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { ConversionRepository, type ConversionListFilter, type ReversalReasonCode } from "../modules/conversions/repository";
import { ConversionService } from "../modules/conversions/service";
import { CONVERSION_STATUSES, type ConversionStatus } from "../modules/conversions/state-machine";

const idSchema = z.string().uuid();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function param(c: ParamCtx, name: string, message: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", message);
  return parsed.data;
}
const conversionId = (c: ParamCtx) => param(c, "conversionId", "conversion not found");
const holdId = (c: ParamCtx) => param(c, "holdId", "hold not found");

function idFilter(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${name}`);
  return parsed.data;
}

function enumFilter<T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (!raw) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${name}`);
  return raw as T;
}

/**
 * Decision body. `reason_code` is typed loosely so the service's domain
 * errors (REASON_REQUIRED / INVALID_REASON_CODE / NOTE_TOO_LONG) name the
 * rule; the route only rejects unknown keys and wrong shapes.
 */
const decisionSchema = z
  .object({
    reason_code: z.string().max(64).optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .strict();

const reverseSchema = decisionSchema.extend({
  amount_minor: z.number().int().nonnegative().optional(),
});

const placeHoldSchema = z
  .object({
    hold_type: z.enum(["CONVERSION_HOLD", "PAYOUT_HOLD"]),
    reason_code: z.string().min(1).max(64),
    conversion_id: idSchema.optional(),
    affiliate_organization_id: idSchema.optional(),
  })
  .strict();

type Decision = z.infer<typeof decisionSchema>;

function decision(body: Decision): { reason_code: string; note: string | null } {
  return { reason_code: body.reason_code ?? "", note: body.note ?? null };
}

/** Per-request service over the bound D1. `service.internal` is never touched by a route. */
export function buildConversionService(c: Ctx): ConversionService {
  const db = c.env.DB;
  return new ConversionService(new ConversionRepository(db), db);
}

// ---- /:orgId/conversions (lifecycle face) ---------------------------------------

export const conversionLifecycleRoutes = new Hono<AppEnv>();

conversionLifecycleRoutes.get("/lifecycle", requirePermission("conversions.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: ConversionListFilter = {};
  const offer = idFilter(c.req.query("offer_id"), "offer_id");
  if (offer) filter.offer_id = offer;
  const affiliate = idFilter(c.req.query("affiliate_organization_id"), "affiliate_organization_id");
  if (affiliate) filter.affiliate_organization_id = affiliate;
  const status = enumFilter<ConversionStatus>(c.req.query("lifecycle_status"), CONVERSION_STATUSES, "lifecycle_status");
  if (status) filter.lifecycle_status = status;
  const result = await buildConversionService(c).list(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

conversionLifecycleRoutes.get("/:conversionId/lifecycle", requirePermission("conversions.read"), async (c) => {
  const detail = await buildConversionService(c).get(c.get("tenant"), conversionId(c));
  return c.json(detail, 200);
});

conversionLifecycleRoutes.post("/:conversionId/approve", requirePermission("conversions.approve"), async (c) => {
  const body = await parseJsonBody(c, decisionSchema);
  const conversion = await buildConversionService(c).approve(c.get("auth"), c.get("tenant"), conversionId(c), decision(body), meta(c));
  return c.json({ conversion }, 200);
});

conversionLifecycleRoutes.post("/:conversionId/reject", requirePermission("conversions.reject"), async (c) => {
  const body = await parseJsonBody(c, decisionSchema);
  const conversion = await buildConversionService(c).reject(c.get("auth"), c.get("tenant"), conversionId(c), decision(body), meta(c));
  return c.json({ conversion }, 200);
});

conversionLifecycleRoutes.post("/:conversionId/dispute", requirePermission("conversions.reject"), async (c) => {
  const body = await parseJsonBody(c, decisionSchema);
  const conversion = await buildConversionService(c).dispute(c.get("auth"), c.get("tenant"), conversionId(c), decision(body), meta(c));
  return c.json({ conversion }, 200);
});

conversionLifecycleRoutes.post("/:conversionId/fraud-review", requirePermission("fraud.review"), async (c) => {
  const body = await parseJsonBody(c, decisionSchema);
  const conversion = await buildConversionService(c).sendToFraudReview(
    c.get("auth"),
    c.get("tenant"),
    conversionId(c),
    decision(body),
    meta(c),
  );
  return c.json({ conversion }, 200);
});

conversionLifecycleRoutes.post("/:conversionId/reverse", requirePermission("conversions.reverse"), async (c) => {
  const body = await parseJsonBody(c, reverseSchema);
  const input: { reason_code: ReversalReasonCode; note: string | null; amount_minor?: number } = {
    // Validated against REVERSAL_REASON_CODES by the service (400 INVALID_REASON_CODE).
    reason_code: (body.reason_code ?? "") as ReversalReasonCode,
    note: body.note ?? null,
  };
  if (body.amount_minor !== undefined) input.amount_minor = body.amount_minor;
  const detail = await buildConversionService(c).reverse(c.get("auth"), c.get("tenant"), conversionId(c), input, meta(c));
  return c.json(detail, 200);
});

// ---- /:orgId/conversion-holds ---------------------------------------------------

export const conversionHoldRoutes = new Hono<AppEnv>();

// Route-level gate is the weaker CONVERSION_HOLD permission; the service
// upgrades the requirement to fraud.manage for PAYOUT_HOLD (403 FORBIDDEN).
conversionHoldRoutes.post("/", requirePermission("conversions.approve"), async (c) => {
  const body = await parseJsonBody(c, placeHoldSchema);
  const hold = await buildConversionService(c).placeHold(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ hold }, 201);
});

// Release permission depends on the hold's type (compliance.resolve for
// COMPLIANCE_BLOCK, fraud.manage for PAYOUT_HOLD, …) and is decided by the
// service after the tenant-scoped lookup; the route only requires read access.
conversionHoldRoutes.post("/:holdId/release", requirePermission("conversions.read"), async (c) => {
  const body = await parseJsonBody(c, decisionSchema);
  const hold = await buildConversionService(c).releaseHold(c.get("auth"), c.get("tenant"), holdId(c), decision(body), meta(c));
  return c.json({ hold }, 200);
});
