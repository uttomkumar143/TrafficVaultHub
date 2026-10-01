/**
 * StubPaymentAdapter (Phase 5 Unit 9).
 *
 * THIS IS A STUB. It never talks to a network, never reads a clock and never
 * uses randomness. It exists so the payout service (Unit 11+) can be built and
 * tested end-to-end against the PaymentProvider port before a real adapter
 * (Wise / PayPal / Payoneer …) is written. A real adapter replaces this file
 * and touches nothing else — in particular NOT the ledger.
 *
 * Determinism rules
 *   - provider_reference = `stub_` + sha256(idempotency_key) (first 40 hex).
 *     Same key ⇒ same reference, forever, on any machine.
 *   - Outcome is driven by the request itself (so tests can pick a path):
 *       method_token starting with `fail:`     → FAILED  (code from token or STUB_DECLINED)
 *       method_token starting with `pending:`  → PENDING (settles only via getStatus()/webhook/settle())
 *       amount_minor % 1000 === 666            → FAILED  STUB_MAGIC_AMOUNT (0011 §66 recoverable path)
 *       currency not in `supportedCurrencies`  → ProviderError PROVIDER_INVALID_CURRENCY
 *       otherwise                              → PAID immediately
 *   - A repeated idempotency_key returns the FIRST result with replayed=true,
 *     even if the amount differs (the provider must never pay twice).
 *   - `getStatus()` is a pure lookup. `settle(ref, status)` lets tests move a
 *     PENDING payout along (stands in for the provider's own back office).
 *
 * Webhooks: payload is a JSON string; signature is hex HMAC-SHA256(secret, payload)
 * (WebCrypto, timing-safe compare). Format: { event_id, reference, status, failure_code?, failure_reason? }.
 */

import {
  ProviderError,
  assertCreatePayoutRequest,
  isProviderPayoutStatus,
  type CancelPayoutResult,
  type CreatePayoutRequest,
  type CreatePayoutResult,
  type PaymentProvider,
  type PayoutStatusResult,
  type ProviderPayoutStatus,
  type VerifyWebhookResult,
} from "./provider";

export const STUB_PROVIDER_NAME = "stub";
/** Any amount whose last three digits are 666 fails deterministically. */
export const STUB_MAGIC_FAIL_REMAINDER = 666;
export const STUB_FAIL_PREFIX = "fail:";
export const STUB_PENDING_PREFIX = "pending:";

interface StubRecord {
  readonly idempotency_key: string;
  readonly amount_minor: number;
  readonly currency: string;
  status: ProviderPayoutStatus;
  failure_code?: string;
  failure_reason?: string;
}

export interface StubAdapterOptions {
  /** Upper-case codes the stub accepts. Default: USD, EUR, GBP. */
  readonly supportedCurrencies?: readonly string[];
}

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

/** Constant-time string compare (length leak only, which is inherent to hex MACs of fixed size). */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

/** Deterministic provider reference for an idempotency key. Exported so tests can assert it. */
export async function stubReferenceFor(idempotency_key: string): Promise<string> {
  return `stub_${(await sha256Hex(idempotency_key)).slice(0, 40)}`;
}

/** Signs a webhook payload the way the stub "provider" would. Test helper, also pure. */
export async function stubSignWebhook(payload: string, secret: string): Promise<string> {
  return hmacHex(secret, payload);
}

export class StubPaymentAdapter implements PaymentProvider {
  readonly name = STUB_PROVIDER_NAME;
  private readonly supported: ReadonlySet<string>;
  private readonly byKey = new Map<string, string>(); // idempotency_key → reference
  private readonly byRef = new Map<string, StubRecord>();

  constructor(opts: StubAdapterOptions = {}) {
    this.supported = new Set(opts.supportedCurrencies ?? ["USD", "EUR", "GBP"]);
  }

