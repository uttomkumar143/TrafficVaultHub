/**
 * Phase 6 Unit 4 — webhooks through the REAL app (auth → requireOrg →
 * requirePermission → WebhookService → WebhookRepository → D1 shim running
 * the actual migrations incl. 0012), with a `ScriptedWebhookTransport`
 * injected through `createApp` so nothing touches the network.
 *
 * Covers (PRD §73–§75, §79, §115, §116):
 *   * subscription CRUD: secret returned exactly once (create / rotate-secret),
 *     only ciphertext + 4-char hint stored; list/get never carry the secret or
 *     the ciphertext; https-only URL → clean 400; permission gating
 *     (webhooks.read vs webhooks.manage; VIEWER has neither); tenant isolation;
 *   * publish fan-out: one QUEUED delivery per ACTIVE matching subscription of
 *     THAT org only ('*' or the event type; PAUSED/DISABLED excluded); the same
 *     idempotency_key is a no-op (no second event, no second delivery);
 *   * delivery lifecycle via the scripted transport: 200 → DELIVERED with one
 *     attempt row and a verifiable signature; failures → RETRY with back-off
 *     until max_attempts, then DEAD_LETTER;
 *   * replay (§75 Definition of Done): DELIVERED → 409 WEBHOOK_DELIVERY_FINAL
 *     from the SERVICE (no trigger text); RETRY|DEAD_LETTER → the SAME row is
 *     re-queued and settles to DELIVERED exactly once; the (subscription, event)
 *     delivery row count never exceeds 1;
 *   * the secret never appears in any response body, attempt row or audit row.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { ScriptedWebhookTransport } from "../modules/webhooks/transport";
import { WEBHOOK_HEADERS, WebhookService } from "../modules/webhooks/service";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 11 + 3));

interface Subscription {
  id: string;
  organization_id: string;
  url: string;
  description: string | null;
  event_types: string[];
  secret_hint: string;
  secret_rotated_at: string | null;
  status: string;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  secret?: string;
}

interface Delivery {
  id: string;
  organization_id: string;
  subscription_id: string;
  event_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  replay_count: number;
  next_attempt_at: string | null;
  last_response_status: number | null;
  last_error_code: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
}

interface Attempt {
  attempt_number: number;
  outcome: string;
  response_status: number | null;
  error_code: string | null;
  is_replay: number;
}

interface PublishResult {
  event: { id: string; event_type: string; idempotency_key: string };
  deliveries: Delivery[];
  replayed: boolean;
}

let h: TestHarness;
let transport: ScriptedWebhookTransport;
beforeEach(() => {
  transport = new ScriptedWebhookTransport();
  h = new TestHarness({ webhookTransport: transport });
  h.env.POSTBACK_SECRET_KEY = MASTER;
});
afterEach(() => h.close());

const W = (orgId: string, path = "") => `/organizations/${orgId}/webhooks${path}`;
const P = (platformOrgId: string, path = "") => `/organizations/${platformOrgId}/platform/webhooks${path}`;

async function advertiser(email: string, name: string) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  return { owner, orgId };
}

async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

/** SUPER_ADMIN seat on the PLATFORM org; returns { token, orgId }. */
async function platformAdmin(email = "ops@platform.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  return { token, orgId };
}

async function createSub(token: string, orgId: string, body: Record<string, unknown> = { url: "https://hooks.example.com/tvh" }): Promise<Subscription> {
  const res = await h.as(token, "POST", W(orgId), body);
  const text = await res.text();
  expect(res.status, text).toBe(201);
  return (JSON.parse(text) as { subscription: Subscription }).subscription;
}

async function publish(platform: { token: string; orgId: string }, targetOrgId: string, body: Record<string, unknown>): Promise<{ status: number; result: PublishResult }> {
  const res = await h.as(platform.token, "POST", P(platform.orgId, `/tenants/${targetOrgId}/events`), body);
  expect([200, 201]).toContain(res.status);
  return { status: res.status, result: await json<PublishResult>(res) };
}

const EVENT = (key = "conversion:c1:APPROVED") => ({
  event_type: "conversion_updated",
  payload: { conversion_id: "c1", status: "APPROVED", amount_minor: 1250, currency: "USD" },
  idempotency_key: key,
  reference_type: "conversion",
  reference_id: "c1",
});

