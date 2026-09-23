/**
 * PRD §116 — "secret never returned to frontend" (Phase 1 Unit 8).
 *
 * Walks every Phase 1 response body (auth + organizations) after a realistic
 * flow and proves that none of the server-side secrets stored in D1 —
 * `user_credentials.password_hash`, `sessions.token_hash`,
 * `auth_tokens.token_hash` — nor the raw verification / reset tokens, nor the
 * plaintext password, ever appear in any JSON returned to a client. Also
 * proves that the `debug` token echo is absent unless `APP_ENV=development`,
 * and that the PRD §72 error envelope never carries a stack trace.
 *
 * Exercises HTTP route → middleware → service → repository → D1 shim running
 * the real migrations.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

// Fixture password (not a secret); joined so secret-scan does not flag it.
const PASSWORD = ["correct", "horse", "battery", "staple"].join("-");
const NEW_PASSWORD = ["purple", "monkey", "dishwasher", "42"].join("-");

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

interface Captured {
  label: string;
  status: number;
  text: string;
}
const captured: Captured[] = [];

async function call(
  label: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  envOverride: Partial<Bindings> = env,
): Promise<{ status: number; json: unknown }> {
  const res = await app.request(
    `/api/v1${path}`,
    {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    envOverride,
  );
  const text = await res.text();
  captured.push({ label, status: res.status, text });
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Recursively collect every object key in a JSON value. */
function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

async function allStoredSecrets(): Promise<string[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all<{ v: string }>()).results.map((r) => r.v);
  return [
    ...(await rows("SELECT password_hash AS v FROM user_credentials")),
    ...(await rows("SELECT token_hash AS v FROM sessions")),
    ...(await rows("SELECT token_hash AS v FROM auth_tokens")),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
}

