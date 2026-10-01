/**
 * Payment provider port (Phase 5 Unit 9).
 *
 * This file is the ONLY contract the payouts module has with the outside
 * payment world. It is deliberately isolated:
 *   - no ledger imports (a new provider must never touch the ledger),
 *   - no D1 / KV / Hono / request types,
 *   - no provider-specific types — every adapter maps its wire format into the
 *     neutral results below, so nothing provider-shaped leaks past the adapter.
 *
 * Money is INTEGER minor units + an upper-case ISO-4217 code. No floats, no
 * cross-currency math: a provider request is for exactly one (amount, currency).
 *
 * Idempotency: `idempotency_key` is the payouts.idempotency_key of the payout
 * (UNIQUE in 0011). A provider MUST return the same `provider_reference` for a
 * repeated key so a retry is visibly a replay (0011 payout_attempts) and never a
 * second payment.
 */

/** Neutral payout lifecycle as seen from the provider side. */
export const PROVIDER_PAYOUT_STATUSES = ["PENDING", "PAID", "FAILED", "CANCELLED"] as const;
export type ProviderPayoutStatus = (typeof PROVIDER_PAYOUT_STATUSES)[number];

export function isProviderPayoutStatus(value: string): value is ProviderPayoutStatus {
  return (PROVIDER_PAYOUT_STATUSES as readonly string[]).includes(value);
}

/** Stable, provider-neutral error codes. Adapters map their own codes onto these. */
export const PROVIDER_ERROR_CODES = [
  "PROVIDER_INVALID_AMOUNT",
  "PROVIDER_INVALID_CURRENCY",
  "PROVIDER_INVALID_METHOD_TOKEN",
  "PROVIDER_INVALID_IDEMPOTENCY_KEY",
  "PROVIDER_UNKNOWN_REFERENCE",
  "PROVIDER_NOT_CANCELLABLE",
  "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** True when the caller may retry later without changing the request (0011 §66 recoverable). */
  readonly retryable: boolean;
  constructor(code: ProviderErrorCode, detail?: string, retryable = false) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface CreatePayoutRequest {
  /** payouts.idempotency_key — same key ⇒ same provider_reference. 1..256 chars. */
  readonly idempotency_key: string;
  /** payout_methods.provider_token — the opaque destination the provider knows. */
  readonly method_token: string;
  /** INTEGER minor units, > 0. */
  readonly amount_minor: number;
  /** Upper-case 3-letter currency; must equal the method's currency (checked upstream and by the adapter). */
  readonly currency: string;
  /** Free-form statement text; adapters may truncate. */
  readonly description?: string;
}

export interface CreatePayoutResult {
  /** Adapter name — written to payouts.provider / payout_attempts. 1..64 chars. */
  readonly provider: string;
  /** Provider's reference — written to payouts.provider_reference (frozen once set). 1..256 chars. */
  readonly provider_reference: string;
  readonly status: ProviderPayoutStatus;
  /** True when this call matched an earlier request with the same idempotency key. */
  readonly replayed: boolean;
  /** Present when status is FAILED. GLOB [A-Z0-9_]*, 1..64 chars (payouts.failure_code). */
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface PayoutStatusResult {
  readonly provider: string;
  readonly provider_reference: string;
  readonly status: ProviderPayoutStatus;
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface CancelPayoutResult {
  readonly provider: string;
  readonly provider_reference: string;
  /** CANCELLED on success; adapters throw PROVIDER_NOT_CANCELLABLE when already PAID. */
  readonly status: ProviderPayoutStatus;
}

/** Verified, provider-neutral webhook content. */
export interface WebhookEvent {
  readonly provider: string;
  readonly provider_reference: string;
  readonly status: ProviderPayoutStatus;
  readonly failure_code?: string;
  readonly failure_reason?: string;
  /** Provider's own event id, when it has one (for dedupe upstream). */
  readonly event_id?: string;
}

export type VerifyWebhookResult = { ok: true; event: WebhookEvent } | { ok: false; code: "WEBHOOK_BAD_SIGNATURE" | "WEBHOOK_MALFORMED"; message: string };

/**
 * The port. Every method is async so a real HTTP adapter and the pure stub
 * share one signature. Implementations MUST NOT import from the ledger module.
 */
export interface PaymentProvider {
  /** Adapter name recorded on payouts.provider. */
  readonly name: string;
  createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult>;
  getStatus(provider_reference: string): Promise<PayoutStatusResult>;
  /** Payload is the raw request body (string); signature is the header value; secret is the per-tenant/provider webhook secret. */
  verifyWebhook(payload: string, signature: string, secret: string): Promise<VerifyWebhookResult>;
  cancelPayout(provider_reference: string): Promise<CancelPayoutResult>;
}

// ---- request validation shared by all adapters (pure) --------------------------------

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validates a CreatePayoutRequest the same way 0011 validates a payouts row:
 * integer minor units > 0 (safe range), upper-case 3-letter currency,
 * non-empty token and key within column limits. Throws ProviderError.
 */
export function assertCreatePayoutRequest(req: CreatePayoutRequest): void {
  const a = req.amount_minor;
  if (typeof a !== "number" || !Number.isFinite(a) || !Number.isInteger(a) || !Number.isSafeInteger(a)) {
    throw new ProviderError("PROVIDER_INVALID_AMOUNT", `amount_minor=${String(a)} is not a safe integer`);
  }
  if (a <= 0) {
    throw new ProviderError("PROVIDER_INVALID_AMOUNT", `amount_minor=${a} must be > 0`);
  }
  if (typeof req.currency !== "string" || !CURRENCY_RE.test(req.currency)) {
    throw new ProviderError("PROVIDER_INVALID_CURRENCY", `currency=${String(req.currency)}`);
  }
  if (typeof req.method_token !== "string" || req.method_token.length < 1 || req.method_token.length > 256) {
    throw new ProviderError("PROVIDER_INVALID_METHOD_TOKEN", "method_token must be 1..256 chars");
  }
  if (typeof req.idempotency_key !== "string" || req.idempotency_key.length < 1 || req.idempotency_key.length > 256) {
    throw new ProviderError("PROVIDER_INVALID_IDEMPOTENCY_KEY", "idempotency_key must be 1..256 chars");
  }
}
