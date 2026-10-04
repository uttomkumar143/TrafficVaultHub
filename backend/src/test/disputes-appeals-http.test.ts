/**
 * Phase 6 Unit 7 — disputes (PRD §82) and appeals (PRD §83) over HTTP.
 * Tickets live in `support-http.test.ts`; this file reuses the same harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RANDOM_ID, TestHarness, json } from "./fixtures";

interface Dispute {
  id: string;
  status: string;
  category: string;
  subject_type: string;
  subject_id: string;
  title: string;
  created_at: string;
}
interface Decision {
  decision: string;
  reason: string;
  evidence: string[];
  actor: string | null;
  timestamp: string;
}
interface Evidence {
  id: string;
  kind: string;
  content: string;
  submitter_side: string;
}
interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const DISPUTE_CATEGORIES = ["CONVERSION", "TRACKING", "COMMISSION", "PAYOUT", "BILLING", "TRAFFIC", "OFFER", "COMPLIANCE"];
const LEAK = /RAISE|trigger|sqlite|constraint|stack|at .*\.ts:/i;

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

const D = (orgId: string, path = "") => `/organizations/${orgId}/disputes${path}`;
const PD = (platformOrgId: string, tenantOrgId: string, path = "") => `/organizations/${platformOrgId}/platform/disputes/tenants/${tenantOrgId}${path}`;
const PS = (platformOrgId: string, tenantOrgId: string, path = "") => `/organizations/${platformOrgId}/platform/support/tenants/${tenantOrgId}${path}`;
const NEW_DISPUTE = { category: "COMMISSION", subject_type: "conversion", subject_id: "conv-1", title: "Commission short", description: "Payout was 10% below the agreed rate." };

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
async function openDispute(token: string, orgId: string, extra: Record<string, unknown> = {}): Promise<Dispute> {
  const res = await h.as(token, "POST", D(orgId), { ...NEW_DISPUTE, ...extra });
  expect(res.status).toBe(201);
  return json<Dispute>(res);
}
/** SUPER_ADMIN (unrestricted) + a SUPPORT_AGENT (reads only, needs a grant). */
async function platform() {
  const admin = await h.user("admin@network.example");
  const platformOrgId = await h.platformOrg("admin@network.example", "SUPER_ADMIN");
  const agent = await h.user("agent@network.example");
  await h.platformOrg("agent@network.example", "SUPPORT_AGENT");
  return { admin, agent, platformOrgId, agentUserId: await userId("agent@network.example") };
}
async function count(table: string, where: string, ...binds: unknown[]): Promise<number> {
  const row = await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("disputes — tenant face", () => {
  it("create accepts all 8 categories (unknown → 400 VALIDATION_ERROR); list/get read back; audit row written", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ids: string[] = [];
    for (const category of DISPUTE_CATEGORIES) {
      const d = await openDispute(a.owner, a.orgId, { category, subject_id: `s-${category}` });
      expect([d.status, d.category]).toEqual(["OPEN", category]);
      ids.push(d.id);
    }
    const bad = await h.as(a.owner, "POST", D(a.orgId), { ...NEW_DISPUTE, category: "REFUND" });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
    const list = await json<Page<Dispute>>(await h.as(a.owner, "GET", D(a.orgId, "?limit=20")));
    expect(new Set(list.items.map((d) => d.id))).toEqual(new Set(ids));
    const got = await json<{ dispute: Dispute; decision: Decision | null }>(await h.as(a.owner, "GET", D(a.orgId, `/${ids[0]}`)));
    expect(got.dispute.category).toBe("CONVERSION");
    expect(got.decision).toBeNull();
    expect((await h.auditRows("dispute.created")).map((r) => r.organization_id)).toEqual(Array(8).fill(a.orgId));
  });

  it("second OPEN dispute on the same subject → 409 DISPUTE_ALREADY_OPEN; cursor pagination walks without overlap; bad status filter → 400", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await openDispute(a.owner, a.orgId, { subject_id: `conv-${i}` })).id);
    const dup = await h.as(a.owner, "POST", D(a.orgId), { ...NEW_DISPUTE, subject_id: "conv-0" });
    expect(dup.status).toBe(409);
    expect(await h.errorCode(dup)).toBe("DISPUTE_ALREADY_OPEN");
    const p1 = await json<Page<Dispute>>(await h.as(a.owner, "GET", D(a.orgId, "?limit=2")));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<Page<Dispute>>(await h.as(a.owner, "GET", D(a.orgId, `?limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`)));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((d) => d.id))).toEqual(ids);
    expect((await h.as(a.owner, "GET", D(a.orgId, "?status=BOGUS"))).status).toBe(400);
  });

  it("evidence append (TEXT/URL) is listed in order; unknown kind / empty content → 400; withdraw from OPEN then evidence → 409 DISPUTE_FINAL", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const d = await openDispute(a.owner, a.orgId);
    expect((await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/evidence`), { kind: "TEXT", content: "Screenshot attached in ticket." })).status).toBe(201);
    expect((await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/evidence`), { kind: "URL", content: "https://acme.example/report.csv" })).status).toBe(201);
    expect((await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/evidence`), { kind: "VIDEO", content: "x" })).status).toBe(400);
    expect((await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/evidence`), { kind: "TEXT", content: "" })).status).toBe(400);
    const ev = await json<Page<Evidence>>(await h.as(a.owner, "GET", D(a.orgId, `/${d.id}/evidence`)));
    expect(new Set(ev.items.map((e) => e.kind))).toEqual(new Set(["TEXT", "URL"]));
    expect(ev.items).toHaveLength(2);
    expect((await h.auditRows("dispute.evidence_added")).length).toBe(2);
    const w = await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/withdraw`));
    expect(w.status).toBe(200);
    expect((await json<Dispute>(w)).status).toBe("WITHDRAWN");
    const late = await h.as(a.owner, "POST", D(a.orgId, `/${d.id}/evidence`), { kind: "TEXT", content: "late" });
    expect(late.status).toBe(409);
    const lateText = await late.clone().text();
    expect(await h.errorCode(late)).toBe("DISPUTE_FINAL");
    expect(lateText).not.toMatch(LEAK);
  });

  it("no PATCH/PUT status route; strict body rejects unknown field; unauthenticated → 401; malformed/foreign id → 404", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const d = await openDispute(a.owner, a.orgId);
    for (const m of ["PATCH", "PUT"]) expect((await h.as(a.owner, m, D(a.orgId, `/${d.id}`), { status: "DECIDED" })).status).toBe(404);
    expect((await h.as(a.owner, "POST", D(a.orgId), { ...NEW_DISPUTE, status: "DECIDED" })).status).toBe(400);
    expect((await h.api("GET", D(a.orgId))).status).toBe(401);
    expect((await h.as(a.owner, "GET", D(a.orgId, "/not-a-uuid"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", D(a.orgId, `/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", D(a.orgId, `/${d.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", D(b.orgId, `/${d.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "POST", D(b.orgId, `/${d.id}/withdraw`))).status).toBe(404);
  });
});

describe("disputes — platform face, RBAC and agent grants", () => {
  it("review → decide records {decision, reason, evidence, actor, timestamp}, audit row, and later decide/withdraw → 409 DISPUTE_FINAL without db text", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const { admin, platformOrgId } = await platform();
    const d = await openDispute(a.owner, a.orgId);
    const premature = await h.as(admin, "POST", PD(platformOrgId, a.orgId, `/${d.id}/decide`), { decision: "UPHELD", reason: "r" });
    expect(premature.status).toBe(409);
    expect(await h.errorCode(premature)).toBe("DISPUTE_ILLEGAL_TRANSITION");
    const r = await h.as(admin, "POST", PD(platformOrgId, a.orgId, `/${d.id}/review`));
    expect(r.status).toBe(200);
    expect((await json<Dispute>(r)).status).toBe("UNDER_REVIEW");
    const body = { decision: "PARTIALLY_UPHELD", reason: "Rate was 8%, not 10%.", evidence: ["ticket:abc", "https://acme.example/report.csv"] };
    const dec = await h.as(admin, "POST", PD(platformOrgId, a.orgId, `/${d.id}/decide`), body);
    expect(dec.status).toBe(200);
    const out = await json<{ dispute: Dispute; decision: Decision }>(dec);
    expect(out.dispute.status).toBe("DECIDED");
    expect(out.decision).toMatchObject({ decision: "PARTIALLY_UPHELD", reason: body.reason, evidence: body.evidence, actor: await userId("admin@network.example") });
    expect(out.decision.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const got = await json<{ decision: Decision | null }>(await h.as(a.owner, "GET", D(a.orgId, `/${d.id}`)));
    expect(got.decision?.decision).toBe("PARTIALLY_UPHELD");
    expect((await h.auditRows("dispute.decided")).map((r) => r.target_id)).toEqual([d.id]);
    expect(await count("dispute_decisions", "dispute_id = ?", d.id)).toBe(1);
    for (const [who, path] of [[admin, PD(platformOrgId, a.orgId, `/${d.id}/decide`)], [a.owner, D(a.orgId, `/${d.id}/withdraw`)]] as const) {
      const res = await h.as(who, "POST", path, { decision: "REJECTED", reason: "again" });
      expect(res.status).toBe(409);
      const text = await res.clone().text();
      expect(await h.errorCode(res)).toBe("DISPUTE_FINAL");
      expect(text).not.toMatch(LEAK);
    }
    expect((await h.as(admin, "POST", PD(platformOrgId, a.orgId, `/${d.id}/decide`), { decision: "MAYBE", reason: "x" })).status).toBe(400);
  });

  it("RBAC: VIEWER cannot create (403); tenant owner cannot use platform face (403 own org / 404 foreign org); agent sees tenant only after a grant (404 → 200) and never decides (403)", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const viewer = await member(a.owner, a.orgId, "viewer@acme.example", "VIEWER");
    const { admin, agent, platformOrgId, agentUserId } = await platform();
    const d = await openDispute(a.owner, a.orgId);
    const v = await h.as(viewer, "POST", D(a.orgId), NEW_DISPUTE);
    expect(v.status).toBe(403);
    expect(await h.errorCode(v)).toBe("FORBIDDEN");
    expect((await h.as(viewer, "GET", D(a.orgId, `/${d.id}`))).status).toBe(200);
    expect((await h.as(a.owner, "GET", PD(a.orgId, a.orgId, `/${d.id}`))).status).toBe(403);
    expect((await h.as(a.owner, "POST", PD(platformOrgId, a.orgId, `/${d.id}/review`))).status).toBe(404);
    expect((await h.as(agent, "GET", PD(platformOrgId, a.orgId, `/${d.id}`))).status).toBe(404);
    expect((await h.as(admin, "POST", PS(platformOrgId, a.orgId, "/agents"), { user_id: agentUserId })).status).toBe(201);
    expect((await h.as(agent, "GET", PD(platformOrgId, a.orgId, `/${d.id}`))).status).toBe(200);
    expect((await h.as(agent, "GET", PD(platformOrgId, a.orgId, "/"))).status).toBe(200);
    expect((await h.as(agent, "POST", PD(platformOrgId, a.orgId, `/${d.id}/review`))).status).toBe(403);
    expect((await h.as(agent, "POST", PD(platformOrgId, a.orgId, `/${d.id}/decide`), { decision: "UPHELD", reason: "r" })).status).toBe(403);
    expect((await h.as(admin, "GET", PD(platformOrgId, a.orgId, `/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.as(admin, "GET", PD(platformOrgId, RANDOM_ID, "/"))).status).toBe(404);
    expect(await count("dispute_decisions", "dispute_id = ?", d.id)).toBe(0);
  });
});

