/**
 * Phase 6 Unit 1 — PRD §72 `request_id` always present.
 *
 * Proves the id is (a) never null in error envelopes, (b) echoed as
 * `x-request-id` on success / error / 404, (c) taken from `cf-ray` first,
 * (d) accepted from a well-formed inbound `x-request-id` but never from a
 * malformed one, and (e) recorded on auth-event rows so audit rows correlate
 * with the id a client saw.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

describe("request-id middleware (PRD §72)", () => {
  it("generates a UUID and echoes x-request-id on a successful response", async () => {
    const res = await app.request("/api/v1/health", {}, env);
    expect(res.status).toBe(200);
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(UUID);
  });

  it("404 envelope carries a non-null request_id that matches the header", async () => {
    const res = await app.request("/api/v1/nope", {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { request_id: string | null } };
    expect(body.error.request_id).toMatch(UUID);
    expect(res.headers.get("x-request-id")).toBe(body.error.request_id);
  });

  it("error envelope (401) carries a non-null request_id that matches the header", async () => {
    const res = await app.request("/api/v1/organizations", {}, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; request_id: string | null } };
    expect(body.error.request_id).toMatch(UUID);
    expect(res.headers.get("x-request-id")).toBe(body.error.request_id);
  });

  it("prefers cf-ray when present", async () => {
    const res = await app.request("/api/v1/nope", { headers: { "cf-ray": "8abc-SIN", "x-request-id": "client-1" } }, env);
    const body = (await res.json()) as { error: { request_id: string | null } };
    expect(body.error.request_id).toBe("8abc-SIN");
    expect(res.headers.get("x-request-id")).toBe("8abc-SIN");
  });

  it("accepts a well-formed inbound x-request-id and rejects a malformed one", async () => {
    const ok = await app.request("/api/v1/nope", { headers: { "x-request-id": "trace.abc_123-X" } }, env);
    expect(ok.headers.get("x-request-id")).toBe("trace.abc_123-X");

    const bad = await app.request("/api/v1/nope", { headers: { "x-request-id": "evil\u0001 id; drop" } }, env);
    expect(bad.headers.get("x-request-id")).toMatch(UUID);

    const long = await app.request("/api/v1/nope", { headers: { "x-request-id": "a".repeat(129) } }, env);
    expect(long.headers.get("x-request-id")).toMatch(UUID);
  });

  it("records the same request_id on the auth_events row written during the request", async () => {
    const res = await app.request(
      "/api/v1/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "signup-trace-77" },
        body: JSON.stringify({ email: "alice@example.com", password: PASSWORD, display_name: "Alice" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("signup-trace-77");
    const row = db.sqlite.prepare("SELECT request_id FROM auth_events ORDER BY rowid DESC LIMIT 1").get() as
      | { request_id: string | null }
      | undefined;
    expect(row?.request_id).toBe("signup-trace-77");
  });
});
