/**
 * Webhook persistence over D1 (migration 0012 `webhook_subscriptions`,
 * `webhook_events`, `webhook_deliveries`, `webhook_delivery_attempts`;
 * PRD §73–§75). Pure data access — policy (who may do what, the delivery
 * state machine, signing) lives in `service.ts`; the 0012 triggers are the
 * last line of defence, never the first.
 *
 * Security invariants enforced HERE, at the SQL level:
 *   * `secret_ciphertext` is selected by exactly ONE method —
 *     `findSigningMaterial` — and only so the service can unwrap it at signing
 *     time. No list / get projection includes it (`SUBSCRIPTION_COLUMNS`).
 *   * Every tenant READ goes through `scopedQuery` (tenant id bound first at
 *     `organization_id = ?`). Writes bind the `TenantId` explicitly at the
 *     `organization_id` position (api-keys / attribution-repository pattern).
 *   * The only tenant-less reads are the delivery-queue scans used by the
 *     platform drain (`findDue`) and by-id loads used after a scoped lookup
 *     already proved ownership (`findDeliveryByIdUnscoped`).
 *   * Rows are never deleted (0012 `*_no_delete` triggers); events and
 *     attempts are append-only (0012 `*_APPEND_ONLY` triggers).
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";

export const WEBHOOK_SUBSCRIPTION_STATUSES = ["ACTIVE", "PAUSED", "DISABLED"] as const;
export type WebhookSubscriptionStatus = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ["QUEUED", "DELIVERING", "DELIVERED", "RETRY", "DEAD_LETTER"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** PRD §79 event names — mirrors the 0012 CHECK on `webhook_events.event_type`. */
export const WEBHOOK_EVENT_TYPES = [
  "offer_status_changed",
  "conversion_updated",
  "payout_status_changed",
  "billing_alert",
  "compliance_action",
  "security_event",
  "tracking_issue",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_ATTEMPT_OUTCOMES = ["SUCCESS", "HTTP_ERROR", "NETWORK_ERROR", "TIMEOUT", "SIGNING_ERROR"] as const;
export type WebhookAttemptOutcome = (typeof WEBHOOK_ATTEMPT_OUTCOMES)[number];

/** Projection shared by every subscription read path. `secret_ciphertext` is deliberately absent. */
export interface WebhookSubscriptionRow {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  url: string;
  description: string | null;
  /** JSON array text as stored. */
  event_types: string;
  key_version: string;
  secret_hint: string;
  secret_rotated_at: string | null;
  status: WebhookSubscriptionStatus;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookSubscriptionInsert {
  id: string;
  created_by_user_id: string | null;
  url: string;
  description: string | null;
  /** JSON array text. */
  event_types: string;
  secret_ciphertext: string;
  key_version: string;
  secret_hint: string;
}

export interface WebhookEventRow {
  id: string;
  organization_id: string;
  event_type: WebhookEventType;
  /** JSON object text as stored. */
  payload: string;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  occurred_at: string;
  created_at: string;
}

export interface WebhookEventInsert {
  id: string;
  event_type: WebhookEventType;
  payload: string;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  occurred_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  organization_id: string;
  subscription_id: string;
  event_id: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  replay_count: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_response_status: number | null;
  last_error_code: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
  last_replayed_at: string | null;
  last_replayed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryAttemptRow {
  id: string;
  delivery_id: string;
  attempt_number: number;
  signed_at: string;
  started_at: string;
  finished_at: string | null;
  outcome: WebhookAttemptOutcome;
  response_status: number | null;
  error_code: string | null;
  is_replay: number;
  triggered_by_user_id: string | null;
  created_at: string;
}

export interface WebhookDeliveryAttemptInsert {
  id: string;
  delivery_id: string;
  attempt_number: number;
  signed_at: string;
  started_at: string;
  finished_at: string | null;
  outcome: WebhookAttemptOutcome;
  response_status: number | null;
  error_code: string | null;
  is_replay: boolean;
  triggered_by_user_id: string | null;
}

/** What the service needs to sign one attempt — the ONLY read of `secret_ciphertext`. */
export interface WebhookSigningMaterial {
  subscription_id: string;
  url: string;
  status: WebhookSubscriptionStatus;
  secret_ciphertext: string;
  key_version: string;
}

const SUBSCRIPTION_COLUMNS = [
  "id",
  "organization_id",
  "created_by_user_id",
  "url",
  "description",
  "event_types",
  "key_version",
  "secret_hint",
  "secret_rotated_at",
  "status",
  "consecutive_failures",
  "disabled_at",
  "disabled_reason",
  "created_at",
  "updated_at",
].join(", ");

const EVENT_COLUMNS = ["id", "organization_id", "event_type", "payload", "reference_type", "reference_id", "idempotency_key", "occurred_at", "created_at"].join(", ");

const DELIVERY_COLUMNS = [
  "id",
  "organization_id",
  "subscription_id",
  "event_id",
  "status",
  "attempt_count",
  "max_attempts",
  "replay_count",
  "next_attempt_at",
  "last_attempt_at",
  "last_response_status",
  "last_error_code",
  "delivered_at",
  "dead_lettered_at",
  "last_replayed_at",
  "last_replayed_by_user_id",
  "created_at",
  "updated_at",
].join(", ");

const ATTEMPT_COLUMNS = [
  "id",
  "delivery_id",
  "attempt_number",
  "signed_at",
  "started_at",
  "finished_at",
  "outcome",
  "response_status",
  "error_code",
  "is_replay",
  "triggered_by_user_id",
  "created_at",
].join(", ");

/** Outcome of one attempt as applied to the delivery row (service decides, repository writes). */
export interface AttemptResolution {
  attempt: WebhookDeliveryAttemptInsert;
  /** DELIVERING → DELIVERED | RETRY | DEAD_LETTER */
  to: Extract<WebhookDeliveryStatus, "DELIVERED" | "RETRY" | "DEAD_LETTER">;
  now: string;
  next_attempt_at: string | null;
  response_status: number | null;
  error_code: string | null;
}

export class WebhookRepository {
  constructor(private readonly db: D1Database) {}

  // ---- subscriptions ------------------------------------------------------------

  insertSubscriptionStatement(tenantId: TenantId, input: WebhookSubscriptionInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO webhook_subscriptions
           (organization_id, id, created_by_user_id, url, description, event_types, secret_ciphertext, key_version, secret_hint, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        tenantId,
        input.id,
        input.created_by_user_id,
        input.url,
        input.description,
        input.event_types,
        input.secret_ciphertext,
        input.key_version,
        input.secret_hint,
      );
  }

  async insertSubscription(tenantId: TenantId, input: WebhookSubscriptionInsert, extra: D1PreparedStatement[] = []): Promise<void> {
    await this.db.batch([this.insertSubscriptionStatement(tenantId, input), ...extra]);
  }

  findSubscriptionById(tenantId: TenantId, id: string): Promise<WebhookSubscriptionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<WebhookSubscriptionRow>();
  }

  /** Cursor-paginated, optional status filter (PRD §127). Never full-table. */
  async listSubscriptions(
    tenantId: TenantId,
    page: PageRequest,
    filter: { status?: WebhookSubscriptionStatus } = {},
  ): Promise<Page<WebhookSubscriptionRow>> {
    const where = ["organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<WebhookSubscriptionRow>();
    return slicePage(res.results, page.limit);
  }

  /** ACTIVE subscriptions of the tenant whose `event_types` contains `*` or `eventType`. */
  async findActiveSubscriptionsFor(tenantId: TenantId, eventType: WebhookEventType): Promise<WebhookSubscriptionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions s
        WHERE s.organization_id = ? AND s.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM json_each(s.event_types) je WHERE je.value IN ('*', ?))
        ORDER BY s.created_at ASC, s.id ASC`,
      tenantId,
      eventType,
    ).all<WebhookSubscriptionRow>();
    return res.results;
  }

  /** Mutable fields only; status/secret have their own paths. Returns false when the row is DISABLED or missing. */
  async updateSubscription(
    tenantId: TenantId,
    id: string,
    patch: { url?: string; description?: string | null; event_types?: string },
    now: string,
    extra: D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.url !== undefined) {
      sets.push("url = ?");
      binds.push(patch.url);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      binds.push(patch.description);
    }
    if (patch.event_types !== undefined) {
      sets.push("event_types = ?");
      binds.push(patch.event_types);
    }
    sets.push("updated_at = ?");
    binds.push(now);
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE webhook_subscriptions SET ${sets.join(", ")} WHERE organization_id = ? AND id = ? AND status <> 'DISABLED'`)
        .bind(...binds, tenantId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /** ACTIVE ↔ PAUSED. The WHERE re-checks the expected `from` so a race cannot skip a state. */
  async setSubscriptionStatus(
    tenantId: TenantId,
    id: string,
    from: Extract<WebhookSubscriptionStatus, "ACTIVE" | "PAUSED">,
    to: Extract<WebhookSubscriptionStatus, "ACTIVE" | "PAUSED">,
    now: string,
    extra: D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE webhook_subscriptions SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = ?`)
        .bind(to, now, tenantId, id, from),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /** ACTIVE|PAUSED → DISABLED (terminal). Satisfies the 0012 CHECK `(status='DISABLED') = (disabled_at IS NOT NULL)`. */
  async disableSubscription(tenantId: TenantId, id: string, reason: string | null, now: string, extra: D1PreparedStatement[] = []): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE webhook_subscriptions SET status = 'DISABLED', disabled_at = ?, disabled_reason = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('ACTIVE','PAUSED')`,
        )
        .bind(now, reason, now, tenantId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /** Replace the wrapped secret (never on a DISABLED row). */
  async rotateSubscriptionSecret(
    tenantId: TenantId,
    id: string,
    material: { secret_ciphertext: string; key_version: string; secret_hint: string },
    now: string,
    extra: D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE webhook_subscriptions
              SET secret_ciphertext = ?, key_version = ?, secret_hint = ?, secret_rotated_at = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status <> 'DISABLED'`,
        )
        .bind(material.secret_ciphertext, material.key_version, material.secret_hint, now, now, tenantId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /**
   * The ONLY statement that reads `secret_ciphertext`. Used by the service
   * immediately before signing one attempt; the plaintext never leaves that
   * call. Tenant-scoped like every other read.
   */
  findSigningMaterial(tenantId: TenantId, subscriptionId: string): Promise<WebhookSigningMaterial | null> {
    return scopedQuery(
      this.db,
      `SELECT id AS subscription_id, url, status, secret_ciphertext, key_version
         FROM webhook_subscriptions WHERE organization_id = ? AND id = ?`,
      tenantId,
      subscriptionId,
    ).first<WebhookSigningMaterial>();
  }

  // ---- events (append-only) ------------------------------------------------------

  insertEventStatement(tenantId: TenantId, input: WebhookEventInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO webhook_events
           (organization_id, id, event_type, payload, reference_type, reference_id, idempotency_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(tenantId, input.id, input.event_type, input.payload, input.reference_type, input.reference_id, input.idempotency_key, input.occurred_at);
  }

  findEventById(tenantId: TenantId, id: string): Promise<WebhookEventRow | null> {
    return scopedQuery(this.db, `SELECT ${EVENT_COLUMNS} FROM webhook_events WHERE organization_id = ? AND id = ?`, tenantId, id).first<WebhookEventRow>();
  }

  findEventByIdempotencyKey(tenantId: TenantId, key: string): Promise<WebhookEventRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${EVENT_COLUMNS} FROM webhook_events WHERE organization_id = ? AND idempotency_key = ?`,
      tenantId,
      key,
    ).first<WebhookEventRow>();
  }

  // ---- deliveries ---------------------------------------------------------------

  /**
   * `INSERT OR IGNORE` on UNIQUE (subscription_id, event_id): a second fan-out
   * for the same pair finds the EXISTING row instead of failing or duplicating
   * (the service then reads deliveries back by event id).
   */
  insertDeliveryStatement(tenantId: TenantId, input: { id: string; subscription_id: string; event_id: string; next_attempt_at: string }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
           (organization_id, id, subscription_id, event_id, status, next_attempt_at)
         VALUES (?, ?, ?, ?, 'QUEUED', ?)`,
      )
      .bind(tenantId, input.id, input.subscription_id, input.event_id, input.next_attempt_at);
  }

  /** Event + its fan-out in one batch. */
  async publish(
    tenantId: TenantId,
    event: WebhookEventInsert,
    deliveries: Array<{ id: string; subscription_id: string; event_id: string; next_attempt_at: string }>,
    extra: D1PreparedStatement[] = [],
  ): Promise<void> {
    await this.db.batch([this.insertEventStatement(tenantId, event), ...deliveries.map((d) => this.insertDeliveryStatement(tenantId, d)), ...extra]);
  }

  findDeliveryById(tenantId: TenantId, id: string): Promise<WebhookDeliveryRow | null> {
    return scopedQuery(this.db, `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE organization_id = ? AND id = ?`, tenantId, id).first<WebhookDeliveryRow>();
  }

  /** Tenant-less by-id load for the platform drain, which found the id via `findDue`. */
  findDeliveryByIdUnscoped(id: string): Promise<WebhookDeliveryRow | null> {
    return this.db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = ?`).bind(id).first<WebhookDeliveryRow>();
  }

  async listDeliveriesForEvent(tenantId: TenantId, eventId: string): Promise<WebhookDeliveryRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE organization_id = ? AND event_id = ? ORDER BY created_at ASC, id ASC`,
      tenantId,
      eventId,
    ).all<WebhookDeliveryRow>();
    return res.results;
  }

  async listDeliveries(
    tenantId: TenantId,
    page: PageRequest,
    filter: { status?: WebhookDeliveryStatus; subscription_id?: string } = {},
  ): Promise<Page<WebhookDeliveryRow>> {
    const where = ["organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.subscription_id) {
      where.push("subscription_id = ?");
      binds.push(filter.subscription_id);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<WebhookDeliveryRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * Queue scan for the platform drain: QUEUED|RETRY rows whose
   * `next_attempt_at` has passed, oldest first. Deliberately NOT tenant-scoped
   * (the queue spans tenants); the only consumer is `WebhookService.processDue`,
   * which is reachable solely through a PLATFORM-gated route.
   */
  async findDue(now: string, limit: number): Promise<WebhookDeliveryRow[]> {
    const res = await this.db
      .prepare(
        `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
          WHERE status IN ('QUEUED','RETRY') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY next_attempt_at ASC, created_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(now, limit)
      .all<WebhookDeliveryRow>();
    return res.results;
  }

  /**
   * QUEUED|RETRY → DELIVERING and claim the attempt number in one statement.
   * `changes = 0` means another worker claimed it (or it is not due) — the
   * service treats that as "nothing to do", never as an error to the caller.
   */
  async claimDelivery(tenantId: TenantId, id: string, now: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE webhook_deliveries
            SET status = 'DELIVERING', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('QUEUED','RETRY')`,
      )
      .bind(now, now, tenantId, id)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Record the attempt (append-only) and move DELIVERING → `to` in one batch.
   * On SUCCESS the subscription's `consecutive_failures` resets; on failure it
   * increments. The delivery UPDATE re-checks DELIVERING so a stale resolver
   * can never overwrite a newer state.
   */
  async resolveAttempt(tenantId: TenantId, deliveryId: string, subscriptionId: string, r: AttemptResolution): Promise<boolean> {
    const a = r.attempt;
    const deliveredAt = r.to === "DELIVERED" ? r.now : null;
    const deadAt = r.to === "DEAD_LETTER" ? r.now : null;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO webhook_delivery_attempts
             (id, delivery_id, attempt_number, signed_at, started_at, finished_at, outcome, response_status, error_code, is_replay, triggered_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          a.id,
          a.delivery_id,
          a.attempt_number,
          a.signed_at,
          a.started_at,
          a.finished_at,
          a.outcome,
          a.response_status,
          a.error_code,
          a.is_replay ? 1 : 0,
          a.triggered_by_user_id,
        ),
      this.db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = ?, next_attempt_at = ?, last_response_status = ?, last_error_code = ?,
                  delivered_at = ?, dead_lettered_at = COALESCE(?, dead_lettered_at), updated_at = ?
            WHERE organization_id = ? AND id = ? AND status = 'DELIVERING'`,
        )
        .bind(r.to, r.next_attempt_at, r.response_status, r.error_code, deliveredAt, deadAt, r.now, tenantId, deliveryId),
      this.db
        .prepare(
          `UPDATE webhook_subscriptions
              SET consecutive_failures = CASE WHEN ? = 'SUCCESS' THEN 0 ELSE consecutive_failures + 1 END, updated_at = ?
            WHERE organization_id = ? AND id = ?`,
        )
        .bind(a.outcome, r.now, tenantId, subscriptionId),
    ]);
    return (results[1]?.meta?.changes ?? 0) > 0;
  }

  /**
   * Operator replay (§75): RETRY|DEAD_LETTER → QUEUED on the SAME row. The
   * WHERE excludes DELIVERED (and QUEUED/DELIVERING) so the 0012
   * `WEBHOOK_DELIVERY_FINAL` trigger is never the thing that says no.
   */
  async requeueForReplay(tenantId: TenantId, id: string, byUserId: string | null, now: string, extra: D1PreparedStatement[] = []): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = 'QUEUED', next_attempt_at = ?, replay_count = replay_count + 1,
                  last_replayed_at = ?, last_replayed_by_user_id = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('RETRY','DEAD_LETTER')`,
        )
        .bind(now, now, byUserId, now, tenantId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  // ---- attempts (append-only) ----------------------------------------------------

  /** Attempts of a delivery the caller has already loaded tenant-scoped (so ownership is proven). */
  async listAttempts(tenantId: TenantId, deliveryId: string): Promise<WebhookDeliveryAttemptRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${ATTEMPT_COLUMNS.split(", ")
        .map((c) => `a.${c}`)
        .join(", ")}
         FROM webhook_delivery_attempts a
         JOIN webhook_deliveries d ON d.id = a.delivery_id
        WHERE d.organization_id = ? AND a.delivery_id = ?
        ORDER BY a.attempt_number ASC`,
      tenantId,
      deliveryId,
    ).all<WebhookDeliveryAttemptRow>();
    return res.results;
  }
}