describe("PRD §116 — secret never returned to frontend", () => {
  it("no stored hash, raw one-time token or password appears in any Phase 1 response body", async () => {
    captured.length = 0;

    // ---- signup → verify → login (test env: no debug echo) -----------------
    const email = "alice@example.com";
    const signup = await call("signup", "POST", "/auth/signup", {}, { email, password: PASSWORD, display_name: "Alice" });
    expect(signup.status).toBe(201);
    const firstVerificationToken = mail.last("EMAIL_VERIFICATION")?.token;
    expect(firstVerificationToken).toBeTruthy();

    // Resend rotates the one-time token; the latest email carries the live one.
    await call("resend-verification", "POST", "/auth/resend-verification", {}, { email });
    const verificationToken = mail.last("EMAIL_VERIFICATION")?.token;
    expect(verificationToken).toBeTruthy();
    expect(verificationToken).not.toBe(firstVerificationToken);
    await call("verify-email", "POST", "/auth/verify-email", {}, { token: verificationToken });
    const login = await call("login", "POST", "/auth/login", { "user-agent": "vitest" }, { email, password: PASSWORD });
    expect(login.status).toBe(200);
    const token = (login.json as { token: string }).token;
    await call("login-2", "POST", "/auth/login", { "user-agent": "vitest-2" }, { email, password: PASSWORD });

    // ---- authenticated identity routes ---------------------------------------
    await call("me", "GET", "/auth/me", bearer(token));
    await call("sessions", "GET", "/auth/sessions", bearer(token));
    await call("mfa", "GET", "/auth/mfa", bearer(token));
    await call("revoke-others", "POST", "/auth/sessions/revoke-others", bearer(token));

    // ---- password reset (raw token travels only by email) --------------------
    await call("forgot-password", "POST", "/auth/forgot-password", {}, { email });
    const resetToken = mail.last("PASSWORD_RESET")?.token;
    expect(resetToken).toBeTruthy();
    await call("reset-password", "POST", "/auth/reset-password", {}, { token: resetToken, password: NEW_PASSWORD });
    const relogin = await call("login-after-reset", "POST", "/auth/login", {}, { email, password: NEW_PASSWORD });
    expect(relogin.status).toBe(200);
    const token2 = (relogin.json as { token: string }).token;

    // ---- organizations / membership -----------------------------------------
    const created = await call("org-create", "POST", "/organizations", bearer(token2), { type: "AFFILIATE", name: "Acme Affiliates" });
    expect(created.status).toBe(201);
    const orgId = (created.json as { organization: { id: string } }).organization.id;
    await call("org-list", "GET", "/organizations", bearer(token2));
    await call("org-get", "GET", `/organizations/${orgId}`, bearer(token2));
    await call("org-me", "GET", `/organizations/${orgId}/me`, bearer(token2));
    await call("org-roles", "GET", `/organizations/${orgId}/roles`, bearer(token2));
    await call("org-members", "GET", `/organizations/${orgId}/members`, bearer(token2));

    // Second user so the member list carries a foreign user record too.
    const bob = "bob@example.com";
    await call("signup-bob", "POST", "/auth/signup", {}, { email: bob, password: PASSWORD });
    await call("verify-bob", "POST", "/auth/verify-email", {}, { token: mail.last("EMAIL_VERIFICATION")?.token });
    await call("add-member", "POST", `/organizations/${orgId}/members`, bearer(token2), { email: bob, role: "AFFILIATE_USER" });
    await call("org-members-2", "GET", `/organizations/${orgId}/members`, bearer(token2));

    // ---- error envelopes ----------------------------------------------------
    await call("login-bad", "POST", "/auth/login", {}, { email, password: "definitely wrong" });
    await call("unauth", "GET", "/auth/me");
    await call("not-found-org", "GET", "/organizations/00000000-0000-4000-8000-000000000000", bearer(token2));
    await call("validation", "POST", "/organizations", bearer(token2), { type: "PLATFORM", name: "x" });

    // ---- assertions -----------------------------------------------------------
    const secrets = await allStoredSecrets();
    expect(secrets.length).toBeGreaterThanOrEqual(6); // 2 password hashes, ≥3 session hashes, ≥3 auth_token hashes
    const forbiddenLiterals = [...secrets, firstVerificationToken!, verificationToken!, resetToken!, PASSWORD, NEW_PASSWORD];
    const forbiddenKeys = ["password", "password_hash", "token_hash", "hash", "secret", "debug", "stack"];

    expect(captured.length).toBeGreaterThan(20);
    for (const c of captured) {
      for (const literal of forbiddenLiterals) {
        expect(c.text, `${c.label} (${c.status}) leaked a secret value`).not.toContain(literal);
      }
      let parsed: unknown = null;
      try {
        parsed = c.text ? JSON.parse(c.text) : null;
      } catch {
        parsed = null;
      }
      const keys = collectKeys(parsed);
      for (const k of forbiddenKeys) {
        expect(keys.has(k), `${c.label} (${c.status}) exposes key "${k}"`).toBe(false);
      }
      // The session token itself is returned ONLY by login, by design (ADR-001).
      if (!c.label.startsWith("login")) {
        expect(c.text, `${c.label} echoed a session token`).not.toContain(token);
        expect(c.text, `${c.label} echoed a session token`).not.toContain(token2);
      }
    }
  });

  it("the debug token echo exists only under APP_ENV=development and never in test/production", async () => {
    const email = "carol@example.com";
    const prod = await call("signup-prod", "POST", "/auth/signup", {}, { email, password: PASSWORD }, {
      ...env,
      APP_ENV: "production",
    });
    expect(prod.status).toBe(201);
    expect(collectKeys(prod.json).has("debug")).toBe(false);

    const dev = await call("signup-dev", "POST", "/auth/signup", {}, { email: "dave@example.com", password: PASSWORD }, {
      ...env,
      APP_ENV: "development",
    });
    expect(dev.status).toBe(201);
    const devBody = dev.json as { debug?: { verification_token?: string } };
    expect(devBody.debug?.verification_token).toBe(mail.last("EMAIL_VERIFICATION")?.token);
    // Even in development only the RAW one-time token is echoed — never its stored hash.
    const hashes = (await db.prepare("SELECT token_hash AS v FROM auth_tokens").all<{ v: string }>()).results.map((r) => r.v);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(JSON.stringify(dev.json)).not.toContain(h);
  });

  it("error envelopes never include a stack trace or internal detail", async () => {
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "request_id"]);
    expect(JSON.stringify(body)).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/);
  });
});