  async createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult> {
    assertCreatePayoutRequest(req);
    if (!this.supported.has(req.currency)) {
      throw new ProviderError("PROVIDER_INVALID_CURRENCY", `${req.currency} is not supported by the stub`);
    }

    const existingRef = this.byKey.get(req.idempotency_key);
    if (existingRef !== undefined) {
      const rec = this.byRef.get(existingRef)!;
      return this.result(existingRef, rec, true);
    }

    const reference = await stubReferenceFor(req.idempotency_key);
    const rec: StubRecord = { idempotency_key: req.idempotency_key, amount_minor: req.amount_minor, currency: req.currency, status: "PAID" };

    if (req.method_token.startsWith(STUB_FAIL_PREFIX)) {
      const code = req.method_token.slice(STUB_FAIL_PREFIX.length);
      rec.status = "FAILED";
      rec.failure_code = FAILURE_CODE_RE.test(code) ? code : "STUB_DECLINED";
      rec.failure_reason = "stub: method token requested failure";
    } else if (req.method_token.startsWith(STUB_PENDING_PREFIX)) {
      rec.status = "PENDING";
    } else if (req.amount_minor % 1000 === STUB_MAGIC_FAIL_REMAINDER) {
      rec.status = "FAILED";
      rec.failure_code = "STUB_MAGIC_AMOUNT";
      rec.failure_reason = `stub: amount ending in ${STUB_MAGIC_FAIL_REMAINDER} always fails`;
    }

    this.byKey.set(req.idempotency_key, reference);
    this.byRef.set(reference, rec);
    return this.result(reference, rec, false);
  }

  async getStatus(provider_reference: string): Promise<PayoutStatusResult> {
    const rec = this.byRef.get(provider_reference);
    if (!rec) throw new ProviderError("PROVIDER_UNKNOWN_REFERENCE", provider_reference);
    return {
      provider: this.name,
      provider_reference,
      status: rec.status,
      ...(rec.failure_code !== undefined ? { failure_code: rec.failure_code } : {}),
      ...(rec.failure_reason !== undefined ? { failure_reason: rec.failure_reason } : {}),
    };
  }

  async cancelPayout(provider_reference: string): Promise<CancelPayoutResult> {
    const rec = this.byRef.get(provider_reference);
    if (!rec) throw new ProviderError("PROVIDER_UNKNOWN_REFERENCE", provider_reference);
    if (rec.status === "PAID") throw new ProviderError("PROVIDER_NOT_CANCELLABLE", "already paid");
    // PENDING, FAILED → CANCELLED; CANCELLED → CANCELLED (idempotent).
    rec.status = "CANCELLED";
    return { provider: this.name, provider_reference, status: "CANCELLED" };
  }

  async verifyWebhook(payload: string, signature: string, secret: string): Promise<VerifyWebhookResult> {
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
    if (typeof b.status !== "string" || !isProviderPayoutStatus(b.status)) return { ok: false, code: "WEBHOOK_MALFORMED", message: "status invalid" };
    if (b.failure_code !== undefined && (typeof b.failure_code !== "string" || !FAILURE_CODE_RE.test(b.failure_code))) {
      return { ok: false, code: "WEBHOOK_MALFORMED", message: "failure_code invalid" };
    }
    return {
      ok: true,
      event: {
        provider: this.name,
        provider_reference: b.reference,
        status: b.status,
        ...(typeof b.event_id === "string" ? { event_id: b.event_id } : {}),
        ...(typeof b.failure_code === "string" ? { failure_code: b.failure_code } : {}),
        ...(typeof b.failure_reason === "string" ? { failure_reason: b.failure_reason } : {}),
      },
    };
  }

  // ---- test-only back office ---------------------------------------------------------

  /**
   * Moves a payout the stub holds to a new status, standing in for the
   * provider's own processing. Not part of PaymentProvider. Terminal (PAID /
   * CANCELLED) records cannot be moved.
   */
  settle(provider_reference: string, status: ProviderPayoutStatus, failure_code?: string, failure_reason?: string): void {
    const rec = this.byRef.get(provider_reference);
    if (!rec) throw new ProviderError("PROVIDER_UNKNOWN_REFERENCE", provider_reference);
    if (rec.status === "PAID" || rec.status === "CANCELLED") throw new ProviderError("PROVIDER_REJECTED", `cannot settle a ${rec.status} payout`);
    if (status === "FAILED") {
      if (failure_code === undefined || !FAILURE_CODE_RE.test(failure_code)) throw new ProviderError("PROVIDER_REJECTED", "FAILED requires a failure_code");
      rec.failure_code = failure_code;
      rec.failure_reason = failure_reason;
    }
    rec.status = status;
  }

  /** Number of distinct payouts the stub has created (a replay does not add one). */
  get size(): number {
    return this.byRef.size;
  }

  private result(reference: string, rec: StubRecord, replayed: boolean): CreatePayoutResult {
    return {
      provider: this.name,
      provider_reference: reference,
      status: rec.status,
      replayed,
      ...(rec.failure_code !== undefined ? { failure_code: rec.failure_code } : {}),
      ...(rec.failure_reason !== undefined ? { failure_reason: rec.failure_reason } : {}),
    };
  }
}