function subRow(id: string) {
  return h.db.sqlite.prepare("SELECT * FROM webhook_subscriptions WHERE id = ?").get(id) as Record<string, unknown>;
}
function deliveryRow(id: string) {
  return h.db.sqlite.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as Record<string, unknown>;
}
function attemptRows(deliveryId: string) {
  return h.db.sqlite.prepare("SELECT * FROM webhook_delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number").all(deliveryId) as Array<Record<string, unknown>>;
}
function count(sql: string, ...params: unknown[]): number {
  return (h.db.sqlite.prepare(sql).get(...(params as never[])) as { n: number }).n;
}
/** Every stored byte that could possibly carry the secret, as one string. */
function everythingStored(): string {
  const tables = ["webhook_subscriptions", "webhook_events", "webhook_deliveries", "webhook_delivery_attempts", "audit_logs"];
  return tables.map((t) => JSON.stringify(h.db.sqlite.prepare(`SELECT * FROM ${t}`).all())).join("\n");
}

describe("webhooks HTTP — subscriptions and secret handling (§115)", () => {
  it("create returns the secret ONCE; stores ciphertext + hint only; list/get never leak secret or ciphertext", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const created = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/tvh", description: "  prod  ", event_types: ["conversion_updated", "payout_status_changed", "conversion_updated"] });

    const secret = created.secret!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.secret_hint).toBe(secret.slice(-4));
    expect(created.status).toBe("ACTIVE");
    expect(created.description).toBe("prod");
    expect(created.event_types).toEqual(["conversion_updated", "payout_status_changed"]);
    expect(created.organization_id).toBe(a.orgId);

    const row = subRow(created.id);
    expect(row.secret_ciphertext).toBeTypeOf("string");
    expect(String(row.secret_ciphertext)).not.toContain(secret);
    expect(row.secret_hint).toBe(secret.slice(-4));
    expect(Object.keys(row)).not.toContain("secret");

    const get = await h.as(a.owner, "GET", W(a.orgId, `/${created.id}`));
    expect(get.status).toBe(200);
    const getText = await get.text();
    expect(getText).not.toContain(secret);
    expect(getText).not.toContain("ciphertext");
    expect(getText).not.toContain(String(row.secret_ciphertext));
    expect((JSON.parse(getText) as { subscription: Subscription }).subscription.secret).toBeUndefined();

    const list = await h.as(a.owner, "GET", W(a.orgId));
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(secret);
    expect(listText).not.toContain("ciphertext");
    expect((JSON.parse(listText) as { items: Subscription[] }).items.map((s) => s.id)).toEqual([created.id]);

    const audit = await h.auditRows("webhooks.subscription_created");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata ?? "").not.toContain(secret);
    expect(audit[0]?.metadata ?? "").toContain(secret.slice(-4));
  });

  it("rotate-secret returns a NEW secret once; hint changes; old/new secrets never stored in clear", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const created = await createSub(a.owner, a.orgId);
    const res = await h.as(a.owner, "POST", W(a.orgId, `/${created.id}/rotate-secret`));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rotated = (await json<{ subscription: Subscription }>(res)).subscription;
    expect(rotated.id).toBe(created.id);
    expect(rotated.secret).toBeDefined();
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret_hint).toBe(rotated.secret!.slice(-4));
    expect(rotated.secret_rotated_at).not.toBeNull();
    const stored = everythingStored();
    expect(stored).not.toContain(created.secret!);
    expect(stored).not.toContain(rotated.secret!);
  });

  it("validation: non-https / credentialed / malformed URL, unknown event type, unknown field → 400 VALIDATION_ERROR with no row written", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const bad: Array<Record<string, unknown>> = [
      { url: "http://hooks.example.com/x" },
      { url: "https://user:pw@hooks.example.com/x" },
      { url: "not a url" },
      { url: "ftp://hooks.example.com/x" },
      { url: "https://hooks.example.com/x", event_types: ["nope"] },
      { url: "https://hooks.example.com/x", event_types: [] },
      { url: "https://hooks.example.com/x", extra: 1 },
      {},
    ];
    for (const body of bad) {
      const res = await h.as(a.owner, "POST", W(a.orgId), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    }
    expect(count("SELECT COUNT(*) AS n FROM webhook_subscriptions")).toBe(0);

    const s = await createSub(a.owner, a.orgId);
    const patch = await h.as(a.owner, "PATCH", W(a.orgId, `/${s.id}`), { url: "http://downgrade.example.com" });
    expect(patch.status).toBe(400);
    expect(subRow(s.id).url).toBe("https://hooks.example.com/tvh");
    expect((await h.as(a.owner, "PATCH", W(a.orgId, `/${s.id}`), {})).status).toBe(400);
  });

  it("lifecycle: pause → resume → disable (terminal → 409 WEBHOOK_SUBSCRIPTION_FINAL, no trigger text); wrong-state toggles are 409", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const s = await createSub(a.owner, a.orgId);

    const notPaused = await h.as(a.owner, "POST", W(a.orgId, `/${s.id}/resume`));
    expect(notPaused.status).toBe(409);
    expect(await h.errorCode(notPaused)).toBe("WEBHOOK_SUBSCRIPTION_NOT_PAUSED");

    expect((await json<{ subscription: Subscription }>(await h.as(a.owner, "POST", W(a.orgId, `/${s.id}/pause`)))).subscription.status).toBe("PAUSED");
    const notActive = await h.as(a.owner, "POST", W(a.orgId, `/${s.id}/pause`));
    expect(notActive.status).toBe(409);
    expect(await h.errorCode(notActive)).toBe("WEBHOOK_SUBSCRIPTION_NOT_ACTIVE");
    expect((await json<{ subscription: Subscription }>(await h.as(a.owner, "POST", W(a.orgId, `/${s.id}/resume`)))).subscription.status).toBe("ACTIVE");

    const upd = await h.as(a.owner, "PATCH", W(a.orgId, `/${s.id}`), { description: "renamed", event_types: ["*"] });
    expect(upd.status).toBe(200);
    expect((await json<{ subscription: Subscription }>(upd)).subscription.event_types).toEqual(["*"]);

    const dis = await h.as(a.owner, "POST", W(a.orgId, `/${s.id}/disable`), { reason: "migrating" });
    expect(dis.status).toBe(200);
    const disabled = (await json<{ subscription: Subscription }>(dis)).subscription;
    expect(disabled.status).toBe("DISABLED");
    expect(disabled.disabled_reason).toBe("migrating");
    const before = JSON.stringify(subRow(s.id));

    for (const [m, p, body] of [
      ["POST", `/${s.id}/disable`, undefined],
      ["POST", `/${s.id}/pause`, undefined],
      ["POST", `/${s.id}/resume`, undefined],
      ["POST", `/${s.id}/rotate-secret`, undefined],
      ["PATCH", `/${s.id}`, { description: "x" }],
    ] as const) {
      const res = await h.as(a.owner, m, W(a.orgId, p), body);
      expect(res.status, `${m} ${p}`).toBe(409);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("WEBHOOK_SUBSCRIPTION_FINAL");
      expect(text).not.toMatch(/sqlite|trigger|RAISE|constraint/i);
    }
    expect(JSON.stringify(subRow(s.id))).toBe(before);

    const bodyless = await h.as(a.owner, "POST", W(a.orgId, `/${(await createSub(a.owner, a.orgId)).id}/disable`));
    expect(bodyless.status).toBe(200);
  });

  it("list: status filter + cursor pagination; malformed id → 404", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createSub(a.owner, a.orgId, { url: `https://hooks.example.com/${i}` })).id);
    await h.as(a.owner, "POST", W(a.orgId, `/${ids[0]}/pause`));

    const paused = await json<{ items: Subscription[] }>(await h.as(a.owner, "GET", W(a.orgId, "?status=PAUSED")));
    expect(paused.items.map((s) => s.id)).toEqual([ids[0]]);
    expect((await h.as(a.owner, "GET", W(a.orgId, "?status=BOGUS"))).status).toBe(400);

    const p1 = await json<{ items: Subscription[]; next_cursor: string | null }>(await h.as(a.owner, "GET", W(a.orgId, "?limit=2")));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<{ items: Subscription[]; next_cursor: string | null }>(await h.as(a.owner, "GET", W(a.orgId, `?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`)));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((s) => s.id)).size).toBe(3);

    expect((await h.as(a.owner, "GET", W(a.orgId, "/not-a-uuid"))).status).toBe(404);
    const missing = await h.as(a.owner, "GET", W(a.orgId, `/${RANDOM_ID}`));
    expect(missing.status).toBe(404);
    expect(await h.errorCode(missing)).toBe("WEBHOOK_SUBSCRIPTION_NOT_FOUND");
  });

  it("fails CLOSED (503 WEBHOOK_VAULT_UNAVAILABLE) when POSTBACK_SECRET_KEY is absent", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    delete h.env.POSTBACK_SECRET_KEY;
    const res = await h.as(a.owner, "POST", W(a.orgId), { url: "https://hooks.example.com/tvh" });
    expect(res.status).toBe(503);
    expect(await h.errorCode(res)).toBe("WEBHOOK_VAULT_UNAVAILABLE");
    expect(count("SELECT COUNT(*) AS n FROM webhook_subscriptions")).toBe(0);
  });
});

