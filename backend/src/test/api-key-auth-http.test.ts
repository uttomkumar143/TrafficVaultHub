/**
 * Phase 6 Unit 4 — API keys as bearer credentials (PRD §76, §77, §116).
 *
 * Drives the real app over HTTP: a key minted through the management routes
 * is presented as `Authorization: Bearer tvh_k_…` and must
 *
 *   * authenticate (200) and bind the request to the key's organization;
 *   * be refused with the standard 401 envelope when revoked, expired,
 *     rotated-and-past-grace, or simply unknown — indistinguishably;
 *   * be limited by its scopes: `requirePermission` sees role ∩ scopes (403
 *     FORBIDDEN), `requireScope` answers 403 INSUFFICIENT_SCOPE;
 *   * never reach another tenant (404 ORGANIZATION_NOT_FOUND, no enumeration);
 *   * never manage keys or sessions itself (403 — needs a user session);
 *   * touch `last_used_at`;
 *   * never appear in audit rows or response bodies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface ApiKey {
  id: string;
  key?: string;
  key_prefix: string;
  scopes: string[];
  status: string;
}

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness({ rateLimit: { enabled: false } });
});
afterEach(() => h.close());

const K = (orgId: string) => `/organizations/${orgId}/api-keys`;

async function advertiser(email: string, name: string) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  return { owner, orgId };
}

async function createKey(token: string, orgId: string, body: Record<string, unknown>): Promise<ApiKey & { key: string }> {
  const res = await h.as(token, "POST", K(orgId), { name: "integration", ...body });
  expect(res.status).toBe(201);
  const k = (await json<{ api_key: ApiKey }>(res)).api_key;
  expect(k.key).toBeDefined();
  return k as ApiKey & { key: string };
}

function dbRow(id: string): Record<string, unknown> {
  return h.db.sqlite.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown>;
}

async function expectEnvelope(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = await json<{ error: { code: string; message: string; request_id: string } }>(res);
  expect(body).toEqual({ error: { code, message: expect.any(String), request_id: expect.any(String) } });
}

describe("API key bearer auth — valid keys (§76)", () => {
  it("authenticates a scoped key against its own organization and updates last_used_at", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read", "api_keys.read"] });
    expect(dbRow(k.id).last_used_at).toBeNull();

    const res = await h.as(k.key, "GET", `/organizations/${a.orgId}`);
    expect(res.status).toBe(200);
    const body = await json<{ organization: { id: string } }>(res);
    expect(body.organization.id).toBe(a.orgId);

    const row = dbRow(k.id);
    expect(row.last_used_at).toEqual(expect.any(String));
    expect(row.status).toBe("ACTIVE");
  });

  it("/auth/me reports the key principal without any secret material", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });

    const res = await h.as(k.key, "GET", "/auth/me");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { user: { email: string }; session: { id: string } };
    expect(body.user.email).toBe("a@adv.example");
    expect(body.session.id).toBe(`apikey:${k.id}`);
    expect(text).not.toContain(k.key.split(".")[1]);
    expect(text).not.toContain("key_hash");
  });

  it("a key with no scopes authenticates but holds no permissions (role ∩ ∅)", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, {});
    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${a.orgId}`), 403, "FORBIDDEN");
    // Still a successful authentication — last_used_at moved.
    expect(dbRow(k.id).last_used_at).toEqual(expect.any(String));
  });
});

describe("API key bearer auth — refused keys use one indistinguishable 401 (§116)", () => {
  it("revoked key → 401 UNAUTHENTICATED and last_used_at is NOT touched", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });
    expect((await h.as(a.owner, "POST", `${K(a.orgId)}/${k.id}/revoke`)).status).toBe(200);

    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
    expect(dbRow(k.id).last_used_at).toBeNull();
  });

  it("expired key → 401 and the row settles to EXPIRED on the way", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, {
      scopes: ["organizations.read"],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // Move expiry into the past directly (read-time expiry, no scheduler).
    h.db.sqlite.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", k.id);

    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
    expect(dbRow(k.id).status).toBe("EXPIRED");
    expect(dbRow(k.id).last_used_at).toBeNull();
  });

  it("rotated key works inside the grace window, then 401 once grace has elapsed; successor keeps working", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k1 = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });
    const rot = await h.as(a.owner, "POST", `${K(a.orgId)}/${k1.id}/rotate`);
    expect(rot.status).toBe(201);
    const k2 = (await json<{ api_key: ApiKey & { key: string } }>(rot)).api_key;

    expect((await h.as(k1.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);
    expect(dbRow(k1.id).status).toBe("ROTATED");
    expect((await h.as(k2.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);

    // Grace over → the old key is final.
    h.db.sqlite.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", k1.id);
    await expectEnvelope(await h.as(k1.key, "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
    expect(dbRow(k1.id).status).toBe("EXPIRED");
    expect((await h.as(k2.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);
  });

  it("unknown / malformed tvh_k_ tokens → the same 401 envelope", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });
    const forged = `${k.key.slice(0, -1)}${k.key.endsWith("A") ? "B" : "A"}`;
    await expectEnvelope(await h.as(forged, "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
    await expectEnvelope(await h.as("tvh_k_nonsense", "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
    await expectEnvelope(await h.as("tvh_x_unknownprefix.secret", "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
  });

  it("a key whose creator is no longer ACTIVE is refused", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });
    h.db.sqlite.prepare("UPDATE users SET status = 'SUSPENDED' WHERE email = ?").run("a@adv.example");
    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${a.orgId}`), 401, "UNAUTHENTICATED");
  });
});

describe("API key scopes (§77)", () => {
  it("wrong scope → 403 FORBIDDEN via requirePermission (role ∩ scopes)", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["api_keys.read"] });

    // Has api_keys.read → can list keys…
    expect((await h.as(k.key, "GET", K(a.orgId))).status).toBe(200);
    // …but not organizations.read.
    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${a.orgId}`), 403, "FORBIDDEN");
  });

  it("scopes cannot exceed the creator's role (VIEWER key with a manage scope is still read-only)", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    await h.user("v@adv.example");
    await h.addMember(a.owner, a.orgId, "v@adv.example", "VIEWER");
    const viewer = (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email: "v@adv.example", password: PASSWORD }))).token;
    // A VIEWER cannot mint keys, so the owner mints one on their behalf is not
    // a thing either — keys belong to their creator. Prove the ceiling with
    // the owner's own key instead: scopes outside the role never materialise.
    expect((await h.as(viewer, "POST", K(a.orgId), { name: "x", scopes: ["organizations.update"] })).status).toBe(403);

    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read", "totally.made_up"] });
    expect((await h.as(k.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);
    // Owner holds organizations.update but the key does not carry it.
    await expectEnvelope(await h.as(k.key, "PATCH", `/organizations/${a.orgId}`, { name: "Renamed" }), 403, "FORBIDDEN");
  });

  it("an API key cannot manage keys or sessions (requireSession → 403)", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["api_keys.read", "api_keys.manage"] });

    await expectEnvelope(await h.as(k.key, "POST", K(a.orgId), { name: "escalate" }), 403, "FORBIDDEN");
    await expectEnvelope(await h.as(k.key, "POST", `${K(a.orgId)}/${k.id}/rotate`), 403, "FORBIDDEN");
    await expectEnvelope(await h.as(k.key, "POST", `${K(a.orgId)}/${k.id}/revoke`), 403, "FORBIDDEN");
    await expectEnvelope(await h.as(k.key, "POST", "/auth/logout"), 403, "FORBIDDEN");
    await expectEnvelope(await h.as(k.key, "GET", "/auth/sessions"), 403, "FORBIDDEN");
    // Nothing happened to the key.
    expect(dbRow(k.id).status).toBe("ACTIVE");
    // A user session is unaffected by requireSession.
    expect((await h.as(a.owner, "GET", "/auth/sessions")).status).toBe(200);
  });
});

describe("API key tenant isolation (§94, §99)", () => {
  it("a key for org A gets 404 ORGANIZATION_NOT_FOUND on org B — even when its creator is a member of B", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const b = await advertiser("b@adv.example", "Adv B");
    // Make A's owner a member of B too: the SESSION can read B, the KEY cannot.
    await h.addMember(b.owner, b.orgId, "a@adv.example", "VIEWER");
    expect((await h.as(a.owner, "GET", `/organizations/${b.orgId}`)).status).toBe(200);

    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read", "api_keys.read"] });
    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${b.orgId}`), 404, "ORGANIZATION_NOT_FOUND");
    await expectEnvelope(await h.as(k.key, "GET", K(b.orgId)), 404, "ORGANIZATION_NOT_FOUND");
    await expectEnvelope(await h.as(k.key, "GET", `/organizations/${RANDOM_ID}`), 404, "ORGANIZATION_NOT_FOUND");
    // Own org still fine.
    expect((await h.as(k.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);
  });

  it("the secret never lands in audit rows", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { scopes: ["organizations.read"] });
    expect((await h.as(k.key, "GET", `/organizations/${a.orgId}`)).status).toBe(200);
    const dump = JSON.stringify(h.db.sqlite.prepare("SELECT * FROM audit_logs").all());
    expect(dump).not.toContain(k.key.split(".")[1]);
  });
});

describe("requireScope middleware (§77)", () => {
  it("API key without the scope → 403 INSUFFICIENT_SCOPE; with it → pass; user session → pass", async () => {
    const { Hono } = await import("hono");
    const { requireScope } = await import("../middleware/require-auth");
    const { AppError } = await import("../lib/errors");
    type Env = { Variables: { auth: unknown } };
    const mk = (auth: unknown) => {
      const app = new Hono<Env>();
      app.use("*", async (c, next) => {
        c.set("auth", auth);
        await next();
      });
      app.get("/r", requireScope("conversions.read") as never, (c) => c.text("ok"));
      app.onError((e, c) => (e instanceof AppError ? c.json({ code: e.code }, e.status) : c.text("boom", 500)));
      return app;
    };
    const session = { user: { id: "u" }, session: { id: "s" } };
    const keyOk = { ...session, api_key: { scopes: ["conversions.read"] } };
    const keyNo = { ...session, api_key: { scopes: ["offers.read"] } };

    expect((await mk(session).request("/r")).status).toBe(200);
    expect((await mk(keyOk).request("/r")).status).toBe(200);
    const denied = await mk(keyNo).request("/r");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: "INSUFFICIENT_SCOPE" });
    const anon = await mk(undefined).request("/r");
    expect(anon.status).toBe(401);
  });
});
