/**
 * Phase 6 Unit 5 — integration adapter ports.
 *
 * Pure: no D1, no network, no clock. Proves for each of the six ports that
 *   (1) the shipped stub implements the interface,
 *   (2) the stub honours the port's idempotency / failure-as-result contract,
 *   (3) a second implementation slots into the SAME calling code with zero
 *       changes (the "seam" test — the caller is typed against the interface
 *       only and runs unchanged against every implementation),
 *   (4) the port files import nothing from ledger / D1 / KV / Hono / services.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EmailSender } from "../modules/auth/email";
import { StubPaymentAdapter as Phase5StubPaymentAdapter } from "../modules/payouts/stub-adapter";
import {
  // CRM
  MemoryCRMAdapter,
  NullCRMAdapter,
  type CRMAdapter,
  type CrmContact,
  // fraud
  NullFraudAdapter,
  ScriptedFraudAdapter,
  normaliseVendorScore,
  type FraudAdapter,
  type FraudScoreRequest,
  // notification
  EmailSenderNotificationAdapter,
  LogNotificationAdapter,
  MemoryNotificationAdapter,
  NOTIFICATION_EVENT_TYPES,
  type GeneralEmailSender,
  type NotificationAdapter,
  type NotificationMessage,
  // payment (inbound)
  PaymentError,
  StubPaymentAdapter,
  assertCreateChargeRequest,
  stubChargeReferenceFor,
  stubSignPaymentWebhook,
  type CreateChargeRequest,
  type PaymentAdapter,
  // payout (outbound)
  StubPayoutAdapter,
  type PayoutAdapter,
  // tracking
  MemoryTrackingAdapter,
  NullTrackingAdapter,
  type TrackingAdapter,
  type TrackingClickEvent,
  type TrackingConversionEvent,
} from "./index";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- (4) isolation ------------------------------------------------------------------------

describe("integrations/ isolation", () => {
  const PORT_FILES = ["tracking-adapter.ts", "payment-adapter.ts", "payout-adapter.ts", "notification-adapter.ts", "crm-adapter.ts", "fraud-adapter.ts", "index.ts"];

  it("no port file imports the ledger, D1/KV, Hono, a service, a repository class or a route", () => {
    for (const f of PORT_FILES) {
      const src = readFileSync(join(HERE, f), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const p of imports) {
        expect(p, `${f} imports ${p}`).not.toMatch(/ledger|\/d1|\/kv|hono|\/service|\/routes|\/lib\//i);
      }
      // Type-only imports of repository.ts are allowed (ClickSignals shape); a value import of a repository class is not.
      expect(src, `${f} must not value-import a repository`).not.toMatch(/^import\s+\{[^}]*Repository[^}]*\}\s+from/m);
    }
  });

  it("the six PRD §367 interfaces are all exported from the barrel", () => {
    const src = readFileSync(join(HERE, "index.ts"), "utf8");
    for (const f of ["tracking", "payment", "payout", "notification", "crm", "fraud"]) {
      expect(src).toContain(`./${f}-adapter`);
    }
  });
});

// ---- PaymentAdapter (inbound charges) ----------------------------------------------------

function chargeReq(over: Partial<CreateChargeRequest> = {}): CreateChargeRequest {
  return { idempotency_key: "topup-1", payment_method_token: "pm_card_1", amount_minor: 500_00, currency: "USD", ...over };
}

describe("PaymentAdapter — StubPaymentAdapter", () => {
  it("validates money the ledger way: floats, zero, negatives, unsafe ints, bad currency all rejected", () => {
    expect(() => assertCreateChargeRequest(chargeReq({ amount_minor: 12.5 }))).toThrow(PaymentError);
    expect(() => assertCreateChargeRequest(chargeReq({ amount_minor: 0 }))).toThrow(/PAYMENT_INVALID_AMOUNT/);
    expect(() => assertCreateChargeRequest(chargeReq({ amount_minor: -1 }))).toThrow(/PAYMENT_INVALID_AMOUNT/);
    expect(() => assertCreateChargeRequest(chargeReq({ amount_minor: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/PAYMENT_INVALID_AMOUNT/);
    expect(() => assertCreateChargeRequest(chargeReq({ currency: "usd" }))).toThrow(/PAYMENT_INVALID_CURRENCY/);
    expect(() => assertCreateChargeRequest(chargeReq({ payment_method_token: "" }))).toThrow(/PAYMENT_INVALID_METHOD_TOKEN/);
    expect(() => assertCreateChargeRequest(chargeReq({ idempotency_key: "x".repeat(257) }))).toThrow(/PAYMENT_INVALID_IDEMPOTENCY_KEY/);
    expect(() => assertCreateChargeRequest(chargeReq())).not.toThrow();
  });

  it("same idempotency_key ⇒ same charge_reference, replayed:true, exactly one charge (never charged twice)", async () => {
    const a = new StubPaymentAdapter();
    const first = await a.createCharge(chargeReq());
    const again = await a.createCharge(chargeReq({ amount_minor: 999_00 })); // even with a different amount
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.charge_reference).toBe(first.charge_reference);
    expect(first.charge_reference).toBe(await stubChargeReferenceFor("topup-1"));
    expect(first.status).toBe("SUCCEEDED");
    expect(a.size).toBe(1);
  });

  it("fail:/pending: tokens drive outcome; refund only of SUCCEEDED; refund idempotent; unknown ref is an error", async () => {
    const a = new StubPaymentAdapter();
    const failed = await a.createCharge(chargeReq({ idempotency_key: "k-fail", payment_method_token: "fail:CARD_DECLINED" }));
    expect(failed.status).toBe("FAILED");
    expect(failed.failure_code).toBe("CARD_DECLINED");
    const pending = await a.createCharge(chargeReq({ idempotency_key: "k-pend", payment_method_token: "pending:bank" }));
    expect(pending.status).toBe("PENDING");
    await expect(a.refundCharge(pending.charge_reference)).rejects.toMatchObject({ code: "PAYMENT_NOT_REFUNDABLE" });
    a.settle(pending.charge_reference, "SUCCEEDED");
    expect((await a.getChargeStatus(pending.charge_reference)).status).toBe("SUCCEEDED");
    expect((await a.refundCharge(pending.charge_reference)).status).toBe("REFUNDED");
    expect((await a.refundCharge(pending.charge_reference)).status).toBe("REFUNDED");
    await expect(a.getChargeStatus("nope")).rejects.toMatchObject({ code: "PAYMENT_UNKNOWN_REFERENCE" });
    await expect(a.createCharge(chargeReq({ idempotency_key: "k-jpy", currency: "JPY" }))).rejects.toMatchObject({ code: "PAYMENT_INVALID_CURRENCY" });
  });

  it("verifyWebhook: good signature + well-formed body → event; bad signature / malformed → typed failure", async () => {
    const a = new StubPaymentAdapter();
    const payload = JSON.stringify({ event_id: "evt_1", reference: "stubch_abc", status: "SUCCEEDED" });
    const sig = await stubSignPaymentWebhook(payload, "whsec");
    const ok = await a.verifyWebhook(payload, sig, "whsec");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.event).toMatchObject({ provider: "stub-payment", charge_reference: "stubch_abc", status: "SUCCEEDED", event_id: "evt_1" });
    expect((await a.verifyWebhook(payload, sig, "other")).ok).toBe(false);
    expect(await a.verifyWebhook("not json", await stubSignPaymentWebhook("not json", "whsec"), "whsec")).toMatchObject({ ok: false, code: "WEBHOOK_MALFORMED" });
    const badStatus = JSON.stringify({ reference: "r", status: "PAID" });
    expect(await a.verifyWebhook(badStatus, await stubSignPaymentWebhook(badStatus, "whsec"), "whsec")).toMatchObject({ ok: false, code: "WEBHOOK_MALFORMED" });
  });
});

// ---- PayoutAdapter (= Phase 5 PaymentProvider) --------------------------------------------

describe("PayoutAdapter — Phase 5 StubPaymentAdapter satisfies it unchanged", () => {
  it("the Phase 5 provider IS the PayoutAdapter (same type, re-exported under the PRD name)", async () => {
    const viaPhase5: PayoutAdapter = new Phase5StubPaymentAdapter();
    const viaUnit5: PayoutAdapter = new StubPayoutAdapter();
    for (const a of [viaPhase5, viaUnit5]) {
      const r = await a.createPayout({ idempotency_key: "p-1", method_token: "tok", amount_minor: 10_00, currency: "USD" });
      expect(r.status).toBe("PAID");
      expect((await a.createPayout({ idempotency_key: "p-1", method_token: "tok", amount_minor: 10_00, currency: "USD" })).replayed).toBe(true);
    }
  });

  it("PaymentAdapter and PayoutAdapter are distinct contracts (inbound vs outbound) — one cannot stand in for the other", () => {
    // Structural check without ts-expect-error noise: the method sets do not overlap.
    const pay = new StubPaymentAdapter() as unknown as Record<string, unknown>;
    const out = new StubPayoutAdapter() as unknown as Record<string, unknown>;
    expect(typeof pay.createCharge).toBe("function");
    expect(typeof pay.createPayout).toBe("undefined");
    expect(typeof out.createPayout).toBe("function");
    expect(typeof out.createCharge).toBe("undefined");
  });
});

// ---- NotificationAdapter -------------------------------------------------------------------

function msg(over: Partial<NotificationMessage> = {}): NotificationMessage {
  return { idempotency_key: "n-1", event_type: "payout_status_changed", to: "affiliate@example.com", subject: "Payout paid", body: "Your payout was paid.", ...over };
}

describe("NotificationAdapter", () => {
  it("event type list equals the 0012 notifications.event_type CHECK list (seven types)", () => {
    expect([...NOTIFICATION_EVENT_TYPES].sort()).toEqual(
      ["offer_status_changed", "conversion_updated", "payout_status_changed", "billing_alert", "compliance_action", "security_event", "tracking_issue"].sort(),
    );
  });

  it("LogNotificationAdapter logs a redacted line only — never the full address, subject or body", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => void lines.push(String(s));
    try {
      const r = await new LogNotificationAdapter().deliver(msg({ body: "SECRET-BODY-TEXT", subject: "SECRET-SUBJECT" }));
      expect(r.status).toBe("QUEUED");
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toContain('"to":"a***@example.com"');
    expect(line).not.toContain("affiliate@example.com");
    expect(line).not.toContain("SECRET-BODY-TEXT");
    expect(line).not.toContain("SECRET-SUBJECT");
  });

  it("MemoryNotificationAdapter dedupes on idempotency_key and surfaces failure as a result, not a throw", async () => {
    const a = new MemoryNotificationAdapter();
    expect((await a.deliver(msg())).status).toBe("SENT");
    expect((await a.deliver(msg())).status).toBe("SENT");
    expect(a.delivered).toHaveLength(1);
    a.failWith = "SMTP_DOWN";
    const r = await a.deliver(msg({ idempotency_key: "n-2" }));
    expect(r).toMatchObject({ status: "FAILED", failure_code: "SMTP_DOWN" });
    expect(a.delivered).toHaveLength(1);
  });

  it("EmailSenderNotificationAdapter bridges an EmailSender vendor: success → SENT with vendor ref; throw → FAILED result", async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const vendor: GeneralEmailSender = {
      async send() {
        /* auth flow path — unused here */
      },
      async sendMessage(to, subject) {
        if (to.endsWith("@bounce.test")) throw new Error("550 mailbox unavailable");
        sent.push({ to, subject });
        return { provider_reference: "vendor-msg-1" };
      },
    };
    // The same object also satisfies Phase 1's EmailSender — one vendor, both ports.
    const asAuthSender: EmailSender = vendor;
    expect(typeof asAuthSender.send).toBe("function");

    const a = new EmailSenderNotificationAdapter(vendor, "acme-mail");
    const ok = await a.deliver(msg());
    expect(ok).toMatchObject({ provider: "acme-mail", channel: "EMAIL", status: "SENT", provider_reference: "vendor-msg-1" });
    const failed = await a.deliver(msg({ idempotency_key: "n-3", to: "x@bounce.test" }));
    expect(failed).toMatchObject({ status: "FAILED", failure_code: "EMAIL_SEND_FAILED" });
    expect(failed.failure_reason).not.toContain("550"); // vendor detail is not propagated verbatim
    expect(sent).toHaveLength(1);
  });
});