// ---- appeals (PRD §83) ----------------------------------------------------------------

interface Appeal {
  id: string;
  status: string;
  appeal_type: string;
  subject_type: string;
  subject_id: string;
  created_at: string;
}
interface Outcome {
  outcome: string;
  reason: string;
  evidence: string[];
  actor: string | null;
  timestamp: string;
}

const APPEAL_TYPES = ["ACCOUNT_RESTRICTION", "ACCOUNT_SUSPENSION", "CONVERSION_DECISION", "PAYOUT_HOLD", "COMPLIANCE_DECISION"];
const A = (orgId: string, path = "") => `/organizations/${orgId}/appeals${path}`;
const PA = (platformOrgId: string, tenantOrgId: string, path = "") => `/organizations/${platformOrgId}/platform/appeals/tenants/${tenantOrgId}${path}`;
const NEW_APPEAL = { appeal_type: "PAYOUT_HOLD", subject_type: "payout", subject_id: "pay-1", grounds: "The hold references a conversion that was already approved." };

async function submitAppeal(token: string, orgId: string, extra: Record<string, unknown> = {}): Promise<Appeal> {
  const res = await h.as(token, "POST", A(orgId), { ...NEW_APPEAL, ...extra });
  expect(res.status).toBe(201);
  return json<Appeal>(res);
}

