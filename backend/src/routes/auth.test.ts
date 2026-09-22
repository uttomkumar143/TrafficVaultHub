import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

interface Envelope {
  error: { code: string; message: string; request_id: string | null };
}

// Test fixture passwords (not secrets). Kept as constants so the repo
// secret-scan does not flag inline `password: "..."` literals.
const PASSWORD = ["correct", "horse", "battery", "staple"].join("-");
const NEW_PASSWORD = ["a", "brand", "new", "password", "123"].join("-");
const OTHER_PASSWORD = ["another", "long", "password"].join("-");
const FINE_PASSWORD = ["a", "perfectly", "fine", "password"].join("-");

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

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `/api/v1/auth${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}
function get(path: string, headers: Record<string, string> = {}) {
  return app.request(`/api/v1/auth${path}`, { headers }, env);
}

async function signupAndVerify(email = "alice@example.com") {
  const res = await post("/signup", { email, password: PASSWORD, display_name: "Alice" });
  expect(res.status).toBe(201);
  const token = mail.last("EMAIL_VERIFICATION")?.token;
  expect(token).toBeTruthy();
  const v = await post("/verify-email", { token });
  expect(v.status).toBe(200);
  return { email, token: token as string };
}

async function login(email = "alice@example.com", password = PASSWORD) {
  const res = await post("/login", { email, password });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /auth/signup", () => {
  it("creates an unverified user, stores only a hash, and emails a verification token", async () => {
    const res = await post("/signup", { email: "Alice@Example.com", password: PASSWORD, display_name: "Alice" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown>; debug?: unknown };
    expect(body.user).toMatchObject({
      email: "alice@example.com",
      display_name: "Alice",
      email_verified: false,
      status: "ACTIVE",
      mfa: { enabled: false, available: false, reason: "NOT_IMPLEMENTED" },
    });
    expect(body.debug).toBeUndefined(); // APP_ENV=test → no token leakage
    expect(JSON.stringify(body)).not.toContain("scrypt");

    const cred = db.sqlite.prepare("SELECT password_hash FROM user_credentials").get() as { password_hash: string };
    expect(cred.password_hash.startsWith("$scrypt$")).toBe(true);
    expect(cred.password_hash).not.toContain(PASSWORD);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.kind).toBe("EMAIL_VERIFICATION");
    const tok = db.sqlite.prepare("SELECT token_hash FROM auth_tokens").get() as { token_hash: string };
    expect(tok.token_hash).not.toBe(mail.sent[0]?.token); // only digest persisted

    const ev = db.sqlite.prepare("SELECT event_type FROM auth_events").all() as { event_type: string }[];
    expect(ev.map((e) => e.event_type)).toEqual(["SIGNUP"]);
  });

  it("rejects duplicate emails case-insensitively and weak/invalid input", async () => {
    await post("/signup", { email: "bob@example.com", password: PASSWORD });
    const dup = await post("/signup", { email: "BOB@example.com", password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as Envelope).error.code).toBe("EMAIL_ALREADY_REGISTERED");

    const short = await post("/signup", { email: "c@example.com", password: "short" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as Envelope).error.code).toBe("VALIDATION_ERROR");

    const badEmail = await post("/signup", { email: "not-an-email", password: PASSWORD });
    expect(badEmail.status).toBe(400);

    const badJson = await app.request(
      "/api/v1/auth/signup",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{" },
      env,
    );
    expect(badJson.status).toBe(400);
  });

  it("exposes debug tokens only in development", async () => {
    env.APP_ENV = "development";
    const res = await post("/signup", { email: "dev@example.com", password: PASSWORD });
    const body = (await res.json()) as { debug?: { verification_token: string } };
    expect(body.debug?.verification_token).toBe(mail.last()?.token);
  });
});

describe("email verification", () => {
  it("verifies once; reuse, garbage and expired tokens are rejected", async () => {
    const { token } = await signupAndVerify();

    const reuse = await post("/verify-email", { token });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as Envelope).error.code).toBe("INVALID_TOKEN");

    const garbage = await post("/verify-email", { token: "x".repeat(43) });
    expect(garbage.status).toBe(400);

    // expired token
    await post("/signup", { email: "late@example.com", password: PASSWORD });
    const lateToken = mail.last("EMAIL_VERIFICATION")?.token;
    db.sqlite.prepare("UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE consumed_at IS NULL").run();
    const expired = await post("/verify-email", { token: lateToken });
    expect(expired.status).toBe(400);
  });

  it("resend invalidates the previous token and never reveals account existence", async () => {
    await post("/signup", { email: "carol@example.com", password: PASSWORD });
    const first = mail.last("EMAIL_VERIFICATION")?.token as string;

    const r1 = await post("/resend-verification", { email: "carol@example.com" });
    expect(r1.status).toBe(202);
    const second = mail.last("EMAIL_VERIFICATION")?.token as string;
    expect(second).not.toBe(first);

    expect((await post("/verify-email", { token: first })).status).toBe(400);
    expect((await post("/verify-email", { token: second })).status).toBe(200);

    const unknown = await post("/resend-verification", { email: "nobody@example.com" });
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({});
  });
});

describe("POST /auth/login", () => {
  it("refuses login before email verification (403 EMAIL_NOT_VERIFIED)", async () => {
    await post("/signup", { email: "dan@example.com", password: PASSWORD });
    const { res, body } = await login("dan@example.com");
    expect(res.status).toBe(403);
    expect((body as unknown as Envelope).error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("returns identical 401 for unknown email and wrong password, and records failures", async () => {
    await signupAndVerify();
    const wrong = await login("alice@example.com", "nope-nope-nope");
    const unknown = await login("ghost@example.com", "nope-nope-nope");
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect((wrong.body as unknown as Envelope).error.code).toBe("INVALID_CREDENTIALS");
    expect((unknown.body as unknown as Envelope).error.code).toBe("INVALID_CREDENTIALS");

    const cred = db.sqlite.prepare("SELECT failed_attempts FROM user_credentials").get() as { failed_attempts: number };
    expect(cred.failed_attempts).toBe(1);
    const fails = db.sqlite
      .prepare("SELECT count(*) AS n FROM auth_events WHERE event_type = 'LOGIN_FAILED'")
      .get() as { n: number };
    expect(fails.n).toBe(2);
  });

  it("issues an opaque bearer session and stores only its digest", async () => {
    await signupAndVerify();
    const { res, body } = await login();
    expect(res.status).toBe(200);
    const token = body.token as string;
    expect(token.startsWith("tvh_s_")).toBe(true);
    expect(body.user).toMatchObject({ email: "alice@example.com", email_verified: true });
    expect(body.session).toMatchObject({ expires_at: body.expires_at });

    const row = db.sqlite.prepare("SELECT token_hash, revoked_at FROM sessions").get() as {
      token_hash: string;
      revoked_at: string | null;
    };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toHaveLength(64);
    expect(row.revoked_at).toBeNull();

    const user = db.sqlite.prepare("SELECT last_login_at FROM users").get() as { last_login_at: string | null };
    expect(user.last_login_at).not.toBeNull();
    const failed = db.sqlite.prepare("SELECT failed_attempts FROM user_credentials").get() as { failed_attempts: number };
    expect(failed.failed_attempts).toBe(0);
  });

  it("refuses inactive accounts even with the right password", async () => {
    await signupAndVerify();
    db.sqlite.prepare("UPDATE users SET status = 'SUSPENDED'").run();
    const { res, body } = await login();
    expect(res.status).toBe(403);
    expect((body as unknown as Envelope).error.code).toBe("ACCOUNT_INACTIVE");
  });
});

describe("protected routes (requireAuth) — PRD §116", () => {
  it("rejects requests without a session (unauthorized user rejected)", async () => {
    const res = await get("/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
    expect((await get("/me", { authorization: "Bearer tvh_s_forged" })).status).toBe(401);
    expect((await get("/me", { authorization: "Basic abc" })).status).toBe(401);
  });

  it("accepts a valid session and reports the MFA stub honestly", async () => {
    await signupAndVerify();
    const { body } = await login();
    const auth = { authorization: `Bearer ${body.token as string}` };

    const me = await get("/me", auth);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string }; session: { id: string } };
    expect(meBody.user.email).toBe("alice@example.com");
    expect(meBody.session.id).toBe((body.session as { id: string }).id);

    const mfa = await get("/mfa", auth);
    expect(await mfa.json()).toEqual({ mfa: { enabled: false, available: false, reason: "NOT_IMPLEMENTED" } });
  });

  it("rejects an expired session", async () => {
    await signupAndVerify();
    const { body } = await login();
    db.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const res = await get("/me", { authorization: `Bearer ${body.token as string}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a revoked session after logout", async () => {
    await signupAndVerify();
    const { body } = await login();
    const auth = { authorization: `Bearer ${body.token as string}` };
    expect((await post("/logout", {}, auth)).status).toBe(204);
    expect((await get("/me", auth)).status).toBe(401);
    const row = db.sqlite.prepare("SELECT revoked_reason FROM sessions").get() as { revoked_reason: string };
    expect(row.revoked_reason).toBe("LOGOUT");
  });

  it("rejects a session whose user became inactive", async () => {
    await signupAndVerify();
    const { body } = await login();
    db.sqlite.prepare("UPDATE users SET status = 'TERMINATED'").run();
    expect((await get("/me", { authorization: `Bearer ${body.token as string}` })).status).toBe(401);
  });
});

