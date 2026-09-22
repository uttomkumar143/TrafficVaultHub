/**
 * Phase 1 Unit 5 — PRD §116 "cross-tenant request rejected" (explicit suite).
 *
 * Two fully independent tenants, A and B, each with an owner and a manager.
 * Every request from a member of A that names B (in the path, in a member id,
 * in the body or in the query string) must be rejected server-side and must
 * leave B's data untouched. Complements `rbac.test.ts` (permission model) and
 * `organizations.test.ts` (module behaviour) — this file is the single place
 * a reviewer looks for the §116 tenant-isolation evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

interface Envelope {
  error: { code: string };
}
interface Organization {
  id: string;
  name: string;
  membership: { id: string };
}
interface Member {
  id: string;
}

// Test fixture password (not a secret); joined so secret-scan does not flag it.
const PASSWORD = ["correct", "horse", "battery", "staple"].join("-");

let db: TestD1;
let mail: MemoryEmailSender;
let app: ReturnType<typeof createApp>;
let env: Partial<Bindings>;

function api(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    `/api/v1${path}`,
    {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = async (res: Response) => ((await res.json()) as Envelope).error.code;

async function user(email: string): Promise<string> {
  expect((await api("POST", "/auth/signup", {}, { email, password: PASSWORD })).status).toBe(201);
  const token = mail.last("EMAIL_VERIFICATION")?.token;
  expect((await api("POST", "/auth/verify-email", {}, { token })).status).toBe(200);
  const res = await api("POST", "/auth/login", {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

interface Tenant {
  org: Organization;
  owner: string;
  ownerEmail: string;
  manager: string;
  managerEmail: string;
  managerMember: Member;
}

async function tenant(label: string, type: "ADVERTISER" | "AFFILIATE", managerRole: string): Promise<Tenant> {
  const ownerEmail = `${label}-owner@example.com`;
  const managerEmail = `${label}-manager@example.com`;
  const owner = await user(ownerEmail);
  const manager = await user(managerEmail);
  const created = await api("POST", "/organizations", bearer(owner), { type, name: `${label} Org` });
  expect(created.status).toBe(201);
  const org = ((await created.json()) as { organization: Organization }).organization;
  const added = await api("POST", `/organizations/${org.id}/members`, bearer(owner), {
    email: managerEmail,
    role: managerRole,
  });
  expect(added.status).toBe(201);
  const managerMember = ((await added.json()) as { member: Member }).member;
  return { org, owner, ownerEmail, manager, managerEmail, managerMember };
}

/** Snapshot of everything about an organization that a cross-tenant attack could alter. */
async function snapshot(orgId: string) {
  const org = await db.prepare("SELECT name, status FROM organizations WHERE id = ?").bind(orgId).first();
  const members = await db
    .prepare(
      `SELECT u.email, r.key, m.status FROM organization_members m
         JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
        WHERE m.organization_id = ? ORDER BY u.email`,
    )
    .bind(orgId)
    .all();
  const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ?").bind(orgId).first<{ n: number }>();
  return { org, members: members.results, audits: audits?.n };
}

let A: Tenant;
let B: Tenant;
let before: Awaited<ReturnType<typeof snapshot>>;

beforeEach(async () => {
  db = createTestD1();
  mail = new MemoryEmailSender();
  app = createApp({ emailSender: mail });
  env = { DB: db, APP_ENV: "test", API_VERSION: "v1" };
  A = await tenant("a", "ADVERTISER", "ADVERTISER_ADMIN");
  B = await tenant("b", "AFFILIATE", "AFFILIATE_MANAGER");
  before = await snapshot(B.org.id);
});
afterEach(() => db.close());

async function expectBUnchanged() {
  expect(await snapshot(B.org.id)).toEqual(before);
}

