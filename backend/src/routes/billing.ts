/**
 * Billing routes — Phase 5 Unit 14; PRD §61–§63 (advertiser funding), §114.
 *
 * Thin HTTP face over the EXISTING `BillingService` only. The service has
 * exactly three public entry points and this file exposes exactly those:
 *
 * Tenant face (`billingRoutes`, mounted UNDER `/:orgId/billing`, the
 * advertiser that OWNS the profile; `requireAuth → requireOrg → requirePermission`):
 *
 *   GET /profile   billing.read → 200 { profile }   the caller's OWN funding position
 *   GET /alerts    billing.read → 200 { items }     funding alerts ABOUT the caller's org
 *                                                   (both audiences; never another tenant's)
 *
 * Platform face (`platformBillingRoutes`, mounted UNDER `/:orgId/platform`
 * where `:orgId` is the PLATFORM organization):
 *
 *   GET  /billing/advertisers/:advertiserOrgId/profile    billing.read    → 200 { profile }
 *   POST /billing/advertisers/:advertiserOrgId/evaluate   billing.manage  → 200 { evaluation }
 *        body { required_minor?: integer ≥ 0 } (profile currency; the service never mixes
 *        currencies — LIVE offers in another currency are reported in
 *        `ignored_other_currency_offer_ids`). The service additionally requires
 *        `offers.pause` and really pauses offers through `OfferService`
 *        (eligibility cache invalidated) and writes funding alerts.
 *
 * NOT exposed (no service method exists — known gaps, see STATE.md): billing
 * profile create/update, raw balance edits, alert acknowledgement. PUT/PATCH/
 * POST on /profile and /alerts therefore fall through to the app's 404.
 *
 * Malformed advertiser ids → 404 (no oracle). Non-PLATFORM callers of the
 * platform face → 403 before any read.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { AuditRepository } from "../modules/audit/repository";
import { BillingRepository, BillingService } from "../modules/billing/service";
import { LedgerRepository } from "../modules/ledger/repository";

type Ctx = Context<AppEnv>;

const idSchema = z.string().uuid();

const evaluateSchema = z
  .object({
    required_minor: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

/** Per-request service over the bound D1; reuses the app's `offerService` (cache-aware). */
export function buildBillingService(c: Ctx): BillingService {
  const db = c.env.DB;
  return new BillingService(new BillingRepository(db), new LedgerRepository(db), c.get("offerService"), new AuditRepository(db));
}

function advertiserOrgId(c: Ctx): string {
  const parsed = idSchema.safeParse(c.req.param("advertiserOrgId"));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", "billing profile not found");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Tenant face
// ---------------------------------------------------------------------------

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get("/profile", requirePermission("billing.read"), async (c) => {
  const profile = await buildBillingService(c).getMyProfile(c.get("tenant"));
  return c.json({ profile }, 200);
});

billingRoutes.get("/alerts", requirePermission("billing.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await buildBillingService(c).listMyAlertsPage(c.get("tenant"), page);
  return c.json(result, 200);
});

// ---------------------------------------------------------------------------
// Platform face
// ---------------------------------------------------------------------------

export const platformBillingRoutes = new Hono<AppEnv>();
const A = "/billing/advertisers/:advertiserOrgId";

function assertPlatform(c: Ctx): void {
  if (c.get("tenant").organization.type !== "PLATFORM") {
    throw new AppError(403, "FORBIDDEN", "platform organization required");
  }
}

platformBillingRoutes.get(`${A}/profile`, requirePermission("billing.read"), async (c) => {
  assertPlatform(c);
  const profile = await buildBillingService(c).getProfileFor(c.get("tenant"), advertiserOrgId(c));
  return c.json({ profile }, 200);
});

platformBillingRoutes.post(`${A}/evaluate`, requirePermission("billing.manage"), async (c) => {
  assertPlatform(c);
  const target = advertiserOrgId(c);
  const body = await parseJsonBody(c, evaluateSchema);
  const evaluation = await buildBillingService(c).evaluateFunding(c.get("auth"), c.get("tenant"), target, body, meta(c));
  return c.json({ evaluation }, 200);
});
