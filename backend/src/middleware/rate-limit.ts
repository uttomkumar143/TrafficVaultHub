/**
 * Phase 6 Unit 2 — PRD §71 / §128 rate limiting with per-endpoint tiers.
 *
 * Seven tiers (spec): `login`, `api`, `tracking`, `postback`, `webhook`,
 * `admin`, `public`. Each tier is a fixed window (`windowSeconds`) with a
 * `limit`; exceeding it yields 429 `RATE_LIMITED` in the uniform §72 envelope
 * plus `Retry-After` / `X-RateLimit-*` headers.
 *
 * Keying — never on anything a caller can cheaply spoof:
 *   - ip-keyed tiers (`login`, `tracking`, `postback`, `webhook`, `public`):
 *     `cf-connecting-ip` (Cloudflare-set; absent locally → "anon").
 *   - credential-keyed tiers (`api`, `admin`): a SHA-256 prefix of the bearer
 *     token when present (so one leaked key can't exhaust another tenant's
 *     budget), otherwise the IP. The raw token is never stored or logged.
 *
 * Storage is a port (`RateLimitStore`). Default `MemoryRateLimitStore` is
 * per-isolate (good enough for a single Worker instance and for tests);
 * `KvRateLimitStore` is best-effort over the CACHE KV binding (eventually
 * consistent — PRD §128 accepts approximate limits; a KV failure fails OPEN
 * for the tracking tier only, CLOSED (429) elsewhere never, it just counts 1).
 *
 * The `tracking` tier is deliberately lightweight: one `get` + one `put`
 * only when the counter changes bucket, no extra hashing (hot path, §107).
 */
import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "../lib/errors";

export type RateLimitTier = "login" | "api" | "tracking" | "postback" | "webhook" | "admin" | "public";

export interface TierConfig {
  limit: number;
  windowSeconds: number;
  /** `ip` or `credential` (bearer-token hash prefix, falling back to IP). */
  keyBy: "ip" | "credential";
}

/** Defaults — PRD §128. Overridable per app via `createRateLimiter({ tiers })`. */
export const DEFAULT_TIERS: Record<RateLimitTier, TierConfig> = {
  login: { limit: 10, windowSeconds: 60, keyBy: "ip" },
  api: { limit: 600, windowSeconds: 60, keyBy: "credential" },
  tracking: { limit: 3000, windowSeconds: 60, keyBy: "ip" },
  postback: { limit: 600, windowSeconds: 60, keyBy: "ip" },
  webhook: { limit: 120, windowSeconds: 60, keyBy: "credential" },
  admin: { limit: 300, windowSeconds: 60, keyBy: "credential" },
  public: { limit: 120, windowSeconds: 60, keyBy: "ip" },
};

export interface RateLimitStore {
  /**
   * Atomically-ish increment `key` within the bucket that expires at
   * `expiresAtMs`; returns the new count. Implementations may be approximate.
   */
  increment(key: string, expiresAtMs: number, nowMs: number): Promise<number>;
}

/** In-memory fixed-window counters; buckets are dropped when they expire. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; expiresAtMs: number }>();

  async increment(key: string, expiresAtMs: number, nowMs: number): Promise<number> {
    const now = nowMs;
    const b = this.buckets.get(key);
    if (!b || b.expiresAtMs <= now) {
      this.buckets.set(key, { count: 1, expiresAtMs });
      if (this.buckets.size > 10_000) this.sweep(now);
      return 1;
    }
    b.count += 1;
    return b.count;
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.expiresAtMs <= now) this.buckets.delete(k);
  }

  /** Test seam. */
  reset(): void {
    this.buckets.clear();
  }
}

/** Best-effort KV store (eventually consistent; failures count as 1). */
export class KvRateLimitStore implements RateLimitStore {
  constructor(private readonly kv: KVNamespace) {}