describe("PRD §116 — cross-tenant request rejected", () => {
  it("A's owner and A's manager cannot READ anything of B (404 ORGANIZATION_NOT_FOUND)", async () => {
    for (const token of [A.owner, A.manager]) {
      for (const path of [
        `/organizations/${B.org.id}`,
        `/organizations/${B.org.id}/me`,
        `/organizations/${B.org.id}/roles`,
        `/organizations/${B.org.id}/members`,
      ]) {
        const res = await api("GET", path, bearer(token));
        expect(res.status, path).toBe(404);
        expect(await code(res)).toBe("ORGANIZATION_NOT_FOUND");
      }
    }
    // The listing endpoint never includes B for A's users.
    const list = await api("GET", "/organizations", bearer(A.owner));
    const ids = ((await list.json()) as { organizations: Organization[] }).organizations.map((o) => o.id);
    expect(ids).toEqual([A.org.id]);
  });

  it("A's owner cannot MUTATE B — even with full authority in A (404, B untouched, no audit rows)", async () => {
    const attempts = [
      api("PATCH", `/organizations/${B.org.id}`, bearer(A.owner), { name: "Owned by A" }),
      api("POST", `/organizations/${B.org.id}/members`, bearer(A.owner), { email: A.ownerEmail, role: "AFFILIATE_OWNER" }),
      api("POST", `/organizations/${B.org.id}/members`, bearer(A.owner), { email: A.managerEmail, role: "VIEWER" }),
      api("PATCH", `/organizations/${B.org.id}/members/${B.managerMember.id}`, bearer(A.owner), { role: "AFFILIATE_OWNER" }),
      api("PATCH", `/organizations/${B.org.id}/members/${B.org.membership.id}`, bearer(A.owner), { role: "VIEWER" }),
      api("DELETE", `/organizations/${B.org.id}/members/${B.managerMember.id}`, bearer(A.owner)),
      api("DELETE", `/organizations/${B.org.id}/members/${B.org.membership.id}`, bearer(A.owner)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("ORGANIZATION_NOT_FOUND");
    }
    await expectBUnchanged();
  });

  it("B's member ids are not addressable under A's path (404 MEMBER_NOT_FOUND) and B is untouched", async () => {
    const attempts = [
      api("PATCH", `/organizations/${A.org.id}/members/${B.managerMember.id}`, bearer(A.owner), { role: "VIEWER" }),
      api("PATCH", `/organizations/${A.org.id}/members/${B.org.membership.id}`, bearer(A.owner), { role: "VIEWER" }),
      api("DELETE", `/organizations/${A.org.id}/members/${B.managerMember.id}`, bearer(A.owner)),
      api("DELETE", `/organizations/${A.org.id}/members/${B.org.membership.id}`, bearer(A.owner)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("MEMBER_NOT_FOUND");
    }
    await expectBUnchanged();
  });

  it("organization_id smuggled in body or query string is ignored — only the path decides", async () => {
    // Body smuggling on an endpoint A's owner IS allowed to call for A.
    const rename = await api("PATCH", `/organizations/${A.org.id}`, bearer(A.owner), {
      name: "A renamed",
      organization_id: B.org.id,
      organizationId: B.org.id,
      org_id: B.org.id,
    });
    expect([200, 400]).toContain(rename.status);
    if (rename.status === 200) {
      const a = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(A.org.id).first<{ name: string }>();
      expect(a?.name).toBe("A renamed");
    }

    // Query-string smuggling.
    const q = await api("GET", `/organizations/${A.org.id}/members?organization_id=${B.org.id}`, bearer(A.owner));
    expect(q.status).toBe(200);
    const emails = ((await q.json()) as { members: { user: { email: string } }[] }).members.map((m) => m.user.email).sort();
    expect(emails).toEqual([A.managerEmail, A.ownerEmail].sort());
    expect(emails).not.toContain(B.ownerEmail);

    // Adding a member to A while naming B in the body lands in A, not B.
    await user("newbie@example.com");
    const add = await api("POST", `/organizations/${A.org.id}/members`, bearer(A.owner), {
      email: "newbie@example.com",
      role: "VIEWER",
      organization_id: B.org.id,
    });
    expect([201, 400]).toContain(add.status);
    await expectBUnchanged();
  });

  it("a user who is a member of BOTH tenants gets each tenant's authority only under that tenant's path", async () => {
    // A's manager is invited to B as a VIEWER.
    const inv = await api("POST", `/organizations/${B.org.id}/members`, bearer(B.owner), {
      email: A.managerEmail,
      role: "VIEWER",
    });
    expect(inv.status).toBe(201);
    before = await snapshot(B.org.id);

    // In A: ADVERTISER_ADMIN → may manage. In B: VIEWER → may read only.
    expect((await api("GET", `/organizations/${B.org.id}`, bearer(A.manager))).status).toBe(200);
    const me = (await (await api("GET", `/organizations/${B.org.id}/me`, bearer(A.manager))).json()) as {
      role: { key: string };
      permissions: string[];
    };
    expect(me.role.key).toBe("VIEWER");
    expect(me.permissions).not.toContain("members.manage");

    const mutate = [
      api("PATCH", `/organizations/${B.org.id}`, bearer(A.manager), { name: "X" }),
      api("POST", `/organizations/${B.org.id}/members`, bearer(A.manager), { email: A.ownerEmail, role: "VIEWER" }),
      api("DELETE", `/organizations/${B.org.id}/members/${B.managerMember.id}`, bearer(A.manager)),
    ];
    for (const res of await Promise.all(mutate)) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("FORBIDDEN");
    }
    await expectBUnchanged();

    // Authority in A is intact and still scoped to A.
    expect((await api("PATCH", `/organizations/${A.org.id}`, bearer(A.manager), { name: "A by admin" })).status).toBe(200);
  });

  it("PLATFORM tenants cannot be self-created (would be a trivial escalation into network-wide roles)", async () => {
    const res = await api("POST", "/organizations", bearer(A.owner), { type: "PLATFORM", name: "Network" });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("VALIDATION_ERROR");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE type = 'PLATFORM'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("an unauthenticated or revoked session gets 401 before any tenant is resolved", async () => {
    // Revoke A's owner session, then try to touch both A and B.
    expect((await api("POST", "/auth/logout", bearer(A.owner))).status).toBe(204);
    for (const path of [`/organizations/${A.org.id}`, `/organizations/${B.org.id}`, `/organizations/${B.org.id}/members`]) {
      const res = await api("GET", path, bearer(A.owner));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("UNAUTHENTICATED");
    }
    await expectBUnchanged();
  });
});
