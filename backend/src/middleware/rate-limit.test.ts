/**
 * Phase 6 Unit 2 — PRD §71 / §128 tiered rate limiting.
 *
 * Pure tests on the limiter + classifier, then HTTP tests through
 * `createApp` proving: 429 `RATE_LIMITED` envelope with `Retry-After`,
 * per-IP isolation, per-credential isolation for the api tier, window
 * reset, the tracking tier staying independent of the login tier, and
 * `enabled:false` disabling everything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { errorResponse } from "../lib/errors";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";
import { classifyTier, createRateLimiter, DEFAULT_TIERS, MemoryRateLimitStore } from "./rate-limit";

describe("classifyTier (PRD §71 tier table)", () => {
  it("maps every endpoint family to exactly one tier", () => {
    expect(classifyTier("/api/v1/auth/login")).toBe("login");
    expect(classifyTier("/api/v1/auth/signup")).toBe("login");
    expect(classifyTier("/api/v1/auth/forgot-password")).toBe("login");
    expect(classifyTier("/api/v1/auth/me")).toBe("public");
    expect(classifyTier("/api/v1/health")).toBe("public");
    expect(classifyTier("/t/abc")).toBe("tracking");
    expect(classifyTier("/s/abc")).toBe("tracking");
    expect(classifyTier("/postback/v1/conversions")).toBe("postback");
    expect(classifyTier("/api/v1/organizations/o1/platform/payouts")).toBe("admin");
    expect(classifyTier("/api/v1/organizations/o1/webhooks")).toBe("webhook");
    expect(classifyTier("/api/v1/organizations/o1/webhooks/w1/deliveries")).toBe("webhook");
    expect(classifyTier("/api/v1/organizations/o1/offers")).toBe("api");
    expect(classifyTier("/api/v1/organizations")).toBe("api");
    expect(classifyTier("/anything-else")).toBe("public");
  });

  it("every tier has a positive limit and window", () => {
    for (const cfg of Object.values(DEFAULT_TIERS)) {
      expect(cfg.limit).toBeGreaterThan(0);
      expect(cfg.windowSeconds).toBeGreaterThan(0);
    }
    expect(DEFAULT_TIERS.tracking.limit).toBeGreaterThan(DEFAULT_TIERS.login.limit); // lightweight hot path
  });
});

describe("createRateLimiter (pure)", () => {
  function miniApp(opts: Parameters<typeof createRateLimiter>[0]) {
    const limiter = createRateLimiter(opts);
    const app = new Hono();
    app.onError((e, c) => errorResponse(e, c));
    app.use("/login", limiter.tier("login"));
    app.use("/api/*", limiter.tier("api"));
    app.get("/login", (c) => c.text("ok"));
    app.get("/api/x", (c) => c.text("ok"));
    return app;
  }

  it("allows `limit` requests then returns 429 RATE_LIMITED with Retry-After and a request_id", async () => {
    let t = 1_000_000;
    const app = miniApp({ tiers: { login: { limit: 2, windowSeconds: 60 } }, now: () => t });
    const h = { "cf-connecting-ip": "1.1.1.1" };
    expect((await app.request("/login", { headers: h })).status).toBe(200);
    const second = await app.request("/login", { headers: h });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("0");
    const third = await app.request("/login", { headers: h });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await third.json()) as { error: { code: string; request_id: string | null } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(JSON.stringify(body)).not.toMatch(/stack|at /);
    // window reset
    t += 61_000;
    expect((await app.request("/login", { headers: h })).status).toBe(200);
  });

  it("isolates by client IP for ip-keyed tiers", async () => {
    const app = miniApp({ tiers: { login: { limit: 1 } } });
    expect((await app.request("/login", { headers: { "cf-connecting-ip": "1.1.1.1" } })).status).toBe(200);
    expect((await app.request("/login", { headers: { "cf-connecting-ip": "1.1.1.1" } })).status).toBe(429);
    expect((await app.request("/login", { headers: { "cf-connecting-ip": "2.2.2.2" } })).status).toBe(200);
  });

  it("isolates by bearer credential for credential-keyed tiers and never stores the raw token", async () => {
    const store = new MemoryRateLimitStore();
    const app = miniApp({ store, tiers: { api: { limit: 1 } } });
    const a = { authorization: "Bearer tvh_k_AAAA_secret_a" };
    const b = { authorization: "Bearer tvh_k_BBBB_secret_b" };
    expect((await app.request("/api/x", { headers: a })).status).toBe(200);
    expect((await app.request("/api/x", { headers: a })).status).toBe(429);
    expect((await app.request("/api/x", { headers: b })).status).toBe(200);
    // raw token must not appear in any bucket key
    const keys = Array.from((store as unknown as { buckets: Map<string, unknown> }).buckets.keys());
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).not.toContain("secret_");
  });

  it("enabled:false bypasses every tier", async () => {
    const app = miniApp({ enabled: false, tiers: { login: { limit: 1 } } });
    for (let i = 0; i < 5; i++) expect((await app.request("/login")).status).toBe(200);
  });
});

describe("rate limiting through createApp (HTTP)", () => {
  let db: TestD1;
  let env: Partial<Bindings>;
  beforeEach(() => {
    db = createTestD1();
    env = { DB: db, APP_ENV: "test", API_VERSION: "v1" };
  });
  afterEach(() => db.close());

  it("login tier: 429 after the limit, tracking tier unaffected (independent counters)", async () => {
    const app = createApp({
      emailSender: new MemoryEmailSender(),
      rateLimit: { tiers: { login: { limit: 2 }, tracking: { limit: 2 } } },
    });
    const ip = { "cf-connecting-ip": "9.9.9.9", "content-type": "application/json" };
    const login = () =>
      app.request("/api/v1/auth/login", { method: "POST", headers: ip, body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-value-1" }) }, env); // secret-scan:allow — deliberately wrong fixture password for a non-existent user
    // Unknown user → 401 (or 400 if validation differs); either way NOT 429 yet.
    expect((await login()).status).not.toBe(429);
    expect((await login()).status).not.toBe(429);
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // tracking tier for the same IP still has its own budget (2) — the
    // redirect returns 404 for an unknown code rather than 429.
    expect((await app.request("/t/unknown", { headers: ip }, env)).status).not.toBe(429);
    expect((await app.request("/t/unknown", { headers: ip }, env)).status).not.toBe(429);
    expect((await app.request("/t/unknown", { headers: ip }, env)).status).toBe(429);
  });

  it("api tier counts per bearer credential, not per IP", async () => {
    const app = createApp({ emailSender: new MemoryEmailSender(), rateLimit: { tiers: { api: { limit: 1 } } } });
    const ip = "7.7.7.7";
    const hit = (token: string) =>
      app.request("/api/v1/organizations", { headers: { "cf-connecting-ip": ip, authorization: `Bearer ${token}` } }, env);
    expect((await hit("tvh_s_one")).status).toBe(401); // invalid session but counted
    expect((await hit("tvh_s_one")).status).toBe(429);
    expect((await hit("tvh_s_two")).status).toBe(401); // different credential → own budget
  });
});
