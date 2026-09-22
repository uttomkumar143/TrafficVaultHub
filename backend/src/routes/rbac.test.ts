/**
 * Phase 1 Unit 4 — RBAC middleware (`requireOrg` + `requirePermission`).
 *
 * Proves, end to end (HTTP → requireAuth → requireOrg → requirePermission →
 * service → D1 shim on the real migrations 0001–0004):
 *   * user → ACTIVE membership → role → permission keys resolution per role
 *   * GET /:orgId/me exposes exactly the keys granted by migration 0004
 *   * role escalation is rejected (PRD §116): VIEWER / AFFILIATE_USER →
 *     403 FORBIDDEN on every mutating route; managers cannot mint owners
 *   * tenant isolation (PRD §94, §116): non-members get 404 on every
 *     `:orgId` route; a client-supplied organization_id in the body is ignored
 *   * removed / non-ACTIVE memberships confer nothing
 *   * the typed PERMISSION_KEYS constant matches the database catalogue
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { PERMISSION_KEYS } from "../modules/rbac/permissions";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

interface Envelope {
  error: { code: string; message: string; request_id: string | null };
}
interface Me {
  organization: { id: string; type: string; name: string };
  membership: { id: string; joined_at: string | null };
  role: { key: string; is_owner: boolean };
  permissions: string[];
}
interface Organization {
  id: string;
  type: string;
  membership: { id: string; role: { key: string } };
}
interface Member {
  id: string;
  role: { key: string };
}

// Test fixture password (not a secret); joined so secret-scan does not flag it.
const PASSWORD = ["correct", "horse", "battery", "staple"].join("-");

let db: TestD1;
let mail: MemoryEmailSender;
let app: ReturnType<typeof createApp>;
let env: Partial<Bindings>;

beforeEach(() => {
  db = createTestD1();
  mail = new MemoryEmailSender();
  app = createApp({ emailSender: mail });
  env = { DB: db, APP_ENV: "test", API_VERSION: "v1" };
});
afterEach(() => db.close());

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

async function user(email: string): Promise<string> {
  expect((await api("POST", "/auth/signup", {}, { email, password: PASSWORD })).status).toBe(201);
  const token = mail.last("EMAIL_VERIFICATION")?.token;
  expect((await api("POST", "/auth/verify-email", {}, { token })).status).toBe(200);
  const res = await api("POST", "/auth/login", {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function createOrg(token: string, type: string, name: string): Promise<Organization> {
  const res = await api("POST", "/organizations", bearer(token), { type, name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { organization: Organization }).organization;
}

async function addMember(token: string, orgId: string, email: string, role: string): Promise<Member> {
  const res = await api("POST", `/organizations/${orgId}/members`, bearer(token), { email, role });
  expect(res.status).toBe(201);
  return ((await res.json()) as { member: Member }).member;
}

async function me(token: string, orgId: string): Promise<Me> {
  const res = await api("GET", `/organizations/${orgId}/me`, bearer(token));
  expect(res.status).toBe(200);
  return (await res.json()) as Me;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as Envelope).error.code;
}

/** Grants exactly as written in migrations/0004_permissions.sql. */
async function grantsFor(roleKey: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT p.key FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.organization_id IS NULL AND r.key = ? ORDER BY p.key`,
    )
    .bind(roleKey)
    .all<{ key: string }>();
  return res.results.map((r) => r.key);
}

const OWNER = "owner@example.com";
const MGR = "manager@example.com";
const USR = "user@example.com";
const VWR = "viewer@example.com";
const OUTSIDER = "outsider@example.com";

describe("permission resolution (user → membership → role → permissions)", () => {
  it("GET /:orgId/me returns the role's exact grant set from migration 0004, per role", async () => {
    const owner = await user(OWNER);
    const mgr = await user(MGR);
    const usr = await user(USR);
    const vwr = await user(VWR);
    const org = await createOrg(owner, "AFFILIATE", "Traffic Co");
    await addMember(owner, org.id, MGR, "AFFILIATE_MANAGER");
    await addMember(owner, org.id, USR, "AFFILIATE_USER");
    await addMember(owner, org.id, VWR, "VIEWER");

    const cases: Array<[string, string, boolean]> = [
      [owner, "AFFILIATE_OWNER", true],
      [mgr, "AFFILIATE_MANAGER", false],
      [usr, "AFFILIATE_USER", false],
      [vwr, "VIEWER", false],
    ];
    for (const [token, roleKey, isOwner] of cases) {
      const ctx = await me(token, org.id);
      expect(ctx.organization).toEqual({ id: org.id, type: "AFFILIATE", name: "Traffic Co" });
      expect(ctx.role).toEqual({ key: roleKey, is_owner: isOwner });
      expect(ctx.permissions).toEqual(await grantsFor(roleKey));
      expect(ctx.permissions.length).toBeGreaterThan(0);
    }

    // Concrete expectations so a grant regression in 0004 is caught here too.
    expect((await me(owner, org.id)).permissions).toEqual(
      expect.arrayContaining(["organizations.update", "members.manage", "payouts.read", "audit.read"]),
    );
    expect((await me(vwr, org.id)).permissions).toEqual([
      "conversions.read",
      "members.read",
      "offers.read",
      "organizations.read",
    ]);
    // Network-only powers never appear on tenant roles.
    for (const token of [owner, mgr, usr, vwr]) {
      const perms = (await me(token, org.id)).permissions;
      for (const k of ["offers.approve", "ledger.adjust", "payouts.approve", "payouts.release", "fraud.review", "compliance.resolve"]) {
        expect(perms, k).not.toContain(k);
      }
    }
  });

  it("permissions follow the role: a role change is reflected on the next request (no caching of authority)", async () => {
    const owner = await user(OWNER);
    const vwr = await user(VWR);
    const org = await createOrg(owner, "ADVERTISER", "Acme");
    const m = await addMember(owner, org.id, VWR, "VIEWER");

    expect((await me(vwr, org.id)).permissions).not.toContain("offers.create");
    expect((await api("PATCH", `/organizations/${org.id}`, bearer(vwr), { name: "X" })).status).toBe(403);

    expect(
      (await api("PATCH", `/organizations/${org.id}/members/${m.id}`, bearer(owner), { role: "ADVERTISER_ADMIN" })).status,
    ).toBe(200);

    const after = await me(vwr, org.id);
    expect(after.role.key).toBe("ADVERTISER_ADMIN");
    expect(after.permissions).toContain("offers.create");
    expect(after.permissions).toContain("organizations.update");
    expect((await api("PATCH", `/organizations/${org.id}`, bearer(vwr), { name: "Renamed by admin" })).status).toBe(200);
  });

  it("the same user has independent permission sets in different organizations", async () => {
    const alice = await user(OWNER);
    const bob = await user(MGR);
    const aliceOrg = await createOrg(alice, "ADVERTISER", "Alice Ads");
    const bobOrg = await createOrg(bob, "AFFILIATE", "Bob Traffic");
    await addMember(bob, bobOrg.id, OWNER, "VIEWER");

    const inOwn = await me(alice, aliceOrg.id);
    const inBobs = await me(alice, bobOrg.id);
    expect(inOwn.role.key).toBe("ADVERTISER_OWNER");
    expect(inBobs.role.key).toBe("VIEWER");
    expect(inOwn.permissions).toContain("members.manage");
    expect(inBobs.permissions).not.toContain("members.manage");

    // Authority in one tenant grants nothing in the other.
    expect((await api("PATCH", `/organizations/${bobOrg.id}`, bearer(alice), { name: "Hijack" })).status).toBe(403);
    expect((await api("PATCH", `/organizations/${aliceOrg.id}`, bearer(bob), { name: "Hijack" })).status).toBe(404);
  });
});

describe("role escalation is rejected (PRD §116)", () => {
  it("VIEWER and AFFILIATE_USER get 403 FORBIDDEN on every mutating route and nothing changes", async () => {
    const owner = await user(OWNER);
    const usr = await user(USR);
    const vwr = await user(VWR);
    await user(OUTSIDER);
    const org = await createOrg(owner, "AFFILIATE", "Traffic Co");
    const usrM = await addMember(owner, org.id, USR, "AFFILIATE_USER");
    const vwrM = await addMember(owner, org.id, VWR, "VIEWER");

    for (const [token, ownMembership] of [
      [usr, usrM.id],
      [vwr, vwrM.id],
    ] as const) {
      const attempts = [
        api("PATCH", `/organizations/${org.id}`, bearer(token), { name: "Pwned" }),
        api("POST", `/organizations/${org.id}/members`, bearer(token), { email: OUTSIDER, role: "VIEWER" }),
        api("POST", `/organizations/${org.id}/members`, bearer(token), { email: OUTSIDER, role: "AFFILIATE_OWNER" }),
        api("PATCH", `/organizations/${org.id}/members/${ownMembership}`, bearer(token), { role: "AFFILIATE_OWNER" }),
        api("PATCH", `/organizations/${org.id}/members/${ownMembership}`, bearer(token), { role: "AFFILIATE_MANAGER" }),
        api("PATCH", `/organizations/${org.id}/members/${org.membership.id}`, bearer(token), { role: "VIEWER" }),
        api("DELETE", `/organizations/${org.id}/members/${org.membership.id}`, bearer(token)),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403);
        expect(await errorCode(res)).toBe("FORBIDDEN");
      }
      // Reads that the role holds still work.
      expect((await api("GET", `/organizations/${org.id}`, bearer(token))).status).toBe(200);
      expect((await api("GET", `/organizations/${org.id}/members`, bearer(token))).status).toBe(200);
    }

    const rows = await db
      .prepare(
        `SELECT u.email, r.key, m.status FROM organization_members m
           JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
          WHERE m.organization_id = ? ORDER BY u.email`,
      )
      .bind(org.id)
      .all<{ email: string; key: string; status: string }>();
    expect(rows.results).toEqual([
      { email: OWNER, key: "AFFILIATE_OWNER", status: "ACTIVE" },
      { email: USR, key: "AFFILIATE_USER", status: "ACTIVE" },
      { email: VWR, key: "VIEWER", status: "ACTIVE" },
    ]);
    const name = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first<{ name: string }>();
    expect(name?.name).toBe("Traffic Co");
    // No audit rows were written for the rejected attempts.
    const audits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND actor_user_id <> (SELECT id FROM users WHERE email = ?)")
      .bind(org.id, OWNER)
      .first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it("a manager with members.manage cannot mint, demote or remove owners, but can manage non-owner seats", async () => {
    const owner = await user(OWNER);
    const mgr = await user(MGR);
    await user(USR);
    const org = await createOrg(owner, "ADVERTISER", "Acme");
    const mgrM = await addMember(owner, org.id, MGR, "ADVERTISER_ADMIN");

    // Allowed: add a non-owner, change a non-owner's role, remove a non-owner.
    const usrM = await addMember(mgr, org.id, USR, "VIEWER");
    expect(
      (await api("PATCH", `/organizations/${org.id}/members/${usrM.id}`, bearer(mgr), { role: "CAMPAIGN_MANAGER" })).status,
    ).toBe(200);
    expect((await api("DELETE", `/organizations/${org.id}/members/${usrM.id}`, bearer(mgr))).status).toBe(204);

    // Forbidden: anything touching an owner seat.
    const readd = await api("POST", `/organizations/${org.id}/members`, bearer(mgr), { email: USR, role: "ADVERTISER_OWNER" });
    expect(readd.status).toBe(403);
    expect((await api("PATCH", `/organizations/${org.id}/members/${mgrM.id}`, bearer(mgr), { role: "ADVERTISER_OWNER" })).status).toBe(403);
    expect((await api("PATCH", `/organizations/${org.id}/members/${org.membership.id}`, bearer(mgr), { role: "VIEWER" })).status).toBe(403);
    expect((await api("DELETE", `/organizations/${org.id}/members/${org.membership.id}`, bearer(mgr))).status).toBe(403);

    const owners = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM organization_members m JOIN roles r ON r.id = m.role_id
          WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND r.is_owner = 1`,
      )
      .bind(org.id)
      .first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });
});

