/**
 * Notification policy (Phase 6 Unit 6; PRD §79–§80, §127).
 *
 * Three channels for the seven event types:
 *   IN_APP  — a `notifications` row that the recipient reads from the feed.
 *   EMAIL   — rendered + handed to the app's EMAIL `NotificationAdapter`
 *             (`LogNotificationAdapter` by default, `MemoryNotificationAdapter`
 *             in tests, a vendor bridge in production). Vendor failure is a
 *             FAILED row, never an exception (PRD §78).
 *   WEBHOOK — handed to `WebhookService.publish` under the idempotency key
 *             `notification:<dedupe_key>`; subscriptions / signing / retry are
 *             the webhook module's concern (Unit 4).
 *
 * Addressing: `user_id` set ⇒ one row per channel for that member;
 * `user_id` null ⇒ an org-wide IN_APP row (shared read state), one EMAIL row
 * per ACTIVE member (bounded fan-out), one WEBHOOK row.
 *
 * Preferences (§80): absence of a row ⇒ enabled. A disabled preference turns
 * the row into SUPPRESSED (still minted so the dedupe key is consumed).
 * `security_event` and `compliance_action` on IN_APP are LOCKED on — the
 * service refuses to store such a preference (409 PREFERENCE_LOCKED) and
 * ignores it on delivery; the 0012 CHECK is the last line of defence.
 *
 * Dedupe (§79): every emit carries a business `dedupe_key`. Row keys are
 * `<dedupe_key>|<channel>|<recipient>`; a replay with the same key returns
 * the rows already minted and performs no delivery (`replayed: true`).
 *
 * Feed: SENT IN_APP rows addressed to the caller or org-wide, newest first,
 * cursor-paginated; `unread_count` is computed with the same visibility.
 */
