/**
 * Payout routes — affiliate face (Phase 5 Unit 13a) + platform face (Unit 13b);
 * PRD §63–§65, §114, §132.
 *
 * Authenticated tenant sub-router mounted by `routes/organizations.ts` UNDER
 * `/:orgId/payouts` (inherits `requireAuth → requireOrg`, adds
 * `requirePermission`). The tenant is `:orgId` = the affiliate organization
 * that OWNS the payout; every read and write is scoped by `PayoutService` to
 * that organization, so a route can never reach another tenant's payouts or
 * payout methods.
 *
 *   GET    /organizations/:orgId/payouts                 payouts.read     → 200 { items, next_cursor }   ?status=&limit=&cursor=
 *   GET    /organizations/:orgId/payouts/:payoutId       payouts.read     → 200 { payout, history, attempts }
 *   POST   /organizations/:orgId/payouts                 payouts.request  → 201 { payout }   { payout_method_id, amount_minor, currency, idempotency_key }
 *                                                        (idempotency_key replay → 200 with the SAME payout, no second row)
 *   POST   /organizations/:orgId/payouts/:payoutId/cancel payouts.review  → 200 { payout }   { reason? }
 *
 * Deliberately NOT on the affiliate face: eligibility / approve / process.
 * Those are finance steps performed by PLATFORM staff on another
 * organization's payout — an affiliate must never approve or release its own
 * payout (§132). No route accepts a status, a provider reference or a ledger
 * entry: the state machine, the journal and the money columns are owned by
 * the service / the 0011 triggers.
 *
 * Platform face (`platformPayoutRoutes`, mounted UNDER
 * `/:orgId/platform` where `:orgId` is the PLATFORM organization; every call
 * is refused 403 for a non-PLATFORM tenant by `PayoutService.assertPlatform`):
 *
 *   GET  /organizations/:platformOrgId/platform/payouts                                        payouts.review  work queue across ALL affiliates  ?status=&limit=&cursor=
 *   GET  /organizations/:platformOrgId/platform/affiliates/:affiliateOrgId/payouts             payouts.read
 *   GET  /organizations/:platformOrgId/platform/affiliates/:affiliateOrgId/payouts/:payoutId   payouts.read    { payout, history, attempts }
 *   POST .../payouts/:payoutId/eligibility   payouts.review   → 200 { outcome, payout, result }
 *   POST .../payouts/:payoutId/approve       payouts.approve  → 200 { payout }   { note? }     approver ≠ requester (§132)
 *   POST .../payouts/:payoutId/process       payouts.release  → 200 { outcome, payout, attempt }
 *   POST .../payouts/:payoutId/cancel        payouts.review   → 200 { payout }   { reason? }
 *
 * Malformed affiliate / payout ids → 404 (never an oracle).
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
import { LedgerRepository } from "../modules/ledger/repository";
import { ReserveRepository, ReserveService } from "../modules/ledger/reserves";
import type { PaymentProvider } from "../modules/payouts/provider";
import { PayoutRepository } from "../modules/payouts/repository";
import { PayoutService, type PayoutListFilter } from "../modules/payouts/service";
import { PAYOUT_STATUSES, type PayoutStatus } from "../modules/payouts/state-machine";
import { StubPaymentAdapter } from "../modules/payouts/stub-adapter";

const idSchema = z.string().uuid();

/**
 * Money arrives as INTEGER minor units + ISO-4217 code. Floats, negatives and
 * unsafe integers are refused at the edge (400) before the service re-checks.
 */
const requestSchema = z
  .object({
    payout_method_id: z.string().min(1).max(128),
    amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();

const cancelSchema = z.object({ reason: z.string().max(2000).nullable().optional() }).strict();
const approveSchema = z.object({ note: z.string().max(1000).nullable().optional() }).strict();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
export function payoutId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("payoutId"));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", "payout not found");
  return parsed.data;
}

/** The affiliate organization a platform route targets; malformed → 404 like an unknown id. */
export function affiliateOrgId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("affiliateOrgId"));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", "payout not found");
  return parsed.data;
}