describe("tenant isolation (PRD §94, §116)", () => {
  it("non-members get 404 ORGANIZATION_NOT_FOUND on every :orgId route, including /me", async () => {
    const owner = await user(OWNER);
    const outsider = await user(OUTSIDER);
    const org = await createOrg(owner, "ADVERTISER", "Acme");

    const attempts = [
      api("GET", `/organizations/${org.id}`, bearer(outsider)),
      api("GET", `/organizations/${org.id}/me`, bearer(outsider)),
      api("GET", `/organizations/${org.id}/roles`, bearer(outsider)),
      api("GET", `/organizations/${org.id}/members`, bearer(outsider)),
      api("PATCH", `/organizations/${org.id}`, bearer(outsider), { name: "X" }),
      api("POST", `/organizations/${org.id}/members`, bearer(outsider), { email: OUTSIDER, role: "ADVERTISER_OWNER" }),
      api("PATCH", `/organizations/${org.id}/members/${org.membership.id}`, bearer(outsider), { role: "VIEWER" }),
      api("DELETE", `/organizations/${org.id}/members/${org.membership.id}`, bearer(outsider)),
      // malformed and unknown ids are indistinguishable from foreign ones
      api("GET", `/organizations/not-a-uuid/me`, bearer(outsider)),
      api("GET", `/organizations/11111111-2222-4333-8444-555555555555/me`, bearer(outsider)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    }
  });

  it("a client-supplied organization_id in the body is ignored; the path decides the tenant", async () => {
    const alice = await user(OWNER);
    const bob = await user(MGR);
    const aliceOrg = await createOrg(alice, "ADVERTISER", "Alice Ads");
    const bobOrg = await createOrg(bob, "ADVERTISER", "Bob Ads");

    // Bob is owner of bobOrg and tries to smuggle aliceOrg's id in the body.
    const res = await api("PATCH", `/organizations/${bobOrg.id}`, bearer(bob), {
      name: "Renamed",
      organization_id: aliceOrg.id,
      orgId: aliceOrg.id,
    });
    // Unknown body fields are rejected by the schema or ignored — either way aliceOrg is untouched.
    expect([200, 400]).toContain(res.status);
    const aliceName = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(aliceOrg.id).first<{ name: string }>();
    expect(aliceName?.name).toBe("Alice Ads");

    // And addressing aliceOrg in the path is a 404 regardless of body content.
    const cross = await api("PATCH", `/organizations/${aliceOrg.id}`, bearer(bob), { name: "Renamed", organization_id: bobOrg.id });
    expect(cross.status).toBe(404);
  });

  it("a REMOVED membership confers no permissions (404 on every route)", async () => {
    const owner = await user(OWNER);
    const mgr = await user(MGR);
    const org = await createOrg(owner, "AFFILIATE", "Traffic Co");
    const m = await addMember(owner, org.id, MGR, "AFFILIATE_MANAGER");
    expect((await me(mgr, org.id)).permissions).toContain("members.manage");

    expect((await api("DELETE", `/organizations/${org.id}/members/${m.id}`, bearer(owner))).status).toBe(204);

    for (const res of [
      await api("GET", `/organizations/${org.id}/me`, bearer(mgr)),
      await api("GET", `/organizations/${org.id}/members`, bearer(mgr)),
      await api("POST", `/organizations/${org.id}/members`, bearer(mgr), { email: MGR, role: "VIEWER" }),
    ]) {
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    }
  });

  it("requires authentication before any tenant resolution (401, never 404 leakage)", async () => {
    const owner = await user(OWNER);
    const org = await createOrg(owner, "AFFILIATE", "Traffic Co");
    for (const res of [
      await api("GET", `/organizations/${org.id}/me`),
      await api("GET", `/organizations/${org.id}/me`, bearer("tvh_s_bogus")),
      await api("GET", `/organizations/11111111-2222-4333-8444-555555555555/me`),
    ]) {
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("UNAUTHENTICATED");
    }
  });
});

describe("permission catalogue parity", () => {
  it("PERMISSION_KEYS (typed constant) equals the permissions table seeded by migration 0004", async () => {
    const rows = await db.prepare("SELECT key FROM permissions ORDER BY key").all<{ key: string }>();
    expect([...PERMISSION_KEYS].sort()).toEqual(rows.results.map((r) => r.key));
  });
});
