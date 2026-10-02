/**
 * Webhook module — policy layer (Phase 6 Unit 4; PRD §73–§75, §79, §115).
 * SQL lives in `repository.ts`; HTTP lives behind the `WebhookTransport`
 * port; this class decides WHO may do WHAT and keeps the delivery state
 * machine honest BEFORE the 0012 triggers see the statement, so illegal
 * transitions surface as clean 409s rather than raw SQLite aborts.
 *
 * Secret handling (PRD §115 "secret never returned to frontend"):
 *   * A subscription secret is 32 CSPRNG bytes base64url. It is wrapped with
 *     the SAME AES-256-GCM vault as advertiser postback secrets
 *     (`postback-auth.ts`: `wrapPostbackSecret` / `unwrapPostbackSecret`,
 *     keyed by `POSTBACK_SECRET_KEY`) — 0012's
 *     `secret_ciphertext / key_version / secret_hint` columns were shaped for
 *     exactly that. The plaintext is returned ONCE (create / rotate-secret),
 *     unwrapped again only inside `attempt()` to sign one request, and never
 *     logged, audited or stored in an attempt row.
 *   * `list` / `get` return `PublicWebhookSubscription`, built from a
 *     projection that cannot contain the ciphertext.
 *
 * Signing (PRD §74 "signed payloads"): the receiver verifies
 *   HMAC-SHA-256(secret, "POST\n<path>\n<timestamp>\n<event_id>\n<sha256(body)>")
 * — the Phase 3 postback canonical string with the event id in the nonce
 * slot (`signPostback` reused directly). Headers carry timestamp, event id,
 * subscription id and the hex signature. A replay (§75) re-sends the SAME
 * event id, so a receiver that stores event ids processes each business
 * event exactly once no matter how many deliveries/attempts it took.
 *
 * Delivery state machine (mirrors `trg_webhook_deliveries_legal_transition`):
 *   QUEUED → DELIVERING → DELIVERED | RETRY | DEAD_LETTER
 *   RETRY  → DELIVERING | DEAD_LETTER | QUEUED (replay)
 *   DEAD_LETTER → QUEUED (replay) · DELIVERED is terminal.
 * There is no scheduler binding in this runtime, so retries are PULLED:
 * `processDue()` (platform-only route) drains rows whose `next_attempt_at`
 * has passed; `attempt()` can also be invoked for one delivery.
 *
 * Error codes: WEBHOOK_SUBSCRIPTION_NOT_FOUND 404 · WEBHOOK_DELIVERY_NOT_FOUND
 *   404 · WEBHOOK_EVENT_NOT_FOUND 404 · WEBHOOK_SUBSCRIPTION_FINAL 409 ·
 *   WEBHOOK_SUBSCRIPTION_NOT_ACTIVE / _NOT_PAUSED 409 · WEBHOOK_DELIVERY_FINAL
 *   409 · WEBHOOK_DELIVERY_NOT_REPLAYABLE 409 · WEBHOOK_DELIVERY_NOT_DUE 409 ·
 *   WEBHOOK_EVENT_DUPLICATE 409 · WEBHOOK_VAULT_UNAVAILABLE 503 ·
 *   FORBIDDEN 403 · VALIDATION_ERROR 400
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import { randomBytes, toBase64Url } from "../auth/crypto-utils";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { PermissionKey } from "../rbac/permissions";
import {
  CURRENT_KEY_VERSION,
  PostbackVaultError,
  secretHint,
  signPostback,
  unwrapPostbackSecret,
  verifyPostbackSignature,
  wrapPostbackSecret,
} from "../tracking/postback-auth";
import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type WebhookDeliveryAttemptRow,
  type WebhookDeliveryRow,
  type WebhookDeliveryStatus,
  type WebhookEventRow,
  type WebhookEventType,
  type WebhookRepository,
  type WebhookSubscriptionRow,
  type WebhookSubscriptionStatus,
} from "./repository";
import type { WebhookRequest, WebhookTransport } from "./transport";

export const WEBHOOK_HEADERS = {
  timestamp: "x-tvh-timestamp",
  eventId: "x-tvh-event-id",
  eventType: "x-tvh-event-type",
  subscriptionId: "x-tvh-subscription-id",
  signature: "x-tvh-signature",
  delivery: "x-tvh-delivery-id",
} as const;

/** Canonical path the receiver must use when recomputing the signature (host-independent). */
export const WEBHOOK_SIGNATURE_PATH = "/webhook";
export const URL_MAX_LENGTH = 2048;
export const DESCRIPTION_MAX_LENGTH = 500;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Back-off schedule in seconds by attempt number (1-based); last value repeats. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600] as const;
/** After this many consecutive failures the subscription is auto-DISABLED (§75 "endpoint verification failure"). */
export const AUTO_DISABLE_AFTER_FAILURES = 25;
export const PROCESS_BATCH_MAX = 100;
const SECRET_BYTES = 32;
const IDEMPOTENCY_KEY_MAX = 200;

