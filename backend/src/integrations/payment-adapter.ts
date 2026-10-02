/**
 * PaymentAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * INBOUND money: collecting funds FROM an advertiser (prepaid top-up under a
 * PREPAID billing profile, or settling an issued invoice under POSTPAID/CREDIT —
 * Phase 5 Unit 8 `advertiser_billing_profiles`). This is the mirror image of
 * `PayoutAdapter` (money OUT to affiliates) and is deliberately a separate
 * contract: a card/bank acquirer (Stripe, Adyen, …) and a disbursement rail
 * (Wise, PayPal Payouts, …) are different vendors with different lifecycles.
 *
 * Isolation rules, identical to `modules/payouts/provider.ts`:
 *   - no ledger / D1 / KV / Hono / request imports — the adapter maps its wire
 *     format into the neutral results below; nothing vendor-shaped leaks past it.
 *   - money is INTEGER minor units + upper-case ISO-4217; no floats, no FX.
 *   - `idempotency_key` ⇒ one charge, ever. A repeated key returns the FIRST
 *     result with `replayed: true` (the advertiser is never charged twice).
 *   - the adapter never sees raw card data: `payment_method_token` is the
 *     opaque vault token the vendor issued client-side.
 *
 * Posting the resulting ADVERTISER_PREPAID credit / invoice settlement to the
 * ledger is the caller's job (billing service), never the adapter's.
 */

/** Neutral charge lifecycle as seen from the acquirer side. */
export const CHARGE_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED"] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export function isChargeStatus(value: string): value is ChargeStatus {
  return (CHARGE_STATUSES as readonly string[]).includes(value);
}

/** Stable, vendor-neutral error codes. Adapters map their own codes onto these. */
export const PAYMENT_ERROR_CODES = [
  "PAYMENT_INVALID_AMOUNT",
  "PAYMENT_INVALID_CURRENCY",
  "PAYMENT_INVALID_METHOD_TOKEN",
  "PAYMENT_INVALID_IDEMPOTENCY_KEY",
  "PAYMENT_UNKNOWN_REFERENCE",
  "PAYMENT_NOT_REFUNDABLE",
  "PAYMENT_DECLINED",
  "PAYMENT_UNAVAILABLE",
] as const;
export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  /** True when the caller may retry later without changing the request. */
  readonly retryable: boolean;
  constructor(code: PaymentErrorCode, detail?: string, retryable = false) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PaymentError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface CreateChargeRequest {
  /** Caller-owned key — same key ⇒ same charge_reference. 1..256 chars. */
  readonly idempotency_key: string;
  /** Opaque vendor-issued token for the advertiser's stored payment method. 1..256 chars. */
  readonly payment_method_token: string;
  /** INTEGER minor units, > 0. */
  readonly amount_minor: number;
  /** Upper-case 3-letter currency; must equal the billing profile currency (checked upstream and by the adapter). */
  readonly currency: string;
  /** Free-form statement descriptor; adapters may truncate. */
  readonly description?: string;
}

