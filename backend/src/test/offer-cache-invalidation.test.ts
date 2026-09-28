/**
 * Phase 3 Unit 5b — OfferService eligibility-cache invalidation hooks.
 *
 * The service is constructed directly with an `EligibilityCache` over a
 * `MemoryKv` (the HTTP layer never sees a cache in tests, so all Phase 2
 * tests run unchanged). For each routing-relevant write we assert:
 *   - the cached entry is gone after the write (stale-LIVE can never be served);
 *   - the KV delete happened BEFORE and AFTER the D1 write;
 *   - a failing pre-write delete blocks the write (D1 unchanged);
 *   - a failing post-write delete surfaces `EligibilityCacheError`.
 * Non-routing writes (name/description) never touch the cache.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tenantIdOf } from "../lib/tenant-scope";
import type { TenantContext } from "../middleware/require-org";
import { AdvertiserRepository } from "../modules/advertisers/repository";
import type { RequestMeta } from "../modules/auth/repository";
import type { AuthenticatedContext } from "../modules/auth/service";
import { OfferRepository } from "../modules/offers/repository";
import { OfferService } from "../modules/offers/service";
import {
  EligibilityCache,
  EligibilityCacheError,
  MemoryKv,
  grantCacheKey,
  offerCacheKey,
  type CachedOfferFacts,
} from "../modules/tracking/eligibility-cache";
import { TestHarness, json } from "./fixtures";

const V1 = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click",
};
const META: RequestMeta = { ip_address: null, user_agent: null, request_id: "req-test" };

interface Offer {
  id: string;
  organization_id: string;
  status: string;
  access_mode: string;
  current_version_id: string | null;
  current_version: { destination_url: string | null } | null;
}

let h: TestHarness;
let kv: MemoryKv;
let cache: EligibilityCache;
let svc: OfferService;
let repo: OfferRepository;

beforeEach(() => {
  h = new TestHarness();
  kv = new MemoryKv();
  cache = new EligibilityCache(kv);
  repo = new OfferRepository(h.db);
  svc = new OfferService(repo, new AdvertiserRepository(h.db), h.db, cache);
});
afterEach(() => h.close());

/** Build a TenantContext straight from D1 for a user's membership in an org. */
async function tenantFor(email: string, orgId: string): Promise<{ tenant: TenantContext; ctx: AuthenticatedContext }> {
  const row = await h.db
    .prepare(
      `SELECT u.id AS user_id, u.email, o.type, o.name, o.slug, o.status,
              m.id AS membership_id, m.joined_at, r.id AS role_id, r.key AS role_key, r.is_owner
         FROM users u
         JOIN organization_members m ON m.user_id = u.id AND m.organization_id = ?
         JOIN organizations o ON o.id = m.organization_id
         JOIN roles r ON r.id = m.role_id
        WHERE lower(u.email) = lower(?)`,
    )
    .bind(orgId, email)
    .first<{
      user_id: string; email: string; type: string; name: string; slug: string; status: string;
      membership_id: string; joined_at: string | null; role_id: string; role_key: string; is_owner: number;
    }>();
  if (!row) throw new Error("fixture: membership not found");
  const perms = await h.db
    .prepare(
      `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    )
    .bind(row.role_id)
    .all<{ key: string }>();
  const tenant: TenantContext = {
    organization: { id: orgId, type: row.type as TenantContext["organization"]["type"], name: row.name, slug: row.slug, status: row.status },
    membership: { id: row.membership_id, joined_at: row.joined_at },
    role: { id: row.role_id, key: row.role_key, is_owner: row.is_owner === 1 },
    permissions: new Set(perms.results.map((p) => p.key)),
  };
  const ctx = {
    user: { id: row.user_id, email: row.email },
    session: {},
  } as unknown as AuthenticatedContext;
  return { tenant, ctx };
}

async function liveOffer(access_mode = "PUBLIC") {
  const advEmail = "adv@acme.example";
  const owner = await h.user(advEmail);
  const advOrg = await h.org(owner, "ADVERTISER", "Acme Ads");
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/advertiser`, { company_name: "Acme Ads" })).status).toBe(201);
  const platEmail = "rev@network.example";
  const platToken = await h.user(platEmail);
  const platOrg = await h.platformOrg(platEmail, "SUPER_ADMIN");

  const created = await json<{ offer: Offer }>(
    await h.as(owner, "POST", `/organizations/${advOrg}/offers`, { name: "Live", access_mode, version: V1 }),
  );
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(platToken, "POST", `/organizations/${platOrg}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  const offer = (await json<{ offer: Offer }>(live)).offer;
  return { offer, advEmail, advOrg, platEmail, platOrg };
}

function factsOf(offer: Offer): CachedOfferFacts {
  return {
    offer_id: offer.id,
    organization_id: offer.organization_id,
    status: offer.status as CachedOfferFacts["status"],
    access_mode: offer.access_mode as CachedOfferFacts["access_mode"],
    current_version_id: offer.current_version_id,
    destination_url: offer.current_version?.destination_url ?? null,
    targeting_starts_at: null,
    targeting_ends_at: null,
    epoch: "2026-01-01T00:00:00.000Z",
  };
}

/** Index of the first KV op matching (op, key) at or after `from`. */
function indexOfCall(op: "get" | "put" | "delete", key: string, from = 0): number {
  return kv.calls.findIndex((c, i) => i >= from && c.op === op && c.key === key);
}

describe("OfferService: eligibility cache invalidation (Unit 5b)", () => {
  it("LIVE → PAUSED (tenant) deletes the cached offer facts before and after the D1 write", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    expect(await cache.getOffer(offer.id)).not.toBeNull();
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    const mark = kv.calls.length;

    const out = await svc.transition(ctx, tenant, offer.id, { to: "PAUSED", reason: "pause" }, META);
    expect(out.status).toBe("PAUSED");
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
    expect(await cache.getOffer(offer.id)).toBeNull();
    const deletes = kv.calls.slice(mark).filter((c) => c.op === "delete" && c.key === offerCacheKey(offer.id));
    expect(deletes).toHaveLength(2);
  });

  it("LIVE → COMPLIANCE_HOLD (platform) invalidates", async () => {
    const { offer, platEmail, platOrg } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    const { tenant, ctx } = await tenantFor(platEmail, platOrg);
    const out = await svc.platformTransition(ctx, tenant, offer.id, { to: "COMPLIANCE_HOLD", reason: "policy" }, META);
    expect(out.status).toBe("COMPLIANCE_HOLD");
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
  });

  it("PAUSED → ARCHIVED invalidates", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    await svc.transition(ctx, tenant, offer.id, { to: "PAUSED", reason: "pause" }, META);
    await cache.putOffer({ ...factsOf(offer) }); // routable snapshot (status LIVE) as if stale
    kv.calls.length = 0;
    await svc.transition(ctx, tenant, offer.id, { to: "ARCHIVED", reason: "done" }, META);
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
    expect(kv.calls.filter((c) => c.op === "delete")).toHaveLength(2);
  });

  it("a new version (destination change) invalidates the offer facts", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    const mark = kv.calls.length;
    const v = await svc.createVersion(ctx, tenant, offer.id, { ...V1, destination_url: "https://track.example/v2" } as never, undefined, META);
    expect(v.version_number).toBe(2);
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
    const deletes = kv.calls.slice(mark).filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(2);
    const fresh = await repo.findById(tenantIdOf(tenant), offer.id);
    expect(fresh?.current_version_id).toBe(v.id);
  });

  it("changing access_mode invalidates; name/description edits do not touch the cache", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    kv.calls.length = 0;
    await svc.update(ctx, tenant, offer.id, { name: "Renamed", description: "x" }, META);
    expect(kv.calls).toHaveLength(0);
    expect(kv.peek(offerCacheKey(offer.id))).not.toBeNull();

    await svc.update(ctx, tenant, offer.id, { access_mode: "PRIVATE" }, META);
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
    expect(kv.calls.filter((c) => c.op === "delete")).toHaveLength(2);
  });

  it("grant set by the advertiser (APPROVED then REVOKED) invalidates the (offer, affiliate) grant key each time", async () => {
    const { offer, advEmail, advOrg } = await liveOffer("PRIVATE");
    const affOwner = await h.user("aff@traffic.example");
    const affOrg = await h.org(affOwner, "AFFILIATE", "Traffic Co");
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    const key = grantCacheKey(offer.id, affOrg);

    await cache.putGrant(offer.id, affOrg, "APPROVED");
    expect(kv.peek(key)).not.toBeNull();
    const mark = kv.calls.length;
    const g1 = await svc.setAccessGrant(ctx, tenant, offer.id, { affiliate_organization_id: affOrg, status: "APPROVED" }, META);
    expect(g1.status).toBe("APPROVED");
    expect(kv.peek(key)).toBeNull();
    expect(kv.calls.slice(mark).filter((c) => c.op === "delete" && c.key === key)).toHaveLength(2);

    await cache.putGrant(offer.id, affOrg, "APPROVED");
    const g2 = await svc.setAccessGrant(ctx, tenant, offer.id, { affiliate_organization_id: affOrg, status: "REVOKED", reason: "fraud" }, META);
    expect(g2.status).toBe("REVOKED");
    expect(kv.peek(key)).toBeNull();
    expect(await cache.getGrant(offer.id, affOrg)).toBeUndefined();
    // The offer-level key is untouched by a grant change (per-affiliate scope only).
    await cache.putOffer(factsOf(offer));
    await svc.setAccessGrant(ctx, tenant, offer.id, { affiliate_organization_id: affOrg, status: "APPROVED" }, META);
    expect(kv.peek(offerCacheKey(offer.id))).not.toBeNull();
  });

  it("an affiliate application (requestAccess) invalidates its own grant key", async () => {
    const { offer } = await liveOffer("APPLICATION_REQUIRED");
    const affEmail = "aff@traffic.example";
    const affOwner = await h.user(affEmail);
    const affOrg = await h.org(affOwner, "AFFILIATE", "Traffic Co");
    const { tenant, ctx } = await tenantFor(affEmail, affOrg);
    const key = grantCacheKey(offer.id, affOrg);
    await cache.putGrant(offer.id, affOrg, null);
    const mark = kv.calls.length;
    const g = await svc.apply(ctx, tenant, offer.id, META);
    expect(g.status).toBe("REQUESTED");
    expect(kv.peek(key)).toBeNull();
    expect(kv.calls.slice(mark).filter((c) => c.op === "delete" && c.key === key)).toHaveLength(2);
  });

  it("fails closed: a failing PRE-write invalidation blocks the transition (offer stays LIVE)", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    kv.failing.delete = true;
    await expect(svc.transition(ctx, tenant, offer.id, { to: "PAUSED", reason: "pause" }, META)).rejects.toBeInstanceOf(
      EligibilityCacheError,
    );
    const row = await repo.findById(tenantIdOf(tenant), offer.id);
    expect(row?.status).toBe("LIVE");
    const transitions = await h.db
      .prepare("SELECT COUNT(*) AS n FROM offer_status_transitions WHERE offer_id = ? AND to_status = 'PAUSED'")
      .bind(offer.id)
      .first<{ n: number }>();
    expect(transitions?.n).toBe(0);
  });

  it("fails closed: a failing POST-write invalidation surfaces EligibilityCacheError (never silent success)", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    // Make only the SECOND delete fail.
    const original = kv.delete.bind(kv);
    let n = 0;
    kv.delete = async (key: string) => {
      n += 1;
      if (n === 2) throw new Error("kv delete failed (post-write)");
      return original(key);
    };
    await expect(svc.transition(ctx, tenant, offer.id, { to: "PAUSED", reason: "pause" }, META)).rejects.toBeInstanceOf(
      EligibilityCacheError,
    );
    // The D1 write did happen (the cache is the thing in doubt, not the truth) and dies at TTL anyway.
    const row = await repo.findById(tenantIdOf(tenant), offer.id);
    expect(row?.status).toBe("PAUSED");
  });

  it("invalidateOfferRouting (public hook for cap-exhausted / tracking-degraded) drops the offer facts", async () => {
    const { offer } = await liveOffer();
    await cache.putOffer(factsOf(offer));
    await svc.invalidateOfferRouting(offer.id);
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();
    kv.failing.delete = true;
    await expect(svc.invalidateOfferRouting(offer.id)).rejects.toBeInstanceOf(EligibilityCacheError);
  });

  it("without a cache the service behaves exactly as in Phase 2 (no KV traffic, writes succeed)", async () => {
    const { offer, advEmail, advOrg } = await liveOffer();
    const plain = new OfferService(repo, new AdvertiserRepository(h.db), h.db);
    const { tenant, ctx } = await tenantFor(advEmail, advOrg);
    const out = await plain.transition(ctx, tenant, offer.id, { to: "PAUSED", reason: "pause" }, META);
    expect(out.status).toBe("PAUSED");
    await expect(plain.invalidateOfferRouting(offer.id)).resolves.toBeUndefined();
    expect(kv.calls).toHaveLength(0);
    expect(indexOfCall("delete", offerCacheKey(offer.id))).toBe(-1);
  });
});
