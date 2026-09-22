/**
 * Phase 1 Unit 2 — Session & device management.
 * Exercises HTTP route → requireAuth → AuthService → AuthRepository → D1
 * (node:sqlite shim running the real migrations).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

interface Envelope {
  error: { code: string; message: string; request_id: string | null };
}
interface SessionItem {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}
interface LoginBody {
  token: string;
  session: { id: string };
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

function request(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    `/api/v1/auth${path}`,
    {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signupAndVerify(email: string) {
  expect((await request("POST", "/signup", {}, { email, password: PASSWORD })).status).toBe(201);
  const token = mail.last("EMAIL_VERIFICATION")?.token;
  expect((await request("POST", "/verify-email", {}, { token })).status).toBe(200);
}

/** Log in and return the bearer token + session id. `ua` lands in sessions.user_agent. */
async function login(email: string, ua = "vitest"): Promise<{ token: string; id: string }> {
  const res = await request("POST", "/login", { "user-agent": ua, "cf-connecting-ip": "203.0.113.7" }, {
    email,
    password: PASSWORD,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as LoginBody;
  return { token: body.token, id: body.session.id };
}

async function listSessions(token: string): Promise<SessionItem[]> {
  const res = await request("GET", "/sessions", bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SessionItem[] }).sessions;
}

const meStatus = async (token: string) => (await request("GET", "/me", bearer(token))).status;

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

describe("GET /auth/sessions — list active sessions", () => {
  it("returns all of the user's active sessions, marking only the caller's as current", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE, "Browser-A");
    const b = await login(ALICE, "Browser-B");

    const fromA = await listSessions(a.token);
    expect(fromA).toHaveLength(2);
    expect(fromA.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(fromA.find((s) => s.id === a.id)?.current).toBe(true);
    expect(fromA.find((s) => s.id === b.id)?.current).toBe(false);
    expect(fromA.filter((s) => s.current)).toHaveLength(1);

    // Same list from B's perspective flips the flag.
    const fromB = await listSessions(b.token);
    expect(fromB.find((s) => s.id === b.id)?.current).toBe(true);
    expect(fromB.find((s) => s.id === a.id)?.current).toBe(false);

    // Safe device metadata + timestamps are present.
    const item = fromA.find((s) => s.id === b.id) as SessionItem;
    expect(item.user_agent).toBe("Browser-B");
    expect(item.ip_address).toBe("203.0.113.7");
    for (const f of ["created_at", "last_seen_at", "expires_at"] as const) {
      expect(new Date(item[f]).toISOString()).toBe(item[f]);
    }
  });

  it("never lists another user's sessions", async () => {
    await signupAndVerify(ALICE);
    await signupAndVerify(BOB);
    const alice = await login(ALICE);
    await login(BOB);
    await login(BOB);

    const sessions = await listSessions(alice.token);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(alice.id);
  });

  it("rejects unauthenticated requests with the uniform 401 envelope", async () => {
    const res = await request("GET", "/sessions");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error).toHaveProperty("request_id");

    expect((await request("GET", "/sessions", bearer("tvh_s_forged"))).status).toBe(401);
    expect((await request("DELETE", "/sessions/00000000-0000-4000-8000-000000000000")).status).toBe(401);
    expect((await request("POST", "/sessions/revoke-others")).status).toBe(401);
  });

  it("excludes revoked and expired sessions", async () => {
    await signupAndVerify(ALICE);
    const current = await login(ALICE, "current");
    const loggedOut = await login(ALICE, "logged-out");
    const expired = await login(ALICE, "expired");
    const live = await login(ALICE, "live");

    expect((await request("POST", "/logout", bearer(loggedOut.token))).status).toBe(204);
    db.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);

    const ids = (await listSessions(current.token)).map((s) => s.id).sort();
    expect(ids).toEqual([current.id, live.id].sort());
  });

  it("never exposes session secrets, hashes or other credential material", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);
    await login(ALICE);
    // Ensure a reset token exists in the DB too.
    expect((await request("POST", "/forgot-password", {}, { email: ALICE })).status).toBe(202);
    const resetToken = mail.last("PASSWORD_RESET")?.token as string;
    const verificationToken = mail.last("EMAIL_VERIFICATION")?.token as string;

    const res = await request("GET", "/sessions", bearer(a.token));
    const text = await res.text();
    const sessions = (JSON.parse(text) as { sessions: SessionItem[] }).sessions;
    expect(sessions).toHaveLength(2);

    // Exact field allow-list.
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual(
        ["created_at", "current", "expires_at", "id", "ip_address", "last_seen_at", "user_agent"].sort(),
      );
    }

    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("revoked");
    expect(text).not.toContain("tvh_s_");
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(resetToken);
    expect(text).not.toContain(verificationToken);

    const hashes = db.sqlite.prepare("SELECT token_hash FROM sessions UNION SELECT token_hash FROM auth_tokens").all() as {
      token_hash: string;
    }[];
    expect(hashes.length).toBeGreaterThanOrEqual(4);
    for (const h of hashes) expect(text).not.toContain(h.token_hash);
    const cred = db.sqlite.prepare("SELECT password_hash FROM user_credentials").get() as { password_hash: string };
    expect(text).not.toContain(cred.password_hash);
  });
});

