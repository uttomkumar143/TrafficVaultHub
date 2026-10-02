/**
 * Phase 6 Unit 6 — notifications through the REAL app (auth → requireOrg →
 * requirePermission → NotificationService → NotificationRepository → D1 shim
 * running the actual migrations incl. 0012), with a `MemoryNotificationAdapter`
 * (EMAIL) and a `ScriptedWebhookTransport` injected through `createApp`.
 *
 * Covers (PRD §79, §80, §116, §127):
 *   * producer face: PLATFORM-only (tenant org → 403); one IN_APP + N EMAIL +
 *     one WEBHOOK row per emit; the EMAIL adapter receives one message per
 *     ACTIVE member; the WEBHOOK channel lands in `webhook_events` under
 *     `notification:<dedupe_key>`; same `dedupe_key` ⇒ 200 replayed, no new
 *     rows, no second email, no second webhook event;
 *   * feed: SENT IN_APP rows only (EMAIL/WEBHOOK/SUPPRESSED invisible), cursor
 *     pagination with `unread_count`, `?unread=true`; tenant isolation; other
 *     members' targeted rows invisible; org-wide rows share one read state;
 *   * read: idempotent POST /:id/read, read-all, 404 for invisible ids;
 *   * preferences: 7×3 matrix, PUT suppresses EMAIL (row SUPPRESSED, no
 *     adapter call), security_event/compliance_action IN_APP → 409
 *     PREFERENCE_LOCKED and still delivered;
 *   * API keys: feed with scope OK, without scope 403 INSUFFICIENT_SCOPE,
 *     write routes 403 FORBIDDEN (session only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryNotificationAdapter } from "../integrations/notification-adapter";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { ScriptedWebhookTransport } from "../modules/webhooks/transport";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));

interface Notification {
  id: string;
  organization_id: string;
  user_id: string | null;
  event_type: string;
  channel: string;
  severity: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  dedupe_key: string | null;
  status: string;
  sent_at: string | null;
  read_at: string | null;
  error_code: string | null;
  created_at: string;
}
interface Feed {
  items: Notification[];
  next_cursor: string | null;
  unread_count: number;
}
interface EmitResult {
  notifications: Notification[];
  replayed: boolean;
}
interface Pref {
  event_type: string;
  channel: string;
  enabled: boolean;
  locked: boolean;
}

let h: TestHarness;
let email: MemoryNotificationAdapter;
let transport: ScriptedWebhookTransport;
beforeEach(() => {
  email = new MemoryNotificationAdapter("EMAIL");
  transport = new ScriptedWebhookTransport();
  h = new TestHarness({ notificationAdapter: email, webhookTransport: transport });
  h.env.POSTBACK_SECRET_KEY = MASTER;
});
afterEach(() => h.close());

const N = (orgId: string, path = "") => `/organizations/${orgId}/notifications${path}`;
const E = (platformOrgId: string, tenantOrgId: string) => `/organizations/${platformOrgId}/platform/notifications/tenants/${tenantOrgId}/events`;

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

async function platformAdmin(email = "ops@platform.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  return { token, orgId };
}

async function userId(email: string): Promise<string> {
  const row = await h.db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").bind(email).first<{ id: string }>();
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

let seq = 0;
function emitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    event_type: "offer_status_changed",
    title: `Offer ${seq} approved`,
    body: "Your offer is now live.",
    dedupe_key: `offer:${seq}:APPROVED`,
    payload: { offer_id: RANDOM_ID },
    ...overrides,
  };
}

async function emit(platform: { token: string; orgId: string }, tenantOrgId: string, body: Record<string, unknown>, expectStatus = 201): Promise<EmitResult> {
  const res = await h.as(platform.token, "POST", E(platform.orgId, tenantOrgId), body);
  const text = await res.text();
  expect(res.status, text).toBe(expectStatus);
  return JSON.parse(text) as EmitResult;
}

async function feed(token: string, orgId: string, qs = ""): Promise<Feed> {
  const res = await h.as(token, "GET", N(orgId, qs));
  expect(res.status).toBe(200);
  return json<Feed>(res);
}

async function dbCount(where: string, ...binds: unknown[]): Promise<number> {
  const row = await h.db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("notifications — producer face (PLATFORM)", () => {
  it("emits one IN_APP + one EMAIL per ACTIVE member + one WEBHOOK row; EMAIL adapter and webhook_events see it once", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    const p = await platformAdmin();

    const r = await emit(p, a.orgId, emitBody({ dedupe_key: "offer:1:APPROVED" }));
    expect(r.replayed).toBe(false);
    const byChannel = (ch: string) => r.notifications.filter((n) => n.channel === ch);
    expect(byChannel("IN_APP")).toHaveLength(1);
    expect(byChannel("IN_APP")[0]!.user_id).toBeNull();
    expect(byChannel("IN_APP")[0]!.status).toBe("SENT");
    expect(byChannel("EMAIL")).toHaveLength(2);
    expect(byChannel("EMAIL").every((n) => n.status === "SENT" && n.user_id !== null)).toBe(true);
    expect(byChannel("WEBHOOK")).toHaveLength(1);
    expect(byChannel("WEBHOOK")[0]!.status).toBe("SENT");
    expect(r.notifications.every((n) => n.organization_id === a.orgId)).toBe(true);

    expect(email.delivered.map((m) => m.to).sort()).toEqual(["mgr@acme.example", "owner@acme.example"]);
    expect(email.delivered[0]!.subject).toContain("approved");

    const ev = await h.db
      .prepare("SELECT organization_id, event_type, idempotency_key FROM webhook_events WHERE idempotency_key = ?")
      .bind("notification:offer:1:APPROVED")
      .all<{ organization_id: string; event_type: string }>();
    expect(ev.results).toHaveLength(1);
    expect(ev.results[0]).toMatchObject({ organization_id: a.orgId, event_type: "offer_status_changed" });

    const audit = await h.auditRows("notification.emitted");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.organization_id).toBe(a.orgId);
  });

  it("same dedupe_key replays idempotently: 200 replayed:true, no new rows, no second email, no second webhook event", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const p = await platformAdmin();
    const body = emitBody({ dedupe_key: "payout:9:PAID", event_type: "payout_status_changed" });

    const first = await emit(p, a.orgId, body);
    const second = await emit(p, a.orgId, { ...body, title: "different title on replay" }, 200);
    expect(second.replayed).toBe(true);
    expect(second.notifications.map((n) => n.id).sort()).toEqual(first.notifications.map((n) => n.id).sort());
    expect(await dbCount("organization_id = ?", a.orgId)).toBe(first.notifications.length);
    expect(email.delivered).toHaveLength(1);
    const ev = await h.db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE idempotency_key = ?").bind("notification:payout:9:PAID").first<{ n: number }>();
    expect(Number(ev?.n)).toBe(1);
  });

  it("targeted emit (user_id) addresses one member only; non-member → 404 MEMBER_NOT_FOUND; tenant org → 403; bad event_type/channel → 400", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const mgr = await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    const mgrId = await userId("mgr@acme.example");
    const p = await platformAdmin();

    const r = await emit(p, a.orgId, emitBody({ user_id: mgrId, channels: ["IN_APP", "EMAIL"] }));
    expect(r.notifications).toHaveLength(2);
    expect(r.notifications.every((n) => n.user_id === mgrId)).toBe(true);
    expect(email.delivered.map((m) => m.to)).toEqual(["mgr@acme.example"]);

    // Visible to mgr, invisible to the owner.
    expect((await feed(mgr, a.orgId)).items).toHaveLength(1);
    expect((await feed(a.owner, a.orgId)).items).toHaveLength(0);

    const stranger = await userId("ops@platform.example");
    let res = await h.as(p.token, "POST", E(p.orgId, a.orgId), emitBody({ user_id: stranger }));
    expect(res.status).toBe(404);
    expect(await h.errorCode(res)).toBe("MEMBER_NOT_FOUND");

    res = await h.as(a.owner, "POST", E(a.orgId, a.orgId), emitBody());
    expect(res.status).toBe(403);

    res = await h.as(p.token, "POST", E(p.orgId, a.orgId), emitBody({ event_type: "something_else" }));
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    res = await h.as(p.token, "POST", E(p.orgId, a.orgId), emitBody({ channels: ["SMS"] }));
    expect(res.status).toBe(400);
    res = await h.as(p.token, "POST", E(p.orgId, a.orgId), emitBody({ dedupe_key: "has|pipe" }));
    expect(res.status).toBe(400);
  });

  it("EMAIL adapter failure → FAILED row with error_code, IN_APP still SENT; response carries no stack", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const p = await platformAdmin();
    email.failWith = "SMTP_DOWN";
    const r = await emit(p, a.orgId, emitBody({ channels: ["IN_APP", "EMAIL"] }));
    const mail = r.notifications.find((n) => n.channel === "EMAIL")!;
    expect(mail.status).toBe("FAILED");
    expect(mail.error_code).toBe("SMTP_DOWN");
    expect(mail.sent_at).toBeNull();
    expect(r.notifications.find((n) => n.channel === "IN_APP")!.status).toBe("SENT");
    expect(JSON.stringify(r)).not.toMatch(/stack|at .*\.ts:/);
  });
});

describe("notifications — feed, read state, isolation", () => {
  it("feed shows only SENT IN_APP rows of this org; cursor pagination + unread_count; ?unread=true", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const p = await platformAdmin();
    for (let i = 0; i < 3; i++) await emit(p, a.orgId, emitBody());
    await emit(p, b.orgId, emitBody({ title: "Beta only" }));

    const page1 = await feed(a.owner, a.orgId, "?limit=2");
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    expect(page1.unread_count).toBe(3);
    expect(page1.items.every((n) => n.channel === "IN_APP" && n.status === "SENT" && n.organization_id === a.orgId)).toBe(true);

    const page2 = await feed(a.owner, a.orgId, `?limit=2&cursor=${page1.next_cursor}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((n) => n.id));
    expect(ids.size).toBe(3);
    expect([...page1.items, ...page2.items].some((n) => n.title === "Beta only")).toBe(false);

    // Beta's owner cannot read Acme's feed at all (non-member → 404, tenant existence hidden).
    const res = await h.as(b.owner, "GET", N(a.orgId));
    expect(res.status).toBe(404);

    // Mark one read → unread filter excludes it.
    const target = page1.items[0]!;
    const read = await h.as(a.owner, "POST", N(a.orgId, `/${target.id}/read`));
    expect(read.status).toBe(200);
    expect((await json<{ notification: Notification }>(read)).notification.read_at).not.toBeNull();
    const unread = await feed(a.owner, a.orgId, "?unread=true");
    expect(unread.items.map((n) => n.id)).not.toContain(target.id);
    expect(unread.unread_count).toBe(2);
    expect(unread.items).toHaveLength(2);

    const bad = await h.as(a.owner, "GET", N(a.orgId, "?unread=maybe"));
    expect(bad.status).toBe(400);
  });

  it("org-wide rows share one read state across members; targeted rows of another member are invisible (404 on read)", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const mgr = await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    const mgrId = await userId("mgr@acme.example");
    const p = await platformAdmin();

    const orgWide = (await emit(p, a.orgId, emitBody({ channels: ["IN_APP"] }))).notifications[0]!;
    const targeted = (await emit(p, a.orgId, emitBody({ user_id: mgrId, channels: ["IN_APP"] }))).notifications[0]!;

    // Owner marks the org-wide row read → mgr also sees it read.
    expect((await h.as(a.owner, "POST", N(a.orgId, `/${orgWide.id}/read`))).status).toBe(200);
    const mgrView = await json<{ notification: Notification }>(await h.as(mgr, "GET", N(a.orgId, `/${orgWide.id}`)));
    expect(mgrView.notification.read_at).not.toBeNull();
    expect((await feed(mgr, a.orgId)).unread_count).toBe(1); // only the targeted row

    // Owner cannot see or read mgr's targeted row.
    let res = await h.as(a.owner, "GET", N(a.orgId, `/${targeted.id}`));
    expect(res.status).toBe(404);
    expect(await h.errorCode(res)).toBe("NOTIFICATION_NOT_FOUND");
    res = await h.as(a.owner, "POST", N(a.orgId, `/${targeted.id}/read`));
    expect(res.status).toBe(404);
    expect(await dbCount("id = ? AND read_at IS NULL", targeted.id)).toBe(1);

    // Malformed id → 404, not 400/500.
    expect((await h.as(a.owner, "GET", N(a.orgId, "/not-a-uuid"))).status).toBe(404);
  });

  it("POST /:id/read is idempotent (second call 200, read_at unchanged); read-all clears the caller's view and audits", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const p = await platformAdmin();
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push((await emit(p, a.orgId, emitBody({ channels: ["IN_APP"] }))).notifications[0]!);

    const first = await json<{ notification: Notification }>(await h.as(a.owner, "POST", N(a.orgId, `/${rows[0]!.id}/read`)));
    const second = await json<{ notification: Notification }>(await h.as(a.owner, "POST", N(a.orgId, `/${rows[0]!.id}/read`)));
    expect(second.notification.read_at).toBe(first.notification.read_at);
    expect(await h.auditRows("notification.read")).toHaveLength(1);

    const all = await h.as(a.owner, "POST", N(a.orgId, "/read-all"));
    expect(all.status).toBe(200);
    expect(await json<{ updated: number; unread_count: number }>(all)).toEqual({ updated: 2, unread_count: 0 });
    expect((await feed(a.owner, a.orgId)).unread_count).toBe(0);
    expect(await h.auditRows("notification.read_all")).toHaveLength(1);
  });

  it("EMAIL / WEBHOOK / SUPPRESSED rows never surface in the feed or by id", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const p = await platformAdmin();
    const r = await emit(p, a.orgId, emitBody());
    const f = await feed(a.owner, a.orgId);
    expect(f.items).toHaveLength(1);
    for (const n of r.notifications.filter((x) => x.channel !== "IN_APP")) {
      expect((await h.as(a.owner, "GET", N(a.orgId, `/${n.id}`))).status).toBe(404);
    }
  });
});

describe("notifications — preferences (PRD §80)", () => {
  it("GET returns the 7×3 matrix, all enabled, security-critical IN_APP locked", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const res = await h.as(a.owner, "GET", N(a.orgId, "/preferences"));
    expect(res.status).toBe(200);
    const { preferences } = await json<{ preferences: Pref[] }>(res);
    expect(preferences).toHaveLength(21);
    expect(preferences.every((p) => p.enabled)).toBe(true);
    const locked = preferences.filter((p) => p.locked).map((p) => `${p.event_type}/${p.channel}`).sort();
    expect(locked).toEqual(["compliance_action/IN_APP", "security_event/IN_APP"]);
  });

  it("PUT disables EMAIL for one event → that user's EMAIL row is SUPPRESSED (no adapter call), others still SENT; audited", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    const ownerId = await userId("owner@acme.example");
    const p = await platformAdmin();

    const put = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), {
      preferences: [{ event_type: "offer_status_changed", channel: "EMAIL", enabled: false }],
    });
    expect(put.status).toBe(200);
    const { preferences } = await json<{ preferences: Pref[] }>(put);
    expect(preferences.find((x) => x.event_type === "offer_status_changed" && x.channel === "EMAIL")!.enabled).toBe(false);
    expect(preferences).toHaveLength(21);
    expect(await h.auditRows("notification_preferences.updated")).toHaveLength(1);

    const r = await emit(p, a.orgId, emitBody());
    const mails = r.notifications.filter((n) => n.channel === "EMAIL");
    expect(mails.find((n) => n.user_id === ownerId)!.status).toBe("SUPPRESSED");
    expect(mails.find((n) => n.user_id !== ownerId)!.status).toBe("SENT");
    expect(email.delivered.map((m) => m.to)).toEqual(["mgr@acme.example"]);

    // A different event type is unaffected.
    const r2 = await emit(p, a.orgId, emitBody({ event_type: "billing_alert" }));
    expect(r2.notifications.filter((n) => n.channel === "EMAIL").every((n) => n.status === "SENT")).toBe(true);

    // Re-enable (upsert) and the next emit sends again.
    expect(
      (await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "offer_status_changed", channel: "EMAIL", enabled: true }] })).status,
    ).toBe(200);
    const r3 = await emit(p, a.orgId, emitBody());
    expect(r3.notifications.filter((n) => n.channel === "EMAIL").every((n) => n.status === "SENT")).toBe(true);
  });

  it("security_event / compliance_action cannot be disabled on IN_APP (409 PREFERENCE_LOCKED) and are always delivered; EMAIL for them CAN be disabled", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ownerId = await userId("owner@acme.example");
    const p = await platformAdmin();

    for (const event_type of ["security_event", "compliance_action"]) {
      const res = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type, channel: "IN_APP", enabled: false }] });
      expect(res.status).toBe(409);
      expect(await h.errorCode(res)).toBe("PREFERENCE_LOCKED");
    }
    // Nothing was stored (the 0012 CHECK would have refused it anyway).
    const stored = await h.db.prepare("SELECT COUNT(*) AS n FROM notification_preferences").first<{ n: number }>();
    expect(Number(stored?.n)).toBe(0);

    // Non-locked channel of a locked event is a normal preference.
    expect(
      (await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "security_event", channel: "EMAIL", enabled: false }] })).status,
    ).toBe(200);

    const r = await emit(p, a.orgId, emitBody({ event_type: "security_event", severity: "CRITICAL", user_id: ownerId }));
    expect(r.notifications.find((n) => n.channel === "IN_APP")!.status).toBe("SENT");
    expect(r.notifications.find((n) => n.channel === "EMAIL")!.status).toBe("SUPPRESSED");
    expect((await feed(a.owner, a.orgId)).items[0]!.severity).toBe("CRITICAL");
  });

  it("PUT validation: unknown event/channel → 400; duplicate pair → 400; empty list → 400; preferences are per user", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const mgr = await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    let res = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "nope", channel: "EMAIL", enabled: false }] });
    expect(res.status).toBe(400);
    res = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "billing_alert", channel: "SMS", enabled: false }] });
    expect(res.status).toBe(400);
    res = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), {
      preferences: [
        { event_type: "billing_alert", channel: "EMAIL", enabled: false },
        { event_type: "billing_alert", channel: "EMAIL", enabled: true },
      ],
    });
    expect(res.status).toBe(400);
    res = await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [] });
    expect(res.status).toBe(400);

    expect((await h.as(a.owner, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "billing_alert", channel: "EMAIL", enabled: false }] })).status).toBe(200);
    const mgrPrefs = await json<{ preferences: Pref[] }>(await h.as(mgr, "GET", N(a.orgId, "/preferences")));
    expect(mgrPrefs.preferences.every((p) => p.enabled)).toBe(true);
  });
});

describe("notifications — API keys (PRD §77)", () => {
  async function createKey(token: string, orgId: string, scopes: string[]): Promise<string> {
    const res = await h.as(token, "POST", `/organizations/${orgId}/api-keys`, { name: "bot", scopes });
    expect(res.status).toBe(201);
    return (await json<{ api_key: { key: string } }>(res)).api_key.key;
  }

  it("key with notifications.read reads the feed; without the scope → 403 INSUFFICIENT_SCOPE; write routes → 403 (session only)", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const p = await platformAdmin();
    const row = (await emit(p, a.orgId, emitBody({ channels: ["IN_APP"] }))).notifications[0]!;

    const scoped = await createKey(a.owner, a.orgId, ["notifications.read"]);
    let res = await h.as(scoped, "GET", N(a.orgId));
    expect(res.status).toBe(200);
    expect((await json<Feed>(res)).items).toHaveLength(1);
    expect((await h.as(scoped, "GET", N(a.orgId, "/preferences"))).status).toBe(200);

    res = await h.as(scoped, "POST", N(a.orgId, `/${row.id}/read`));
    expect(res.status).toBe(403);
    expect(await h.errorCode(res)).toBe("FORBIDDEN");
    res = await h.as(scoped, "PUT", N(a.orgId, "/preferences"), { preferences: [{ event_type: "billing_alert", channel: "EMAIL", enabled: false }] });
    expect(res.status).toBe(403);
    expect((await h.as(scoped, "POST", N(a.orgId, "/read-all"))).status).toBe(403);
    expect(await dbCount("id = ? AND read_at IS NULL", row.id)).toBe(1);

    const unscoped = await createKey(a.owner, a.orgId, ["organizations.read"]);
    res = await h.as(unscoped, "GET", N(a.orgId));
    expect(res.status).toBe(403);
    expect(await h.errorCode(res)).toBe("INSUFFICIENT_SCOPE");

    // Unauthenticated → 401 with the standard envelope.
    res = await h.api("GET", N(a.orgId));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