describe("appeals — tenant face", () => {
  it("submit accepts all 5 subjects (unknown → 400 VALIDATION_ERROR); list/get read back; audit row written", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ids: string[] = [];
    for (const appeal_type of APPEAL_TYPES) {
      const ap = await submitAppeal(a.owner, a.orgId, { appeal_type, subject_id: `s-${appeal_type}` });
      expect([ap.status, ap.appeal_type]).toEqual(["SUBMITTED", appeal_type]);
      ids.push(ap.id);
    }
    const bad = await h.as(a.owner, "POST", A(a.orgId), { ...NEW_APPEAL, appeal_type: "REFUND" });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
    const list = await json<Page<Appeal>>(await h.as(a.owner, "GET", A(a.orgId, "?limit=20")));
    expect(new Set(list.items.map((x) => x.id))).toEqual(new Set(ids));
    const got = await json<{ appeal: Appeal; outcome: Outcome | null }>(await h.as(a.owner, "GET", A(a.orgId, `/${ids[0]}`)));
    expect(got.appeal.appeal_type).toBe("ACCOUNT_RESTRICTION");
    expect(got.outcome).toBeNull();
    expect((await h.auditRows("appeal.submitted")).map((r) => r.organization_id)).toEqual(Array(5).fill(a.orgId));
  });

  it("one-open rule: second appeal on the same subject → 409 APPEAL_ALREADY_OPEN; withdraw frees the subject; withdrawn appeal is final (409 APPEAL_FINAL)", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const ap = await submitAppeal(a.owner, a.orgId);
    const dup = await h.as(a.owner, "POST", A(a.orgId), NEW_APPEAL);
    expect(dup.status).toBe(409);
    expect(await h.errorCode(dup)).toBe("APPEAL_ALREADY_OPEN");
    const w = await h.as(a.owner, "POST", A(a.orgId, `/${ap.id}/withdraw`));
    expect(w.status).toBe(200);
    expect((await json<Appeal>(w)).status).toBe("WITHDRAWN");
    expect((await h.auditRows("appeal.withdrawn")).map((r) => r.target_id)).toEqual([ap.id]);
    const again = await h.as(a.owner, "POST", A(a.orgId, `/${ap.id}/withdraw`));
    expect(again.status).toBe(409);
    const text = await again.clone().text();
    expect(await h.errorCode(again)).toBe("APPEAL_FINAL");
    expect(text).not.toMatch(LEAK);
    expect((await submitAppeal(a.owner, a.orgId)).status).toBe("SUBMITTED");
    for (const m of ["PATCH", "PUT"]) expect((await h.as(a.owner, m, A(a.orgId, `/${ap.id}`), { status: "DECIDED" })).status).toBe(404);
    expect((await h.as(a.owner, "POST", A(a.orgId), { ...NEW_APPEAL, status: "DECIDED" })).status).toBe(400);
  });
});