export function payoutStatusFilter(raw: string | undefined): PayoutStatus | undefined {
  if (!raw) return undefined;
  if (!(PAYOUT_STATUSES as readonly string[]).includes(raw)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
  return raw as PayoutStatus;
}

/**
 * Per-request service over the bound D1. The payment provider comes from the
 * `createApp` seam (`c.get("paymentProvider")`, default StubPaymentAdapter
 * until a real provider is configured — Phase 5 known gap); it is only
 * reached by the PLATFORM `process` step, never by the affiliate routes.
 */
export function buildPayoutService(c: Ctx, provider: PaymentProvider = c.get("paymentProvider") ?? new StubPaymentAdapter()): PayoutService {
  const db = c.env.DB;
  const ledger = new LedgerRepository(db);
  const reserves = new ReserveService(new ReserveRepository(db), ledger, new AuditRepository(db));
  return new PayoutService(new PayoutRepository(db), ledger, reserves, provider, db);
}

export const payoutRoutes = new Hono<AppEnv>();

payoutRoutes.get("/", requirePermission("payouts.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: PayoutListFilter = {};
  const status = payoutStatusFilter(c.req.query("status"));
  const result = await buildPayoutService(c).list(c.get("tenant"), page, status ? { ...filter, status } : filter);
  return c.json(result, 200);
});

payoutRoutes.post("/", requirePermission("payouts.request"), async (c) => {
  const body = await parseJsonBody(c, requestSchema);
  const svc = buildPayoutService(c);
  const existing = await svc.peekIdempotencyKey(c.get("tenant"), body.idempotency_key);
  const payout = await svc.request(c.get("auth"), c.get("tenant"), body, meta(c));
  // Replay of the same key returns the SAME row — 200, never a second payout.
  return c.json({ payout }, existing ? 200 : 201);
});

payoutRoutes.get("/:payoutId", requirePermission("payouts.read"), async (c) => {
  const detail = await buildPayoutService(c).getPayout(c.get("tenant"), payoutId(c));
  return c.json(detail, 200);
});

payoutRoutes.post("/:payoutId/cancel", requirePermission("payouts.review"), async (c) => {
  const body = await parseJsonBody(c, cancelSchema);
  const payout = await buildPayoutService(c).cancel(c.get("auth"), c.get("tenant"), payoutId(c), body.reason ?? null, meta(c));
  return c.json({ payout }, 200);
});

// ---- platform face ------------------------------------------------------------------------

export const platformPayoutRoutes = new Hono<AppEnv>();

const AFF = "/affiliates/:affiliateOrgId/payouts";

platformPayoutRoutes.get("/payouts", requirePermission("payouts.review"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const status = payoutStatusFilter(c.req.query("status"));
  const result = await buildPayoutService(c).listAll(c.get("tenant"), page, status ? { status } : {});
  return c.json(result, 200);
});

platformPayoutRoutes.get(AFF, requirePermission("payouts.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const status = payoutStatusFilter(c.req.query("status"));
  const result = await buildPayoutService(c).listFor(c.get("tenant"), affiliateOrgId(c), page, status ? { status } : {});
  return c.json(result, 200);
});

platformPayoutRoutes.get(`${AFF}/:payoutId`, requirePermission("payouts.read"), async (c) => {
  const detail = await buildPayoutService(c).getPayoutFor(c.get("tenant"), affiliateOrgId(c), payoutId(c));
  return c.json(detail, 200);
});

platformPayoutRoutes.post(`${AFF}/:payoutId/eligibility`, requirePermission("payouts.review"), async (c) => {
  const run = await buildPayoutService(c).runEligibilityFor(c.get("auth"), c.get("tenant"), affiliateOrgId(c), payoutId(c), meta(c));
  return c.json(run, 200);
});

platformPayoutRoutes.post(`${AFF}/:payoutId/approve`, requirePermission("payouts.approve"), async (c) => {
  const body = await parseJsonBody(c, approveSchema);
  const payout = await buildPayoutService(c).approveFor(c.get("auth"), c.get("tenant"), affiliateOrgId(c), payoutId(c), body.note ?? null, meta(c));
  return c.json({ payout }, 200);
});

platformPayoutRoutes.post(`${AFF}/:payoutId/process`, requirePermission("payouts.release"), async (c) => {
  const result = await buildPayoutService(c).processFor(c.get("auth"), c.get("tenant"), affiliateOrgId(c), payoutId(c), meta(c));
  return c.json(result, 200);
});

platformPayoutRoutes.post(`${AFF}/:payoutId/cancel`, requirePermission("payouts.review"), async (c) => {
  const body = await parseJsonBody(c, cancelSchema);
  const payout = await buildPayoutService(c).cancelFor(c.get("auth"), c.get("tenant"), affiliateOrgId(c), payoutId(c), body.reason ?? null, meta(c));
  return c.json({ payout }, 200);
});