  async increment(key: string, expiresAtMs: number, nowMs: number): Promise<number> {
    try {
      const current = Number((await this.kv.get(`rl:${key}`)) ?? "0");
      const next = (Number.isFinite(current) ? current : 0) + 1;
      const ttl = Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1000));
      await this.kv.put(`rl:${key}`, String(next), { expirationTtl: ttl });
      return next;
    } catch {
      return 1;
    }
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", "Too many requests; retry later");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimiterOptions {
  store?: RateLimitStore;
  tiers?: Partial<Record<RateLimitTier, Partial<TierConfig>>>;
  now?: () => number;
  /** Master switch — tests of other modules disable limits entirely. */
  enabled?: boolean;
}

async function credentialKey(c: Context): Promise<string | null> {
  const auth = c.req.header("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  // 16 hex chars — enough to separate keys; never reversible to the token.
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ipKey(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "anon";
}

/**
 * Map a request path to its tier (PRD §71 table). Exactly one tier per
 * request — mounted once at the app root so tiers never stack.
 */
export function classifyTier(path: string): RateLimitTier {
  if (path.startsWith("/t/") || path.startsWith("/s/")) return "tracking";
  if (path.startsWith("/postback/")) return "postback";
  if (path.startsWith("/api/v1/auth/")) {
    const tail = path.slice("/api/v1/auth/".length);
    if (tail === "login" || tail === "signup" || tail === "forgot-password" || tail === "resend-verification") return "login";
    return "public";
  }
  if (path.startsWith("/api/v1/organizations")) {
    if (/\/platform(\/|$)/.test(path)) return "admin";
    if (/\/webhooks(\/|$)/.test(path)) return "webhook";
    return "api";
  }
  return "public";
}

export interface RateLimiter {
  /** Middleware for one tier. Mount per route group. */
  tier(name: RateLimitTier): MiddlewareHandler;
  /** Single root middleware: classifies the path and applies that tier. */
  auto(): MiddlewareHandler;
  readonly tiers: Record<RateLimitTier, TierConfig>;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const store = options.store ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => Date.now());
  const enabled = options.enabled ?? true;
  const tiers = { ...DEFAULT_TIERS } as Record<RateLimitTier, TierConfig>;
  for (const [name, patch] of Object.entries(options.tiers ?? {}) as [RateLimitTier, Partial<TierConfig>][]) {
    tiers[name] = { ...DEFAULT_TIERS[name], ...patch };
  }

  const handlers = new Map<RateLimitTier, MiddlewareHandler>();
  const limiter: RateLimiter = {
    tiers,
    auto() {
      return (c, next) => limiter.tier(classifyTier(new URL(c.req.url).pathname))(c, next);
    },
    tier(name) {
      const cached = handlers.get(name);
      if (cached) return cached;
      const cfg = tiers[name];
      const handler: MiddlewareHandler = async (c, next) => {
        if (!enabled) return next();
        const windowMs = cfg.windowSeconds * 1000;
        const t = now();
        const bucketStart = Math.floor(t / windowMs) * windowMs;
        const expiresAtMs = bucketStart + windowMs;
        const subject = cfg.keyBy === "credential" ? ((await credentialKey(c)) ?? `ip:${ipKey(c)}`) : `ip:${ipKey(c)}`;
        const key = `${name}:${subject}:${bucketStart}`;
        const count = await store.increment(key, expiresAtMs, t);
        const remaining = Math.max(0, cfg.limit - count);
        const resetSeconds = Math.max(1, Math.ceil((expiresAtMs - t) / 1000));

        if (count > cfg.limit) {
          c.header("Retry-After", String(resetSeconds));
          c.header("X-RateLimit-Limit", String(cfg.limit));
          c.header("X-RateLimit-Remaining", "0");
          throw new RateLimitedError(resetSeconds);
        }
        await next();
        c.res.headers.set("X-RateLimit-Limit", String(cfg.limit));
        c.res.headers.set("X-RateLimit-Remaining", String(remaining));
      };
      handlers.set(name, handler);
      return handler;
    },
  };
  return limiter;
}