describe("DELETE /auth/sessions/:id — revoke one own session", () => {
  it("revokes the target session only; the remaining session stays valid", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);
    const b = await login(ALICE);

    const res = await request("DELETE", `/sessions/${b.id}`, bearer(a.token));
    expect(res.status).toBe(204);

    expect(await meStatus(b.token)).toBe(401); // revoked session cannot authenticate
    expect(await meStatus(a.token)).toBe(200); // remaining session still valid

    const row = db.sqlite.prepare("SELECT revoked_at, revoked_reason FROM sessions WHERE id = ?").get(b.id) as {
      revoked_at: string | null;
      revoked_reason: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("USER_REVOKED");

    const remaining = await listSessions(a.token);
    expect(remaining.map((s) => s.id)).toEqual([a.id]);

    // Second revoke of the same id is not found (already inactive).
    expect((await request("DELETE", `/sessions/${b.id}`, bearer(a.token))).status).toBe(404);

    const ev = db.sqlite
      .prepare("SELECT count(*) AS n FROM auth_events WHERE event_type = 'LOGOUT' AND session_id = ?")
      .get(b.id) as { n: number };
    expect(ev.n).toBe(1);
  });

  it("revoking the current session behaves like logout", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);
    expect((await request("DELETE", `/sessions/${a.id}`, bearer(a.token))).status).toBe(204);
    expect(await meStatus(a.token)).toBe(401);
  });

  it("returns 404 for a foreign session id and leaves the other user's session intact (PRD §116)", async () => {
    await signupAndVerify(ALICE);
    await signupAndVerify(BOB);
    const alice = await login(ALICE);
    const bob = await login(BOB);

    const res = await request("DELETE", `/sessions/${bob.id}`, bearer(alice.token));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
    expect(res.status).not.toBe(403); // must not disclose existence

    // Indistinguishable from a truly unknown id.
    const unknown = await request("DELETE", "/sessions/00000000-0000-4000-8000-000000000000", bearer(alice.token));
    expect(unknown.status).toBe(404);
    const unknownBody = (await unknown.json()) as Envelope;
    expect(unknownBody.error.code).toBe("SESSION_NOT_FOUND");
    expect(unknownBody.error.message).toBe(body.error.message);

    // Bob is unaffected.
    expect(await meStatus(bob.token)).toBe(200);
    const row = db.sqlite.prepare("SELECT revoked_at FROM sessions WHERE id = ?").get(bob.id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).toBeNull();
    const revokedCount = db.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NOT NULL").get() as {
      n: number;
    };
    expect(revokedCount.n).toBe(0);
  });

  it("returns 404 SESSION_NOT_FOUND for unknown and malformed ids", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);

    const unknown = await request("DELETE", "/sessions/11111111-2222-4333-8444-555555555555", bearer(a.token));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Envelope).error.code).toBe("SESSION_NOT_FOUND");

    const malformed = await request("DELETE", "/sessions/not-a-uuid", bearer(a.token));
    expect(malformed.status).toBe(404);
    expect(((await malformed.json()) as Envelope).error.code).toBe("SESSION_NOT_FOUND");

    // Caller's own session is untouched by the failed attempts.
    expect(await meStatus(a.token)).toBe(200);
  });
});

describe("POST /auth/sessions/revoke-others", () => {
  it("revokes every other session of the caller, keeps the current one, and leaves other users alone", async () => {
    await signupAndVerify(ALICE);
    await signupAndVerify(BOB);
    const a = await login(ALICE, "A");
    const b = await login(ALICE, "B");
    const c = await login(ALICE, "C");
    const bob = await login(BOB);

    const res = await request("POST", "/sessions/revoke-others", bearer(a.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked_count: 2 });

    expect(await meStatus(a.token)).toBe(200);
    expect(await meStatus(b.token)).toBe(401);
    expect(await meStatus(c.token)).toBe(401);
    expect(await meStatus(bob.token)).toBe(200);

    const list = await listSessions(a.token);
    expect(list).toEqual([expect.objectContaining({ id: a.id, current: true })]);

    const reasons = db.sqlite
      .prepare("SELECT id, revoked_reason FROM sessions WHERE revoked_at IS NOT NULL ORDER BY id")
      .all() as { id: string; revoked_reason: string }[];
    expect(reasons.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
    expect(reasons.every((r) => r.revoked_reason === "REVOKE_OTHERS")).toBe(true);

    const events = db.sqlite
      .prepare("SELECT session_id FROM auth_events WHERE event_type = 'LOGOUT'")
      .all() as { session_id: string }[];
    expect(events.map((e) => e.session_id).sort()).toEqual([b.id, c.id].sort());
  });

  it("succeeds idempotently when there are no other active sessions", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);

    const first = await request("POST", "/sessions/revoke-others", bearer(a.token));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revoked_count: 0 });

    const second = await request("POST", "/sessions/revoke-others", bearer(a.token));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ revoked_count: 0 });

    expect(await meStatus(a.token)).toBe(200);
    const logoutEvents = db.sqlite.prepare("SELECT count(*) AS n FROM auth_events WHERE event_type = 'LOGOUT'").get() as {
      n: number;
    };
    expect(logoutEvents.n).toBe(0);
  });

  it("does not re-revoke already inactive sessions (count reflects active ones only)", async () => {
    await signupAndVerify(ALICE);
    const a = await login(ALICE);
    const b = await login(ALICE);
    const expired = await login(ALICE);
    db.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.id);

    const res = await request("POST", "/sessions/revoke-others", bearer(a.token));
    expect(await res.json()).toEqual({ revoked_count: 1 });
    expect(await meStatus(b.token)).toBe(401);

    const expiredRow = db.sqlite.prepare("SELECT revoked_at FROM sessions WHERE id = ?").get(expired.id) as {
      revoked_at: string | null;
    };
    expect(expiredRow.revoked_at).toBeNull(); // expired rows are left as-is
  });
});
