/**
 * Ledger routes — Phase 5 Unit 13c; PRD §55–§60, §114, §132.
 *
 * Every route is a thin HTTP face over EXISTING service / repository
 * methods. No route posts a raw journal or ledger entry: journals are only
 * ever written by `LedgerService` (commissions / reversals), `AdjustmentService`
 * (approved adjustments) and `PayoutService` (PAID payouts). The 0010 triggers
 * keep posted rows immutable.
 *
 * Tenant face (`ledgerRoutes`, mounted UNDER `/:orgId/ledger`, the tenant that
 * OWNS the accounts; `requireAuth → requireOrg → requirePermission`):
 *
 *   GET  /accounts                              ledger.read     → 200 { items }            chart of accounts
 *   GET  /accounts/:accountId/balance           ledger.read     → 200 { balance }          Σ ledger_entries (source of truth)
 *   GET  /available?currency=USD                ledger.read     → 200 { available }        balance − holds − reserves
 *   GET  /journals/:journalId                   ledger.read     → 200 { journal, entries }  read-only detail
 *   GET  /adjustments/:adjustmentId             ledger.read     → 200 { adjustment, history }
 *   POST /adjustments                           ledger.adjust   → 201 { adjustment }       REQUESTED (§59 fields)
 *   POST /adjustments/:adjustmentId/post        ledger.adjust   → 200 { outcome, ... }     only APPROVED (409 otherwise)
 *   GET  /reserves?status=&currency=            ledger.read     → 200 { items }
 *   GET  /reserves/:reserveId                   ledger.read     → 200 { reserve }
 *   POST /reserves                              ledger.reserve  → 201 { reserve, available_before, available_after }
 *   POST /reserves/:reserveId/release           ledger.reserve  → 200 { reserve }          { reason? }
 *
 * Approve / reject are NOT on the tenant face: `AdjustmentService.approve`
 * requires a PLATFORM actor (`requirePlatform` → 403 PLATFORM_ONLY) and a
 * user different from the requester (§132, 409 ADJUSTMENT_SELF_APPROVAL).
 *
 * Platform face (`platformLedgerRoutes`, mounted UNDER `/:orgId/platform`
 * where `:orgId` is the PLATFORM organization). The tenancy rule is the one
 * exercised by `adjustments.test.ts` (`tenantFor(ADV, "PLATFORM", ...)`): the
 * TenantContext keeps the PLATFORM organization's type / role / permissions
 * but carries the TARGET tenant's id, so the service scopes every read and
 * write to the target tenant and records actor_type PLATFORM. A non-PLATFORM
 * caller is refused 403 before anything is read.
 *
 *   GET  /ledger/tenants/:tenantOrgId/adjustments/:adjustmentId          ledger.read
 *   POST /ledger/tenants/:tenantOrgId/adjustments                        ledger.adjust   → 201
 *   POST /ledger/tenants/:tenantOrgId/adjustments/:adjustmentId/approve  ledger.approve  → 200 { adjustment }  { note? }
 *   POST /ledger/tenants/:tenantOrgId/adjustments/:adjustmentId/reject   ledger.approve  → 200 { adjustment }  { note? }
 *   POST /ledger/tenants/:tenantOrgId/adjustments/:adjustmentId/post     ledger.adjust   → 200 { outcome, ... }
 *   GET  /ledger/tenants/:tenantOrgId/available?currency=                ledger.read
 *   POST /ledger/tenants/:tenantOrgId/reserves                           ledger.reserve  → 201
 *   POST /ledger/tenants/:tenantOrgId/reserves/:reserveId/release        ledger.reserve  → 200
 *
 * Malformed ids → 404 (never an oracle). Money is INTEGER minor units +
 * ISO-4217 code; floats / negatives / unsafe integers are refused 400 at the
 * edge and re-checked by the services.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { requestMeta as meta } from "../lib/request-meta";
import { tenantIdOf } from "../lib/tenant-scope";
import { parseJsonBody } from "../lib/validation";
import { requirePermission, type TenantContext } from "../middleware/require-org";
import { AuditRepository } from "../modules/audit/repository";
import {
  ADJUSTMENT_REASON_CODES,
  ADJUSTMENT_REFERENCE_TYPES,
  AdjustmentRepository,
  AdjustmentService,
} from "../modules/ledger/adjustments";
import { LedgerRepository } from "../modules/ledger/repository";
import { RESERVE_REFERENCE_TYPES, RESERVE_TYPES, ReserveRepository, ReserveService, type ReserveStatus } from "../modules/ledger/reserves";

const idSchema = z.string().uuid();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const amountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const adjustmentRequestSchema = z
  .object({
    account_id: z.string().uuid(),
    counter_account_id: z.string().uuid(),
    direction: z.enum(["DEBIT", "CREDIT"]),
    amount_minor: amountSchema,
    currency: currencySchema,
    reason_code: z.enum(ADJUSTMENT_REASON_CODES),
    reason_note: z.string().min(1).max(1000),
    reference_type: z.enum(ADJUSTMENT_REFERENCE_TYPES).nullable().optional(),
    reference_id: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

const decisionSchema = z.object({ note: z.string().max(1000).nullable().optional() }).strict();

const reservePlaceSchema = z
  .object({
    reserve_type: z.enum(RESERVE_TYPES),
    currency: currencySchema,
    amount_minor: amountSchema,
    reason_code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    reference_type: z.enum(RESERVE_REFERENCE_TYPES).nullable().optional(),
    reference_id: z.string().min(1).max(128).nullable().optional(),
    require_coverage: z.boolean().optional(),
  })
  .strict();

const releaseSchema = z.object({ reason: z.string().max(500).nullable().optional() }).strict();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function uuidParam(c: ParamCtx, name: string, what: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", `${what} not found`);
  return parsed.data;
}

function currencyQuery(c: Ctx): string {
  const parsed = currencySchema.safeParse(c.req.query("currency"));
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: currency");
  return parsed.data;
}

function reserveStatusQuery(c: Ctx): ReserveStatus | undefined {
  const raw = c.req.query("status");
  if (!raw) return undefined;
  if (raw !== "ACTIVE" && raw !== "RELEASED") throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
  return raw;
}

interface LedgerServices {
  readonly ledger: LedgerRepository;
  readonly adjustments: AdjustmentService;
  readonly reserves: ReserveService;
}

/** Per-request services over the bound D1 (same construction as `buildPayoutService`). */
export function buildLedgerServices(c: Ctx): LedgerServices {
  const db = c.env.DB;
  const ledger = new LedgerRepository(db);
  const audit = new AuditRepository(db);
  return {
    ledger,
    adjustments: new AdjustmentService(new AdjustmentRepository(db), ledger, audit),
    reserves: new ReserveService(new ReserveRepository(db), ledger, audit),
  };
}

