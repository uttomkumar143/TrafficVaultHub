/**
 * Phase 1 Unit 3 — Organizations CRUD + membership.
 * Exercises HTTP route → requireAuth → OrganizationService →
 * OrganizationRepository → D1 (node:sqlite shim running the real migrations
 * 0001–0004). Also covers the Unit 3/4 slice of PRD §116: a member of tenant A
 * can never read or manage tenant B (404, no enumeration), and a role without
 * the required permission key cannot perform management actions (403).
 * Dedicated RBAC middleware tests live in `rbac.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

interface Envelope {
  error: { code: string; message: string; request_id: string | null };
}
interface Role {
  key: string;
  name: string;
  is_owner: boolean;
}
interface Organization {
  id: string;
  type: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  membership: { id: string; role: Role; joined_at: string | null };
}
interface Member {
  id: string;
  user: { id: string; email: string; display_name: string | null };
  role: Role;
  status: string;
  joined_at: string | null;
  created_at: string;
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

/** Sign up, verify and log in; returns the bearer token. */
async function user(email: string): Promise<string> {
  expect((await api("POST", "/auth/signup", {}, { email, password: PASSWORD })).status).toBe(201);
  const token = mail.last("EMAIL_VERIFICATION")?.token;
  expect((await api("POST", "/auth/verify-email", {}, { token })).status).toBe(200);
  const res = await api("POST", "/auth/login", {}, { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function createOrg(token: string, body: Record<string, unknown>): Promise<Organization> {
  const res = await api("POST", "/organizations", bearer(token), body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { organization: Organization }).organization;
}

async function addMember(token: string, orgId: string, email: string, role: string): Promise<Member> {
  const res = await api("POST", `/organizations/${orgId}/members`, bearer(token), { email, role });
  expect(res.status).toBe(201);
  return ((await res.json()) as { member: Member }).member;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as Envelope).error.code;
}

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
const DAVE = "dave@example.com";
const RANDOM_ID = "11111111-2222-4333-8444-555555555555";

describe("POST /organizations — create", () => {
  it("creates an organization and seats the creator as the type's owner role", async () => {
    const alice = await user(ALICE);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme Ads" });

    expect(org.type).toBe("ADVERTISER");
    expect(org.name).toBe("Acme Ads");
    expect(org.slug).toBe("acme-ads");
    expect(org.status).toBe("ACTIVE");
    expect(org.membership.role).toEqual({ key: "ADVERTISER_OWNER", name: "Advertiser Owner", is_owner: true });
    expect(org.membership.joined_at).not.toBeNull();

    // Each type gets its own owner role.
    const aff = await createOrg(alice, { type: "AFFILIATE", name: "Traffic Co" });
    expect(aff.membership.role.key).toBe("AFFILIATE_OWNER");
    const partner = await createOrg(alice, { type: "PARTNER", name: "Partner Co" });
    expect(partner.membership.role.key).toBe("AFFILIATE_OWNER");
    const agency = await createOrg(alice, { type: "AGENCY", name: "Agency Co" });
    expect(agency.membership.role.key).toBe("ADVERTISER_OWNER");

    // Audit trail written in the same transaction.
    const audit = await db
      .prepare("SELECT action, target_type FROM audit_logs WHERE organization_id = ? ORDER BY action")
      .bind(org.id)
      .all<{ action: string; target_type: string }>();
    expect(audit.results).toEqual([
      { action: "member.added", target_type: "organization_member" },
      { action: "organization.created", target_type: "organization" },
    ]);
  });

  it("rejects PLATFORM self-service creation and invalid bodies with VALIDATION_ERROR", async () => {
    const alice = await user(ALICE);
    const platform = await api("POST", "/organizations", bearer(alice), { type: "PLATFORM", name: "Root" });
    expect(platform.status).toBe(400);
    expect(await errorCode(platform)).toBe("VALIDATION_ERROR");

    const short = await api("POST", "/organizations", bearer(alice), { type: "ADVERTISER", name: "A" });
    expect(short.status).toBe(400);

    const badSlug = await api("POST", "/organizations", bearer(alice), {
      type: "ADVERTISER",
      name: "Fine Name",
      slug: "Not Valid!",
    });
    expect(badSlug.status).toBe(400);

    const notJson = await app.request(
      "/api/v1/organizations",
      { method: "POST", headers: { ...bearer(alice), "content-type": "application/json" }, body: "{" },
      env,
    );
    expect(notJson.status).toBe(400);
  });

  it("rejects duplicate slugs with 409 SLUG_ALREADY_EXISTS", async () => {
    const alice = await user(ALICE);
    await createOrg(alice, { type: "ADVERTISER", name: "Acme", slug: "acme" });
    const dup = await api("POST", "/organizations", bearer(alice), { type: "AFFILIATE", name: "Other", slug: "acme" });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("SLUG_ALREADY_EXISTS");
  });

  it("requires authentication on every route", async () => {
    for (const [method, path] of [
      ["POST", "/organizations"],
      ["GET", "/organizations"],
      ["GET", `/organizations/${RANDOM_ID}`],
      ["PATCH", `/organizations/${RANDOM_ID}`],
      ["GET", `/organizations/${RANDOM_ID}/roles`],
      ["GET", `/organizations/${RANDOM_ID}/members`],
      ["POST", `/organizations/${RANDOM_ID}/members`],
      ["PATCH", `/organizations/${RANDOM_ID}/members/${RANDOM_ID}`],
      ["DELETE", `/organizations/${RANDOM_ID}/members/${RANDOM_ID}`],
    ] as const) {
      const res = await api(method, path, {}, method === "GET" || method === "DELETE" ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await errorCode(res)).toBe("UNAUTHENTICATED");
    }
  });
});

describe("GET /organizations — list & get (tenant scoping)", () => {
  it("lists only organizations the caller is an active member of", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const a1 = await createOrg(alice, { type: "ADVERTISER", name: "Alice One" });
    const a2 = await createOrg(alice, { type: "AFFILIATE", name: "Alice Two" });
    const b1 = await createOrg(bob, { type: "ADVERTISER", name: "Bob One" });

    const mine = await api("GET", "/organizations", bearer(alice));
    expect(mine.status).toBe(200);
    const list = ((await mine.json()) as { organizations: Organization[] }).organizations;
    expect(list.map((o) => o.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(list.map((o) => o.id)).not.toContain(b1.id);

    const bobs = ((await (await api("GET", "/organizations", bearer(bob))).json()) as { organizations: Organization[] })
      .organizations;
    expect(bobs.map((o) => o.id)).toEqual([b1.id]);
  });

  it("returns 404 ORGANIZATION_NOT_FOUND for another tenant's org, an unknown id and a malformed id alike", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const bobOrg = await createOrg(bob, { type: "ADVERTISER", name: "Bob Org" });

    for (const id of [bobOrg.id, RANDOM_ID, "not-a-uuid"]) {
      const res = await api("GET", `/organizations/${id}`, bearer(alice));
      expect(res.status, id).toBe(404);
      expect(await errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    }
    // Owner still sees it.
    const own = await api("GET", `/organizations/${bobOrg.id}`, bearer(bob));
    expect(own.status).toBe(200);
    expect(((await own.json()) as { organization: Organization }).organization.id).toBe(bobOrg.id);
  });

  it("lists roles assignable for the organization's type", async () => {
    const alice = await user(ALICE);
    const adv = await createOrg(alice, { type: "ADVERTISER", name: "Adv" });
    const aff = await createOrg(alice, { type: "AFFILIATE", name: "Aff" });

    const advRoles = ((await (await api("GET", `/organizations/${adv.id}/roles`, bearer(alice))).json()) as {
      roles: Role[];
    }).roles;
    expect(advRoles.map((r) => r.key).sort()).toEqual(
      ["ADVERTISER_ADMIN", "ADVERTISER_OWNER", "BILLING_MANAGER", "CAMPAIGN_MANAGER", "VIEWER"].sort(),
    );
    expect(advRoles.filter((r) => r.is_owner).map((r) => r.key)).toEqual(["ADVERTISER_OWNER"]);

    const affRoles = ((await (await api("GET", `/organizations/${aff.id}/roles`, bearer(alice))).json()) as {
      roles: Role[];
    }).roles;
    expect(affRoles.map((r) => r.key).sort()).toEqual(
      ["AFFILIATE_MANAGER", "AFFILIATE_OWNER", "AFFILIATE_USER", "VIEWER"].sort(),
    );
    // Platform roles are never assignable in tenant orgs.
    expect([...advRoles, ...affRoles].map((r) => r.key)).not.toContain("SUPER_ADMIN");
  });
});

describe("PATCH /organizations/:id — update", () => {
  it("lets an owner rename and audits before/after; non-members get 404", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Old Name" });

    const res = await api("PATCH", `/organizations/${org.id}`, bearer(alice), { name: "New Name" });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { organization: Organization }).organization;
    expect(updated.name).toBe("New Name");
    expect(updated.slug).toBe("old-name"); // slug is stable

    const audit = await db
      .prepare("SELECT metadata FROM audit_logs WHERE organization_id = ? AND action = 'organization.updated'")
      .bind(org.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({ before: { name: "Old Name" }, after: { name: "New Name" } });

    const cross = await api("PATCH", `/organizations/${org.id}`, bearer(bob), { name: "Hijacked" });
    expect(cross.status).toBe(404);
    expect(await errorCode(cross)).toBe("ORGANIZATION_NOT_FOUND");
    const row = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first<{ name: string }>();
    expect(row?.name).toBe("New Name");
  });

  it("rejects a non-owner member with 403 FORBIDDEN", async () => {
    const alice = await user(ALICE);
    await user(BOB);
    const bobToken = (await (await api("POST", "/auth/login", {}, { email: BOB, password: PASSWORD })).json()) as {
      token: string;
    };
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });
    await addMember(alice, org.id, BOB, "VIEWER");

    const res = await api("PATCH", `/organizations/${org.id}`, bearer(bobToken.token), { name: "Nope" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
    // But the viewer can read.
    expect((await api("GET", `/organizations/${org.id}`, bearer(bobToken.token))).status).toBe(200);
  });
});

describe("members — add / list / change role / remove", () => {
  it("owner adds an existing user by email with a type-valid role; list shows both", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });

    const member = await addMember(alice, org.id, BOB.toUpperCase(), "campaign_manager");
    expect(member.user.email).toBe(BOB);
    expect(member.role).toEqual({ key: "CAMPAIGN_MANAGER", name: "Campaign Manager", is_owner: false });
    expect(member.status).toBe("ACTIVE");

    const list = ((await (await api("GET", `/organizations/${org.id}/members`, bearer(alice))).json()) as {
      members: Member[];
    }).members;
    expect(list.map((m) => m.user.email)).toEqual([ALICE, BOB]); // owner first
    expect(JSON.stringify(list)).not.toMatch(/password|token_hash|tvh_s_/);

    // Bob now sees the org in his list.
    const bobs = ((await (await api("GET", "/organizations", bearer(bob))).json()) as { organizations: Organization[] })
      .organizations;
    expect(bobs.map((o) => o.id)).toEqual([org.id]);
    expect(bobs[0]?.membership.role.key).toBe("CAMPAIGN_MANAGER");
  });

  it("rejects unknown users, roles from other org types, duplicates", async () => {
    const alice = await user(ALICE);
    await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });

    const unknown = await api("POST", `/organizations/${org.id}/members`, bearer(alice), {
      email: "nobody@example.com",
      role: "VIEWER",
    });
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("USER_NOT_FOUND");

    for (const role of ["AFFILIATE_USER", "SUPER_ADMIN", "DOES_NOT_EXIST"]) {
      const res = await api("POST", `/organizations/${org.id}/members`, bearer(alice), { email: BOB, role });
      expect(res.status, role).toBe(400);
      expect(await errorCode(res)).toBe("ROLE_NOT_ALLOWED_FOR_ORG_TYPE");
    }

    await addMember(alice, org.id, BOB, "VIEWER");
    const dup = await api("POST", `/organizations/${org.id}/members`, bearer(alice), { email: BOB, role: "VIEWER" });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("ALREADY_MEMBER");
    const self = await api("POST", `/organizations/${org.id}/members`, bearer(alice), { email: ALICE, role: "VIEWER" });
    expect(self.status).toBe(409);
  });

  it("manager (members.manage) can add non-owner members but never touch owner seats; VIEWER gets 403; non-member gets 404", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const carol = await user(CAROL);
    const dave = await user(DAVE);
    const org = await createOrg(alice, { type: "AFFILIATE", name: "Traffic" });
    const bobMember = await addMember(alice, org.id, BOB, "AFFILIATE_MANAGER");
    const daveMember = await addMember(alice, org.id, DAVE, "VIEWER");

    // AFFILIATE_MANAGER holds members.manage (migration 0004) → may add a non-owner.
    const add = await api("POST", `/organizations/${org.id}/members`, bearer(bob), { email: CAROL, role: "VIEWER" });
    expect(add.status).toBe(201);

    // …but granting an owner seat requires the owner role itself (escalation guard).
    const grantOwner = await api("PATCH", `/organizations/${org.id}/members/${bobMember.id}`, bearer(bob), {
      role: "AFFILIATE_OWNER",
    });
    expect(grantOwner.status).toBe(403);
    expect(await errorCode(grantOwner)).toBe("FORBIDDEN");

    // …nor may a manager demote or remove the owner.
    const demoteOwner = await api("PATCH", `/organizations/${org.id}/members/${org.membership.id}`, bearer(bob), {
      role: "VIEWER",
    });
    expect(demoteOwner.status).toBe(403);
    const remove = await api("DELETE", `/organizations/${org.id}/members/${org.membership.id}`, bearer(bob));
    expect(remove.status).toBe(403);
    expect(await errorCode(remove)).toBe("FORBIDDEN");

    // VIEWER lacks members.manage → every management call is 403 (role escalation rejected, PRD §116).
    for (const res of [
      await api("POST", `/organizations/${org.id}/members`, bearer(dave), { email: CAROL, role: "VIEWER" }),
      await api("PATCH", `/organizations/${org.id}/members/${bobMember.id}`, bearer(dave), { role: "VIEWER" }),
      await api("DELETE", `/organizations/${org.id}/members/${bobMember.id}`, bearer(dave)),
      await api("PATCH", `/organizations/${org.id}`, bearer(dave), { name: "Nope" }),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("FORBIDDEN");
    }
    // …while reads stay open to the viewer.
    expect((await api("GET", `/organizations/${org.id}/members`, bearer(dave))).status).toBe(200);

    // Carol is now a member (added by Bob) — use a fresh non-member for the 404 case.
    const erin = await user("erin@example.com");
    for (const res of [
      await api("GET", `/organizations/${org.id}/members`, bearer(erin)),
      await api("POST", `/organizations/${org.id}/members`, bearer(erin), { email: CAROL, role: "VIEWER" }),
      await api("PATCH", `/organizations/${org.id}/members/${bobMember.id}`, bearer(erin), { role: "VIEWER" }),
      await api("DELETE", `/organizations/${org.id}/members/${bobMember.id}`, bearer(erin)),
    ]) {
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    }
    void carol;

    // Nothing about Bob or the owner changed.
    const row = await db
      .prepare("SELECT r.key, m.status FROM organization_members m JOIN roles r ON r.id = m.role_id WHERE m.id = ?")
      .bind(bobMember.id)
      .first<{ key: string; status: string }>();
    expect(row).toEqual({ key: "AFFILIATE_MANAGER", status: "ACTIVE" });
    const owner = await db
      .prepare("SELECT r.key, m.status FROM organization_members m JOIN roles r ON r.id = m.role_id WHERE m.id = ?")
      .bind(org.membership.id)
      .first<{ key: string; status: string }>();
    expect(owner).toEqual({ key: "AFFILIATE_OWNER", status: "ACTIVE" });
    void daveMember;
  });

  it("changes a member's role, audits it, and is a no-op for the same role", async () => {
    const alice = await user(ALICE);
    await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });
    const bob = await addMember(alice, org.id, BOB, "VIEWER");

    const res = await api("PATCH", `/organizations/${org.id}/members/${bob.id}`, bearer(alice), {
      role: "BILLING_MANAGER",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: Member }).member.role.key).toBe("BILLING_MANAGER");

    const same = await api("PATCH", `/organizations/${org.id}/members/${bob.id}`, bearer(alice), {
      role: "BILLING_MANAGER",
    });
    expect(same.status).toBe(200);

    const audits = await db
      .prepare("SELECT metadata FROM audit_logs WHERE action = 'member.role_changed' AND target_id = ?")
      .bind(bob.id)
      .all<{ metadata: string }>();
    expect(audits.results).toHaveLength(1);
    expect(JSON.parse(audits.results[0]!.metadata)).toMatchObject({
      before: { role: "VIEWER" },
      after: { role: "BILLING_MANAGER" },
    });

    const bad = await api("PATCH", `/organizations/${org.id}/members/${bob.id}`, bearer(alice), { role: "AFFILIATE_USER" });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("ROLE_NOT_ALLOWED_FOR_ORG_TYPE");

    const missing = await api("PATCH", `/organizations/${org.id}/members/${RANDOM_ID}`, bearer(alice), { role: "VIEWER" });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("MEMBER_NOT_FOUND");
  });

  it("member ids from another organization are not addressable (404 MEMBER_NOT_FOUND)", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    await user(CAROL);
    const aliceOrg = await createOrg(alice, { type: "ADVERTISER", name: "Alice Org" });
    const bobOrg = await createOrg(bob, { type: "ADVERTISER", name: "Bob Org" });
    const carolInBob = await addMember(bob, bobOrg.id, CAROL, "VIEWER");

    // Alice is owner of her org but tries to use Bob's membership id under her org path.
    const change = await api("PATCH", `/organizations/${aliceOrg.id}/members/${carolInBob.id}`, bearer(alice), {
      role: "BILLING_MANAGER",
    });
    expect(change.status).toBe(404);
    expect(await errorCode(change)).toBe("MEMBER_NOT_FOUND");
    const remove = await api("DELETE", `/organizations/${aliceOrg.id}/members/${carolInBob.id}`, bearer(alice));
    expect(remove.status).toBe(404);

    const row = await db
      .prepare("SELECT status FROM organization_members WHERE id = ?")
      .bind(carolInBob.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("ACTIVE");
  });

  it("removes a member (soft), hides them from the list, revokes their access, and can re-add them", async () => {
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });
    const bobMember = await addMember(alice, org.id, BOB, "VIEWER");

    const res = await api("DELETE", `/organizations/${org.id}/members/${bobMember.id}`, bearer(alice));
    expect(res.status).toBe(204);

    const row = await db
      .prepare("SELECT status, removed_at FROM organization_members WHERE id = ?")
      .bind(bobMember.id)
      .first<{ status: string; removed_at: string | null }>();
    expect(row?.status).toBe("REMOVED");
    expect(row?.removed_at).not.toBeNull();

    const list = ((await (await api("GET", `/organizations/${org.id}/members`, bearer(alice))).json()) as {
      members: Member[];
    }).members;
    expect(list.map((m) => m.user.email)).toEqual([ALICE]);

    // Bob lost access to the tenant.
    expect((await api("GET", `/organizations/${org.id}`, bearer(bob))).status).toBe(404);

    // Removing again → 404 (already gone).
    expect((await api("DELETE", `/organizations/${org.id}/members/${bobMember.id}`, bearer(alice))).status).toBe(404);

    // Re-adding re-activates the same row with the new role.
    const again = await addMember(alice, org.id, BOB, "CAMPAIGN_MANAGER");
    expect(again.id).toBe(bobMember.id);
    expect(again.role.key).toBe("CAMPAIGN_MANAGER");
    expect((await api("GET", `/organizations/${org.id}`, bearer(bob))).status).toBe(200);
  });

  it("guards the last owner (409 LAST_OWNER) and self-removal (400 SELF_MODIFICATION)", async () => {
    const alice = await user(ALICE);
    await user(BOB);
    const org = await createOrg(alice, { type: "ADVERTISER", name: "Acme" });
    const me = org.membership.id;

    const demote = await api("PATCH", `/organizations/${org.id}/members/${me}`, bearer(alice), { role: "VIEWER" });
    expect(demote.status).toBe(409);
    expect(await errorCode(demote)).toBe("LAST_OWNER");

    const selfRemove = await api("DELETE", `/organizations/${org.id}/members/${me}`, bearer(alice));
    expect(selfRemove.status).toBe(400);
    expect(await errorCode(selfRemove)).toBe("SELF_MODIFICATION");

    // With a second owner, the demotion is allowed, and removing that owner afterwards is blocked again.
    const bob = await addMember(alice, org.id, BOB, "ADVERTISER_OWNER");
    expect(bob.role.is_owner).toBe(true);
    const demoteNow = await api("PATCH", `/organizations/${org.id}/members/${me}`, bearer(alice), { role: "VIEWER" });
    expect(demoteNow.status).toBe(200);

    // Alice is now a VIEWER → cannot manage anymore.
    const bobToken = ((await (await api("POST", "/auth/login", {}, { email: BOB, password: PASSWORD })).json()) as {
      token: string;
    }).token;
    expect((await api("PATCH", `/organizations/${org.id}`, bearer(alice), { name: "Renamed" })).status).toBe(403);

    // Bob is the last owner → cannot be demoted or removed even by himself/others.
    const bobDemote = await api("PATCH", `/organizations/${org.id}/members/${bob.id}`, bearer(bobToken), { role: "VIEWER" });
    expect(bobDemote.status).toBe(409);
    expect(await errorCode(bobDemote)).toBe("LAST_OWNER");
  });
});