import type { NotificationAdapter } from "../../integrations/notification-adapter";
import { isNotificationEventType, NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "../../integrations/notification-adapter";
import { AppError } from "../../lib/errors";
import type { PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { WebhookService } from "../webhooks/service";
import {
  NOTIFICATION_DB_CHANNELS,
  NOTIFICATION_SEVERITIES,
  type NotificationDbChannel,
  type NotificationInsert,
  type NotificationRepository,
  type NotificationRow,
  type NotificationSeverity,
  type PreferenceRow,
} from "./repository";

export const TITLE_MAX_LENGTH = 200;
export const BODY_MAX_LENGTH = 4000;
export const DEDUPE_KEY_MAX_LENGTH = 200;
export const REFERENCE_MAX_LENGTH = 64;

/** Event types whose IN_APP channel can never be disabled (PRD §80). */
export const LOCKED_IN_APP_EVENTS: ReadonlySet<string> = new Set<NotificationEventType>(["security_event", "compliance_action"]);

export function isLockedPreference(eventType: string, channel: string): boolean {
  return channel === "IN_APP" && LOCKED_IN_APP_EVENTS.has(eventType);
}

export function isNotificationChannel(value: string): value is NotificationDbChannel {
  return (NOTIFICATION_DB_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationSeverity(value: string): value is NotificationSeverity {
  return (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);
}

export interface PublicNotification {
  id: string;
  organization_id: string;
  user_id: string | null;
  event_type: string;
  channel: NotificationDbChannel;
  severity: NotificationSeverity;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  reference_type: string | null;
  reference_id: string | null;
  dedupe_key: string | null;
  status: string;
  sent_at: string | null;
  read_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedResult {
  items: PublicNotification[];
  next_cursor: string | null;
  unread_count: number;
}

export interface PreferenceView {
  event_type: NotificationEventType;
  channel: NotificationDbChannel;
  enabled: boolean;
  /** True when the pair cannot be disabled (security-critical, IN_APP). */
  locked: boolean;
}

export interface PreferenceInput {
  event_type: string;
  channel: string;
  enabled: boolean;
}

export interface EmitInput {
  event_type: string;
  title: string;
  body: string;
  dedupe_key: string;
  severity?: string;
  payload?: Record<string, unknown> | null;
  reference_type?: string | null;
  reference_id?: string | null;
  /** Member of the tenant; null/undefined ⇒ org-wide. */
  user_id?: string | null;
  /** Defaults to all three channels. */
  channels?: string[];
}

export interface EmitResult {
  notifications: PublicNotification[];
  replayed: boolean;
}

export interface NotificationServiceDeps {
  /** EMAIL transport (PRD §78 adapter). A non-EMAIL adapter makes EMAIL rows FAILED (NO_EMAIL_ADAPTER). */
  emailAdapter: NotificationAdapter;
  webhooks: WebhookService;
  clock?: () => Date;
}

export class NotificationService {
  private readonly audit: AuditRepository;
  private readonly clock: () => Date;

  constructor(
    private readonly repo: NotificationRepository,
    db: D1Database,
    private readonly deps: NotificationServiceDeps,
  ) {
    this.audit = new AuditRepository(db);
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---- feed (`notifications.read`) ------------------------------------------------

  async feed(auth: AuthenticatedContext, tenant: TenantContext, page: PageRequest, unreadOnly: boolean): Promise<FeedResult> {
    this.ensurePermission(tenant, "notifications.read");
    const tenantId = tenantIdOf(tenant);
    const [pageResult, unread] = await Promise.all([
      this.repo.listFeed(tenantId, auth.user.id, page, { unreadOnly }),
      this.repo.countUnread(tenantId, auth.user.id),
    ]);
    return { items: pageResult.items.map(toPublic), next_cursor: pageResult.next_cursor, unread_count: unread };
  }

  async get(auth: AuthenticatedContext, tenant: TenantContext, id: string): Promise<PublicNotification> {
    this.ensurePermission(tenant, "notifications.read");
    const row = await this.repo.findFeedItem(tenantIdOf(tenant), auth.user.id, id);
    if (!row) throw notFound();
    return toPublic(row);
  }

  /** Idempotent: an already-read row is returned unchanged (200). Invisible rows → 404. */
  async markRead(auth: AuthenticatedContext, tenant: TenantContext, id: string, meta: RequestMeta): Promise<PublicNotification> {
    this.ensurePermission(tenant, "notifications.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.repo.findFeedItem(tenantId, auth.user.id, id);
    if (!row) throw notFound();
    if (row.read_at !== null) return toPublic(row);
    const now = this.now();
    await this.repo.markRead(tenantId, auth.user.id, id, now, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: auth.user.id,
        action: "notification.read",
        target_type: "notification",
        target_id: id,
        metadata: { event_type: row.event_type, org_wide: row.user_id === null },
        meta,
      }),
    ]);
    const after = await this.repo.findFeedItem(tenantId, auth.user.id, id);
    if (!after) throw notFound();
    return toPublic(after);
  }

  async markAllRead(auth: AuthenticatedContext, tenant: TenantContext, meta: RequestMeta): Promise<{ updated: number; unread_count: number }> {
    this.ensurePermission(tenant, "notifications.read");
    const tenantId = tenantIdOf(tenant);
    const now = this.now();
    const updated = await this.repo.markAllRead(tenantId, auth.user.id, now, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: auth.user.id,
        action: "notification.read_all",
        target_type: "notification",
        target_id: null,
        meta,
      }),
    ]);
    return { updated, unread_count: await this.repo.countUnread(tenantId, auth.user.id) };
  }

  // ---- preferences (`notifications.read`, own rows only) ----------------------

  /** Full 7×3 matrix with effective values — absent rows read as enabled. */
  async getPreferences(auth: AuthenticatedContext, tenant: TenantContext): Promise<PreferenceView[]> {
    this.ensurePermission(tenant, "notifications.read");
    const rows = await this.repo.listPreferences(tenantIdOf(tenant), auth.user.id);
    return buildMatrix(rows);
  }

  async putPreferences(auth: AuthenticatedContext, tenant: TenantContext, input: PreferenceInput[], meta: RequestMeta): Promise<PreferenceView[]> {
    this.ensurePermission(tenant, "notifications.read");
    const seen = new Set<string>();
    const prefs = input.map((p) => {
      if (!isNotificationEventType(p.event_type)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: event_type");
      if (!isNotificationChannel(p.channel)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: channel");
      const k = `${p.event_type}|${p.channel}`;
      if (seen.has(k)) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: duplicate preference ${p.event_type}/${p.channel}`);
      seen.add(k);
      if (!p.enabled && isLockedPreference(p.event_type, p.channel)) {
        throw new AppError(409, "PREFERENCE_LOCKED", `${p.event_type} cannot be disabled on ${p.channel}`);
      }
      return { event_type: p.event_type, channel: p.channel, enabled: p.enabled };
    });
    if (prefs.length > 0) {
      await this.repo.upsertPreferences(tenantIdOf(tenant), auth.user.id, prefs, this.now(), [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: auth.user.id,
          action: "notification_preferences.updated",
          target_type: "notification_preferences",
          target_id: auth.user.id,
          metadata: { changes: prefs },
          meta,
        }),
      ]);
    }
    return this.getPreferences(auth, tenant);
  }

  // ---- producer face -----------------------------------------------------------------

  /**
   * Emit one business event to the tenant `tenantId`. Idempotent on
   * `dedupe_key`. `actor` is the PLATFORM principal (or null for in-process
   * producers); the audit row lands in the same batch as the notifications.
   */
  async emit(actor: AuthenticatedContext | null, tenantId: TenantId, input: EmitInput, meta: RequestMeta): Promise<EmitResult> {
    const v = validateEmit(input);

    const existing = await this.repo.findByDedupePrefix(tenantId, v.dedupe_key);
    if (existing.length > 0) return { notifications: existing.map(toPublic), replayed: true };

    const now = this.now();
    const inserts: NotificationInsert[] = [];
    const base = {
      event_type: v.event_type,
      severity: v.severity,
      title: v.title,
      body: v.body,
      payload: v.payload === null ? null : JSON.stringify(v.payload),
      reference_type: v.reference_type,
      reference_id: v.reference_id,
      created_at: now,
    };

    // Resolve recipients.
    let targeted: { user_id: string; email: string } | null = null;
    if (v.user_id !== null) {
      targeted = await this.repo.findActiveRecipient(tenantId, v.user_id);
      if (!targeted) throw new AppError(404, "MEMBER_NOT_FOUND", "Recipient is not an active member of the organization");
    }

    for (const channel of v.channels) {
      if (channel === "IN_APP") {
        const recipient = targeted?.user_id ?? null;
        const suppressed = recipient !== null && !(await this.isEnabled(tenantId, recipient, v.event_type, "IN_APP"));
        inserts.push({
          ...base,
          id: crypto.randomUUID(),
          user_id: recipient,
          channel: "IN_APP",
          dedupe_key: rowKey(v.dedupe_key, "IN_APP", recipient ?? "org"),
          status: suppressed ? "SUPPRESSED" : "SENT",
          sent_at: suppressed ? null : now,
          error_code: null,
        });
      } else if (channel === "EMAIL") {
        const recipients = targeted ? [targeted] : await this.repo.listActiveRecipients(tenantId);
        const disabled = targeted ? null : disabledUsers(await this.repo.listPreferencesForEvent(tenantId, v.event_type, "EMAIL"));
        for (const r of recipients) {
          const enabled = targeted ? await this.isEnabled(tenantId, r.user_id, v.event_type, "EMAIL") : !disabled!.has(r.user_id);
          const id = crypto.randomUUID();
          let status: NotificationInsert["status"] = "SUPPRESSED";
          let error_code: string | null = null;
          if (enabled) {
            const out = await this.deliverEmail(id, v, r.email);
            status = out.ok ? "SENT" : "FAILED";
            error_code = out.ok ? null : out.code;
          }
          inserts.push({
            ...base,
            id,
            user_id: r.user_id,
            channel: "EMAIL",
            dedupe_key: rowKey(v.dedupe_key, "EMAIL", r.user_id),
            status,
            sent_at: status === "SENT" ? now : null,
            error_code,
          });
        }
      } else {
        const suppressed = targeted !== null && !(await this.isEnabled(tenantId, targeted.user_id, v.event_type, "WEBHOOK"));
        const id = crypto.randomUUID();
        let status: NotificationInsert["status"] = "SUPPRESSED";
        let error_code: string | null = null;
        if (!suppressed) {
          const out = await this.publishWebhook(tenantId, v, now);
          status = out.ok ? "SENT" : "FAILED";
          error_code = out.ok ? null : out.code;
        }
        inserts.push({
          ...base,
          id,
          user_id: targeted?.user_id ?? null,
          channel: "WEBHOOK",
          dedupe_key: rowKey(v.dedupe_key, "WEBHOOK", "org"),
          status,
          sent_at: status === "SENT" ? now : null,
          error_code,
        });
      }
    }

    await this.repo.insertMany(tenantId, inserts, [
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor?.user.id ?? null,
        action: "notification.emitted",
        target_type: "notification_event",
        target_id: null,
        metadata: {
          event_type: v.event_type,
          dedupe_key: v.dedupe_key,
          channels: v.channels,
          org_wide: targeted === null,
          rows: inserts.map((i) => ({ id: i.id, channel: i.channel, status: i.status })),
        },
        meta,
      }),
    ]);

    const rows = await this.repo.findByDedupePrefix(tenantId, v.dedupe_key);
    return { notifications: rows.map(toPublic), replayed: false };
  }

  // ---- internals ------------------------------------------------------------------------

  private async isEnabled(tenantId: TenantId, userId: string, eventType: string, channel: NotificationDbChannel): Promise<boolean> {
    if (isLockedPreference(eventType, channel)) return true;
    const rows = await this.repo.listPreferences(tenantId, userId);
    const match = rows.find((r) => r.event_type === eventType && r.channel === channel);
    return match ? match.enabled === 1 : true;
  }

  private async deliverEmail(id: string, v: ValidatedEmit, to: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const adapter = this.deps.emailAdapter;
    if (adapter.channel !== "EMAIL") return { ok: false, code: "NO_EMAIL_ADAPTER" };
    try {
      const result = await adapter.deliver({ idempotency_key: id, event_type: v.event_type, to, subject: v.title, body: v.body });
      if (result.status === "FAILED") return { ok: false, code: result.failure_code ?? "EMAIL_SEND_FAILED" };
      return { ok: true };
    } catch {
      return { ok: false, code: "EMAIL_SEND_FAILED" };
    }
  }

  private async publishWebhook(tenantId: TenantId, v: ValidatedEmit, now: string): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      await this.deps.webhooks.publish(tenantId, {
        event_type: v.event_type,
        payload: {
          notification: { event_type: v.event_type, severity: v.severity, title: v.title, body: v.body },
          data: v.payload ?? {},
        },
        idempotency_key: `notification:${v.dedupe_key}`,
        reference_type: v.reference_type,
        reference_id: v.reference_id,
        occurred_at: now,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err instanceof AppError ? err.code : "WEBHOOK_PUBLISH_FAILED" };
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private ensurePermission(tenant: TenantContext, key: "notifications.read"): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `Missing permission: ${key}`);
  }
}

// ---- helpers ---------------------------------------------------------------------------

interface ValidatedEmit {
  event_type: NotificationEventType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  dedupe_key: string;
  payload: Record<string, unknown> | null;
  reference_type: string | null;
  reference_id: string | null;
  user_id: string | null;
  channels: NotificationDbChannel[];
}

function validateEmit(input: EmitInput): ValidatedEmit {
  if (!isNotificationEventType(input.event_type)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: event_type");
  const severity = input.severity ?? "INFO";
  if (!isNotificationSeverity(severity)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: severity");
  const title = input.title?.trim() ?? "";
  if (title.length < 1 || title.length > TITLE_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: title");
  const body = input.body ?? "";
  if (body.length > BODY_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: body");
  const dedupe_key = input.dedupe_key ?? "";
  if (dedupe_key.length < 1 || dedupe_key.length > DEDUPE_KEY_MAX_LENGTH || dedupe_key.includes("|")) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: dedupe_key");
  }
  const payload = input.payload ?? null;
  if (payload !== null && !isPlainObject(payload)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: payload must be an object");
  const rawChannels = input.channels ?? [...NOTIFICATION_DB_CHANNELS];
  if (rawChannels.length === 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: channels");
  const channels: NotificationDbChannel[] = [];
  for (const ch of rawChannels) {
    if (!isNotificationChannel(ch)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: channels");
    if (!channels.includes(ch)) channels.push(ch);
  }
  return {
    event_type: input.event_type,
    severity,
    title,
    body,
    dedupe_key,
    payload,
    reference_type: input.reference_type ?? null,
    reference_id: input.reference_id ?? null,
    user_id: input.user_id ?? null,
    channels,
  };
}

function rowKey(base: string, channel: NotificationDbChannel, recipient: string): string {
  return `${base}|${channel}|${recipient}`;
}

function disabledUsers(rows: PreferenceRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) if (r.enabled === 0) s.add(r.user_id);
  return s;
}

function buildMatrix(rows: PreferenceRow[]): PreferenceView[] {
  const byKey = new Map(rows.map((r) => [`${r.event_type}|${r.channel}`, r]));
  const out: PreferenceView[] = [];
  for (const event_type of NOTIFICATION_EVENT_TYPES) {
    for (const channel of NOTIFICATION_DB_CHANNELS) {
      const locked = isLockedPreference(event_type, channel);
      const row = byKey.get(`${event_type}|${channel}`);
      out.push({ event_type, channel, enabled: locked ? true : row ? row.enabled === 1 : true, locked });
    }
  }
  return out;
}

function notFound(): AppError {
  return new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toPublic(row: NotificationRow): PublicNotification {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed: unknown = JSON.parse(row.payload);
      payload = isPlainObject(parsed) ? parsed : null;
    } catch {
      payload = null;
    }
  }
  return { ...row, payload };
}