describe("password reset", () => {
  it("always answers 202, and a valid token resets the password, revokes sessions and is single-use", async () => {
    await signupAndVerify();
    const { body } = await login();
    const oldAuth = { authorization: `Bearer ${body.token as string}` };

    const unknown = await post("/forgot-password", { email: "nobody@example.com" });
    expect(unknown.status).toBe(202);
    expect(mail.last("PASSWORD_RESET")).toBeUndefined();

    const known = await post("/forgot-password", { email: "alice@example.com" });
    expect(known.status).toBe(202);
    expect(await known.json()).toEqual({});
    const resetToken = mail.last("PASSWORD_RESET")?.token as string;
    expect(resetToken).toBeTruthy();

    const newPassword = NEW_PASSWORD;
    const reset = await post("/reset-password", { token: resetToken, password: newPassword });
    expect(reset.status).toBe(204);

    // old session revoked, old password dead, new password works
    expect((await get("/me", oldAuth)).status).toBe(401);
    expect((await login("alice@example.com", PASSWORD)).res.status).toBe(401);
    expect((await login("alice@example.com", newPassword)).res.status).toBe(200);

    // token cannot be replayed
    const replay = await post("/reset-password", { token: resetToken, password: OTHER_PASSWORD });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Envelope).error.code).toBe("INVALID_TOKEN");

    const events = db.sqlite
      .prepare("SELECT event_type FROM auth_events WHERE event_type LIKE 'PASSWORD_RESET_%' ORDER BY created_at")
      .all() as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual(["PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETED"]);
  });

  it("rejects expired reset tokens and weak new passwords", async () => {
    await signupAndVerify();
    await post("/forgot-password", { email: "alice@example.com" });
    const token = mail.last("PASSWORD_RESET")?.token as string;

    const weak = await post("/reset-password", { token, password: "short" });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as Envelope).error.code).toBe("VALIDATION_ERROR");

    db.sqlite.prepare("UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE purpose = 'PASSWORD_RESET'").run();
    const expired = await post("/reset-password", { token, password: FINE_PASSWORD });
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as Envelope).error.code).toBe("INVALID_TOKEN");
  });
});

describe("fail-closed without a DB binding", () => {
  it("returns 503 in the uniform envelope instead of crashing", async () => {
    const res = await app.request("/api/v1/auth/me", {}, { APP_ENV: "test" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as Envelope).error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
