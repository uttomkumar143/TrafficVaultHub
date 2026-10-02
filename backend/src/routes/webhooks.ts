/**
 * Webhook routes (Phase 6 Unit 4; PRD §73–§75, §79, §115). Two faces, both
 * mounted by `routes/organizations.ts` so every route inherits
 * `requireAuth → requireOrg` and adds its own `requirePermission`.
 *
 * Tenant face (`webhookRoutes`, mounted UNDER `/:orgId/webhooks`):
 *   GET    /                                   webhooks.read    → 200 { items, next_cursor }   ?status=&limit=&cursor=
 *   POST   /                                   webhooks.manage  → 201 { subscription }         (`subscription.secret` shown ONCE)
 *   GET    /deliveries                         webhooks.read    → 200 { items, next_cursor }   ?status=&subscription_id=&limit=&cursor=
 *   GET    /deliveries/:deliveryId             webhooks.read    → 200 { delivery, event, attempts }
 *   POST   /deliveries/:deliveryId/attempt     webhooks.manage  → 200 { delivery }             (one attempt for a QUEUED|RETRY row)
 *   POST   /deliveries/:deliveryId/replay      webhooks.replay  → 200 { delivery }             (RETRY|DEAD_LETTER → same row re-queued → attempted)
 *   GET    /:subscriptionId                    webhooks.read    → 200 { subscription }         (never the secret)
 *   PATCH  /:subscriptionId                    webhooks.manage  → 200 { subscription }
 *   POST   /:subscriptionId/pause              webhooks.manage  → 200 { subscription }
 *   POST   /:subscriptionId/resume             webhooks.manage  → 200 { subscription }
 *   POST   /:subscriptionId/disable            webhooks.manage  → 200 { subscription }         (terminal)
 *   POST   /:subscriptionId/rotate-secret      webhooks.manage  → 201 { subscription }         (`secret` shown ONCE)
 *
 * Platform face (`platformWebhookRoutes`, mounted UNDER `/:orgId/platform`
 * where `:orgId` is the PLATFORM organization — same tenancy rule as
 * `platformLedgerRoutes`: the caller keeps the PLATFORM type / role /
 * permissions, only the organization id is replaced by the target tenant):
 *   POST   /webhooks/process-due                                       webhooks.manage  → 200 { processed, delivered, retry, dead_letter }
 *   POST   /webhooks/tenants/:tenantOrgId/events                       webhooks.manage  → 201|200 { event, deliveries, replayed }
 *   GET    /webhooks/tenants/:tenantOrgId/deliveries                   webhooks.read    → 200 { items, next_cursor }
 *   GET    /webhooks/tenants/:tenantOrgId/deliveries/:deliveryId       webhooks.read    → 200 { delivery, event, attempts }
 *   POST   /webhooks/tenants/:tenantOrgId/deliveries/:deliveryId/replay webhooks.replay → 200 { delivery }
 *
 * `webhooks.replay` is granted to PLATFORM operators only (0012), so replay
 * is reached through the platform face in practice; the tenant-face replay
 * route exists for custom roles and is gated identically. `process-due` is
 * the pull drain (no scheduler binding): the service refuses non-PLATFORM
 * callers 403 and runs each due delivery under its own tenant id.
 *
 * Illegal transitions are 409 from the service — the 0012 triggers never
 * get to abort. Malformed ids → 404. The organization is ALWAYS a path
 * param, never a body/query value (PRD §94).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { tenantIdOf } from "../lib/tenant-scope";
import { parseJsonBody } from "../lib/validation";
import { requirePermission, type TenantContext } from "../middleware/require-org";
import { WEBHOOK_EVENT_TYPES, WebhookRepository } from "../modules/webhooks/repository";
import { DESCRIPTION_MAX_LENGTH, PROCESS_BATCH_MAX, URL_MAX_LENGTH, WebhookService } from "../modules/webhooks/service";

const eventTypeSchema = z.union([z.literal("*"), z.enum(WEBHOOK_EVENT_TYPES)]);

const createSchema = z
  .object({
    url: z.string().min(1).max(URL_MAX_LENGTH),
    description: z.string().max(DESCRIPTION_MAX_LENGTH).nullable().optional(),
    event_types: z.array(eventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length + 1).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    url: z.string().min(1).max(URL_MAX_LENGTH).optional(),
    description: z.string().max(DESCRIPTION_MAX_LENGTH).nullable().optional(),
    event_types: z.array(eventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length + 1).optional(),
  })
  .strict();

const disableSchema = z.object({ reason: z.string().max(DESCRIPTION_MAX_LENGTH).nullable().optional() }).strict();

const publishSchema = z
  .object({
    event_type: z.enum(WEBHOOK_EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
    idempotency_key: z.string().min(1).max(200),
    reference_type: z.string().min(1).max(64).nullable().optional(),
    reference_id: z.string().min(1).max(64).nullable().optional(),
    occurred_at: z.string().min(1).max(40).optional(),
  })
  .strict();

const processDueSchema = z.object({ limit: z.number().int().min(1).max(PROCESS_BATCH_MAX).optional() }).strict();

const idSchema = z.string().uuid();
type Ctx = Context<AppEnv>;

function uuidParam(c: Ctx, name: string, code: string, what: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError(404, code, `${what} not found`);
  return parsed.data;
}
const subscriptionId = (c: Ctx) => uuidParam(c, "subscriptionId", "WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription");
const deliveryId = (c: Ctx) => uuidParam(c, "deliveryId", "WEBHOOK_DELIVERY_NOT_FOUND", "Webhook delivery");

/** Body-less POST ⇒ `{}`; otherwise validated like `parseJsonBody`. */
async function optionalJsonBody<T>(c: Ctx, schema: z.ZodType<T>): Promise<Partial<T>> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const fields = Array.from(new Set(result.error.issues.map((i) => i.path.map(String).join(".") || "(root)")));
    throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${fields.join(", ")}`);
  }
  return result.data;
}

/** Per-request service over the bound D1, the app's transport and the postback vault key (same pattern as `routes/api-keys.ts`). */
export function buildWebhookService(c: Ctx): WebhookService {
  return new WebhookService(new WebhookRepository(c.env.DB), c.get("webhookTransport"), c.env.DB, { masterKey: c.env.POSTBACK_SECRET_KEY });
}

/**
 * PLATFORM staff acting on a target tenant's webhooks (`tenantFor(target,
 * "PLATFORM")` rule, as in `routes/ledger.ts`). Non-PLATFORM callers are
 * refused 403 before any read.
 */
function platformTenant(c: Ctx): TenantContext {
  const tenant = c.get("tenant");
  if (tenant.organization.type !== "PLATFORM") throw new AppError(403, "FORBIDDEN", "platform organization required");
  const targetOrgId = uuidParam(c, "tenantOrgId", "NOT_FOUND", "Organization");
  return { ...tenant, organization: { ...tenant.organization, id: targetOrgId } };
}

async function listDeliveries(c: Ctx, tenant: TenantContext) {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: { status?: string; subscription_id?: string } = {};
  const status = c.req.query("status");
  if (status !== undefined) filter.status = status;
  const sub = c.req.query("subscription_id");
  if (sub !== undefined && sub !== "") {
    if (!idSchema.safeParse(sub).success) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: subscription_id");
    filter.subscription_id = sub;
  }
  return c.json(await buildWebhookService(c).listDeliveries(tenant, page, filter), 200);
}

async function getDelivery(c: Ctx, tenant: TenantContext) {
  return c.json(await buildWebhookService(c).getDelivery(tenant, deliveryId(c)), 200);
}

async function replay(c: Ctx, tenant: TenantContext) {
  const delivery = await buildWebhookService(c).replay(c.get("auth"), tenant, deliveryId(c), meta(c));
  return c.json({ delivery }, 200);
}

// ---- tenant face ----------------------------------------------------------------------

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.get("/", requirePermission("webhooks.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  return c.json(await buildWebhookService(c).listSubscriptions(c.get("tenant"), page, c.req.query("status")), 200);
});

webhookRoutes.post("/", requirePermission("webhooks.manage"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const subscription = await buildWebhookService(c).createSubscription(c.get("auth"), c.get("tenant"), body, meta(c));
  c.header("cache-control", "no-store");
  return c.json({ subscription }, 201);
});

// Deliveries are registered BEFORE `/:subscriptionId` so the literal segment wins.
webhookRoutes.get("/deliveries", requirePermission("webhooks.read"), (c) => listDeliveries(c, c.get("tenant")));

webhookRoutes.get("/deliveries/:deliveryId", requirePermission("webhooks.read"), (c) => getDelivery(c, c.get("tenant")));

webhookRoutes.post("/deliveries/:deliveryId/attempt", requirePermission("webhooks.manage"), async (c) => {
  const delivery = await buildWebhookService(c).attempt(c.get("tenant"), deliveryId(c), { user_id: c.get("auth").user.id, is_replay: false });
  return c.json({ delivery }, 200);
});

webhookRoutes.post("/deliveries/:deliveryId/replay", requirePermission("webhooks.replay"), (c) => replay(c, c.get("tenant")));

webhookRoutes.get("/:subscriptionId", requirePermission("webhooks.read"), async (c) => {
  const subscription = await buildWebhookService(c).getSubscription(c.get("tenant"), subscriptionId(c));
  return c.json({ subscription }, 200);
});

webhookRoutes.patch("/:subscriptionId", requirePermission("webhooks.manage"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const subscription = await buildWebhookService(c).updateSubscription(c.get("auth"), c.get("tenant"), subscriptionId(c), body, meta(c));
  return c.json({ subscription }, 200);
});

webhookRoutes.post("/:subscriptionId/pause", requirePermission("webhooks.manage"), async (c) => {
  const subscription = await buildWebhookService(c).pauseSubscription(c.get("auth"), c.get("tenant"), subscriptionId(c), meta(c));
  return c.json({ subscription }, 200);
});

webhookRoutes.post("/:subscriptionId/resume", requirePermission("webhooks.manage"), async (c) => {
  const subscription = await buildWebhookService(c).resumeSubscription(c.get("auth"), c.get("tenant"), subscriptionId(c), meta(c));
  return c.json({ subscription }, 200);
});

webhookRoutes.post("/:subscriptionId/disable", requirePermission("webhooks.manage"), async (c) => {
  const body = await optionalJsonBody(c, disableSchema);
  const subscription = await buildWebhookService(c).disableSubscription(c.get("auth"), c.get("tenant"), subscriptionId(c), body.reason, meta(c));
  return c.json({ subscription }, 200);
});

webhookRoutes.post("/:subscriptionId/rotate-secret", requirePermission("webhooks.manage"), async (c) => {
  const subscription = await buildWebhookService(c).rotateSecret(c.get("auth"), c.get("tenant"), subscriptionId(c), meta(c));
  c.header("cache-control", "no-store");
  return c.json({ subscription }, 201);
});

// ---- platform face --------------------------------------------------------------------

export const platformWebhookRoutes = new Hono<AppEnv>();
const T = "/webhooks/tenants/:tenantOrgId";

platformWebhookRoutes.post("/webhooks/process-due", requirePermission("webhooks.manage"), async (c) => {
  const body = await optionalJsonBody(c, processDueSchema);
  return c.json(await buildWebhookService(c).processDue(c.get("tenant"), body.limit), 200);
});

platformWebhookRoutes.post(`${T}/events`, requirePermission("webhooks.manage"), async (c) => {
  const tenant = platformTenant(c);
  const body = await parseJsonBody(c, publishSchema);
  const result = await buildWebhookService(c).publish(tenantIdOf(tenant), body);
  return c.json(result, result.replayed ? 200 : 201);
});

platformWebhookRoutes.get(`${T}/deliveries`, requirePermission("webhooks.read"), (c) => listDeliveries(c, platformTenant(c)));

platformWebhookRoutes.get(`${T}/deliveries/:deliveryId`, requirePermission("webhooks.read"), (c) => getDelivery(c, platformTenant(c)));

platformWebhookRoutes.post(`${T}/deliveries/:deliveryId/replay`, requirePermission("webhooks.replay"), (c) => replay(c, platformTenant(c)));
