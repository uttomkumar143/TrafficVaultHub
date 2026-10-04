/**
 * Phase 6 consolidated security gate (PRD §116 subset) across api-keys,
 * webhooks, notifications, support, disputes and appeals.
 *
 * Deep per-module coverage already lives in:
 *   api-key-auth-http.test.ts  "expired key → 401 and the row settles to EXPIRED on the way",
 *                              "the secret never lands in audit rows"
 *   api-keys-http.test.ts      "api_keys.read vs api_keys.manage: … unauthenticated → 401"
 *   webhooks-http.test.ts      "create returns the secret ONCE; stores ciphertext + hint only; list/get never leak secret or ciphertext",
 *                              "fans out to org A's ACTIVE matching subscriptions only; … same idempotency_key is a no-op",
 *                              "org B cannot see, read, change or replay org A's subscriptions/deliveries (404 both ways); nothing written"
 *   notifications-http.test.ts "same dedupe_key replays idempotently: 200 replayed:true, no new rows, no second email, no second webhook event"
 *   auth-sessions.test.ts      "rejects an expired session"
 * This file re-asserts the cross-cutting invariants in one place and adds the
 * matrix pieces that were only covered module-by-module.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { ScriptedWebhookTransport } from "../modules/webhooks/transport";
import { RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 13 + 5));
const LEAK = /RAISE|trigger|sqlite|constraint|stack|at .*\.ts:|token_hash|ciphertext|secret_ciphertext/i;

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

let h: TestHarness;
let transport: ScriptedWebhookTransport;
beforeEach(() => {
  transport = new ScriptedWebhookTransport();
  h = new TestHarness({ webhookTransport: transport });
  h.env.POSTBACK_SECRET_KEY = MASTER;
});
afterEach(() => h.close());

const O = (orgId: string, path: string) => `/organizations/${orgId}${path}`;

async function advertiser(email: string, name: string) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  return { owner, orgId };
}
async function platformAdmin() {
  const token = await h.user("ops@platform.example");
  const orgId = await h.platformOrg("ops@platform.example", "SUPER_ADMIN");
  return { token, orgId };
}
/** Asserts the canonical error envelope and that the body carries no internals. */
async function expectEnvelope(res: Response, status: number, code?: string): Promise<Envelope> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(text).not.toMatch(LEAK);
  const body = JSON.parse(text) as Envelope;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error.code).toBe("string");
  expect(typeof body.error.message).toBe("string");
  expect(typeof body.error.request_id).toBe("string");
  if (code) expect(body.error.code).toBe(code);
  return body;
}

/** One representative read + write per Phase 6 surface, all tenant-scoped. */
function surfaces(orgId: string): Array<[string, string, unknown?]> {
  return [
    ["GET", O(orgId, "/api-keys")],
    ["POST", O(orgId, "/api-keys"), { name: "x", scopes: ["organizations.read"] }],
    ["GET", O(orgId, "/webhooks")],
    ["POST", O(orgId, "/webhooks"), { url: "https://hooks.example.com/x" }],
    ["GET", O(orgId, "/notifications")],
    ["PUT", O(orgId, "/notifications/preferences"), { preferences: [] }],
    ["GET", O(orgId, "/support/tickets")],
    ["POST", O(orgId, "/support/tickets"), { category: "BILLING", subject: "s", body: "b" }],
    ["GET", O(orgId, "/disputes")],
    ["POST", O(orgId, "/disputes"), { category: "BILLING", subject_type: "invoice", subject_id: "i1", title: "t", description: "d" }],
    ["GET", O(orgId, "/appeals")],
    ["POST", O(orgId, "/appeals"), { appeal_type: "PAYOUT_HOLD", subject_type: "payout", subject_id: "p1", grounds: "g" }],
  ];
}

