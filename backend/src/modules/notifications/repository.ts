/**
 * Notification persistence over D1 (migration 0012 `notifications`,
 * `notification_preferences`; PRD §79–§80). Pure data access — channel
 * routing, preference evaluation and dedupe policy live in `service.ts`.
 *
 * Invariants enforced HERE, at the SQL level:
 *   * Every tenant READ goes through `scopedQuery` (first bind is the
 *     caller's resolved `TenantId`). Writes bind the `TenantId` explicitly at
 *     the `organization_id` position (same rule as `api-keys/repository.ts`).
 *   * The in-app feed (`listFeed`, `countUnread`, `findFeedItem`) only ever
 *     returns `channel = 'IN_APP' AND status = 'SENT'` rows addressed to the
 *     caller (`user_id = ?`) or to the whole org (`user_id IS NULL`). Other
 *     users' rows, EMAIL/WEBHOOK rows and SUPPRESSED/FAILED rows are
 *     invisible by construction.
 *   * Rows are never deleted or re-addressed (triggers
 *     `trg_notifications_no_delete` / `trg_notifications_frozen`); the only
 *     mutable columns are `read_at`, `status`, `sent_at`, `error_code`,
 *     `updated_at`.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";

export const NOTIFICATION_DB_CHANNELS = ["IN_APP", "EMAIL", "WEBHOOK"] as const;
export type NotificationDbChannel = (typeof NOTIFICATION_DB_CHANNELS)[number];

export const NOTIFICATION_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_STATUSES = ["PENDING", "SENT", "FAILED", "SUPPRESSED"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface NotificationRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  event_type: string;
  channel: NotificationDbChannel;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** JSON object text or null. */
  payload: string | null;
  reference_type: string | null;
  reference_id: string | null;
  dedupe_key: string | null;
  status: NotificationStatus;
  sent_at: string | null;
  read_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationInsert {
  id: string;
  user_id: string | null;
  event_type: string;
  channel: NotificationDbChannel;
  severity: NotificationSeverity;
  title: string;
  body: string;
  payload: string | null;
  reference_type: string | null;
  reference_id: string | null;
  dedupe_key: string | null;
  status: NotificationStatus;
  /** Must be non-null iff `status === 'SENT'` (0012 CHECK). */
  sent_at: string | null;
  error_code: string | null;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  user_id: string;
  organization_id: string;
  event_type: string;
  channel: NotificationDbChannel;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PreferenceUpsert {
  event_type: string;
  channel: NotificationDbChannel;
  enabled: boolean;
}

export interface MemberRecipient {
  user_id: string;
  email: string;
}

const COLUMNS = [
  "id",
  "organization_id",
  "user_id",
  "event_type",
  "channel",
  "severity",
  "title",
  "body",
  "payload",
  "reference_type",
  "reference_id",
  "dedupe_key",
  "status",
  "sent_at",
  "read_at",
  "error_code",
  "created_at",
  "updated_at",
].join(", ");

/** Visibility predicate shared by every feed read. Binds: user_id. */
const FEED_SCOPE = "channel = 'IN_APP' AND status = 'SENT' AND (user_id = ? OR user_id IS NULL)";

/** Hard cap on org-wide EMAIL fan-out — bounded by construction (PRD §127). */
export const MAX_FANOUT_RECIPIENTS = 500;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class NotificationRepository {
  constructor(private readonly db: D1Database) {}

  insertStatement(tenantId: TenantId, input: NotificationInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO notifications
           (organization_id, id, user_id, event_type, channel, severity, title, body, payload, reference_type, reference_id,
            dedupe_key, status, sent_at, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        input.id,
        input.user_id,
        input.event_type,
        input.channel,
        input.severity,
        input.title,
        input.body,
        input.payload,
        input.reference_type,
        input.reference_id,
        input.dedupe_key,
        input.status,
        input.sent_at,
        input.error_code,
        input.created_at,
        input.created_at,
      );
  }

  async insertMany(tenantId: TenantId, inputs: NotificationInsert[], extra: D1PreparedStatement[] = []): Promise<void> {
    const statements = [...inputs.map((i) => this.insertStatement(tenantId, i)), ...extra];
    if (statements.length === 0) return;
    await this.db.batch(statements);
  }

  /** Every row minted for a business dedupe key (`<key>|<channel>|<recipient>`), any channel/status. */
  async findByDedupePrefix(tenantId: TenantId, baseKey: string): Promise<NotificationRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM notifications
        WHERE organization_id = ? AND dedupe_key LIKE ? ESCAPE '\\'
        ORDER BY created_at ASC, id ASC`,
      tenantId,
      `${escapeLike(baseKey)}|%`,
    ).all<NotificationRow>();
    return res.results;
  }

  // ---- in-app feed -------------------------------------------------------------

  /** Cursor-paginated feed (PRD §127). Only SENT IN_APP rows visible to `userId`. */
  async listFeed(tenantId: TenantId, userId: string, page: PageRequest, filter: { unreadOnly?: boolean } = {}): Promise<Page<NotificationRow>> {
    const where = ["organization_id = ?", FEED_SCOPE];
    const binds: unknown[] = [userId];
    if (filter.unreadOnly) where.push("read_at IS NULL");
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM notifications
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<NotificationRow>();
    return slicePage(res.results, page.limit);
  }

  async countUnread(tenantId: TenantId, userId: string): Promise<number> {
    const row = await scopedQuery(
      this.db,
      `SELECT COUNT(*) AS n FROM notifications WHERE organization_id = ? AND ${FEED_SCOPE} AND read_at IS NULL`,
      tenantId,
      userId,
    ).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  findFeedItem(tenantId: TenantId, userId: string, id: string): Promise<NotificationRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM notifications WHERE organization_id = ? AND ${FEED_SCOPE} AND id = ?`,
      tenantId,
      userId,
      id,
    ).first<NotificationRow>();
  }

  /** Marks one visible unread row read. Returns false when nothing changed (already read / not visible). */
  async markRead(tenantId: TenantId, userId: string, id: string, now: string, extra: D1PreparedStatement[] = []): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE notifications SET read_at = ?, updated_at = ?
            WHERE organization_id = ? AND ${FEED_SCOPE} AND id = ? AND read_at IS NULL`,
        )
        .bind(now, now, tenantId, userId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /** Marks every visible unread row read; returns the number of rows updated. */
  async markAllRead(tenantId: TenantId, userId: string, now: string, extra: D1PreparedStatement[] = []): Promise<number> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE notifications SET read_at = ?, updated_at = ?
            WHERE organization_id = ? AND ${FEED_SCOPE} AND read_at IS NULL`,
        )
        .bind(now, now, tenantId, userId),
      ...extra,
    ]);
    return results[0]?.meta?.changes ?? 0;
  }

  // ---- preferences -------------------------------------------------------------

  async listPreferences(tenantId: TenantId, userId: string): Promise<PreferenceRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT id, user_id, organization_id, event_type, channel, enabled, created_at, updated_at
         FROM notification_preferences
        WHERE organization_id = ? AND user_id = ?
        ORDER BY event_type, channel`,
      tenantId,
      userId,
    ).all<PreferenceRow>();
    return res.results;
  }

  /** Preferences for several users at once (org-wide fan-out). Bounded by the recipient cap. */
  async listPreferencesForEvent(tenantId: TenantId, eventType: string, channel: NotificationDbChannel): Promise<PreferenceRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT id, user_id, organization_id, event_type, channel, enabled, created_at, updated_at
         FROM notification_preferences
        WHERE organization_id = ? AND event_type = ? AND channel = ?
        LIMIT ?`,
      tenantId,
      eventType,
      channel,
      MAX_FANOUT_RECIPIENTS,
    ).all<PreferenceRow>();
    return res.results;
  }

  /** Upsert (user, org, event, channel) → enabled. One batch, plus the audit row. */
  async upsertPreferences(tenantId: TenantId, userId: string, prefs: PreferenceUpsert[], now: string, extra: D1PreparedStatement[] = []): Promise<void> {
    const statements = prefs.map((p) =>
      this.db
        .prepare(
          `INSERT INTO notification_preferences (organization_id, id, user_id, event_type, channel, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, organization_id, event_type, channel)
           DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .bind(tenantId, crypto.randomUUID(), userId, p.event_type, p.channel, p.enabled ? 1 : 0, now, now),
    );
    await this.db.batch([...statements, ...extra]);
  }

  // ---- recipients ----------------------------------------------------------------

  /** ACTIVE members (ACTIVE users) of the tenant — the org-wide EMAIL audience. Capped. */
  async listActiveRecipients(tenantId: TenantId): Promise<MemberRecipient[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT m.user_id AS user_id, u.email AS email
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ?`,
      tenantId,
      MAX_FANOUT_RECIPIENTS,
    ).all<MemberRecipient>();
    return res.results;
  }

  findActiveRecipient(tenantId: TenantId, userId: string): Promise<MemberRecipient | null> {
    return scopedQuery(
      this.db,
      `SELECT m.user_id AS user_id, u.email AS email
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'`,
      tenantId,
      userId,
    ).first<MemberRecipient>();
  }
}
