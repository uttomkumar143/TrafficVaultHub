/**
 * Phase 3 Unit 5 — eligibility cache semantics over a MemoryKv.
 * The invariant under test: a cached entry can NEVER serve an inactive offer.
 */
import { describe, expect, it } from "vitest";
import {
  EligibilityCache,
  EligibilityCacheError,
  MemoryKv,
  grantCacheKey,
  offerCacheKey,
  toRoutingFacts,
  type CachedOfferFacts,
} from "./eligibility-cache";
import { offerRoutability } from "./eligibility";

const T0 = new Date("2026-03-15T12:00:00.000Z");

function clock(start: Date = T0): { now: () => Date; advance: (ms: number) => void } {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

const live = (over: Partial<CachedOfferFacts> = {}): CachedOfferFacts => ({
  offer_id: "offer-1",
  organization_id: "org-adv-1",
  status: "LIVE",
  access_mode: "PUBLIC",
  current_version_id: "v1",
  destination_url: "https://adv.example/landing",
  targeting_starts_at: null,
  targeting_ends_at: null,
  epoch: "2026-03-15T11:00:00.000Z",
  ...over,
});

function make(ttlSeconds = 60) {
  const c = clock();
  const kv = new MemoryKv(c.now);
  const cache = new EligibilityCache(kv, { ttlSeconds, now: c.now });
  return { c, kv, cache };
}

describe("eligibility-cache: offer facts hit / miss", () => {
  it("misses on an empty cache, hits after put, and returns exactly the stored facts", async () => {
    const { kv, cache } = make();
    expect(await cache.getOffer("offer-1")).toBeNull();
    await cache.putOffer(live());
    expect(kv.peek(offerCacheKey("offer-1"))).not.toBeNull();
    expect(await cache.getOffer("offer-1")).toEqual(live());
  });

  it("a hit composed with a grant yields eligible routing facts", async () => {
    const { cache } = make();
    await cache.putOffer(live({ access_mode: "PRIVATE" }));
    const facts = await cache.getOffer("offer-1");
    expect(facts).not.toBeNull();
    expect(offerRoutability(toRoutingFacts(facts!, "APPROVED"), T0)).toEqual({ eligible: true });
    expect(offerRoutability(toRoutingFacts(facts!, "REVOKED"), T0)).toEqual({ eligible: false, reason: "ACCESS_DENIED" });
    expect(offerRoutability(toRoutingFacts(facts!, null), T0)).toEqual({ eligible: false, reason: "ACCESS_DENIED" });
  });

  it("expires by its own cached_at + ttl even if KV kept the blob", async () => {
    const { c, kv, cache } = make(60);
    await cache.putOffer(live());
    c.advance(59_000);
    expect(await cache.getOffer("offer-1")).not.toBeNull();
    c.advance(1_000);
    expect(await cache.getOffer("offer-1")).toBeNull();
    // Also: the entry's cached_at is authoritative even when KV has not evicted it.
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live(), v: 1, cached_at: "2026-03-15T11:00:00.000Z" }));
    expect(await cache.getOffer("offer-1")).toBeNull();
  });

  it("honours a longer ttl for the entry and clamps the KV backstop to >= 60 s", async () => {
    const { c, cache } = make(300);
    await cache.putOffer(live());
    c.advance(299_000);
    expect(await cache.getOffer("offer-1")).not.toBeNull();
    c.advance(1_000);
    expect(await cache.getOffer("offer-1")).toBeNull();
    expect(() => new EligibilityCache(new MemoryKv(), { ttlSeconds: 0 })).toThrow();
  });
});

describe("eligibility-cache: never serves an inactive offer", () => {
  it.each(["PAUSED", "COMPLIANCE_HOLD", "CAP_REACHED", "BUDGET_EXHAUSTED", "TRACKING_ISSUE", "ARCHIVED", "EXPIRED", "DRAFT"] as const)(
    "put of a %s offer deletes any existing entry instead of caching a negative",
    async (status) => {
      const { kv, cache } = make();
      await cache.putOffer(live());
      expect(kv.size).toBe(1);
      await cache.putOffer(live({ status }));
      expect(kv.size).toBe(0);
      expect(await cache.getOffer("offer-1")).toBeNull();
    },
  );

  it("a stale blob written behind the cache's back for a non-LIVE offer is a miss at read time", async () => {
    const { kv, cache } = make();
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live({ status: "PAUSED" }), v: 1, cached_at: T0.toISOString() }));
    expect(await cache.getOffer("offer-1")).toBeNull();
  });

  it("re-validates the targeting window at READ time (window closes while cached)", async () => {
    const { c, cache } = make(600);
    await cache.putOffer(live({ targeting_ends_at: new Date(T0.getTime() + 30_000).toISOString() }));
    expect(await cache.getOffer("offer-1")).not.toBeNull();
    c.advance(30_000);
    expect(await cache.getOffer("offer-1")).toBeNull();
  });

  it("does not cache an offer that has not started, no version, or no destination", async () => {
    const { kv, cache } = make();
    await cache.putOffer(live({ targeting_starts_at: new Date(T0.getTime() + 60_000).toISOString() }));
    await cache.putOffer(live({ offer_id: "o2", current_version_id: null }));
    await cache.putOffer(live({ offer_id: "o3", destination_url: null }));
    expect(kv.size).toBe(0);
  });

  it("rejects malformed / foreign / wrong-version blobs", async () => {
    const { kv, cache } = make();
    kv.poke(offerCacheKey("offer-1"), "not json");
    expect(await cache.getOffer("offer-1")).toBeNull();
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live(), v: 2, cached_at: T0.toISOString() }));
    expect(await cache.getOffer("offer-1")).toBeNull();
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live({ offer_id: "someone-else" }), v: 1, cached_at: T0.toISOString() }));
    expect(await cache.getOffer("offer-1")).toBeNull();
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live({ status: "BOGUS" as never }), v: 1, cached_at: T0.toISOString() }));
    expect(await cache.getOffer("offer-1")).toBeNull();
    kv.poke(offerCacheKey("offer-1"), JSON.stringify({ ...live({ access_mode: "OPEN" as never }), v: 1, cached_at: T0.toISOString() }));
    expect(await cache.getOffer("offer-1")).toBeNull();
  });

  it("a KV read failure is a miss, never a throw", async () => {
    const { kv, cache } = make();
    await cache.putOffer(live());
    kv.failing.get = true;
    await expect(cache.getOffer("offer-1")).resolves.toBeNull();
  });
});