export interface PublicWebhookSubscription {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  url: string;
  description: string | null;
  event_types: string[];
  secret_hint: string;
  secret_rotated_at: string | null;
  status: WebhookSubscriptionStatus;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Returned ONLY by create / rotateSecret. */
export interface IssuedWebhookSubscription extends PublicWebhookSubscription {
  /** The signing secret. Shown once; stored only wrapped. */
  secret: string;
}

export interface CreateSubscriptionInput {
  url: string;
  description?: string | null;
  event_types?: string[];
}

export interface UpdateSubscriptionInput {
  url?: string;
  description?: string | null;
  event_types?: string[];
}

export interface PublishInput {
  event_type: WebhookEventType;
  payload: Record<string, unknown>;
  /** Business-event key (e.g. `conversion:<id>:APPROVED`). Same key ⇒ same event, no second fan-out. */
  idempotency_key: string;
  reference_type?: string | null;
  reference_id?: string | null;
  occurred_at?: string;
}

export interface PublishResult {
  event: PublicWebhookEvent;
  deliveries: PublicWebhookDelivery[];
  /** true when the idempotency key already existed and NO new rows were written. */
  replayed: boolean;
}

export type PublicWebhookEvent = Omit<WebhookEventRow, "payload"> & { payload: Record<string, unknown> };
export type PublicWebhookDelivery = WebhookDeliveryRow;
export type PublicWebhookDeliveryAttempt = WebhookDeliveryAttemptRow;

export interface WebhookServiceOptions {
  /** POSTBACK_SECRET_KEY (base64url, 32 bytes). Absent ⇒ every secret operation fails CLOSED (503). */
  masterKey?: string;
  clock?: () => Date;
  timeoutMs?: number;
  maxAttempts?: number;
}

export function isWebhookSubscriptionStatus(v: string): v is WebhookSubscriptionStatus {
  return (WEBHOOK_SUBSCRIPTION_STATUSES as readonly string[]).includes(v);
}
export function isWebhookDeliveryStatus(v: string): v is WebhookDeliveryStatus {
  return (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(v);
}
export function isWebhookEventType(v: string): v is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v);
}

export class WebhookService {
  private readonly audit: AuditRepository;
  private readonly masterKey: string | undefined;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly repo: WebhookRepository,
    private readonly transport: WebhookTransport,
    db: D1Database,
    options: WebhookServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.masterKey = options.masterKey;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  // ---- subscriptions: reads (`webhooks.read`) ------------------------------------

  async listSubscriptions(tenant: TenantContext, page: PageRequest, status?: string): Promise<Page<PublicWebhookSubscription>> {
    this.ensurePermission(tenant, "webhooks.read");
    let filter: WebhookSubscriptionStatus | undefined;
    if (status !== undefined && status !== "") {
      if (!isWebhookSubscriptionStatus(status)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      filter = status;
    }
    const result = await this.repo.listSubscriptions(tenantIdOf(tenant), page, { status: filter });
    return { items: result.items.map(toPublicSubscription), next_cursor: result.next_cursor };
  }

  async getSubscription(tenant: TenantContext, id: string): Promise<PublicWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.read");
    return toPublicSubscription(await this.requireSubscription(tenant, id));
  }