// ---------------------------------------------------------------------------
// Shared handlers (tenant face and platform face differ only in the TenantContext)
// ---------------------------------------------------------------------------

async function adjustmentDetail(c: Ctx, tenant: TenantContext, adjustmentId: string): Promise<Response> {
  const svc = buildLedgerServices(c).adjustments;
  const adjustment = await svc.get(tenant, adjustmentId);
  if (!adjustment) throw new AppError(404, "NOT_FOUND", "financial adjustment not found");
  const history = await svc.history(tenant, adjustmentId);
  return c.json({ adjustment, history }, 200);
}

async function requestAdjustment(c: Ctx, tenant: TenantContext): Promise<Response> {
  const body = await parseJsonBody(c, adjustmentRequestSchema);
  const adjustment = await buildLedgerServices(c).adjustments.request(c.get("auth"), tenant, body, meta(c));
  return c.json({ adjustment }, 201);
}

async function postAdjustment(c: Ctx, tenant: TenantContext, adjustmentId: string): Promise<Response> {
  const result = await buildLedgerServices(c).adjustments.post(c.get("auth"), tenant, adjustmentId, meta(c));
  return c.json(result, 200);
}

async function availableBalance(c: Ctx, tenant: TenantContext): Promise<Response> {
  const available = await buildLedgerServices(c).reserves.available(tenant, currencyQuery(c));
  return c.json({ available }, 200);
}

async function placeReserve(c: Ctx, tenant: TenantContext): Promise<Response> {
  const body = await parseJsonBody(c, reservePlaceSchema);
  const result = await buildLedgerServices(c).reserves.place(c.get("auth"), tenant, body, meta(c));
  return c.json(result, 201);
}

async function releaseReserve(c: Ctx, tenant: TenantContext, reserveId: string): Promise<Response> {
  const body = await parseJsonBody(c, releaseSchema);
  const reserve = await buildLedgerServices(c).reserves.release(c.get("auth"), tenant, reserveId, body.reason ?? null, meta(c));
  return c.json({ reserve }, 200);
}

// ---------------------------------------------------------------------------
// Tenant face
// ---------------------------------------------------------------------------

export const ledgerRoutes = new Hono<AppEnv>();

ledgerRoutes.get("/accounts", requirePermission("ledger.read"), async (c) => {
  const accounts = await buildLedgerServices(c).ledger.accountsOf(tenantIdOf(c.get("tenant")));
  return c.json({ items: [...accounts.values()] }, 200);
});

ledgerRoutes.get("/accounts/:accountId/balance", requirePermission("ledger.read"), async (c) => {
  const balance = await buildLedgerServices(c).ledger.computeBalance(tenantIdOf(c.get("tenant")), uuidParam(c, "accountId", "ledger account"));
  return c.json({ balance }, 200);
});

ledgerRoutes.get("/available", requirePermission("ledger.read"), (c) => availableBalance(c, c.get("tenant")));

ledgerRoutes.get("/journals/:journalId", requirePermission("ledger.read"), async (c) => {
  const tenantId = tenantIdOf(c.get("tenant"));
  const journalId = uuidParam(c, "journalId", "journal");
  const { ledger } = buildLedgerServices(c);
  const journal = await ledger.findJournal(tenantId, journalId);
  if (!journal) throw new AppError(404, "NOT_FOUND", "journal not found");
  const entries = await ledger.listEntries(tenantId, journalId);
  return c.json({ journal, entries }, 200);
});

