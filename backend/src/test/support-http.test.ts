/**
 * Phase 6 Unit 7 — support tickets over HTTP (PRD §81, §116).
 * Disputes and appeals live in `disputes-appeals-http.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RANDOM_ID, TestHarness, json } from "./fixtures";

interface Ticket {
  id: string;
  status: string;
  category: string;
  priority: string;
  subject: string;
  assigned_agent_user_id: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
}
interface Message {
  id: string;
  author_type: string;
  body: string;
  is_internal: boolean;
}
interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

const T = (orgId: string, path = "") => `/organizations/${orgId}/support/tickets${path}`;
const P = (platformOrgId: string, tenantOrgId: string, path = "") => `/organizations/${platformOrgId}/platform/support/tenants/${tenantOrgId}${path}`;
const NEW_TICKET = { category: "BILLING", subject: "Invoice mismatch", body: "Our March invoice shows a line we did not order." };

async function advertiser(email: string, name: string) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  return { owner, orgId };
}
async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  const token = await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return token;
}
async function userId(email: string): Promise<string> {
  const row = await h.db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").bind(email).first<{ id: string }>();
  if (!row) throw new Error("no user");
  return row.id;
}
async function openTicket(token: string, orgId: string, extra: Record<string, unknown> = {}): Promise<Ticket> {
  const res = await h.as(token, "POST", T(orgId), { ...NEW_TICKET, ...extra });
  expect(res.status).toBe(201);
  return json<Ticket>(res);
}
/** SUPER_ADMIN (unrestricted) + a SUPPORT_AGENT without any grant yet. */
async function platform() {
  const admin = await h.user("admin@network.example");
  const platformOrgId = await h.platformOrg("admin@network.example", "SUPER_ADMIN");
  const agent = await h.user("agent@network.example");
  await h.platformOrg("agent@network.example", "SUPPORT_AGENT");
  return { admin, agent, platformOrgId, agentUserId: await userId("agent@network.example") };
}

