/**
 * Phase 5 Unit 9 — PaymentProvider port + StubPaymentAdapter.
 * Pure: no D1, no network, no clock, no randomness.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProviderError, assertCreatePayoutRequest, type CreatePayoutRequest, type PaymentProvider } from "./provider";
import { STUB_PROVIDER_NAME, StubPaymentAdapter, stubReferenceFor, stubSignWebhook } from "./stub-adapter";

const HERE = dirname(fileURLToPath(import.meta.url));

function req(over: Partial<CreatePayoutRequest> = {}): CreatePayoutRequest {
  return { idempotency_key: "payout-req-1", method_token: "tok_bank_1", amount_minor: 125_00, currency: "USD", ...over };
}

describe("payouts/provider port", () => {
  it("provider.ts and stub-adapter.ts import nothing from the ledger (adding a provider never touches the ledger)", () => {
    for (const f of ["provider.ts", "stub-adapter.ts"]) {
      const src = readFileSync(join(HERE, f), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.some((p) => /ledger|d1|kv|hono|\.\.\//.test(p)), `${f} imports: ${imports.join(", ")}`).toBe(false);
    }
    // provider.ts has no imports at all — it is a pure contract.
    expect(/^import /m.test(readFileSync(join(HERE, "provider.ts"), "utf8"))).toBe(false);
  });

  it("assertCreatePayoutRequest: integer minor units > 0 and upper-case 3-letter currency only", () => {
    expect(() => assertCreatePayoutRequest(req())).not.toThrow();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100" as unknown as number]) {
      expect(() => assertCreatePayoutRequest(req({ amount_minor: bad }))).toThrow(ProviderError);
      try {
        assertCreatePayoutRequest(req({ amount_minor: bad }));
      } catch (e) {
        expect((e as ProviderError).code).toBe("PROVIDER_INVALID_AMOUNT");
      }
    }
    for (const cur of ["usd", "US", "USDT", "", "U$D"]) {
      expect(() => assertCreatePayoutRequest(req({ currency: cur }))).toThrow(/PROVIDER_INVALID_CURRENCY/);
    }
    expect(() => assertCreatePayoutRequest(req({ method_token: "" }))).toThrow(/PROVIDER_INVALID_METHOD_TOKEN/);
    expect(() => assertCreatePayoutRequest(req({ method_token: "x".repeat(257) }))).toThrow(/PROVIDER_INVALID_METHOD_TOKEN/);
    expect(() => assertCreatePayoutRequest(req({ idempotency_key: "" }))).toThrow(/PROVIDER_INVALID_IDEMPOTENCY_KEY/);
  });
});

describe("payouts/stub-adapter (STUB — deterministic, no network)", () => {
  it("is a PaymentProvider named 'stub' and its reference is a pure function of the idempotency key", async () => {
    const p: PaymentProvider = new StubPaymentAdapter();
    expect(p.name).toBe(STUB_PROVIDER_NAME);
    const a = await stubReferenceFor("k1");
    const b = await stubReferenceFor("k1");
    const c = await stubReferenceFor("k2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^stub_[0-9a-f]{40}$/);
    const again = new StubPaymentAdapter();
    const r1 = await p.createPayout(req({ idempotency_key: "k1" }));
    const r2 = await again.createPayout(req({ idempotency_key: "k1" }));
    expect(r1.provider_reference).toBe(a);
    expect(r2.provider_reference).toBe(a); // separate instance, same key, same reference
  });

  it("createPayout is idempotent: same key → same reference, first result, replayed=true, never a second payment", async () => {
    const p = new StubPaymentAdapter();
    const first = await p.createPayout(req({ idempotency_key: "dup" }));
    expect(first.replayed).toBe(false);
    expect(first.status).toBe("PAID");
    // Different amount with the same key must NOT create a second payout nor change the first.
    const second = await p.createPayout(req({ idempotency_key: "dup", amount_minor: 999_00 }));
    expect(second.replayed).toBe(true);
    expect(second.provider_reference).toBe(first.provider_reference);
    expect(second.status).toBe("PAID");
    expect(p.size).toBe(1);
    // Different key → different payout.
    const third = await p.createPayout(req({ idempotency_key: "other" }));
    expect(third.replayed).toBe(false);
    expect(third.provider_reference).not.toBe(first.provider_reference);
    expect(p.size).toBe(2);
  });

  it("outcome is driven by the request: fail: token → FAILED with code, pending: token → PENDING, magic amount → FAILED, else PAID", async () => {
    const p = new StubPaymentAdapter();
    const paid = await p.createPayout(req({ idempotency_key: "a" }));
    expect(paid.status).toBe("PAID");
    expect(paid.failure_code).toBeUndefined();

    const failed = await p.createPayout(req({ idempotency_key: "b", method_token: "fail:ACCOUNT_CLOSED" }));
    expect(failed.status).toBe("FAILED");
    expect(failed.failure_code).toBe("ACCOUNT_CLOSED");
    expect(failed.failure_reason).toMatch(/stub/);

    const failedBadCode = await p.createPayout(req({ idempotency_key: "b2", method_token: "fail:not-a-code" }));
    expect(failedBadCode.failure_code).toBe("STUB_DECLINED"); // sanitised to a 0011-legal failure_code

    const pending = await p.createPayout(req({ idempotency_key: "c", method_token: "pending:tok" }));
    expect(pending.status).toBe("PENDING");

    const magic = await p.createPayout(req({ idempotency_key: "d", amount_minor: 10_666 }));
    expect(magic.status).toBe("FAILED");
    expect(magic.failure_code).toBe("STUB_MAGIC_AMOUNT");
    expect(magic.failure_code).toMatch(/^[A-Z0-9_]{1,64}$/);
  });

  it("rejects non-integer / non-positive amounts and bad or unsupported currencies before creating anything", async () => {
    const p = new StubPaymentAdapter({ supportedCurrencies: ["USD"] });
    await expect(p.createPayout(req({ amount_minor: 12.5 }))).rejects.toMatchObject({ code: "PROVIDER_INVALID_AMOUNT" });
    await expect(p.createPayout(req({ amount_minor: 0 }))).rejects.toMatchObject({ code: "PROVIDER_INVALID_AMOUNT" });
    await expect(p.createPayout(req({ amount_minor: -5 }))).rejects.toMatchObject({ code: "PROVIDER_INVALID_AMOUNT" });
    await expect(p.createPayout(req({ currency: "usd" }))).rejects.toMatchObject({ code: "PROVIDER_INVALID_CURRENCY" });
    await expect(p.createPayout(req({ currency: "EUR" }))).rejects.toMatchObject({ code: "PROVIDER_INVALID_CURRENCY" });
    expect(p.size).toBe(0);
    await expect(p.getStatus(await stubReferenceFor("payout-req-1"))).rejects.toMatchObject({ code: "PROVIDER_UNKNOWN_REFERENCE" });
  });

  it("getStatus reflects transitions: PENDING → (settle) PAID / FAILED; unknown reference throws", async () => {
    const p = new StubPaymentAdapter();
    const r = await p.createPayout(req({ idempotency_key: "pend", method_token: "pending:tok" }));
    expect((await p.getStatus(r.provider_reference)).status).toBe("PENDING");
    p.settle(r.provider_reference, "PAID");
    expect((await p.getStatus(r.provider_reference)).status).toBe("PAID");
    // terminal: cannot move again
    expect(() => p.settle(r.provider_reference, "FAILED", "X")).toThrow(ProviderError);

    const f = await p.createPayout(req({ idempotency_key: "pend2", method_token: "pending:tok" }));
    expect(() => p.settle(f.provider_reference, "FAILED")).toThrow(/failure_code/); // FAILED needs a code (0011 CHECK)
    p.settle(f.provider_reference, "FAILED", "BANK_REJECTED", "returned");
    const s = await p.getStatus(f.provider_reference);
    expect(s).toMatchObject({ status: "FAILED", failure_code: "BANK_REJECTED", failure_reason: "returned", provider: "stub" });
    // FAILED is recoverable on the provider side too: back to PENDING then PAID
    p.settle(f.provider_reference, "PENDING");
    p.settle(f.provider_reference, "PAID");
    expect((await p.getStatus(f.provider_reference)).status).toBe("PAID");

    await expect(p.getStatus("stub_nope")).rejects.toMatchObject({ code: "PROVIDER_UNKNOWN_REFERENCE" });
  });

  it("cancelPayout: PENDING / FAILED → CANCELLED (idempotent); PAID is not cancellable; unknown throws", async () => {
    const p = new StubPaymentAdapter();
    const pend = await p.createPayout(req({ idempotency_key: "c1", method_token: "pending:tok" }));
    expect((await p.cancelPayout(pend.provider_reference)).status).toBe("CANCELLED");
    expect((await p.cancelPayout(pend.provider_reference)).status).toBe("CANCELLED"); // idempotent
    expect((await p.getStatus(pend.provider_reference)).status).toBe("CANCELLED");

    const failed = await p.createPayout(req({ idempotency_key: "c2", method_token: "fail:DECLINED" }));
    expect((await p.cancelPayout(failed.provider_reference)).status).toBe("CANCELLED");

    const paid = await p.createPayout(req({ idempotency_key: "c3" }));
    await expect(p.cancelPayout(paid.provider_reference)).rejects.toMatchObject({ code: "PROVIDER_NOT_CANCELLABLE" });
    expect((await p.getStatus(paid.provider_reference)).status).toBe("PAID");

    await expect(p.cancelPayout("stub_missing")).rejects.toMatchObject({ code: "PROVIDER_UNKNOWN_REFERENCE" });
  });

  it("verifyWebhook: valid HMAC → neutral event; bad signature / wrong secret / tampered payload rejected; malformed body rejected", async () => {
    const p = new StubPaymentAdapter();
    const secret = "whsec_test_123";
    const payload = JSON.stringify({ event_id: "evt_1", reference: "stub_abc", status: "PAID" });
    const sig = await stubSignWebhook(payload, secret);

    const ok = await p.verifyWebhook(payload, sig, secret);
    expect(ok).toEqual({ ok: true, event: { provider: "stub", provider_reference: "stub_abc", status: "PAID", event_id: "evt_1" } });
    // upper-case hex signature accepted (case-insensitive hex), still timing-safe
    expect((await p.verifyWebhook(payload, sig.toUpperCase(), secret)).ok).toBe(true);

    expect(await p.verifyWebhook(payload, sig, "whsec_other")).toMatchObject({ ok: false, code: "WEBHOOK_BAD_SIGNATURE" });
    expect(await p.verifyWebhook(payload, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), secret)).toMatchObject({ ok: false, code: "WEBHOOK_BAD_SIGNATURE" });
    expect(await p.verifyWebhook(payload, "", secret)).toMatchObject({ ok: false, code: "WEBHOOK_BAD_SIGNATURE" });
    expect(await p.verifyWebhook(payload, sig, "")).toMatchObject({ ok: false, code: "WEBHOOK_BAD_SIGNATURE" });
    const tampered = payload.replace('"PAID"', '"FAILED"');
    expect(await p.verifyWebhook(tampered, sig, secret)).toMatchObject({ ok: false, code: "WEBHOOK_BAD_SIGNATURE" });

    // Correctly signed but malformed bodies are rejected AFTER the signature check.
    for (const bad of ["not json", JSON.stringify(null), JSON.stringify({ status: "PAID" }), JSON.stringify({ reference: "r", status: "WEIRD" }), JSON.stringify({ reference: "r", status: "FAILED", failure_code: "lower-case" })]) {
      expect(await p.verifyWebhook(bad, await stubSignWebhook(bad, secret), secret)).toMatchObject({ ok: false, code: "WEBHOOK_MALFORMED" });
    }
    const failedBody = JSON.stringify({ reference: "r", status: "FAILED", failure_code: "BANK_REJECTED", failure_reason: "nope" });
    const fr = await p.verifyWebhook(failedBody, await stubSignWebhook(failedBody, secret), secret);
    expect(fr).toMatchObject({ ok: true, event: { status: "FAILED", failure_code: "BANK_REJECTED", failure_reason: "nope" } });
  });

  it("documents itself as a stub (header comment) and exposes no provider-specific types through the port", () => {
    const src = readFileSync(join(HERE, "stub-adapter.ts"), "utf8");
    expect(src).toMatch(/THIS IS A STUB/);
    const port = readFileSync(join(HERE, "provider.ts"), "utf8");
    expect(port).not.toMatch(/\b(Stub\w*Adapter|Wise|PayPal|Payoneer)\b/);
  });
});
