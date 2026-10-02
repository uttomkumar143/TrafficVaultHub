/**
 * Phase 6 Unit 3 — API keys through the REAL app (auth → requireOrg →
 * requirePermission → ApiKeyService → ApiKeyRepository → D1 shim running the
 * actual migrations incl. 0012).
 *
 * Covers (PRD §73, §115, §116):
 *   * creation returns the full key exactly once; only SHA-256 + 4-char hint
 *     + prefix are stored; list/get never carry the hash or the secret;
 *   * rotate: ACTIVE → ROTATED with a successor; the old key keeps a grace
 *     window; rotating a ROTATED/REVOKED key → 409 from the SERVICE (the DB
 *     trigger is never reached, so no raw SQLite error leaks);
 *   * revoke: ACTIVE|ROTATED → REVOKED; terminal afterwards (409 API_KEY_FINAL
 *     at the service layer — proven by asserting the response code AND that
 *     the row is untouched);
 *   * read-time expiry via `expires_at`;
 *   * tenant isolation (one org cannot see/rotate/revoke another's key);
 *   * permission gating (api_keys.read vs api_keys.manage; VIEWER has neither);
 *   * `authenticate`: valid key → principal + last_used_at; invalid / revoked /
 *     expired / malformed → null.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../modules/auth/crypto-utils";
import { ApiKeyRepository } from "../modules/api-keys/repository";
import { ApiKeyService, isWellFormedKey } from "../modules/api-keys/service";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface ApiKey {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  secret_hint: string;
  scopes: string[];
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
  rotated_to_key_id: string | null;
  revoked_at: string | null;
  key?: string;
}

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

const K = (orgId: string, path = "") => `/organizations/${orgId}/api-keys${path}`;

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

async function createKey(token: string, orgId: string, body: Record<string, unknown> = { name: "CI deploy" }): Promise<ApiKey> {
  const res = await h.as(token, "POST", K(orgId), body);
  expect(res.status).toBe(201);
  return (await json<{ api_key: ApiKey }>(res)).api_key;
}

function dbRow(id: string) {
  return h.db.sqlite.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("api keys HTTP — creation and secret handling (§115)", () => {
  it("returns the full key ONCE; stores only hash + hint + prefix; list/get never leak it", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const created = await createKey(a.owner, a.orgId, { name: "CI deploy", scopes: ["conversions.read", "offers.read"] });

    expect(created.key).toBeDefined();
    const key = created.key!;
    expect(isWellFormedKey(key)).toBe(true);
    expect(key.startsWith(created.key_prefix + ".")).toBe(true);
    expect(created.secret_hint).toBe(key.slice(-4));
    expect(created.scopes).toEqual(["conversions.read", "offers.read"]);
    expect(created.status).toBe("ACTIVE");
    expect(created).not.toHaveProperty("key_hash");

    // Stored: SHA-256 of the full key, 4-char hint, prefix. Never the plaintext.
    const row = dbRow(created.id);
    expect(row.key_hash).toBe(await sha256Hex(key));
    expect(String(row.key_hash)).toHaveLength(64);
    expect(row.secret_hint).toBe(key.slice(-4));
    expect(row.key_prefix).toBe(created.key_prefix);
    expect(JSON.stringify(row)).not.toContain(key.split(".")[1]);

    // list + get: no `key`, no `key_hash`, and the secret string appears nowhere in the body.
    const listRes = await h.as(a.owner, "GET", K(a.orgId));
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain(key.split(".")[1]!);
    expect(listText).not.toContain(await sha256Hex(key));
    const list = JSON.parse(listText) as { items: ApiKey[]; next_cursor: string | null };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty("key");
    expect(list.items[0]).not.toHaveProperty("key_hash");
    expect(list.items[0]!.key_prefix).toBe(created.key_prefix);

    const getRes = await h.as(a.owner, "GET", K(a.orgId, `/${created.id}`));
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    expect(getText).not.toContain(key.split(".")[1]!);
    expect(getText).not.toContain(await sha256Hex(key));
    expect((JSON.parse(getText) as { api_key: ApiKey }).api_key).not.toHaveProperty("key");

    // Audit row exists and carries no secret material either.
    const audits = await h.auditRows("api_keys.created");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target_id).toBe(created.id);
    expect(audits[0]!.metadata).not.toContain(key.split(".")[1]!);
  });

  it("validates input: name required, scopes shape, expires_at must be a future timestamp, unknown fields refused", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    expect((await h.as(a.owner, "POST", K(a.orgId), {})).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "" })).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "x", scopes: "offers.read" })).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "x", scopes: ["Bad Scope!"] })).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "x", expires_at: "not-a-date" })).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "x", expires_at: "2000-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await h.as(a.owner, "POST", K(a.orgId), { name: "x", organization_id: RANDOM_ID })).status).toBe(400);
    const ok = await h.as(a.owner, "POST", K(a.orgId), { name: "x", expires_at: "2099-01-01T00:00:00Z" });
    expect(ok.status).toBe(201);
    expect((await json<{ api_key: ApiKey }>(ok)).api_key.expires_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("lists with cursor pagination and a status filter; invalid status → 400; malformed id → 404", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    for (let i = 0; i < 3; i++) await createKey(a.owner, a.orgId, { name: `k${i}` });
    const p1 = await json<{ items: ApiKey[]; next_cursor: string | null }>(await h.as(a.owner, "GET", K(a.orgId, "?limit=2")));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<{ items: ApiKey[]; next_cursor: string | null }>(await h.as(a.owner, "GET", K(a.orgId, `?limit=2&cursor=${p1.next_cursor}`)));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((k) => k.id)).size).toBe(3);

    expect((await h.as(a.owner, "GET", K(a.orgId, "?status=BOGUS"))).status).toBe(400);
    const active = await json<{ items: ApiKey[] }>(await h.as(a.owner, "GET", K(a.orgId, "?status=ACTIVE")));
    expect(active.items).toHaveLength(3);
    const revoked = await json<{ items: ApiKey[] }>(await h.as(a.owner, "GET", K(a.orgId, "?status=REVOKED")));
    expect(revoked.items).toHaveLength(0);

    expect((await h.as(a.owner, "GET", K(a.orgId, "/not-a-uuid"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", K(a.orgId, `/${RANDOM_ID}`))).status).toBe(404);
  });
});

describe("api keys HTTP — state machine enforced at the service layer", () => {
  it("rotate: ACTIVE → ROTATED with a linked successor whose key is shown once; old key gets a grace expiry", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k1 = await createKey(a.owner, a.orgId, { name: "prod", scopes: ["offers.read"] });

    const res = await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/rotate`));
    expect(res.status).toBe(201);
    const k2 = (await json<{ api_key: ApiKey }>(res)).api_key;
    expect(k2.id).not.toBe(k1.id);
    expect(k2.key).toBeDefined();
    expect(k2.key).not.toBe(k1.key);
    expect(k2.status).toBe("ACTIVE");
    expect(k2.name).toBe("prod");
    expect(k2.scopes).toEqual(["offers.read"]);
    expect(k2.rotated_from_key_id).toBe(k1.id);

    const old = (await json<{ api_key: ApiKey }>(await h.as(a.owner, "GET", K(a.orgId, `/${k1.id}`)))).api_key;
    expect(old.status).toBe("ROTATED");
    expect(old.rotated_to_key_id).toBe(k2.id);
    expect(old.expires_at).not.toBeNull();
    expect(new Date(old.expires_at!).getTime()).toBeGreaterThan(Date.now());

    // Old key still authenticates during the grace window; new key authenticates too.
    const svc = new ApiKeyService(new ApiKeyRepository(h.db), h.db);
    expect((await svc.authenticate(k1.key!))?.status).toBe("ROTATED");
    expect((await svc.authenticate(k2.key!))?.key_id).toBe(k2.id);

    expect((await h.auditRows("api_keys.rotated")).map((r) => r.target_id)).toEqual([k2.id]);
  });

  it("rotating a ROTATED key → 409 API_KEY_NOT_ACTIVE from the service; nothing is written", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k1 = await createKey(a.owner, a.orgId);
    expect((await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/rotate`))).status).toBe(201);
    const before = dbRow(k1.id);
    const keysBefore = h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number };

    const res = await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/rotate`));
    expect(res.status).toBe(409);
    expect(await h.errorCode(res)).toBe("API_KEY_NOT_ACTIVE");
    expect(dbRow(k1.id)).toEqual(before);
    expect((h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n).toBe(keysBefore.n);
  });

  it("revoke: ACTIVE → REVOKED and ROTATED → REVOKED; afterwards every transition is 409 API_KEY_FINAL (service-level, row untouched)", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k1 = await createKey(a.owner, a.orgId);
    const k2 = await createKey(a.owner, a.orgId);
    expect((await h.as(a.owner, "POST", K(a.orgId, `/${k2.id}/rotate`))).status).toBe(201); // k2 → ROTATED

    for (const id of [k1.id, k2.id]) {
      const res = await h.as(a.owner, "POST", K(a.orgId, `/${id}/revoke`));
      expect(res.status).toBe(200);
      const body = (await json<{ api_key: ApiKey }>(res)).api_key;
      expect(body.status).toBe("REVOKED");
      expect(body.revoked_at).not.toBeNull();
      expect(body).not.toHaveProperty("key");
    }

    // Revoking the ROTATED predecessor clears its forward link (0012 CHECK), but
    // the successor's frozen `rotated_from_key_id` keeps the chain reconstructable.
    const successor = h.db.sqlite.prepare("SELECT id FROM api_keys WHERE rotated_from_key_id = ?").get(k2.id) as { id: string };
    expect(successor.id).toBeDefined();
    expect(dbRow(k2.id).rotated_to_key_id).toBeNull();

    const frozen = dbRow(k1.id);
    const again = await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/revoke`));
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("API_KEY_FINAL");
    const rotateFinal = await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/rotate`));
    expect(rotateFinal.status).toBe(409);
    expect(await h.errorCode(rotateFinal)).toBe("API_KEY_FINAL");
    expect(dbRow(k1.id)).toEqual(frozen);

    // Envelope shape only — no stack trace, no SQLite / trigger text leaks.
    const text = JSON.stringify(await (await h.as(a.owner, "POST", K(a.orgId, `/${k1.id}/revoke`))).json());
    expect(text).not.toMatch(/SQLITE|RAISE|trg_|\bat\s+\w+\s*\(/);
    expect(JSON.parse(text)).toEqual({ error: { code: "API_KEY_FINAL", message: expect.any(String), request_id: expect.any(String) } });

    // Revoked keys never authenticate.
    const svc = new ApiKeyService(new ApiKeyRepository(h.db), h.db);
    expect(await svc.authenticate(k1.key!)).toBeNull();
    expect(await svc.authenticate(k2.key!)).toBeNull();
    expect((await h.auditRows("api_keys.revoked")).map((r) => r.target_id).sort()).toEqual([k1.id, k2.id].sort());
  });

  it("expiry is settled at read time from expires_at: a past expiry → EXPIRED, then terminal", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { name: "short", expires_at: "2099-01-01T00:00:00Z" });
    // Simulate time passing: move expires_at into the past directly (expires_at is not frozen by the trigger).
    h.db.sqlite.prepare("UPDATE api_keys SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(k.id);

    const got = (await json<{ api_key: ApiKey }>(await h.as(a.owner, "GET", K(a.orgId, `/${k.id}`)))).api_key;
    expect(got.status).toBe("EXPIRED");
    expect(dbRow(k.id).status).toBe("EXPIRED");

    const rot = await h.as(a.owner, "POST", K(a.orgId, `/${k.id}/rotate`));
    expect(rot.status).toBe(409);
    expect(await h.errorCode(rot)).toBe("API_KEY_FINAL");
    const rev = await h.as(a.owner, "POST", K(a.orgId, `/${k.id}/revoke`));
    expect(rev.status).toBe(409);
    expect(await h.errorCode(rev)).toBe("API_KEY_FINAL");

    const svc = new ApiKeyService(new ApiKeyRepository(h.db), h.db);
    expect(await svc.authenticate(k.key!)).toBeNull();
  });

  it("authenticate() also settles expiry for a live row and refuses it", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { name: "short", expires_at: "2099-01-01T00:00:00Z" });
    h.db.sqlite.prepare("UPDATE api_keys SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(k.id);
    const svc = new ApiKeyService(new ApiKeyRepository(h.db), h.db);
    expect(await svc.authenticate(k.key!)).toBeNull();
    expect(dbRow(k.id).status).toBe("EXPIRED");
  });
});

describe("api keys — authenticate (PRD §116 'invalid API key rejected')", () => {
  it("valid key → principal with scopes and touches last_used_at; wrong/malformed/unknown → null without touching anything", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId, { name: "svc", scopes: ["offers.read"] });
    const svc = new ApiKeyService(new ApiKeyRepository(h.db), h.db);

    expect(dbRow(k.id).last_used_at).toBeNull();
    const principal = await svc.authenticate(k.key!);
    expect(principal).toMatchObject({ key_id: k.id, organization_id: a.orgId, scopes: ["offers.read"], status: "ACTIVE", expires_at: null });
    expect(principal?.created_by_user_id).toEqual(expect.any(String));
    expect(principal?.key_prefix).toBe(k.key_prefix);
    expect(dbRow(k.id).last_used_at).not.toBeNull();
    const seen = (await json<{ api_key: ApiKey }>(await h.as(a.owner, "GET", K(a.orgId, `/${k.id}`)))).api_key;
    expect(seen.last_used_at).toBe(dbRow(k.id).last_used_at);

    const [prefix, secret] = k.key!.split(".") as [string, string];
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    expect(await svc.authenticate(`${prefix}.${flipped}`)).toBeNull(); // same prefix, wrong secret
    expect(await svc.authenticate(`tvh_k_zzzzzzzzzz.${secret}`)).toBeNull(); // wrong prefix (hash covers the whole key)
    expect(await svc.authenticate(secret)).toBeNull(); // bare secret
    expect(await svc.authenticate(prefix)).toBeNull(); // bare prefix
    expect(await svc.authenticate("")).toBeNull();
    expect(await svc.authenticate(null)).toBeNull();
    expect(await svc.authenticate(undefined)).toBeNull();
    expect(await svc.authenticate("Bearer " + k.key!)).toBeNull();
    expect(await svc.authenticate(k.key! + "x")).toBeNull();
  });
});

describe("api keys HTTP — tenant isolation and RBAC (§94, §116)", () => {
  it("org B cannot see, rotate or revoke org A's key (404 everywhere, no oracle); A's listing never includes B's keys", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const b = await advertiser("b@adv.example", "Adv B");
    const ka = await createKey(a.owner, a.orgId, { name: "A key" });
    const kb = await createKey(b.owner, b.orgId, { name: "B key" });

    // B through B's own org path, addressing A's key id → 404 (scoped query finds nothing).
    expect((await h.as(b.owner, "GET", K(b.orgId, `/${ka.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "POST", K(b.orgId, `/${ka.id}/rotate`))).status).toBe(404);
    expect((await h.as(b.owner, "POST", K(b.orgId, `/${ka.id}/revoke`))).status).toBe(404);
    // B through A's org path → not a member → 404 ORGANIZATION_NOT_FOUND.
    const viaA = await h.as(b.owner, "GET", K(a.orgId));
    expect(viaA.status).toBe(404);
    expect(await h.errorCode(viaA)).toBe("ORGANIZATION_NOT_FOUND");
    expect((await h.as(b.owner, "POST", K(a.orgId, `/${ka.id}/revoke`))).status).toBe(404);

    const aList = await json<{ items: ApiKey[] }>(await h.as(a.owner, "GET", K(a.orgId)));
    expect(aList.items.map((k) => k.id)).toEqual([ka.id]);
    const bList = await json<{ items: ApiKey[] }>(await h.as(b.owner, "GET", K(b.orgId)));
    expect(bList.items.map((k) => k.id)).toEqual([kb.id]);

    // Nothing changed on A's key.
    expect(dbRow(ka.id).status).toBe("ACTIVE");
  });

  it("api_keys.read vs api_keys.manage: CAMPAIGN_MANAGER reads but cannot create/rotate/revoke; VIEWER cannot even read; unauthenticated → 401", async () => {
    const a = await advertiser("a@adv.example", "Adv A");
    const k = await createKey(a.owner, a.orgId);
    const cm = await member(a.owner, a.orgId, "cm@adv.example", "CAMPAIGN_MANAGER");
    const viewer = await member(a.owner, a.orgId, "v@adv.example", "VIEWER");

    expect((await h.as(cm, "GET", K(a.orgId))).status).toBe(200);
    expect((await h.as(cm, "GET", K(a.orgId, `/${k.id}`))).status).toBe(200);
    for (const [m, p] of [
      ["POST", K(a.orgId)],
      ["POST", K(a.orgId, `/${k.id}/rotate`)],
      ["POST", K(a.orgId, `/${k.id}/revoke`)],
    ] as const) {
      const res = await h.as(cm, m, p, m === "POST" && p === K(a.orgId) ? { name: "x" } : undefined);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }

    const vRead = await h.as(viewer, "GET", K(a.orgId));
    expect(vRead.status).toBe(403);
    expect((await h.as(viewer, "GET", K(a.orgId, `/${k.id}`))).status).toBe(403);
    expect((await h.as(viewer, "POST", K(a.orgId), { name: "x" })).status).toBe(403);

    expect((await h.api("GET", K(a.orgId))).status).toBe(401);
    expect((await h.api("POST", K(a.orgId), {}, { name: "x" })).status).toBe(401);

    // The key is still ACTIVE: none of the refused calls wrote anything.
    expect(dbRow(k.id).status).toBe("ACTIVE");
    expect((h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n).toBe(1);
  });
});