describe("support tickets — tenant face", () => {
  it("create → 201 OPEN with opening REQUESTER message + CREATED event; list/get/messages/events read back; audit row written", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const t = await openTicket(a.owner, a.orgId);
    expect(t.status).toBe("OPEN");
    expect(t.priority).toBe("NORMAL");
    expect((await json<Page<Ticket>>(await h.as(a.owner, "GET", T(a.orgId)))).items.map((x) => x.id)).toEqual([t.id]);
    expect((await json<Ticket>(await h.as(a.owner, "GET", T(a.orgId, `/${t.id}`)))).subject).toBe("Invoice mismatch");
    const msgs = await json<Page<Message>>(await h.as(a.owner, "GET", T(a.orgId, `/${t.id}/messages`)));
    expect(msgs.items.map((m) => [m.author_type, m.is_internal])).toEqual([["REQUESTER", false]]);
    const events = await json<Page<{ event_type: string; to_status: string }>>(await h.as(a.owner, "GET", T(a.orgId, `/${t.id}/events`)));
    expect(events.items.map((e) => e.event_type)).toEqual(["CREATED"]);
    expect((await h.auditRows("support.ticket.created")).map((r) => r.target_id)).toEqual([t.id]);
  });

  it("cursor pagination walks (created_at,id) without overlap; status filter applies; unknown status → 400", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await openTicket(a.owner, a.orgId, { subject: `T${i}` })).id);
    const p1 = await json<Page<Ticket>>(await h.as(a.owner, "GET", T(a.orgId, "?limit=2")));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<Page<Ticket>>(await h.as(a.owner, "GET", T(a.orgId, `?limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`)));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((t) => t.id))).toEqual(ids);
    expect((await json<Page<Ticket>>(await h.as(a.owner, "GET", T(a.orgId, "?status=CLOSED")))).items).toEqual([]);
    expect((await h.as(a.owner, "GET", T(a.orgId, "?status=BOGUS"))).status).toBe(400);
  });

  it("requester reply is never internal; requester may close OPEN and reopen RESOLVED, but OPEN→RESOLVED is 409 SUPPORT_TICKET_ILLEGAL_TRANSITION", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const t = await openTicket(a.owner, a.orgId);
    const reply = await h.as(a.owner, "POST", T(a.orgId, `/${t.id}/messages`), { body: "Any update?", internal: true });
    expect(reply.status).toBe(201);
    expect((await json<Message>(reply)).is_internal).toBe(false);
    const bad = await h.as(a.owner, "POST", T(a.orgId, `/${t.id}/transition`), { status: "RESOLVED" });
    expect(bad.status).toBe(409);
    expect(await h.errorCode(bad)).toBe("SUPPORT_TICKET_ILLEGAL_TRANSITION");
    const closed = await h.as(a.owner, "POST", T(a.orgId, `/${t.id}/transition`), { status: "CLOSED", reason: "solved it myself" });
    expect(closed.status).toBe(200);
    expect((await json<Ticket>(closed)).closed_at).not.toBeNull();
    const again = await h.as(a.owner, "POST", T(a.orgId, `/${t.id}/messages`), { body: "late" });
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("SUPPORT_TICKET_FINAL");
  });

  it("strict bodies: unknown field / bad category / missing body → 400 VALIDATION_ERROR; PATCH status route does not exist", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    for (const body of [{ ...NEW_TICKET, status: "CLOSED" }, { ...NEW_TICKET, category: "NOPE" }, { category: "BILLING", subject: "x" }]) {
      const res = await h.as(a.owner, "POST", T(a.orgId), body);
      expect(res.status).toBe(400);
      expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    }
    const t = await openTicket(a.owner, a.orgId);
    expect((await h.as(a.owner, "PATCH", T(a.orgId, `/${t.id}`), { status: "CLOSED" })).status).toBe(404);
  });

  it("RBAC: VIEWER reads but cannot create (403 FORBIDDEN); CAMPAIGN_MANAGER creates; non-member and other tenant → 404; unauthenticated → 401", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const viewer = await member(a.owner, a.orgId, "viewer@acme.example", "VIEWER");
    const mgr = await member(a.owner, a.orgId, "mgr@acme.example", "CAMPAIGN_MANAGER");
    const t = await openTicket(mgr, a.orgId);
    expect((await h.as(viewer, "GET", T(a.orgId, `/${t.id}`))).status).toBe(200);
    const denied = await h.as(viewer, "POST", T(a.orgId), NEW_TICKET);
    expect(denied.status).toBe(403);
    expect(await h.errorCode(denied)).toBe("FORBIDDEN");
    expect((await h.as(b.owner, "GET", T(a.orgId, `/${t.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", T(b.orgId, `/${t.id}`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", T(a.orgId, "/not-a-uuid"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", T(a.orgId, `/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.api("GET", T(a.orgId))).status).toBe(401);
  });
});