describe("webhooks HTTP — tenant isolation and permissions (§116)", () => {
  it("org B cannot see, read, change or replay org A's subscriptions/deliveries (404 both ways); nothing written", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const b = await advertiser("b@adv.example", "Adv B");
    const sa = await createSub(a.owner, a.orgId);
    const sb = await createSub(b.owner, b.orgId);

    const bList = await json<{ items: Subscription[] }>(await h.as(b.owner, "GET", W(b.orgId)));
    expect(bList.items.map((s) => s.id)).toEqual([sb.id]);
    const aList = await json<{ items: Subscription[] }>(await h.as(a.owner, "GET", W(a.orgId)));
    expect(aList.items.map((s) => s.id)).toEqual([sa.id]);

    for (const [m, p, body] of [
      ["GET", `/${sa.id}`, undefined],
      ["PATCH", `/${sa.id}`, { description: "hijack" }],
      ["POST", `/${sa.id}/pause`, undefined],
      ["POST", `/${sa.id}/disable`, undefined],
      ["POST", `/${sa.id}/rotate-secret`, undefined],
    ] as const) {
      const res = await h.as(b.owner, m, W(b.orgId, p), body);
      expect(res.status, `${m} ${p}`).toBe(404);
    }
    // Cross-org path: B's token against A's org id → requireOrg 404 (no enumeration).
    expect((await h.as(b.owner, "GET", W(a.orgId))).status).toBe(404);
    expect(subRow(sa.id).status).toBe("ACTIVE");
    expect(subRow(sa.id).description).toBeNull();

    // Deliveries: publish for A; B's delivery log stays empty and cannot address A's row.
    const ops = await platformAdmin();
    const { result } = await publish(ops, a.orgId, EVENT());
    const dA = result.deliveries[0]!;
    expect((await json<{ items: Delivery[] }>(await h.as(b.owner, "GET", W(b.orgId, "/deliveries")))).items).toEqual([]);
    expect((await h.as(b.owner, "GET", W(b.orgId, `/deliveries/${dA.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "POST", W(b.orgId, `/deliveries/${dA.id}/attempt`))).status).toBe(404);
    expect(deliveryRow(dA.id).status).toBe("QUEUED");
  });

  it("webhooks.read vs webhooks.manage vs webhooks.replay: CAMPAIGN_MANAGER reads only; VIEWER nothing; owner cannot replay or drain; unauthenticated → 401", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const s = await createSub(a.owner, a.orgId);
    const cm = await member(a.owner, a.orgId, "cm@adv.example", "CAMPAIGN_MANAGER");
    const viewer = await member(a.owner, a.orgId, "v@adv.example", "VIEWER");
    const ops = await platformAdmin();
    const d = (await publish(ops, a.orgId, EVENT())).result.deliveries[0]!;

    expect((await h.as(cm, "GET", W(a.orgId))).status).toBe(200);
    expect((await h.as(cm, "GET", W(a.orgId, `/${s.id}`))).status).toBe(200);
    expect((await h.as(cm, "GET", W(a.orgId, "/deliveries"))).status).toBe(200);
    expect((await h.as(cm, "GET", W(a.orgId, `/deliveries/${d.id}`))).status).toBe(200);
    for (const [m, p, body] of [
      ["POST", "", { url: "https://x.example.com" }],
      ["PATCH", `/${s.id}`, { description: "x" }],
      ["POST", `/${s.id}/pause`, undefined],
      ["POST", `/${s.id}/rotate-secret`, undefined],
      ["POST", `/deliveries/${d.id}/attempt`, undefined],
      ["POST", `/deliveries/${d.id}/replay`, undefined],
    ] as const) {
      const res = await h.as(cm, m, W(a.orgId, p), body);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
    expect((await h.as(viewer, "GET", W(a.orgId))).status).toBe(403);
    expect((await h.as(viewer, "GET", W(a.orgId, "/deliveries"))).status).toBe(403);

    // Tenant owner holds webhooks.manage but NOT webhooks.replay (0012) and is not PLATFORM.
    const ownerReplay = await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/replay`));
    expect(ownerReplay.status).toBe(403);
    // The platform face is 404 for a non-member of the PLATFORM org and 403 if an ADVERTISER somehow reaches it by its own org id.
    expect((await h.as(a.owner, "POST", P(ops.orgId, "/process-due"))).status).toBe(404);
    const drainAsTenant = await h.as(a.owner, "POST", P(a.orgId, "/process-due"));
    expect(drainAsTenant.status).toBe(403);
    expect((await h.as(a.owner, "POST", P(a.orgId, `/tenants/${a.orgId}/events`), EVENT("x"))).status).toBe(403);

    expect((await h.api("GET", W(a.orgId))).status).toBe(401);
    expect((await h.api("POST", W(a.orgId), {}, { url: "https://x.example.com" })).status).toBe(401);

    expect(subRow(s.id).status).toBe("ACTIVE");
    expect(deliveryRow(d.id).status).toBe("QUEUED");
    expect(transport.sent).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM webhook_events")).toBe(1);
  });
});

describe("webhooks HTTP — publish fan-out and idempotency (§75, §79)", () => {
  it("fans out to org A's ACTIVE matching subscriptions only; PAUSED/DISABLED/other-type/other-org excluded; same idempotency_key is a no-op", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const b = await advertiser("b@adv.example", "Adv B");
    const ops = await platformAdmin();

    const star = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/star" });
    const conv = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/conv", event_types: ["conversion_updated"] });
    const payout = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/payout", event_types: ["payout_status_changed"] });
    const paused = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/paused" });
    await h.as(a.owner, "POST", W(a.orgId, `/${paused.id}/pause`));
    const disabled = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/disabled" });
    await h.as(a.owner, "POST", W(a.orgId, `/${disabled.id}/disable`));
    await createSub(b.owner, b.orgId, { url: "https://hooks.example.com/b-star" });

    const first = await publish(ops, a.orgId, EVENT());
    expect(first.status).toBe(201);
    expect(first.result.replayed).toBe(false);
    expect(first.result.event.event_type).toBe("conversion_updated");
    expect(first.result.deliveries.map((d) => d.subscription_id).sort()).toEqual([star.id, conv.id].sort());
    for (const d of first.result.deliveries) {
      expect(d.status).toBe("QUEUED");
      expect(d.organization_id).toBe(a.orgId);
      expect(d.attempt_count).toBe(0);
    }
    expect(first.result.deliveries.map((d) => d.subscription_id)).not.toContain(payout.id);

    const again = await publish(ops, a.orgId, { ...EVENT(), payload: { different: true } });
    expect(again.status).toBe(200);
    expect(again.result.replayed).toBe(true);
    expect(again.result.event.id).toBe(first.result.event.id);
    expect(again.result.deliveries.map((d) => d.id).sort()).toEqual(first.result.deliveries.map((d) => d.id).sort());
    expect(count("SELECT COUNT(*) AS n FROM webhook_events")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE organization_id = ?", b.orgId)).toBe(0);

    // idempotency_key is GLOBALLY unique (0012): org B reusing A's key → clean 409 (no raw SQLite text, nothing written, nothing revealed).
    const collide = await h.as(ops.token, "POST", P(ops.orgId, `/tenants/${b.orgId}/events`), EVENT());
    expect(collide.status).toBe(409);
    const collideText = await collide.text();
    expect(JSON.parse(collideText).error.code).toBe("WEBHOOK_EVENT_DUPLICATE");
    expect(collideText).not.toMatch(/sqlite|unique|constraint/i);
    expect(collideText).not.toContain(a.orgId);
    expect(count("SELECT COUNT(*) AS n FROM webhook_events")).toBe(1);
    // A properly namespaced key for org B is its own event, fanned out to B only.
    const forB = await publish(ops, b.orgId, EVENT(`${b.orgId}:conversion:c1:APPROVED`));
    expect(forB.status).toBe(201);
    expect(forB.result.deliveries).toHaveLength(1);
    expect(forB.result.deliveries[0]!.organization_id).toBe(b.orgId);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE organization_id = ?", a.orgId)).toBe(2);

    // Tenant delivery log is filterable by subscription and status.
    const forConv = await json<{ items: Delivery[] }>(await h.as(a.owner, "GET", W(a.orgId, `/deliveries?subscription_id=${conv.id}`)));
    expect(forConv.items.map((d) => d.subscription_id)).toEqual([conv.id]);
    const queued = await json<{ items: Delivery[] }>(await h.as(a.owner, "GET", W(a.orgId, "/deliveries?status=QUEUED")));
    expect(queued.items).toHaveLength(2);
    expect((await h.as(a.owner, "GET", W(a.orgId, "/deliveries?status=NOPE"))).status).toBe(400);
    expect((await h.as(a.owner, "GET", W(a.orgId, "/deliveries?subscription_id=nope"))).status).toBe(400);

    // Platform publish validation: bad event type / missing key / unknown field → 400; unknown tenant id → 404.
    expect((await h.as(ops.token, "POST", P(ops.orgId, `/tenants/${a.orgId}/events`), { ...EVENT("k2"), event_type: "nope" })).status).toBe(400);
    expect((await h.as(ops.token, "POST", P(ops.orgId, `/tenants/${a.orgId}/events`), { event_type: "billing_alert", payload: {} })).status).toBe(400);
    expect((await h.as(ops.token, "POST", P(ops.orgId, `/tenants/not-a-uuid/events`), EVENT("k3"))).status).toBe(404);
  });
});

describe("webhooks HTTP — delivery lifecycle through the scripted transport (§74)", () => {
  it("successful attempt → DELIVERED, one attempt row, signed headers verify with the issued secret; second attempt → 409 WEBHOOK_DELIVERY_FINAL", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const ops = await platformAdmin();
    const s = await createSub(a.owner, a.orgId);
    const secret = s.secret!;
    const d = (await publish(ops, a.orgId, EVENT())).result.deliveries[0]!;

    const res = await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`));
    expect(res.status).toBe(200);
    const settled = (await json<{ delivery: Delivery }>(res)).delivery;
    expect(settled.id).toBe(d.id);
    expect(settled.status).toBe("DELIVERED");
    expect(settled.attempt_count).toBe(1);
    expect(settled.last_response_status).toBe(200);
    expect(settled.delivered_at).not.toBeNull();
    expect(settled.next_attempt_at).toBeNull();

    expect(transport.sent).toHaveLength(1);
    const req = transport.sent[0]!;
    expect(req.url).toBe("https://hooks.example.com/tvh");
    expect(req.method).toBe("POST");
    expect(req.headers[WEBHOOK_HEADERS.eventId]).toBe(d.event_id);
    expect(req.headers[WEBHOOK_HEADERS.subscriptionId]).toBe(s.id);
    expect(req.headers[WEBHOOK_HEADERS.delivery]).toBe(d.id);
    expect(req.headers[WEBHOOK_HEADERS.eventType]).toBe("conversion_updated");
    expect(req.headers[WEBHOOK_HEADERS.signature]).toMatch(/^[0-9a-f]{64}$/);
    expect(await WebhookService.verifySignature(secret, req.headers, req.body)).toBe(true);
    expect(await WebhookService.verifySignature(secret, req.headers, req.body + " ")).toBe(false);
    expect(await WebhookService.verifySignature("wrong-secret", req.headers, req.body)).toBe(false);
    const body = JSON.parse(req.body) as { id: string; type: string; data: Record<string, unknown>; reference: { type: string; id: string } };
    expect(body.id).toBe(d.event_id);
    expect(body.type).toBe("conversion_updated");
    expect(body.data).toEqual(EVENT().payload);
    expect(body.reference).toEqual({ type: "conversion", id: "c1" });
    // The signing secret travels in no header and no body.
    expect(JSON.stringify(req)).not.toContain(secret);

    const detail = await h.as(a.owner, "GET", W(a.orgId, `/deliveries/${d.id}`));
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain(secret);
    const parsed = JSON.parse(detailText) as { delivery: Delivery; event: { id: string }; attempts: Attempt[] };
    expect(parsed.event.id).toBe(d.event_id);
    expect(parsed.attempts).toHaveLength(1);
    expect(parsed.attempts[0]).toMatchObject({ attempt_number: 1, outcome: "SUCCESS", response_status: 200, error_code: null, is_replay: 0 });

    const again = await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`));
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("WEBHOOK_DELIVERY_FINAL");
    expect(transport.sent).toHaveLength(1);
    expect(attemptRows(d.id)).toHaveLength(1);
    expect(everythingStored()).not.toContain(secret);
  });

  it("failing attempts → RETRY with increasing back-off until max_attempts, then DEAD_LETTER; timeouts and network errors classified", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const ops = await platformAdmin();
    await createSub(a.owner, a.orgId);
    const d = (await publish(ops, a.orgId, EVENT())).result.deliveries[0]!;
    expect(d.max_attempts).toBe(5);

    transport.enqueue({ kind: "response", status: 500 }, { kind: "timeout" }, { kind: "network_error", code: "ECONNREFUSED" }, { kind: "response", status: 404 }, { kind: "response", status: 503 });

    const statuses: Array<[string, string | null, number | null]> = [];
    let previousNext: string | null = null;
    for (let i = 1; i <= 5; i++) {
      // RETRY rows are attemptable regardless of next_attempt_at (the drain is what honours it).
      const res = await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`));
      expect(res.status, `attempt ${i}`).toBe(200);
      const row = (await json<{ delivery: Delivery }>(res)).delivery;
      expect(row.attempt_count).toBe(i);
      statuses.push([row.status, row.last_error_code, row.last_response_status]);
      if (i < 5) {
        expect(row.status).toBe("RETRY");
        expect(row.next_attempt_at).not.toBeNull();
        if (previousNext) expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(new Date(previousNext).getTime());
        previousNext = row.next_attempt_at;
      } else {
        expect(row.status).toBe("DEAD_LETTER");
        expect(row.next_attempt_at).toBeNull();
        expect(row.dead_lettered_at).not.toBeNull();
      }
    }
    expect(statuses.map(([, code]) => code)).toEqual(["HTTP_500", "TIMEOUT", "ECONNREFUSED", "HTTP_404", "HTTP_503"]);
    expect(statuses.map(([, , st]) => st)).toEqual([500, null, null, 404, 503]);
    expect(attemptRows(d.id).map((r) => r.outcome)).toEqual(["HTTP_ERROR", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "HTTP_ERROR"]);

    // DEAD_LETTER is not attemptable (only replay re-queues it).
    const dead = await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`));
    expect(dead.status).toBe(409);
    expect(await h.errorCode(dead)).toBe("WEBHOOK_DELIVERY_NOT_DUE");
    expect(transport.sent).toHaveLength(5);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?", d.subscription_id, d.event_id)).toBe(1);
  });

  it("PLATFORM process-due drains QUEUED rows across tenants under each row's own tenant; honours next_attempt_at; non-PLATFORM → 403", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const b = await advertiser("b@adv.example", "Adv B");
    const ops = await platformAdmin();
    await createSub(a.owner, a.orgId);
    await createSub(b.owner, b.orgId);
    const dA = (await publish(ops, a.orgId, EVENT("a1"))).result.deliveries[0]!;
    const dB = (await publish(ops, b.orgId, EVENT("b1"))).result.deliveries[0]!;

    transport.enqueue({ kind: "response", status: 500 }); // first sent request fails, the other succeeds
    const drain = await h.as(ops.token, "POST", P(ops.orgId, "/process-due"), { limit: 10 });
    expect(drain.status).toBe(200);
    expect(await json<unknown>(drain)).toEqual({ processed: 2, delivered: 1, retry: 1, dead_letter: 0 });
    const after = [deliveryRow(dA.id), deliveryRow(dB.id)].map((r) => r.status).sort();
    expect(after).toEqual(["DELIVERED", "RETRY"]);
    expect(deliveryRow(dA.id).organization_id).toBe(a.orgId);
    expect(deliveryRow(dB.id).organization_id).toBe(b.orgId);

    // The RETRY row's next_attempt_at is in the future → a second drain does nothing.
    const idle = await h.as(ops.token, "POST", P(ops.orgId, "/process-due"));
    expect(await json<unknown>(idle)).toEqual({ processed: 0, delivered: 0, retry: 0, dead_letter: 0 });
    expect(transport.sent).toHaveLength(2);

    expect((await h.as(ops.token, "POST", P(ops.orgId, "/process-due"), { limit: 0 })).status).toBe(400);
    expect((await h.as(ops.token, "POST", P(ops.orgId, "/process-due"), { limit: 1000 })).status).toBe(400);

    // Tenant read of its own drained delivery shows the platform-triggered attempt (no user attribution).
    const detail = await json<{ attempts: Attempt[] }>(await h.as(b.owner, "GET", W(b.orgId, `/deliveries/${dB.id}`)));
    expect(detail.attempts).toHaveLength(1);
  });
});