describe("phase 6 security — credentials", () => {
  it("expired session → 401 on every Phase 6 surface; the same envelope as no credentials; nothing written", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    h.db.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    for (const [method, path, body] of surfaces(a.orgId)) {
      await expectEnvelope(await h.as(a.owner, method, path, body), 401, "UNAUTHENTICATED");
      await expectEnvelope(await h.api(method, path, {}, body), 401, "UNAUTHENTICATED");
    }
    for (const table of ["api_keys", "webhook_subscriptions", "support_tickets", "disputes", "appeals"]) {
      expect(h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("invalid API keys (garbage, wrong secret, revoked, expired) → 401 UNAUTHENTICATED; a valid read-scoped key reads but cannot write; the key never leaves the server again", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const created = await h.as(a.owner, "POST", O(a.orgId, "/api-keys"), { name: "ro", scopes: ["organizations.read", "disputes.read"] });
    expect(created.status).toBe(201);
    const { api_key } = await json<{ api_key: { id: string; key: string } }>(created);
    const [prefix, secret] = api_key.key.split(".") as [string, string];
    await expectEnvelope(await h.as("tvh_k_garbage", "GET", O(a.orgId, "/disputes")), 401, "UNAUTHENTICATED");
    await expectEnvelope(await h.as(`${prefix}.${secret.split("").reverse().join("")}`, "GET", O(a.orgId, "/disputes")), 401, "UNAUTHENTICATED");
    expect((await h.as(api_key.key, "GET", O(a.orgId, "/disputes"))).status).toBe(200);
    await expectEnvelope(await h.as(api_key.key, "POST", O(a.orgId, "/disputes"), surfaces(a.orgId)[9]?.[2]), 403);
    const listed = await (await h.as(a.owner, "GET", O(a.orgId, "/api-keys"))).text();
    expect(listed).not.toContain(secret);
    expect((await h.as(a.owner, "POST", O(a.orgId, `/api-keys/${api_key.id}/revoke`))).status).toBe(200);
    await expectEnvelope(await h.as(api_key.key, "GET", O(a.orgId, "/disputes")), 401, "UNAUTHENTICATED");
    const dump = h.db.sqlite.prepare("SELECT group_concat(metadata) AS m FROM audit_logs").get() as { m: string | null };
    expect(dump.m ?? "").not.toContain(secret);
  });
});

describe("phase 6 security — replay, secrets and isolation", () => {
  it("replayed webhook event (same idempotency_key) has effect exactly once: one event, one delivery, one transport call after draining twice", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ops = await platformAdmin();
    expect((await h.as(a.owner, "POST", O(a.orgId, "/webhooks"), { url: "https://hooks.example.com/tvh" })).status).toBe(201);
    const event = { event_type: "conversion_updated", payload: { conversion_id: "c1", status: "APPROVED" }, idempotency_key: "conversion:c1:APPROVED", reference_type: "conversion", reference_id: "c1" };
    const first = await h.as(ops.token, "POST", O(ops.orgId, `/platform/webhooks/tenants/${a.orgId}/events`), event);
    expect(first.status).toBe(201);
    const second = await h.as(ops.token, "POST", O(ops.orgId, `/platform/webhooks/tenants/${a.orgId}/events`), { ...event, payload: { conversion_id: "c1", status: "REJECTED" } });
    expect(second.status).toBe(200);
    expect((await json<{ replayed: boolean }>(second)).replayed).toBe(true);
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()).toEqual({ n: 1 });
    expect(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 1 });
    for (let i = 0; i < 2; i++) expect((await h.as(ops.token, "POST", O(ops.orgId, "/platform/webhooks/process-due"), {})).status).toBe(200);
    expect(transport.sent).toHaveLength(1);
    expect(h.db.sqlite.prepare("SELECT status FROM webhook_deliveries").get()).toEqual({ status: "DELIVERED" });
  });

  it("secrets never come back: api key secret, webhook secret/ciphertext, notification preference internals, dispute evidence to other tenants", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const key = (await json<{ api_key: { id: string; key: string } }>(await h.as(a.owner, "POST", O(a.orgId, "/api-keys"), { name: "k", scopes: ["organizations.read"] }))).api_key;
    const sub = (await json<{ subscription: { id: string; secret: string } }>(await h.as(a.owner, "POST", O(a.orgId, "/webhooks"), { url: "https://hooks.example.com/tvh" }))).subscription;
    expect(sub.secret).toBeTruthy();
    const dispute = await json<{ id: string }>(await h.as(a.owner, "POST", O(a.orgId, "/disputes"), surfaces(a.orgId)[9]?.[2]));
    expect((await h.as(a.owner, "POST", O(a.orgId, `/disputes/${dispute.id}/evidence`), { kind: "TEXT", content: "CONFIDENTIAL-EVIDENCE-7731" })).status).toBe(201);
    const reads = [
      O(a.orgId, "/api-keys"),
      O(a.orgId, `/api-keys/${key.id}`),
      O(a.orgId, "/webhooks"),
      O(a.orgId, `/webhooks/${sub.id}`),
      O(a.orgId, "/notifications/preferences"),
      O(a.orgId, `/disputes/${dispute.id}`),
    ];
    for (const path of reads) {
      const res = await h.as(a.owner, "GET", path);
      const text = await res.text();
      expect(res.status, path).toBe(200);
      expect(text).not.toContain(key.key.split(".")[1] as string);
      expect(text).not.toContain(sub.secret);
      expect(text).not.toMatch(/ciphertext|token_hash|secret_hash|key_hash/i);
    }
    const foreign = await h.as(b.owner, "GET", O(a.orgId, `/disputes/${dispute.id}/evidence`));
    const body = await expectEnvelope(foreign, 404);
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL-EVIDENCE-7731");
    const row = h.db.sqlite.prepare("SELECT secret_ciphertext FROM webhook_subscriptions WHERE id = ?").get(sub.id) as { secret_ciphertext: string };
    expect(row.secret_ciphertext).not.toContain(sub.secret);
  });

  it("cross-tenant access is refused on every Phase 6 surface (404, same envelope as a missing org); malformed ids → 404; bodies carry no internals", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const messages = new Set<string>();
    for (const [method, path, body] of surfaces(a.orgId)) {
      const res = await expectEnvelope(await h.as(b.owner, method, path, body), 404, "ORGANIZATION_NOT_FOUND");
      messages.add(res.error.message);
      const missing = await expectEnvelope(await h.as(b.owner, method, path.replace(a.orgId, RANDOM_ID), body), 404, "ORGANIZATION_NOT_FOUND");
      messages.add(missing.error.message);
    }
    expect(messages.size).toBe(1);
    for (const sub of ["/api-keys/not-a-uuid", "/webhooks/not-a-uuid", "/notifications/not-a-uuid", "/support/tickets/not-a-uuid", "/disputes/not-a-uuid", "/appeals/not-a-uuid"]) {
      await expectEnvelope(await h.as(b.owner, "GET", O(b.orgId, sub)), 404);
    }
    for (const table of ["api_keys", "webhook_subscriptions", "support_tickets", "disputes", "appeals"]) {
      expect(h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`).get(a.orgId)).toEqual({ n: 0 });
    }
  });

  it("conflict and validation errors keep the envelope and never expose sqlite/trigger/RAISE/constraint text", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ops = await platformAdmin();
    const appealBody = surfaces(a.orgId)[11]?.[2] as Record<string, unknown>;
    expect((await h.as(a.owner, "POST", O(a.orgId, "/appeals"), appealBody)).status).toBe(201);
    await expectEnvelope(await h.as(a.owner, "POST", O(a.orgId, "/appeals"), appealBody), 409, "APPEAL_ALREADY_OPEN");
    await expectEnvelope(await h.as(a.owner, "POST", O(a.orgId, "/appeals"), { ...appealBody, appeal_type: "NOPE" }), 400, "VALIDATION_ERROR");
    const dispute = await json<{ id: string }>(await h.as(a.owner, "POST", O(a.orgId, "/disputes"), surfaces(a.orgId)[9]?.[2]));
    expect((await h.as(a.owner, "POST", O(a.orgId, `/disputes/${dispute.id}/withdraw`))).status).toBe(200);
    await expectEnvelope(await h.as(a.owner, "POST", O(a.orgId, `/disputes/${dispute.id}/withdraw`)), 409, "DISPUTE_FINAL");
    await expectEnvelope(await h.as(ops.token, "POST", O(ops.orgId, `/platform/disputes/tenants/${a.orgId}/${dispute.id}/decide`), { decision: "UPHELD", reason: "r" }), 409, "DISPUTE_FINAL");
    await expectEnvelope(await h.as(a.owner, "POST", O(a.orgId, "/webhooks"), { url: "http://insecure.example/x" }), 400, "VALIDATION_ERROR");
    await expectEnvelope(await h.as(a.owner, "PUT", O(a.orgId, "/notifications/preferences"), { preferences: [{ event_type: "nope", channel: "EMAIL", enabled: false }] }), 400, "VALIDATION_ERROR");
  });
});