describe("eligibility-cache: invalidation", () => {
  it("invalidateOffer removes the entry synchronously", async () => {
    const { kv, cache } = make();
    await cache.putOffer(live());
    await cache.invalidateOffer("offer-1");
    expect(kv.peek(offerCacheKey("offer-1"))).toBeNull();
    expect(await cache.getOffer("offer-1")).toBeNull();
  });

  it("invalidation failure THROWS EligibilityCacheError (caller must fail closed)", async () => {
    const { kv, cache } = make();
    await cache.putOffer(live());
    kv.failing.delete = true;
    await expect(cache.invalidateOffer("offer-1")).rejects.toBeInstanceOf(EligibilityCacheError);
    await expect(cache.invalidateGrant("offer-1", "org-aff-1")).rejects.toBeInstanceOf(EligibilityCacheError);
  });

  it("put failure is swallowed (accelerator only) and leaves no entry", async () => {
    const { kv, cache } = make();
    kv.failing.put = true;
    await expect(cache.putOffer(live())).resolves.toBeUndefined();
    await expect(cache.putGrant("offer-1", "org-aff-1", "APPROVED")).resolves.toBeUndefined();
    expect(kv.size).toBe(0);
  });
});

describe("eligibility-cache: grant status", () => {
  it("distinguishes miss (undefined) from a cached 'no grant' (null) and caches every status", async () => {
    const { cache } = make();
    expect(await cache.getGrant("offer-1", "org-aff-1")).toBeUndefined();
    await cache.putGrant("offer-1", "org-aff-1", null);
    expect(await cache.getGrant("offer-1", "org-aff-1")).toEqual({ grant_status: null });
    await cache.putGrant("offer-1", "org-aff-1", "APPROVED");
    expect(await cache.getGrant("offer-1", "org-aff-1")).toEqual({ grant_status: "APPROVED" });
    await cache.putGrant("offer-1", "org-aff-1", "REVOKED");
    expect(await cache.getGrant("offer-1", "org-aff-1")).toEqual({ grant_status: "REVOKED" });
  });

  it("is keyed per (offer, affiliate org), expires by ttl, and invalidates independently of the offer entry", async () => {
    const { c, kv, cache } = make(60);
    await cache.putOffer(live());
    await cache.putGrant("offer-1", "org-aff-1", "APPROVED");
    await cache.putGrant("offer-1", "org-aff-2", "REVOKED");
    expect(await cache.getGrant("offer-1", "org-aff-2")).toEqual({ grant_status: "REVOKED" });
    await cache.invalidateGrant("offer-1", "org-aff-1");
    expect(kv.peek(grantCacheKey("offer-1", "org-aff-1"))).toBeNull();
    expect(await cache.getGrant("offer-1", "org-aff-1")).toBeUndefined();
    expect(await cache.getGrant("offer-1", "org-aff-2")).toEqual({ grant_status: "REVOKED" });
    expect(await cache.getOffer("offer-1")).not.toBeNull();
    c.advance(60_000);
    expect(await cache.getGrant("offer-1", "org-aff-2")).toBeUndefined();
  });

  it("rejects malformed grant blobs and read failures as misses", async () => {
    const { kv, cache } = make();
    kv.poke(grantCacheKey("offer-1", "org-aff-1"), JSON.stringify({ v: 1, offer_id: "offer-1", affiliate_organization_id: "org-aff-1", grant_status: "MAYBE", cached_at: T0.toISOString() }));
    expect(await cache.getGrant("offer-1", "org-aff-1")).toBeUndefined();
    kv.poke(grantCacheKey("offer-1", "org-aff-1"), JSON.stringify({ v: 1, offer_id: "other", affiliate_organization_id: "org-aff-1", grant_status: "APPROVED", cached_at: T0.toISOString() }));
    expect(await cache.getGrant("offer-1", "org-aff-1")).toBeUndefined();
    kv.failing.get = true;
    expect(await cache.getGrant("offer-1", "org-aff-1")).toBeUndefined();
  });
});