  // ---- subscriptions: writes (`webhooks.manage`) ---------------------------------

  async createSubscription(ctx: AuthenticatedContext, tenant: TenantContext, input: CreateSubscriptionInput, meta: RequestMeta): Promise<IssuedWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.manage");
    const url = parseUrl(input.url);
    const description = parseDescription(input.description);
    const eventTypes = parseEventTypes(input.event_types);
    const secret = toBase64Url(randomBytes(SECRET_BYTES));
    const ciphertext = await this.wrap(secret);
    const id = crypto.randomUUID();
    const tid = tenantIdOf(tenant);
    await this.repo.insertSubscription(
      tid,
      {
        id,
        created_by_user_id: ctx.user.id,
        url,
        description,
        event_types: JSON.stringify(eventTypes),
        secret_ciphertext: ciphertext,
        key_version: CURRENT_KEY_VERSION,
        secret_hint: secretHint(secret),
      },
      [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "webhooks.subscription_created",
          target_type: "webhook_subscription",
          target_id: id,
          metadata: { url, event_types: eventTypes, secret_hint: secretHint(secret) },
          meta,
        }),
      ],
    );
    const row = await this.repo.findSubscriptionById(tid, id);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "Webhook subscription was not persisted");
    return { ...toPublicSubscription(row), secret };
  }

  async updateSubscription(ctx: AuthenticatedContext, tenant: TenantContext, id: string, input: UpdateSubscriptionInput, meta: RequestMeta): Promise<PublicWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.manage");
    const existing = await this.requireSubscription(tenant, id);
    this.assertNotDisabled(existing);
    const patch: { url?: string; description?: string | null; event_types?: string } = {};
    if (input.url !== undefined) patch.url = parseUrl(input.url);
    if (input.description !== undefined) patch.description = parseDescription(input.description);
    if (input.event_types !== undefined) patch.event_types = JSON.stringify(parseEventTypes(input.event_types));
    if (Object.keys(patch).length === 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: nothing to update");
    const tid = tenantIdOf(tenant);
    const ok = await this.repo.updateSubscription(tid, id, patch, this.now(), [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "webhooks.subscription_updated",
        target_type: "webhook_subscription",
        target_id: id,
        metadata: { changed: Object.keys(patch) },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "WEBHOOK_SUBSCRIPTION_FINAL", "The subscription is DISABLED and can no longer change");
    return toPublicSubscription(await this.requireSubscription(tenant, id));
  }

  /** ACTIVE → PAUSED (deliveries keep queueing; nothing is sent). */
  async pauseSubscription(ctx: AuthenticatedContext, tenant: TenantContext, id: string, meta: RequestMeta): Promise<PublicWebhookSubscription> {
    return this.toggle(ctx, tenant, id, "ACTIVE", "PAUSED", meta);
  }

  /** PAUSED → ACTIVE. */
  async resumeSubscription(ctx: AuthenticatedContext, tenant: TenantContext, id: string, meta: RequestMeta): Promise<PublicWebhookSubscription> {
    return this.toggle(ctx, tenant, id, "PAUSED", "ACTIVE", meta);
  }

  /** ACTIVE|PAUSED → DISABLED (terminal). */
  async disableSubscription(ctx: AuthenticatedContext, tenant: TenantContext, id: string, reason: string | null | undefined, meta: RequestMeta): Promise<PublicWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.manage");
    const existing = await this.requireSubscription(tenant, id);
    this.assertNotDisabled(existing);
    const why = parseDescription(reason);
    const ok = await this.repo.disableSubscription(tenantIdOf(tenant), id, why, this.now(), [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "webhooks.subscription_disabled",
        target_type: "webhook_subscription",
        target_id: id,
        metadata: { previous_status: existing.status, reason: why },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "WEBHOOK_SUBSCRIPTION_FINAL", "The subscription is already DISABLED");
    return toPublicSubscription(await this.requireSubscription(tenant, id));
  }

  /** Mint a fresh secret (shown once). The old secret stops validating immediately. */
  async rotateSecret(ctx: AuthenticatedContext, tenant: TenantContext, id: string, meta: RequestMeta): Promise<IssuedWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.manage");
    const existing = await this.requireSubscription(tenant, id);
    this.assertNotDisabled(existing);
    const secret = toBase64Url(randomBytes(SECRET_BYTES));
    const ciphertext = await this.wrap(secret);
    const ok = await this.repo.rotateSubscriptionSecret(
      tenantIdOf(tenant),
      id,
      { secret_ciphertext: ciphertext, key_version: CURRENT_KEY_VERSION, secret_hint: secretHint(secret) },
      this.now(),
      [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "webhooks.secret_rotated",
          target_type: "webhook_subscription",
          target_id: id,
          metadata: { secret_hint: secretHint(secret) },
          meta,
        }),
      ],
    );
    if (!ok) throw new AppError(409, "WEBHOOK_SUBSCRIPTION_FINAL", "The subscription is DISABLED and can no longer change");
    const row = await this.requireSubscription(tenant, id);
    return { ...toPublicSubscription(row), secret };
  }

  // ---- events: publish (internal producers; no caller permission — the org is the producer's) ----

  /**
   * Record the business event and fan out one QUEUED delivery per ACTIVE
   * subscription of `organizationId` subscribed to the event type. Repeating
   * the same `idempotency_key` returns the existing event and its deliveries
   * with `replayed: true` and writes NOTHING — this is how a retried state
   * transition cannot emit the same event twice (§75).
   *
   * Called by other modules with the tenant they already resolved — never
   * with a client-supplied organization id.
   */
  async publish(organizationId: TenantId, input: PublishInput): Promise<PublishResult> {
    if (!isWebhookEventType(input.event_type)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: event_type");
    const key = input.idempotency_key;
    if (typeof key !== "string" || key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: idempotency_key");
    if (!isPlainObject(input.payload)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: payload must be an object");

    const existing = await this.repo.findEventByIdempotencyKey(organizationId, key);
    if (existing) {
      return { event: toPublicEvent(existing), deliveries: await this.repo.listDeliveriesForEvent(organizationId, existing.id), replayed: true };
    }

    const now = this.now();
    const eventId = crypto.randomUUID();
    const subs = await this.repo.findActiveSubscriptionsFor(organizationId, input.event_type);
    await this.repo.publish(
      organizationId,
      {
        id: eventId,
        event_type: input.event_type,
        payload: JSON.stringify(input.payload),
        reference_type: input.reference_type ?? null,
        reference_id: input.reference_id ?? null,
        idempotency_key: key,
        occurred_at: input.occurred_at ?? now,
      },
      subs.map((s) => ({ id: crypto.randomUUID(), subscription_id: s.id, event_id: eventId, next_attempt_at: now })),
    );
    const event = await this.repo.findEventById(organizationId, eventId);
    if (!event) {
      // UNIQUE(idempotency_key) raced with another producer: that event wins.
      const winner = await this.repo.findEventByIdempotencyKey(organizationId, key);
      if (!winner) throw new AppError(500, "INTERNAL_ERROR", "Webhook event was not persisted");
      return { event: toPublicEvent(winner), deliveries: await this.repo.listDeliveriesForEvent(organizationId, winner.id), replayed: true };
    }
    return { event: toPublicEvent(event), deliveries: await this.repo.listDeliveriesForEvent(organizationId, eventId), replayed: false };
  }

  // ---- deliveries: reads (`webhooks.read`) ---------------------------------------

  async listDeliveries(tenant: TenantContext, page: PageRequest, filter: { status?: string; subscription_id?: string } = {}): Promise<Page<PublicWebhookDelivery>> {
    this.ensurePermission(tenant, "webhooks.read");
    let status: WebhookDeliveryStatus | undefined;
    if (filter.status !== undefined && filter.status !== "") {
      if (!isWebhookDeliveryStatus(filter.status)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      status = filter.status;
    }
    const f: { status?: WebhookDeliveryStatus; subscription_id?: string } = {};
    if (status) f.status = status;
    if (filter.subscription_id) f.subscription_id = filter.subscription_id;
    return this.repo.listDeliveries(tenantIdOf(tenant), page, f);
  }

  async getDelivery(tenant: TenantContext, id: string): Promise<{ delivery: PublicWebhookDelivery; event: PublicWebhookEvent; attempts: PublicWebhookDeliveryAttempt[] }> {
    this.ensurePermission(tenant, "webhooks.read");
    const tid = tenantIdOf(tenant);
    const delivery = await this.requireDelivery(tenant, id);
    const event = await this.repo.findEventById(tid, delivery.event_id);
    if (!event) throw new AppError(404, "WEBHOOK_EVENT_NOT_FOUND", "Webhook event not found");
    return { delivery, event: toPublicEvent(event), attempts: await this.repo.listAttempts(tid, id) };
  }

  // ---- deliveries: attempt + drain -------------------------------------------------

  /**
   * Perform ONE attempt for a QUEUED|RETRY delivery: claim (→ DELIVERING),
   * sign, send through the transport, record the attempt, settle to
   * DELIVERED | RETRY | DEAD_LETTER. `tenant` is the delivery's own tenant
   * (resolved by the caller: a tenant-scoped route or the platform drain).
   *
   * Idempotent in effect: a DELIVERED row is refused before any claim
   * (409 WEBHOOK_DELIVERY_FINAL); a DELIVERING row is left alone (409
   * WEBHOOK_DELIVERY_NOT_DUE) so two drains cannot double-send.
   */
  async attempt(tenant: TenantContext, deliveryId: string, by: { user_id: string | null; is_replay: boolean } = { user_id: null, is_replay: false }): Promise<PublicWebhookDelivery> {
    const tid = tenantIdOf(tenant);
    const delivery = await this.requireDelivery(tenant, deliveryId);
    if (delivery.status === "DELIVERED") throw new AppError(409, "WEBHOOK_DELIVERY_FINAL", "The delivery is already DELIVERED");
    if (delivery.status !== "QUEUED" && delivery.status !== "RETRY") {
      throw new AppError(409, "WEBHOOK_DELIVERY_NOT_DUE", `The delivery is ${delivery.status} and cannot be attempted now`);
    }
    const startedAt = this.now();
    const claimed = await this.repo.claimDelivery(tid, deliveryId, startedAt);
    if (!claimed) throw new AppError(409, "WEBHOOK_DELIVERY_NOT_DUE", "The delivery was claimed by another worker");
    const claimedRow = await this.repo.findDeliveryById(tid, deliveryId);
    if (!claimedRow) throw new AppError(404, "WEBHOOK_DELIVERY_NOT_FOUND", "Webhook delivery not found");
    const attemptNumber = claimedRow.attempt_count;
    const isReplay = by.is_replay || claimedRow.replay_count > 0;

    const event = await this.repo.findEventById(tid, delivery.event_id);
    const material = await this.repo.findSigningMaterial(tid, delivery.subscription_id);
    const signedAt = startedAt;
    let outcome: "SUCCESS" | "HTTP_ERROR" | "NETWORK_ERROR" | "TIMEOUT" | "SIGNING_ERROR";
    let responseStatus: number | null = null;
    let errorCode: string | null = null;

    if (!event || !material) {
      outcome = "SIGNING_ERROR";
      errorCode = "MISSING_EVENT_OR_SUBSCRIPTION";
    } else if (material.status !== "ACTIVE") {
      // PAUSED / DISABLED endpoint: do not send; park as RETRY (paused) or dead-letter (disabled).
      outcome = "SIGNING_ERROR";
      errorCode = material.status === "PAUSED" ? "SUBSCRIPTION_PAUSED" : "SUBSCRIPTION_DISABLED";
    } else {
      let req: WebhookRequest | null = null;
      try {
        const secret = await unwrapPostbackSecret(this.masterKey, material.secret_ciphertext);
        req = await this.buildRequest(material.url, material.subscription_id, delivery.id, event, secret, signedAt);
      } catch (err) {
        if (!(err instanceof PostbackVaultError)) throw err;
        outcome = "SIGNING_ERROR";
        errorCode = "VAULT_UNAVAILABLE";
      }
      if (req) {
        const result = await this.transport.send(req, this.timeoutMs);
        if (result.kind === "response") {
          responseStatus = result.status;
          if (result.status >= 200 && result.status < 300) outcome = "SUCCESS";
          else {
            outcome = "HTTP_ERROR";
            errorCode = `HTTP_${result.status}`;
          }
        } else if (result.kind === "timeout") {
          outcome = "TIMEOUT";
          errorCode = "TIMEOUT";
        } else {
          outcome = "NETWORK_ERROR";
          errorCode = result.code.slice(0, 64);
        }
      } else {
        outcome = "SIGNING_ERROR";
        errorCode = errorCode ?? "SIGNING_ERROR";
      }
    }

    const finishedAt = this.now();
    const exhausted = attemptNumber >= claimedRow.max_attempts || errorCode === "SUBSCRIPTION_DISABLED";
    const to = outcome === "SUCCESS" ? "DELIVERED" : exhausted ? "DEAD_LETTER" : "RETRY";
    const nextAt = to === "RETRY" ? this.backoffFrom(finishedAt, attemptNumber) : null;
    await this.repo.resolveAttempt(tid, deliveryId, delivery.subscription_id, {
      attempt: {
        id: crypto.randomUUID(),
        delivery_id: deliveryId,
        attempt_number: attemptNumber,
        signed_at: signedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        outcome,
        response_status: responseStatus,
        error_code: errorCode,
        is_replay: isReplay,
        triggered_by_user_id: by.user_id,
      },
      to,
      now: finishedAt,
      next_attempt_at: nextAt,
      response_status: responseStatus,
      error_code: errorCode,
    });

    if (outcome !== "SUCCESS" && material && material.status === "ACTIVE") await this.maybeAutoDisable(tid, material.subscription_id, finishedAt);

    const settled = await this.repo.findDeliveryById(tid, deliveryId);
    if (!settled) throw new AppError(404, "WEBHOOK_DELIVERY_NOT_FOUND", "Webhook delivery not found");
    return settled;
  }

  /**
   * Platform drain: attempt every due QUEUED|RETRY delivery (oldest first,
   * bounded by `limit`). Each delivery runs under ITS OWN tenant id — the
   * platform caller's identity is only the authorization to run the drain.
   */
  async processDue(platform: TenantContext, limit: number = PROCESS_BATCH_MAX): Promise<{ processed: number; delivered: number; retry: number; dead_letter: number }> {
    this.ensurePermission(platform, "webhooks.manage");
    if (platform.organization.type !== "PLATFORM") throw new AppError(403, "FORBIDDEN", "platform organization required");
    const cap = Math.max(1, Math.min(PROCESS_BATCH_MAX, Math.floor(limit)));
    const due = await this.repo.findDue(this.now(), cap);
    const out = { processed: 0, delivered: 0, retry: 0, dead_letter: 0 };
    for (const d of due) {
      const tenant = this.tenantFor(platform, d.organization_id);
      let settled: PublicWebhookDelivery;
      try {
        settled = await this.attempt(tenant, d.id);
      } catch (err) {
        if (err instanceof AppError && err.status === 409) continue; // claimed elsewhere / already final
        throw err;
      }
      out.processed += 1;
      if (settled.status === "DELIVERED") out.delivered += 1;
      else if (settled.status === "RETRY") out.retry += 1;
      else if (settled.status === "DEAD_LETTER") out.dead_letter += 1;
    }
    return out;
  }

  // ---- replay (`webhooks.replay`, PLATFORM operators only per 0012 grants) --------

  /**
   * §75 operator replay: RETRY|DEAD_LETTER → QUEUED on the SAME delivery row,
   * then attempt immediately. The same event id is re-sent, so the receiver
   * sees the business event once. A DELIVERED delivery is REJECTED with 409
   * WEBHOOK_DELIVERY_FINAL at the service level (the 0012 trigger of the same
   * name is never reached); QUEUED/DELIVERING are 409
   * WEBHOOK_DELIVERY_NOT_REPLAYABLE (nothing to replay yet).
   */
  async replay(ctx: AuthenticatedContext, tenant: TenantContext, deliveryId: string, meta: RequestMeta): Promise<PublicWebhookDelivery> {
    this.ensurePermission(tenant, "webhooks.replay");
    const tid = tenantIdOf(tenant);
    const delivery = await this.requireDelivery(tenant, deliveryId);
    if (delivery.status === "DELIVERED") throw new AppError(409, "WEBHOOK_DELIVERY_FINAL", "The delivery is already DELIVERED and cannot be replayed");
    if (delivery.status !== "RETRY" && delivery.status !== "DEAD_LETTER") {
      throw new AppError(409, "WEBHOOK_DELIVERY_NOT_REPLAYABLE", `Only RETRY or DEAD_LETTER deliveries can be replayed (current: ${delivery.status})`);
    }
    const now = this.now();
    const ok = await this.repo.requeueForReplay(tid, deliveryId, ctx.user.id, now, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "webhooks.delivery_replayed",
        target_type: "webhook_delivery",
        target_id: deliveryId,
        metadata: { event_id: delivery.event_id, previous_status: delivery.status, replay_number: delivery.replay_count + 1 },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "WEBHOOK_DELIVERY_NOT_REPLAYABLE", "The delivery changed state and cannot be replayed");
    return this.attempt(tenant, deliveryId, { user_id: ctx.user.id, is_replay: true });
  }

  // ---- receiver-side helper (for SDK / tests): verify a signed request -------------

  /** Recompute and constant-time compare the signature a receiver sees. */
  static async verifySignature(secret: string, headers: Record<string, string>, body: string): Promise<boolean> {
    const ts = Number(headers[WEBHOOK_HEADERS.timestamp]);
    const eventId = headers[WEBHOOK_HEADERS.eventId];
    const sig = headers[WEBHOOK_HEADERS.signature];
    if (!Number.isInteger(ts) || !eventId || !sig) return false;
    return verifyPostbackSignature(secret, { method: "POST", path: WEBHOOK_SIGNATURE_PATH, timestamp: ts, nonce: eventId, body }, sig);
  }

  // ---- internals ---------------------------------------------------------------------

  private async buildRequest(url: string, subscriptionId: string, deliveryId: string, event: WebhookEventRow, secret: string, signedAt: string): Promise<WebhookRequest> {
    const body = JSON.stringify({
      id: event.id,
      type: event.event_type,
      occurred_at: event.occurred_at,
      reference: event.reference_type ? { type: event.reference_type, id: event.reference_id } : null,
      data: JSON.parse(event.payload) as Record<string, unknown>,
    });
    const timestamp = Math.floor(new Date(signedAt).getTime() / 1000);
    const signature = await signPostback(secret, { method: "POST", path: WEBHOOK_SIGNATURE_PATH, timestamp, nonce: event.id, body });
    return {
      url,
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "TrafficVaultHub-Webhooks/1",
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
        [WEBHOOK_HEADERS.eventId]: event.id,
        [WEBHOOK_HEADERS.eventType]: event.event_type,
        [WEBHOOK_HEADERS.subscriptionId]: subscriptionId,
        [WEBHOOK_HEADERS.delivery]: deliveryId,
        [WEBHOOK_HEADERS.signature]: signature,
      },
    };
  }

  private async maybeAutoDisable(tid: TenantId, subscriptionId: string, now: string): Promise<void> {
    const sub = await this.repo.findSubscriptionById(tid, subscriptionId);
    if (sub && sub.status === "ACTIVE" && sub.consecutive_failures >= AUTO_DISABLE_AFTER_FAILURES) {
      await this.repo.disableSubscription(tid, subscriptionId, `auto: ${sub.consecutive_failures} consecutive failures`, now);
    }
  }

  private backoffFrom(iso: string, attemptNumber: number): string {
    const idx = Math.min(Math.max(attemptNumber - 1, 0), RETRY_BACKOFF_SECONDS.length - 1);
    const seconds = RETRY_BACKOFF_SECONDS[idx] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1] ?? 60;
    return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
  }

  private async toggle(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    id: string,
    from: "ACTIVE" | "PAUSED",
    to: "ACTIVE" | "PAUSED",
    meta: RequestMeta,
  ): Promise<PublicWebhookSubscription> {
    this.ensurePermission(tenant, "webhooks.manage");
    const existing = await this.requireSubscription(tenant, id);
    this.assertNotDisabled(existing);
    if (existing.status !== from) {
      throw new AppError(409, from === "ACTIVE" ? "WEBHOOK_SUBSCRIPTION_NOT_ACTIVE" : "WEBHOOK_SUBSCRIPTION_NOT_PAUSED", `The subscription is ${existing.status}`);
    }
    const ok = await this.repo.setSubscriptionStatus(tenantIdOf(tenant), id, from, to, this.now(), [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: to === "PAUSED" ? "webhooks.subscription_paused" : "webhooks.subscription_resumed",
        target_type: "webhook_subscription",
        target_id: id,
        metadata: { previous_status: from },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "WEBHOOK_SUBSCRIPTION_NOT_ACTIVE", "The subscription changed state");
    return toPublicSubscription(await this.requireSubscription(tenant, id));
  }

  private tenantFor(platform: TenantContext, organizationId: string): TenantContext {
    return { ...platform, organization: { ...platform.organization, id: organizationId } };
  }

  private async wrap(secret: string): Promise<string> {
    try {
      return await wrapPostbackSecret(this.masterKey, secret);
    } catch (err) {
      if (err instanceof PostbackVaultError) throw new AppError(503, "WEBHOOK_VAULT_UNAVAILABLE", "Webhook secret storage is unavailable");
      throw err;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private ensurePermission(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `Missing required permission: ${key}`);
  }

  private async requireSubscription(tenant: TenantContext, id: string): Promise<WebhookSubscriptionRow> {
    const row = await this.repo.findSubscriptionById(tenantIdOf(tenant), id);
    if (!row) throw new AppError(404, "WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Webhook subscription not found");
    return row;
  }

  private async requireDelivery(tenant: TenantContext, id: string): Promise<WebhookDeliveryRow> {
    const row = await this.repo.findDeliveryById(tenantIdOf(tenant), id);
    if (!row) throw new AppError(404, "WEBHOOK_DELIVERY_NOT_FOUND", "Webhook delivery not found");
    return row;
  }

  private assertNotDisabled(row: WebhookSubscriptionRow): void {
    if (row.status === "DISABLED") throw new AppError(409, "WEBHOOK_SUBSCRIPTION_FINAL", "The subscription is DISABLED and can no longer change");
  }
}

// ---- pure helpers ---------------------------------------------------------------------

function parseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > URL_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: url");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request: url");
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: url must be https");
  return raw;
}

function parseDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > DESCRIPTION_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: description");
  const d = raw.trim();
  return d.length === 0 ? null : d;
}

function parseEventTypes(raw: unknown): string[] {
  if (raw === undefined) return ["*"];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > WEBHOOK_EVENT_TYPES.length + 1) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: event_types");
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string" || (t !== "*" && !isWebhookEventType(t))) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: event_types");
    out.add(t);
  }
  return out.has("*") ? ["*"] : Array.from(out).sort();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toPublicSubscription(row: WebhookSubscriptionRow): PublicWebhookSubscription {
  // Explicit field list — never spread the row, so a future column cannot leak by accident.
  return {
    id: row.id,
    organization_id: row.organization_id,
    created_by_user_id: row.created_by_user_id,
    url: row.url,
    description: row.description,
    event_types: JSON.parse(row.event_types) as string[],
    secret_hint: row.secret_hint,
    secret_rotated_at: row.secret_rotated_at,
    status: row.status,
    consecutive_failures: row.consecutive_failures,
    disabled_at: row.disabled_at,
    disabled_reason: row.disabled_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPublicEvent(row: WebhookEventRow): PublicWebhookEvent {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}