ledgerRoutes.get("/adjustments/:adjustmentId", requirePermission("ledger.read"), (c) =>
  adjustmentDetail(c, c.get("tenant"), uuidParam(c, "adjustmentId", "financial adjustment")),
);

ledgerRoutes.post("/adjustments", requirePermission("ledger.adjust"), (c) => requestAdjustment(c, c.get("tenant")));

ledgerRoutes.post("/adjustments/:adjustmentId/post", requirePermission("ledger.adjust"), (c) =>
  postAdjustment(c, c.get("tenant"), uuidParam(c, "adjustmentId", "financial adjustment")),
);

ledgerRoutes.get("/reserves", requirePermission("ledger.read"), async (c) => {
  const status = reserveStatusQuery(c);
  const rawCurrency = c.req.query("currency");
  const currency = rawCurrency ? currencyQuery(c) : undefined;
  const items = await buildLedgerServices(c).reserves.list(c.get("tenant"), { ...(status ? { status } : {}), ...(currency ? { currency } : {}) });
  return c.json({ items }, 200);
});

ledgerRoutes.get("/reserves/:reserveId", requirePermission("ledger.read"), async (c) => {
  const reserve = await buildLedgerServices(c).reserves.get(c.get("tenant"), uuidParam(c, "reserveId", "reserve"));
  if (!reserve) throw new AppError(404, "NOT_FOUND", "reserve not found");
  return c.json({ reserve }, 200);
});

ledgerRoutes.post("/reserves", requirePermission("ledger.reserve"), (c) => placeReserve(c, c.get("tenant")));

ledgerRoutes.post("/reserves/:reserveId/release", requirePermission("ledger.reserve"), (c) =>
  releaseReserve(c, c.get("tenant"), uuidParam(c, "reserveId", "reserve")),
);

// ---------------------------------------------------------------------------
// Platform face
// ---------------------------------------------------------------------------

/**
 * PLATFORM staff acting on a target tenant's ledger: the caller's PLATFORM
 * organization type, role and permissions are kept; only the organization id
 * is replaced by the target tenant (`tenantFor(target, "PLATFORM")` rule).
 * Non-PLATFORM callers are refused 403 before any read.
 */
function platformTenant(c: Ctx): TenantContext {
  const tenant = c.get("tenant");
  if (tenant.organization.type !== "PLATFORM") throw new AppError(403, "FORBIDDEN", "platform organization required");
  const targetOrgId = uuidParam(c, "tenantOrgId", "financial adjustment");
  return { ...tenant, organization: { ...tenant.organization, id: targetOrgId } };
}

export const platformLedgerRoutes = new Hono<AppEnv>();
const T = "/ledger/tenants/:tenantOrgId";

platformLedgerRoutes.get(`${T}/adjustments/:adjustmentId`, requirePermission("ledger.read"), (c) =>
  adjustmentDetail(c, platformTenant(c), uuidParam(c, "adjustmentId", "financial adjustment")),
);

platformLedgerRoutes.post(`${T}/adjustments`, requirePermission("ledger.adjust"), (c) => requestAdjustment(c, platformTenant(c)));

platformLedgerRoutes.post(`${T}/adjustments/:adjustmentId/approve`, requirePermission("ledger.approve"), async (c) => {
  const tenant = platformTenant(c);
  const body = await parseJsonBody(c, decisionSchema);
  const adjustment = await buildLedgerServices(c).adjustments.approve(
    c.get("auth"),
    tenant,
    uuidParam(c, "adjustmentId", "financial adjustment"),
    body.note ?? null,
    meta(c),
  );
  return c.json({ adjustment }, 200);
});

platformLedgerRoutes.post(`${T}/adjustments/:adjustmentId/reject`, requirePermission("ledger.approve"), async (c) => {
  const tenant = platformTenant(c);
  const body = await parseJsonBody(c, decisionSchema);
  const adjustment = await buildLedgerServices(c).adjustments.reject(
    c.get("auth"),
    tenant,
    uuidParam(c, "adjustmentId", "financial adjustment"),
    body.note ?? null,
    meta(c),
  );
  return c.json({ adjustment }, 200);
});

platformLedgerRoutes.post(`${T}/adjustments/:adjustmentId/post`, requirePermission("ledger.adjust"), (c) =>
  postAdjustment(c, platformTenant(c), uuidParam(c, "adjustmentId", "financial adjustment")),
);

platformLedgerRoutes.get(`${T}/available`, requirePermission("ledger.read"), (c) => availableBalance(c, platformTenant(c)));

platformLedgerRoutes.post(`${T}/reserves`, requirePermission("ledger.reserve"), (c) => placeReserve(c, platformTenant(c)));

platformLedgerRoutes.post(`${T}/reserves/:reserveId/release`, requirePermission("ledger.reserve"), (c) =>
  releaseReserve(c, platformTenant(c), uuidParam(c, "reserveId", "reserve")),
);