// ---- TrackingAdapter -----------------------------------------------------------------------

const click: TrackingClickEvent = {
  click_id: "clk_1",
  organization_id: "org_1",
  offer_id: "off_1",
  affiliate_id: "aff_1",
  sub_ids: { sub1: "a" },
  signals: { country_code: "US", region_code: null, device_type: null, os_family: null, browser_family: null, language: "en", ip_hash: null, user_agent_hash: null, referrer_host: null },
  occurred_at: "2026-10-02T00:00:00.000Z",
};
const conv: TrackingConversionEvent = {
  conversion_id: "cnv_1",
  organization_id: "org_1",
  offer_id: "off_1",
  affiliate_id: "aff_1",
  click_id: "clk_1",
  status: "PENDING",
  transaction_id: "tx-1",
  payout_minor: 12_50,
  revenue_minor: 20_00,
  currency: "USD",
  occurred_at: "2026-10-02T00:01:00.000Z",
};

describe("TrackingAdapter", () => {
  it("NullTrackingAdapter accepts everything (the platform is correct with no external tracker)", async () => {
    const a = new NullTrackingAdapter();
    expect((await a.forwardClick(click)).status).toBe("ACCEPTED");
    expect((await a.forwardConversion(conv)).status).toBe("ACCEPTED");
  });

  it("MemoryTrackingAdapter: repeat click_id → DUPLICATE; same (conversion, status) → DUPLICATE; new status → ACCEPTED", async () => {
    const a = new MemoryTrackingAdapter();
    expect((await a.forwardClick(click)).status).toBe("ACCEPTED");
    expect((await a.forwardClick(click)).status).toBe("DUPLICATE");
    expect(a.clicks).toHaveLength(1);
    expect((await a.forwardConversion(conv)).status).toBe("ACCEPTED");
    expect((await a.forwardConversion(conv)).status).toBe("DUPLICATE");
    expect((await a.forwardConversion({ ...conv, status: "APPROVED" })).status).toBe("ACCEPTED");
    expect(a.conversions).toHaveLength(2);
  });
});