export interface CreateChargeResult {
  /** Adapter name. 1..64 chars. */
  readonly provider: string;
  /** Vendor's reference for this charge. 1..256 chars. */
  readonly charge_reference: string;
  readonly status: ChargeStatus;
  /** True when this call matched an earlier request with the same idempotency key. */
  readonly replayed: boolean;
  /** Present when status is FAILED. GLOB [A-Z0-9_]*, 1..64 chars. */
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface ChargeStatusResult {
  readonly provider: string;
  readonly charge_reference: string;
  readonly status: ChargeStatus;
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface RefundChargeResult {
  readonly provider: string;
  readonly charge_reference: string;
  /** REFUNDED on success; adapters throw PAYMENT_NOT_REFUNDABLE unless the charge SUCCEEDED. */
  readonly status: ChargeStatus;
}

/** Verified, vendor-neutral acquirer webhook content. */
export interface PaymentWebhookEvent {
  readonly provider: string;
  readonly charge_reference: string;
  readonly status: ChargeStatus;
  readonly failure_code?: string;
  readonly failure_reason?: string;
  /** Vendor's own event id, when it has one (for dedupe upstream). */
  readonly event_id?: string;
}

export type PaymentVerifyWebhookResult =
  | { ok: true; event: PaymentWebhookEvent }
  | { ok: false; code: "WEBHOOK_BAD_SIGNATURE" | "WEBHOOK_MALFORMED"; message: string };

/**
 * The port. Every method is async so a real HTTP adapter and the pure stub
 * share one signature. Implementations MUST NOT import from the ledger module.
 */
export interface PaymentAdapter {
  /** Adapter name recorded alongside the charge. */
  readonly name: string;
  createCharge(req: CreateChargeRequest): Promise<CreateChargeResult>;
  getChargeStatus(charge_reference: string): Promise<ChargeStatusResult>;
  /** Full refund of a SUCCEEDED charge. Partial refunds are out of scope for this phase. */
  refundCharge(charge_reference: string): Promise<RefundChargeResult>;
  /** Payload is the raw request body; signature is the header value; secret is the per-tenant/vendor webhook secret. */
  verifyWebhook(payload: string, signature: string, secret: string): Promise<PaymentVerifyWebhookResult>;
}

// ---- request validation shared by all adapters (pure) --------------------------------

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validates a CreateChargeRequest the way the ledger validates money:
 * safe integer minor units > 0, upper-case 3-letter currency, non-empty token
 * and key within column limits. Throws PaymentError.
 */
export function assertCreateChargeRequest(req: CreateChargeRequest): void {
  const a = req.amount_minor;
  if (typeof a !== "number" || !Number.isFinite(a) || !Number.isInteger(a) || !Number.isSafeInteger(a)) {
    throw new PaymentError("PAYMENT_INVALID_AMOUNT", `amount_minor=${String(a)} is not a safe integer`);
  }
  if (a <= 0) {
    throw new PaymentError("PAYMENT_INVALID_AMOUNT", `amount_minor=${a} must be > 0`);
  }
  if (typeof req.currency !== "string" || !CURRENCY_RE.test(req.currency)) {
    throw new PaymentError("PAYMENT_INVALID_CURRENCY", `currency=${String(req.currency)}`);
  }
  if (typeof req.payment_method_token !== "string" || req.payment_method_token.length < 1 || req.payment_method_token.length > 256) {
    throw new PaymentError("PAYMENT_INVALID_METHOD_TOKEN", "payment_method_token must be 1..256 chars");
  }
  if (typeof req.idempotency_key !== "string" || req.idempotency_key.length < 1 || req.idempotency_key.length > 256) {
    throw new PaymentError("PAYMENT_INVALID_IDEMPOTENCY_KEY", "idempotency_key must be 1..256 chars");
  }
}

// ---- stub implementation ---------------------------------------------------------------

export const STUB_PAYMENT_ADAPTER_NAME = "stub-payment";
export const STUB_CHARGE_FAIL_PREFIX = "fail:";
export const STUB_CHARGE_PENDING_PREFIX = "pending:";

const FAILURE_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const enc = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input))));
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))));
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Deterministic charge reference for an idempotency key. Exported so tests can assert it. */
export async function stubChargeReferenceFor(idempotency_key: string): Promise<string> {
  return `stubch_${(await sha256Hex(idempotency_key)).slice(0, 40)}`;
}

/** Signs a webhook payload the way the stub acquirer would. Test helper, pure. */
export async function stubSignPaymentWebhook(payload: string, secret: string): Promise<string> {
  return hmacHex(secret, payload);
}

interface StubChargeRecord {
  status: ChargeStatus;
  failure_code?: string;
  failure_reason?: string;
}

export interface StubPaymentAdapterOptions {
  /** Upper-case codes the stub accepts. Default: USD, EUR, GBP. */
  readonly supportedCurrencies?: readonly string[];
}

/**
 * THIS IS A STUB. No network, no clock, no randomness. Outcome is driven by
 * the request so tests can pick a path:
 *   payment_method_token starting with `fail:`     → FAILED (code from token or STUB_DECLINED)
 *   payment_method_token starting with `pending:`  → PENDING (settles via settle()/webhook)
 *   currency not in `supportedCurrencies`          → PaymentError PAYMENT_INVALID_CURRENCY
 *   otherwise                                      → SUCCEEDED immediately
 * A repeated idempotency_key returns the FIRST result with replayed=true.
 */
export class StubPaymentAdapter implements PaymentAdapter {
  readonly name = STUB_PAYMENT_ADAPTER_NAME;
  private readonly supported: ReadonlySet<string>;
  private readonly byKey = new Map<string, string>();
  private readonly byRef = new Map<string, StubChargeRecord>();

  constructor(opts: StubPaymentAdapterOptions = {}) {
    this.supported = new Set(opts.supportedCurrencies ?? ["USD", "EUR", "GBP"]);
  }

  async createCharge(req: CreateChargeRequest): Promise<CreateChargeResult> {
    assertCreateChargeRequest(req);
    if (!this.supported.has(req.currency)) {
      throw new PaymentError("PAYMENT_INVALID_CURRENCY", `${req.currency} is not supported by the stub`);
    }
    const existingRef = this.byKey.get(req.idempotency_key);
    if (existingRef !== undefined) {
      const rec = this.byRef.get(existingRef);
      if (rec) return this.result(existingRef, rec, true);
    }

    const reference = await stubChargeReferenceFor(req.idempotency_key);
    const rec: StubChargeRecord = { status: "SUCCEEDED" };
    if (req.payment_method_token.startsWith(STUB_CHARGE_FAIL_PREFIX)) {
      const code = req.payment_method_token.slice(STUB_CHARGE_FAIL_PREFIX.length);
      rec.status = "FAILED";
      rec.failure_code = FAILURE_CODE_RE.test(code) ? code : "STUB_DECLINED";
      rec.failure_reason = "stub: payment method token requested failure";
    } else if (req.payment_method_token.startsWith(STUB_CHARGE_PENDING_PREFIX)) {
      rec.status = "PENDING";
    }
    this.byKey.set(req.idempotency_key, reference);
    this.byRef.set(reference, rec);
    return this.result(reference, rec, false);
  }