describe("appeals — platform face, RBAC and agent grants", () => {
  it("review → decide records audited {outcome, reason, evidence, actor, timestamp}; decide before review and after DECIDED → 409 with stable codes", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const { admin, platformOrgId } = await platform();
    const ap = await submitAppeal(a.owner, a.orgId);
    const premature = await h.as(admin, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/decide`), { outcome: "ACCEPTED", reason: "r" });
    expect(premature.status).toBe(409);
    expect(await h.errorCode(premature)).toBe("APPEAL_ILLEGAL_TRANSITION");
    const r = await h.as(admin, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/review`));
    expect(r.status).toBe(200);
    expect((await json<Appeal>(r)).status).toBe("UNDER_REVIEW");
    const body = { outcome: "PARTIALLY_ACCEPTED", reason: "Hold lifted for the approved conversion only.", evidence: ["conversion:conv-9"] };
    const dec = await h.as(admin, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/decide`), body);
    expect(dec.status).toBe(200);
    const out = await json<{ appeal: Appeal; outcome: Outcome }>(dec);
    expect(out.appeal.status).toBe("DECIDED");
    expect(out.outcome).toMatchObject({ outcome: "PARTIALLY_ACCEPTED", reason: body.reason, evidence: body.evidence, actor: await userId("admin@network.example") });
    expect(out.outcome.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const got = await json<{ outcome: Outcome | null }>(await h.as(a.owner, "GET", A(a.orgId, `/${ap.id}`)));
    expect(got.outcome?.outcome).toBe("PARTIALLY_ACCEPTED");
    const audit = await h.auditRows("appeal.decided");
    expect(audit.map((x) => x.target_id)).toEqual([ap.id]);
    expect(audit[0]?.metadata ?? "").toContain("PARTIALLY_ACCEPTED");
    expect(await count("appeal_decisions", "appeal_id = ?", ap.id)).toBe(1);
    for (const [who, path] of [[admin, PA(platformOrgId, a.orgId, `/${ap.id}/decide`)], [a.owner, A(a.orgId, `/${ap.id}/withdraw`)]] as const) {
      const res = await h.as(who, "POST", path, { outcome: "REJECTED", reason: "again" });
      expect(res.status).toBe(409);
      const text = await res.clone().text();
      expect(await h.errorCode(res)).toBe("APPEAL_FINAL");
      expect(text).not.toMatch(LEAK);
    }
    expect((await h.as(admin, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/decide`), { outcome: "MAYBE", reason: "x" })).status).toBe(400);
    expect((await submitAppeal(a.owner, a.orgId)).status).toBe("SUBMITTED");
  });

  it("RBAC: VIEWER cannot submit (403); tenant cannot use platform face; agent needs a grant (404 → 200) and never decides (403); isolation/malformed → 404; unauth → 401", async () => {
    const a = await advertiser("owner@acme.example", "Acme");
    const b = await advertiser("owner@beta.example", "Beta");
    const viewer = await member(a.owner, a.orgId, "viewer@acme.example", "VIEWER");
    const { admin, agent, platformOrgId, agentUserId } = await platform();
    const ap = await submitAppeal(a.owner, a.orgId);
    const v = await h.as(viewer, "POST", A(a.orgId), NEW_APPEAL);
    expect(v.status).toBe(403);
    expect(await h.errorCode(v)).toBe("FORBIDDEN");
    expect((await h.as(viewer, "GET", A(a.orgId, `/${ap.id}`))).status).toBe(200);
    expect((await h.api("GET", A(a.orgId))).status).toBe(401);
    expect((await h.as(a.owner, "GET", A(a.orgId, "/not-a-uuid"))).status).toBe(404);
    expect((await h.as(b.owner, "GET", A(a.orgId, `/${ap.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "POST", A(b.orgId, `/${ap.id}/withdraw`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", PA(a.orgId, a.orgId, `/${ap.id}`))).status).toBe(403);
    expect((await h.as(a.owner, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/review`))).status).toBe(404);
    expect((await h.as(agent, "GET", PA(platformOrgId, a.orgId, `/${ap.id}`))).status).toBe(404);
    expect((await h.as(admin, "POST", PS(platformOrgId, a.orgId, "/agents"), { user_id: agentUserId })).status).toBe(201);
    expect((await h.as(agent, "GET", PA(platformOrgId, a.orgId, `/${ap.id}`))).status).toBe(200);
    expect((await h.as(agent, "GET", PA(platformOrgId, a.orgId, "/"))).status).toBe(200);
    expect((await h.as(agent, "GET", PA(platformOrgId, b.orgId, "/"))).status).toBe(404);
    expect((await h.as(agent, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/review`))).status).toBe(403);
    expect((await h.as(agent, "POST", PA(platformOrgId, a.orgId, `/${ap.id}/decide`), { outcome: "ACCEPTED", reason: "r" })).status).toBe(403);
    expect((await h.as(admin, "GET", PA(platformOrgId, a.orgId, `/${RANDOM_ID}`))).status).toBe(404);
    expect(await count("appeal_decisions", "appeal_id = ?", ap.id)).toBe(0);
  });
});