// ---- CRMAdapter ----------------------------------------------------------------------------

const contact: CrmContact = {
  external_ref: "aff_1",
  organization_id: "org_1",
  party_type: "AFFILIATE",
  company_name: "Acme Traffic",
  contact_name: "Jo",
  email: "jo@acme.test",
  status: "ACTIVE",
  attributes: { tier: "gold" },
};

describe("CRMAdapter", () => {
  it("NullCRMAdapter: everything UNCHANGED, nothing sent", async () => {
    const a = new NullCRMAdapter();
    expect((await a.upsertContact(contact)).status).toBe("UNCHANGED");
    expect((await a.recordActivity({ idempotency_key: "act-1", external_ref: "aff_1", type: "NOTE", summary: "hi", occurred_at: "2026-10-02T00:00:00.000Z" })).status).toBe("UNCHANGED");
  });

  it("MemoryCRMAdapter: upsert is CREATED → UNCHANGED → UPDATED on external_ref; activity idempotent; unknown contact FAILED as a result", async () => {
    const a = new MemoryCRMAdapter();
    expect((await a.upsertContact(contact)).status).toBe("CREATED");
    expect((await a.upsertContact(contact)).status).toBe("UNCHANGED");
    expect((await a.upsertContact({ ...contact, status: "SUSPENDED" })).status).toBe("UPDATED");
    expect(a.contacts.size).toBe(1);
    const act = { idempotency_key: "act-1", external_ref: "aff_1", type: "SUSPENDED" as const, summary: "policy", occurred_at: "2026-10-02T00:00:00.000Z" };
    expect((await a.recordActivity(act)).status).toBe("CREATED");
    expect((await a.recordActivity(act)).status).toBe("UNCHANGED");
    expect(a.activities).toHaveLength(1);
    expect(await a.recordActivity({ ...act, idempotency_key: "act-2", external_ref: "ghost" })).toMatchObject({ status: "FAILED", failure_code: "CRM_UNKNOWN_CONTACT" });
  });
});