  async getChargeStatus(charge_reference: string): Promise<ChargeStatusResult> {
    const rec = this.byRef.get(charge_reference);
    if (!rec) throw new PaymentError("PAYMENT_UNKNOWN_REFERENCE", charge_reference);
    return {
      provider: this.name,
      charge_reference,
      status: rec.status,
      ...(rec.failure_code !== undefined ? { failure_code: rec.failure_code } : {}),
      ...(rec.failure_reason !== undefined ? { failure_reason: rec.failure_reason } : {}),
    };
  }

  async refundCharge(charge_reference: string): Promise<RefundChargeResult> {
    const rec = this.byRef.get(charge_reference);
    if (!rec) throw new PaymentError("PAYMENT_UNKNOWN_REFERENCE", charge_reference);
    if (rec.status === "REFUNDED") return { provider: this.name, charge_reference, status: "REFUNDED" }; // idempotent
    if (rec.status !== "SUCCEEDED") throw new PaymentError("PAYMENT_NOT_REFUNDABLE", `charge is ${rec.status}`);
    rec.status = "REFUNDED";
    return { provider: this.name, charge_reference, status: "REFUNDED" };
  }

  async verifyWebhook(payload: string, signature: string, secret: string): Promise<PaymentVerifyWebhookResult> {
    if (typeof signature !== "string" || typeof secret !== "string" || secret.length === 0) {
      return { ok: false, code: "WEBHOOK_BAD_SIGNATURE", message: "missing signature or secret" };
    }
    const expected = await hmacHex(secret, payload);
    if (!timingSafeEqual(expected, signature.toLowerCase())) {
      return { ok: false, code: "WEBHOOK_BAD_SIGNATURE", message: "signature mismatch" };
    }
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return { ok: false, code: "WEBHOOK_MALFORMED", message: "payload is not JSON" };
    }
    if (body === null || typeof body !== "object") return { ok: false, code: "WEBHOOK_MALFORMED", message: "payload is not an object" };
    const b = body as Record<string, unknown>;
    if (typeof b.reference !== "string" || b.reference.length === 0) return { ok: false, code: "WEBHOOK_MALFORMED", message: "reference missing" };
    if (typeof b.status !== "string" || !isChargeStatus(b.status)) return { ok: false, code: "WEBHOOK_MALFORMED", message: "status invalid" };
    if (b.failure_code !== undefined && (typeof b.failure_code !== "string" || !FAILURE_CODE_RE.test(b.failure_code))) {
      return { ok: false, code: "WEBHOOK_MALFORMED", message: "failure_code invalid" };
    }
    return {
      ok: true,
      event: {
        provider: this.name,
        charge_reference: b.reference,
        status: b.status,
        ...(typeof b.event_id === "string" ? { event_id: b.event_id } : {}),
        ...(typeof b.failure_code === "string" ? { failure_code: b.failure_code } : {}),
        ...(typeof b.failure_reason === "string" ? { failure_reason: b.failure_reason } : {}),
      },
    };
  }

  // ---- test-only back office ---------------------------------------------------------

  /** Moves a PENDING charge along (stands in for the acquirer's async capture). Not part of PaymentAdapter. */
  settle(charge_reference: string, status: ChargeStatus, failure_code?: string, failure_reason?: string): void {
    const rec = this.byRef.get(charge_reference);
    if (!rec) throw new PaymentError("PAYMENT_UNKNOWN_REFERENCE", charge_reference);
    if (rec.status !== "PENDING") throw new PaymentError("PAYMENT_DECLINED", `cannot settle a ${rec.status} charge`);
    if (status === "FAILED") {
      if (failure_code === undefined || !FAILURE_CODE_RE.test(failure_code)) throw new PaymentError("PAYMENT_DECLINED", "FAILED requires a failure_code");
      rec.failure_code = failure_code;
      rec.failure_reason = failure_reason;
    }
    rec.status = status;
  }

  /** Distinct charges created (a replay does not add one). */
  get size(): number {
    return this.byRef.size;
  }

  private result(reference: string, rec: StubChargeRecord, replayed: boolean): CreateChargeResult {
    return {
      provider: this.name,
      charge_reference: reference,
      status: rec.status,
      replayed,
      ...(rec.failure_code !== undefined ? { failure_code: rec.failure_code } : {}),
      ...(rec.failure_reason !== undefined ? { failure_reason: rec.failure_reason } : {}),
    };
  }
}
