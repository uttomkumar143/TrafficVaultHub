/**
 * NotificationAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * Outbound delivery of a rendered notification over ONE external channel
 * (transactional email today; SMS / push later). The in-app channel writes to
 * the `notifications` table (0012) and the webhook channel goes through Unit 4's
 * WebhookService — neither is an external vendor, so neither is an adapter.
 *
 * Relationship to Phase 1's `EmailSender` (modules/auth/email.ts): that port is
 * the auth-flow sender (verification / reset tokens) and is wired into
 * `createApp` as `emailSender`. `NotificationAdapter` is the general port Unit 6
 * (Notifications) dispatches through. `EmailSenderNotificationAdapter` bridges
 * the two so a vendor that implements `EmailSender` is automatically a
 * notification channel — one vendor integration, both uses, zero changes to
 * calling code.
 *
 * Secrets: implementations never log recipient addresses un-redacted (reuse
 * `redactEmail`) and never log the body.
 */

import { redactEmail, type EmailSender } from "../modules/auth/email";

export const NOTIFICATION_CHANNELS = ["EMAIL", "SMS", "PUSH"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The seven Phase 6 event types (spec Unit 6; 0012 notifications.event_type CHECK). */
export const NOTIFICATION_EVENT_TYPES = [
  "offer_status_changed",
  "conversion_updated",
  "payout_status_changed",
  "billing_alert",
  "compliance_action",
  "security_event",
  "tracking_issue",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** A fully rendered message — templating happens upstream; the adapter only transports. */
export interface NotificationMessage {
  /** Caller-owned key (e.g. notifications.id) — same key ⇒ adapters may dedupe. 1..256 chars. */
  readonly idempotency_key: string;
  readonly event_type: NotificationEventType;
  /** Channel-specific address: email address, E.164 number, push token. */
  readonly to: string;
  readonly subject: string;
  /** Plain-text body. HTML is a vendor concern layered inside an adapter. */
  readonly body: string;
}

export const NOTIFICATION_DELIVERY_STATUSES = ["SENT", "QUEUED", "FAILED"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export interface NotificationDeliveryResult {
  readonly provider: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationDeliveryStatus;
  /** Vendor message id when it issues one. */
  readonly provider_reference?: string;
  /** Present when FAILED. GLOB [A-Z0-9_]*, 1..64 chars. */
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface NotificationAdapter {
  readonly name: string;
  readonly channel: NotificationChannel;
  /** Never throws for a vendor-side failure — returns status FAILED so the dispatcher can record it. */
  deliver(message: NotificationMessage): Promise<NotificationDeliveryResult>;
}

// ---- implementations -----------------------------------------------------------------

/** Default: a redacted structured log line only (mirrors `LogEmailSender`). Never logs body or full address. */
export class LogNotificationAdapter implements NotificationAdapter {
  readonly name = "log";
  readonly channel: NotificationChannel;
  constructor(channel: NotificationChannel = "EMAIL") {
    this.channel = channel;
  }
  async deliver(message: NotificationMessage): Promise<NotificationDeliveryResult> {
    console.log(
      JSON.stringify({
        event: "notification.queued",
        channel: this.channel,
        event_type: message.event_type,
        to: this.channel === "EMAIL" ? redactEmail(message.to) : "***",
        idempotency_key: message.idempotency_key,
        // subject/body intentionally omitted
      }),
    );
    return { provider: this.name, channel: this.channel, status: "QUEUED" };
  }
}

/** Test adapter — captures messages for assertions; dedupes on idempotency_key like a real vendor would. */
export class MemoryNotificationAdapter implements NotificationAdapter {
  readonly name = "memory";
  readonly channel: NotificationChannel;
  readonly delivered: NotificationMessage[] = [];
  private readonly seen = new Set<string>();
  /** When set, every deliver() after construction reports FAILED with this code (tests the failure path). */
  failWith: string | null = null;

  constructor(channel: NotificationChannel = "EMAIL") {
    this.channel = channel;
  }

  async deliver(message: NotificationMessage): Promise<NotificationDeliveryResult> {
    if (this.failWith !== null) {
      return { provider: this.name, channel: this.channel, status: "FAILED", failure_code: this.failWith, failure_reason: "memory adapter forced failure" };
    }
    const replayed = this.seen.has(message.idempotency_key);
    if (!replayed) {
      this.seen.add(message.idempotency_key);
      this.delivered.push(message);
    }
    return { provider: this.name, channel: this.channel, status: "SENT", provider_reference: `mem_${message.idempotency_key}` };
  }

  last(event_type?: NotificationEventType): NotificationMessage | undefined {
    const list = event_type ? this.delivered.filter((m) => m.event_type === event_type) : this.delivered;
    return list[list.length - 1];
  }
}

/**
 * Bridge: any `EmailSender` becomes an EMAIL `NotificationAdapter`.
 *
 * `EmailSender.send()` takes an `AuthEmail` (kind + to + raw token). A general
 * notification has no token, so the bridge needs a sender that also exposes a
 * free-form send. We model that as `GeneralEmailSender` — an EmailSender plus
 * `sendMessage(to, subject, body)`. Vendors implement both methods once.
 */
export interface GeneralEmailSender extends EmailSender {
  sendMessage(to: string, subject: string, body: string): Promise<{ provider_reference?: string } | void>;
}

export class EmailSenderNotificationAdapter implements NotificationAdapter {
  readonly name: string;
  readonly channel = "EMAIL" as const;
  constructor(
    private readonly sender: GeneralEmailSender,
    name = "email-sender",
  ) {
    this.name = name;
  }
  async deliver(message: NotificationMessage): Promise<NotificationDeliveryResult> {
    try {
      const out = await this.sender.sendMessage(message.to, message.subject, message.body);
      const ref = out && typeof out === "object" && typeof out.provider_reference === "string" ? out.provider_reference : undefined;
      return { provider: this.name, channel: "EMAIL", status: "SENT", ...(ref !== undefined ? { provider_reference: ref } : {}) };
    } catch (err) {
      // Vendor failure is a result, not an exception: the dispatcher records it and retries by policy.
      return {
        provider: this.name,
        channel: "EMAIL",
        status: "FAILED",
        failure_code: "EMAIL_SEND_FAILED",
        failure_reason: err instanceof Error ? err.name : "unknown",
      };
    }
  }
}