describe("webhooks HTTP — replay (§75 Definition of Done)", () => {
  it("DELIVERED → 409 WEBHOOK_DELIVERY_FINAL (clean envelope); DEAD_LETTER → same row re-queued → DELIVERED exactly once; row count stays 1", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const ops = await platformAdmin();
    const s = await createSub(a.owner, a.orgId, { url: "https://hooks.example.com/tvh", description: "primary" });
    const secret = s.secret!;
    const d = (await publish(ops, a.orgId, EVENT())).result.deliveries[0]!;
    const pair = () => count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE subscription_id = ? AND event_id = ?", d.subscription_id, d.event_id);
    const replayPath = P(ops.orgId, `/tenants/${a.orgId}/deliveries/${d.id}/replay`);

    // QUEUED: nothing to replay yet.
    const tooEarly = await h.as(ops.token, "POST", replayPath);
    expect(tooEarly.status).toBe(409);
    expect(await h.errorCode(tooEarly)).toBe("WEBHOOK_DELIVERY_NOT_REPLAYABLE");

    // Drive to DEAD_LETTER with five failures.
    transport.enqueue(...Array.from({ length: 5 }, () => ({ kind: "response", status: 502 }) as const));
    for (let i = 0; i < 5; i++) expect((await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`))).status).toBe(200);
    expect(deliveryRow(d.id).status).toBe("DEAD_LETTER");
    expect(pair()).toBe(1);
    const beforeReplay = JSON.stringify(deliveryRow(d.id));

    // Replay with a healthy receiver: SAME row → QUEUED → attempted → DELIVERED.
    const replay = await h.as(ops.token, "POST", replayPath);
    expect(replay.status).toBe(200);
    const replayed = (await json<{ delivery: Delivery }>(replay)).delivery;
    expect(replayed.id).toBe(d.id);
    expect(replayed.status).toBe("DELIVERED");
    expect(replayed.replay_count).toBe(1);
    expect(replayed.attempt_count).toBe(6);
    expect(replayed.delivered_at).not.toBeNull();
    expect(pair()).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM webhook_events")).toBe(1);
    expect(JSON.stringify(deliveryRow(d.id))).not.toBe(beforeReplay);

    // The replayed request re-sends the SAME event id with a fresh valid signature.
    expect(transport.sent).toHaveLength(6);
    const last = transport.sent[5]!;
    expect(last.headers[WEBHOOK_HEADERS.eventId]).toBe(d.event_id);
    expect(last.headers[WEBHOOK_HEADERS.delivery]).toBe(d.id);
    expect(await WebhookService.verifySignature(secret, last.headers, last.body)).toBe(true);
    const attempts = attemptRows(d.id);
    expect(attempts).toHaveLength(6);
    expect(attempts.map((r) => r.is_replay)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(attempts[5]!.outcome).toBe("SUCCESS");
    expect(attempts[5]!.triggered_by_user_id).not.toBeNull();

    const audit = await h.auditRows("webhooks.delivery_replayed");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(d.id);
    expect(audit[0]!.organization_id).toBe(a.orgId);
    expect(JSON.parse(audit[0]!.metadata!)).toMatchObject({ event_id: d.event_id, previous_status: "DEAD_LETTER", replay_number: 1 });

    // Replaying the now-DELIVERED row is refused at the service with a clean envelope and writes nothing.
    const afterDelivered = JSON.stringify(deliveryRow(d.id));
    const final = await h.as(ops.token, "POST", replayPath);
    expect(final.status).toBe(409);
    const text = await final.text();
    expect(JSON.parse(text).error.code).toBe("WEBHOOK_DELIVERY_FINAL");
    expect(text).not.toMatch(/sqlite|trigger|RAISE|constraint|WEBHOOK_DELIVERY_FINAL:/i);
    expect(JSON.stringify(deliveryRow(d.id))).toBe(afterDelivered);
    expect(transport.sent).toHaveLength(6);
    expect(attemptRows(d.id)).toHaveLength(6);
    expect(pair()).toBe(1);
    expect((await h.auditRows("webhooks.delivery_replayed")).length).toBe(1);

    // No secret anywhere: responses, attempt rows, audit rows, events, deliveries.
    expect(everythingStored()).not.toContain(secret);
    expect(text).not.toContain(secret);
    expect(JSON.stringify(transport.sent)).not.toContain(secret);
  });

  it("RETRY → replay re-queues the same row; a replay that fails again goes back to RETRY (not a new row); malformed/unknown ids → 404", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const ops = await platformAdmin();
    await createSub(a.owner, a.orgId);
    const d = (await publish(ops, a.orgId, EVENT())).result.deliveries[0]!;
    const replayPath = (id: string) => P(ops.orgId, `/tenants/${a.orgId}/deliveries/${id}/replay`);

    transport.enqueue({ kind: "response", status: 500 });
    expect((await json<{ delivery: Delivery }>(await h.as(a.owner, "POST", W(a.orgId, `/deliveries/${d.id}/attempt`)))).delivery.status).toBe("RETRY");

    transport.enqueue({ kind: "timeout" });
    const r1 = (await json<{ delivery: Delivery }>(await h.as(ops.token, "POST", replayPath(d.id)))).delivery;
    expect(r1.id).toBe(d.id);
    expect(r1.status).toBe("RETRY");
    expect(r1.replay_count).toBe(1);
    expect(r1.attempt_count).toBe(2);

    const r2 = (await json<{ delivery: Delivery }>(await h.as(ops.token, "POST", replayPath(d.id)))).delivery;
    expect(r2.id).toBe(d.id);
    expect(r2.status).toBe("DELIVERED");
    expect(r2.replay_count).toBe(2);
    expect(r2.attempt_count).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM webhook_deliveries")).toBe(1);
    expect(attemptRows(d.id).map((r) => r.is_replay)).toEqual([0, 1, 1]);

    expect((await h.as(ops.token, "POST", replayPath("not-a-uuid"))).status).toBe(404);
    const missing = await h.as(ops.token, "POST", replayPath(RANDOM_ID));
    expect(missing.status).toBe(404);
    expect(await h.errorCode(missing)).toBe("WEBHOOK_DELIVERY_NOT_FOUND");
    // Platform read of the tenant's delivery log.
    const platformList = await json<{ items: Delivery[] }>(await h.as(ops.token, "GET", P(ops.orgId, `/tenants/${a.orgId}/deliveries`)));
    expect(platformList.items.map((x) => x.id)).toEqual([d.id]);
    expect((await h.as(ops.token, "GET", P(ops.orgId, `/tenants/${a.orgId}/deliveries/${d.id}`))).status).toBe(200);
  });
});