// ---- FraudAdapter --------------------------------------------------------------------------

const scoreReq: FraudScoreRequest = {
  idempotency_key: "cnv_1",
  organization_id: "org_1",
  subject_type: "CONVERSION",
  subject_id: "cnv_1",
  facts: { timing: { clicked_at: "2026-10-02T00:00:00.000Z", occurred_at: "2026-10-02T00:00:01.000Z" } },
};

describe("FraudAdapter", () => {
  it("normaliseVendorScore clamps onto the engine's integer 0..100; non-finite is no opinion", () => {
    expect(normaliseVendorScore(-5)).toBe(0);
    expect(normaliseVendorScore(42.6)).toBe(43);
    expect(normaliseVendorScore(250)).toBe(100);
    expect(normaliseVendorScore(Number.NaN)).toBeNull();
    expect(normaliseVendorScore(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("NullFraudAdapter is 'no opinion' (available, score null) — fires no signal, exactly like an absent fact", async () => {
    const r = await new NullFraudAdapter().score(scoreReq);
    expect(r).toMatchObject({ available: true, score: null, level: null, reason_codes: [] });
  });

  it("ScriptedFraudAdapter: scripted score → level via the engine's levelFor; outage → available:false, never throws; outcome idempotent", async () => {
    const a = new ScriptedFraudAdapter();
    a.scriptScore("cnv_1", 93.4, ["DEVICE_EMULATOR"]);
    const hi = await a.score(scoreReq);
    expect(hi).toMatchObject({ available: true, score: 93, level: "CRITICAL", reason_codes: ["DEVICE_EMULATOR"] });
    const none = await a.score({ ...scoreReq, idempotency_key: "cnv_2" });
    expect(none).toMatchObject({ available: true, score: null, level: null });
    a.unavailable = true;
    await expect(a.score(scoreReq)).resolves.toMatchObject({ available: false, score: null, level: null });
    expect(a.requests).toHaveLength(3);
    const rep = { idempotency_key: "cnv_1:decision", subject_type: "CONVERSION" as const, subject_id: "cnv_1", outcome: "CONFIRMED_FRAUD" as const, decided_at: "2026-10-02T01:00:00.000Z" };
    await a.reportOutcome(rep);
    await a.reportOutcome(rep);
    expect(a.outcomes).toHaveLength(1);
  });
});

// ---- (3) the seam: one caller, many implementations, zero caller changes --------------------

/**
 * These functions stand in for "core business logic". They are typed against
 * the PORT only. The test passes each one every shipped implementation of
 * its port; if any implementation required a caller change, this would not
 * compile — which is exactly the guarantee the spec asks for.
 */
async function coreTopUp(payments: PaymentAdapter, key: string) {
  const r = await payments.createCharge({ idempotency_key: key, payment_method_token: "pm", amount_minor: 100_00, currency: "USD" });
  return r.status;
}
async function corePayAffiliate(payouts: PayoutAdapter, key: string) {
  const r = await payouts.createPayout({ idempotency_key: key, method_token: "tok", amount_minor: 100_00, currency: "USD" });
  return r.status;
}
async function coreNotify(n: NotificationAdapter) {
  return (await n.deliver(msg())).status;
}
async function coreMirrorClick(t: TrackingAdapter) {
  return (await t.forwardClick(click)).status;
}
async function coreSyncParty(c: CRMAdapter) {
  return (await c.upsertContact(contact)).status;
}
async function coreScore(f: FraudAdapter) {
  return (await f.score(scoreReq)).available;
}

describe("seam: swapping an implementation never touches calling code", () => {
  it("every shipped implementation of every port runs through the same caller", async () => {
    const payments: PaymentAdapter[] = [new StubPaymentAdapter(), new StubPaymentAdapter({ supportedCurrencies: ["USD"] })];
    const payouts: PayoutAdapter[] = [new StubPayoutAdapter(), new Phase5StubPaymentAdapter()];
    const notifiers: NotificationAdapter[] = [
      new MemoryNotificationAdapter(),
      new EmailSenderNotificationAdapter({ async send() {}, async sendMessage() {} }),
      new MemoryNotificationAdapter("SMS"),
    ];
    const trackers: TrackingAdapter[] = [new NullTrackingAdapter(), new MemoryTrackingAdapter()];
    const crms: CRMAdapter[] = [new NullCRMAdapter(), new MemoryCRMAdapter()];
    const frauds: FraudAdapter[] = [new NullFraudAdapter(), new ScriptedFraudAdapter()];

    for (const p of payments) expect(await coreTopUp(p, "seam")).toBe("SUCCEEDED");
    for (const p of payouts) expect(await corePayAffiliate(p, "seam")).toBe("PAID");
    for (const n of notifiers) expect(await coreNotify(n)).toBe("SENT");
    for (const t of trackers) expect(await coreMirrorClick(t)).toBe("ACCEPTED");
    for (const c of crms) expect(["CREATED", "UNCHANGED"]).toContain(await coreSyncParty(c));
    for (const f of frauds) expect(await coreScore(f)).toBe(true);
  });

  it("an ad-hoc vendor object literal (no class, no inheritance) satisfies each port structurally", async () => {
    const vendorTracker: TrackingAdapter = {
      name: "acme-tracker",
      async forwardClick() {
        return { provider: "acme-tracker", status: "ACCEPTED" };
      },
      async forwardConversion() {
        return { provider: "acme-tracker", status: "FAILED", failure_code: "RATE_LIMITED" };
      },
    };
    const vendorFraud: FraudAdapter = {
      name: "acme-fraud",
      async score() {
        return { provider: "acme-fraud", available: true, score: 10, level: "LOW", reason_codes: [] };
      },
      async reportOutcome() {},
    };
    expect(await coreMirrorClick(vendorTracker)).toBe("ACCEPTED");
    expect(await coreScore(vendorFraud)).toBe(true);
  });
});