describe("support tickets — platform face + agent tenant access", () => {
  it("SUPER_ADMIN drives OPEN→IN_PROGRESS (auto-assign)→WAITING_FOR_USER→RESOLVED→CLOSED; internal note hidden from tenant; first_response_at stamped", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const { admin, platformOrgId } = await platform();
    const t = await openTicket(a.owner, a.orgId);
    const note = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/messages`), { body: "check billing export", internal: true });
    expect(note.status).toBe(201);
    expect((await json<Message>(note)).is_internal).toBe(true);
    const pub = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/messages`), { body: "Looking into it." });
    expect(pub.status).toBe(201);
    const tenantView = await json<Page<Message>>(await h.as(a.owner, "GET", T(a.orgId, `/${t.id}/messages`)));
    expect(tenantView.items.map((m) => m.body)).not.toContain("check billing export");
    expect(tenantView.items.map((m) => m.body)).toContain("Looking into it.");
    const platformView = await json<Page<Message>>(await h.as(admin, "GET", P(platformOrgId, a.orgId, `/tickets/${t.id}/messages`)));
    expect(platformView.items.map((m) => m.body)).toContain("check billing export");
    let cur: Ticket | null = null;
    for (const status of ["IN_PROGRESS", "WAITING_FOR_USER", "RESOLVED", "CLOSED"]) {
      const res = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/transition`), { status });
      expect(res.status).toBe(200);
      cur = await json<Ticket>(res);
      expect(cur.status).toBe(status);
    }
    expect(cur?.assigned_agent_user_id).toBe(await userId("admin@network.example"));
    expect(cur?.first_response_at).not.toBeNull();
    expect(cur?.resolved_at).not.toBeNull();
    expect(cur?.closed_at).not.toBeNull();
    const dead = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/transition`), { status: "IN_PROGRESS" });
    expect(dead.status).toBe(409);
    expect(await h.errorCode(dead)).toBe("SUPPORT_TICKET_FINAL");
    const events = await json<Page<{ event_type: string; from_status: string | null; to_status: string | null }>>(
      await h.as(a.owner, "GET", T(a.orgId, `/${t.id}/events`)),
    );
    expect(events.items.map((e) => e.to_status)).toEqual(["CLOSED", "RESOLVED", "WAITING_FOR_USER", "IN_PROGRESS", "OPEN"]);
  });

  it("agent edge IN_PROGRESS→CLOSED is 409 SUPPORT_TICKET_ILLEGAL_TRANSITION with no trigger/sqlite text", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const { admin, platformOrgId } = await platform();
    const t = await openTicket(a.owner, a.orgId);
    expect((await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/transition`), { status: "IN_PROGRESS" })).status).toBe(200);
    const res = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/transition`), { status: "CLOSED" });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("SUPPORT_TICKET_ILLEGAL_TRANSITION");
    expect(text).not.toMatch(/RAISE|trigger|sqlite|constraint|stack/i);
  });

  it("SUPPORT_AGENT sees a tenant only after a grant; grant must name an ACTIVE platform member; revoke restores 404; agent cannot self-grant", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const { admin, agent, platformOrgId, agentUserId } = await platform();
    const t = await openTicket(a.owner, a.orgId);
    expect((await h.as(agent, "GET", P(platformOrgId, a.orgId, `/tickets/${t.id}`))).status).toBe(404);
    expect((await h.as(agent, "POST", P(platformOrgId, a.orgId, "/agents"), { user_id: agentUserId })).status).toBe(403);
    const outsider = await userId("owner@beta.example");
    expect((await h.as(admin, "POST", P(platformOrgId, a.orgId, "/agents"), { user_id: outsider })).status).toBe(404);
    expect((await h.as(admin, "POST", P(platformOrgId, a.orgId, "/agents"), { user_id: "garbage" })).status).toBe(404);
    const grant = await h.as(admin, "POST", P(platformOrgId, a.orgId, "/agents"), { user_id: agentUserId, reason: "billing escalation" });
    expect(grant.status).toBe(201);
    expect((await h.as(agent, "GET", P(platformOrgId, a.orgId, `/tickets/${t.id}`))).status).toBe(200);
    expect((await h.as(agent, "POST", P(platformOrgId, a.orgId, `/tickets/${t.id}/transition`), { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await h.as(agent, "GET", P(platformOrgId, b.orgId, "/tickets"))).status).toBe(404);
    const list = await json<Page<{ agent_user_id: string; revoked_at: string | null }>>(await h.as(admin, "GET", P(platformOrgId, a.orgId, "/agents")));
    expect(list.items.map((g) => g.agent_user_id)).toEqual([agentUserId]);
    const revoke = await h.as(admin, "POST", P(platformOrgId, a.orgId, `/agents/${agentUserId}/revoke`));
    expect(revoke.status).toBe(200);
    expect((await json<{ revoked_at: string | null }>(revoke)).revoked_at).not.toBeNull();
    expect((await h.as(agent, "GET", P(platformOrgId, a.orgId, `/tickets/${t.id}`))).status).toBe(404);
    expect((await h.auditRows("support.agent_access.granted")).map((r) => r.organization_id)).toEqual([a.orgId]);
  });

  it("platform face refuses tenant orgs (403), unknown/malformed/PLATFORM tenant ids (404), and tenant owners cannot reach the platform face", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const { admin, platformOrgId } = await platform();
    expect((await h.as(a.owner, "GET", P(a.orgId, a.orgId, "/tickets"))).status).toBe(403);
    expect((await h.as(a.owner, "GET", P(platformOrgId, a.orgId, "/tickets"))).status).toBe(404);
    expect((await h.as(admin, "GET", P(platformOrgId, RANDOM_ID, "/tickets"))).status).toBe(404);
    expect((await h.as(admin, "GET", P(platformOrgId, "nope", "/tickets"))).status).toBe(404);
    expect((await h.as(admin, "GET", P(platformOrgId, platformOrgId, "/tickets"))).status).toBe(404);
  });
});
