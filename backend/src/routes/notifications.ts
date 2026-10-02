/**
 * Notification routes (Phase 6 Unit 6; PRD §79, §80, §127). Mounted by
 * `routes/organizations.ts` UNDER `/:orgId/notifications` (tenant face) and
 * `/:orgId/platform` (producer face), so every route inherits
 * `requireAuth → requireOrg`.
 *
 * Tenant face — the caller's OWN feed and preferences (`notifications.read`):
 *   GET  /organizations/:orgId/notifications                 → 200 { items, next_cursor, unread_count }   ?unread=true&limit=&cursor=
 *   GET  /organizations/:orgId/notifications/preferences     → 200 { preferences: PreferenceView[] }
 *   PUT  /organizations/:orgId/notifications/preferences     → 200 { preferences }    session only  (409 PREFERENCE_LOCKED)
 *   POST /organizations/:orgId/notifications/read-all        → 200 { updated, unread_count }   session only
 *   GET  /organizations/:orgId/notifications/:id             → 200 { notification }
 *   POST /organizations/:orgId/notifications/:id/read        → 200 { notification }   session only, idempotent
 *
 * API keys may READ the feed with scope `notifications.read`; the write
 * routes are `requireSession` (read state and preferences are personal).
 *
 * Producer face — PLATFORM staff (`webhooks.manage`, same gate as webhook
 * publishing) emit an event into a tenant:
 *   POST /organizations/:orgId/platform/notifications/tenants/:tenantOrgId/events
 *        → 201 { notifications, replayed:false } | 200 { …, replayed:true } (same dedupe_key)
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { tenantIdOf } from "../lib/tenant-scope";
import { parseJsonBody } from "../lib/validation";
import { requireScope, requireSession } from "../middleware/require-auth";
import { requirePermission, type TenantContext } from "../middleware/require-org";
import { NotificationRepository } from "../modules/notifications/repository";
import {
  BODY_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
  NotificationService,
  REFERENCE_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "../modules/notifications/service";
import { buildWebhookService } from "./webhooks";

type Ctx = Context<AppEnv>;
const idSchema = z.string().uuid();

const preferencesSchema = z
  .object({
    preferences: z
      .array(
        z
          .object({
            event_type: z.string().min(1).max(64),
            channel: z.string().min(1).max(16),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(21),
  })
  .strict();

const emitSchema = z
  .object({
    event_type: z.string().min(1).max(64),
    title: z.string().min(1).max(TITLE_MAX_LENGTH),
    body: z.string().max(BODY_MAX_LENGTH).default(""),
    dedupe_key: z.string().min(1).max(DEDUPE_KEY_MAX_LENGTH),
    severity: z.string().min(1).max(16).optional(),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
    reference_type: z.string().min(1).max(REFERENCE_MAX_LENGTH).nullable().optional(),
    reference_id: z.string().min(1).max(REFERENCE_MAX_LENGTH).nullable().optional(),
    user_id: z.string().uuid().nullable().optional(),
    channels: z.array(z.string().min(1).max(16)).min(1).max(3).optional(),
  })
  .strict();

function notificationId(c: Ctx): string {
  const parsed = idSchema.safeParse(c.req.param("notificationId"));
  if (!parsed.success) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
  return parsed.data;
}

/** Per-request service over the bound D1, the app's EMAIL adapter and the webhook service. */
export function buildNotificationService(c: Ctx): NotificationService {
  return new NotificationService(new NotificationRepository(c.env.DB), c.env.DB, {
    emailAdapter: c.get("notificationAdapter"),
    webhooks: buildWebhookService(c),
  });
}

/** PLATFORM staff acting on a target tenant (same rule as `routes/webhooks.ts`). */
function platformTenant(c: Ctx): TenantContext {
  const tenant = c.get("tenant");
  if (tenant.organization.type !== "PLATFORM") throw new AppError(403, "FORBIDDEN", "platform organization required");
  const parsed = idSchema.safeParse(c.req.param("tenantOrgId"));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", "Organization not found");
  return { ...tenant, organization: { ...tenant.organization, id: parsed.data } };
}

// ---- tenant face ----------------------------------------------------------------------

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.get("/", requireScope("notifications.read"), requirePermission("notifications.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const unread = c.req.query("unread");
  if (unread !== undefined && unread !== "" && unread !== "true" && unread !== "false") {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: unread");
  }
  const result = await buildNotificationService(c).feed(c.get("auth"), c.get("tenant"), page, unread === "true");
  return c.json(result, 200);
});

// Static segments are registered before `/:notificationId` so they are never shadowed.
notificationRoutes.get("/preferences", requireScope("notifications.read"), requirePermission("notifications.read"), async (c) => {
  const preferences = await buildNotificationService(c).getPreferences(c.get("auth"), c.get("tenant"));
  return c.json({ preferences }, 200);
});

notificationRoutes.put("/preferences", requireSession, requirePermission("notifications.read"), async (c) => {
  const body = await parseJsonBody(c, preferencesSchema);
  const preferences = await buildNotificationService(c).putPreferences(c.get("auth"), c.get("tenant"), body.preferences, meta(c));
  return c.json({ preferences }, 200);
});

notificationRoutes.post("/read-all", requireSession, requirePermission("notifications.read"), async (c) => {
  const result = await buildNotificationService(c).markAllRead(c.get("auth"), c.get("tenant"), meta(c));
  return c.json(result, 200);
});

notificationRoutes.get("/:notificationId", requireScope("notifications.read"), requirePermission("notifications.read"), async (c) => {
  const notification = await buildNotificationService(c).get(c.get("auth"), c.get("tenant"), notificationId(c));
  return c.json({ notification }, 200);
});

notificationRoutes.post("/:notificationId/read", requireSession, requirePermission("notifications.read"), async (c) => {
  const notification = await buildNotificationService(c).markRead(c.get("auth"), c.get("tenant"), notificationId(c), meta(c));
  return c.json({ notification }, 200);
});

// ---- producer face (PLATFORM) ------------------------------------------------------

export const platformNotificationRoutes = new Hono<AppEnv>();

platformNotificationRoutes.post("/notifications/tenants/:tenantOrgId/events", requireSession, requirePermission("webhooks.manage"), async (c) => {
  const tenant = platformTenant(c);
  const body = await parseJsonBody(c, emitSchema);
  const result = await buildNotificationService(c).emit(c.get("auth"), tenantIdOf(tenant), body, meta(c));
  return c.json(result, result.replayed ? 200 : 201);
});
