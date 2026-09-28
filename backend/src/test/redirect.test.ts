/**
 * Phase 3 Unit 2 — public redirect endpoints over HTTP (GET /t/:code,
 * GET /s/:code) against the real migrations 0001–0008 through the D1 shim.
 * Real affiliate / advertiser / offer flows mint the link; the cap ledger is
 * the in-memory port (the DO is exercised in cap-object / cap-ledger tests).
 *
 * Covers: the mount is public (no auth, outside /api/v1); 302 + Location
 * with click_id; one clicks row with tenant ids from D1 (never the client);
 * sub-ID overrides; generic 404 for junk / unknown / paused link / paused
 * offer; cap exhaustion → 404 + deferred KV invalidation through CACHE;
 * a failing CACHE never breaks the response; ledger outage → 503 only for
 * capped offers; SmartLink routing + never-inactive + fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryCapLedger, type CapCounter } from "../modules/tracking/caps";
import { MemoryKv, offerCacheKey } from "../modules/tracking/eligibility-cache";
import { TestHarness, json } from "./fixtures";

const V1 = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click?src=tvh",
};

const COMPLETE_AFFILIATE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

interface Link {
  id: string;
  code: string;
  tracking_path: string;
}
interface Offer {
  id: string;
  status: string;
  current_version_id: string | null;
}
interface ClickRow {
  id: string;
  organization_id: string;
  affiliate_profile_id: string;
  tracking_link_id: string | null;
  smartlink_id: string | null;
  offer_id: string;
  offer_version_id: string;
  offer_organization_id: string;
  sub1: string | null;
  sub2: string | null;
  country_code: string | null;
  device_type: string | null;
  ip_hash: string | null;
  routing_mode: string | null;
  decision_reason_code: string;
  failover_from_offer_id: string | null;
  destination_url: string;
}

let h: TestHarness;
let ledger: MemoryCapLedger;
let deferred: Promise<void>[];
let kv: MemoryKv;

beforeEach(() => {
  ledger = new MemoryCapLedger();
  deferred = [];
  h = new TestHarness({ redirect: { ledger, onDefer: (p) => deferred.push(p) } });
  kv = new MemoryKv();
  h.env.CACHE = kv as unknown as KVNamespace;
  h.env.CLICK_SIGNAL_SALT = "test-salt";
});
afterEach(() => h.close());

const HEADERS = {
  "cf-connecting-ip": "198.51.100.7",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "cf-ipcountry": "GB",
  "accept-language": "en-GB,en;q=0.8",
};

async function hit(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await h.app.request(path, { method: "GET", headers: { ...HEADERS, ...headers }, redirect: "manual" }, h.env);
}

function clicks(): ClickRow[] {
  return h.db.sqlite.prepare("SELECT * FROM clicks ORDER BY created_at, id").all() as unknown as ClickRow[];
}

function run(sql: string, params: (string | number | null)[]): void {
  h.db.sqlite.prepare(sql).run(...params);
}

async function platform(email = "rev@network.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  return { token, orgId };
}

async function advertiser(email = "adv@acme.example", name = "Acme Ads") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: name })).status).toBe(201);
  return { owner, orgId };
}

async function activeAffiliate(plat: { token: string; orgId: string }, email = "aff@traffic.example", name = "Traffic Co") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {})).status).toBeLessThan(300);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(200);
  for (const to of ["APPROVED", "ACTIVE"]) {
    const res = await h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/affiliates/${created.profile.id}/transition`, { to });
    expect(res.status, to).toBe(200);
  }
  return { owner, orgId, profileId: created.profile.id };
}

async function toLive(owner: string, advOrg: string, plat: { token: string; orgId: string }, body: Record<string, unknown>): Promise<Offer> {
  const created = await json<{ offer: Offer }>(await h.as(owner, "POST", `/organizations/${advOrg}/offers`, body));
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}

async function world(version: Record<string, unknown> = V1) {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version });
  const aff = await activeAffiliate(plat);
  const res = await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links`, {
    offer_id: offer.id,
    name: "Newsletter",
    defaults: { sub1: "nl" },
  });
  expect(res.status).toBe(201);
  const { tracking_link: link } = await json<{ tracking_link: Link }>(res);
  return { plat, adv, offer, aff, link };
}

function exhaust(offerId: string, cap: CapCounter["cap_type"], limit: number, currency: string | null = null) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const period = cap.startsWith("DAILY") ? day : cap.startsWith("MONTHLY") ? day.slice(0, 7) : "TOTAL";
  ledger.seed(offerId, [{ cap_type: cap, period_key: period, limit_value: limit, current_value: limit, currency, exhausted_at: now.toISOString() }]);
}

// ---------------------------------------------------------------------------
describe("GET /t/:code — public tracking redirect", () => {
  it("302s to the version destination with click_id, records one click with D1-derived tenant ids, no auth needed", async () => {
    const { adv, offer, aff, link } = await world();
    expect(link.tracking_path).toBe(`/t/${link.code}`);
    const res = await hit(`${link.tracking_path}?sub2=camp-1&sub1=override`);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = res.headers.get("location")!;
    expect(location.startsWith("https://track.example/click?src=tvh&click_id=")).toBe(true);
    const clickId = new URL(location).searchParams.get("click_id")!;
    expect(clickId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 (generateClickId)

    const rows = clicks();
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.id).toBe(clickId);
    expect(c.organization_id).toBe(aff.orgId);
    expect(c.affiliate_profile_id).toBe(aff.profileId);
    expect(c.offer_organization_id).toBe(adv.orgId);
    expect(c.offer_id).toBe(offer.id);
    expect(c.offer_version_id).toBe(offer.current_version_id);
    expect(c.tracking_link_id).toBe(link.id);
    expect(c.smartlink_id).toBeNull();
    expect(c.sub1).toBe("override");
    expect(c.sub2).toBe("camp-1");
    expect(c.country_code).toBe("GB");
    expect(c.device_type).toBe("DESKTOP");
    expect(c.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.decision_reason_code).toBe("TRACKING_LINK");
    expect(c.destination_url).toBe(location);
    // Raw IP / UA never stored anywhere on the row.
    expect(JSON.stringify(c)).not.toContain("198.51.100.7");
    expect(deferred).toHaveLength(0);
  });

  it("two clicks → two distinct click ids; lower-case code resolves too", async () => {
    const { link } = await world();
    const a = await hit(link.tracking_path);
    const b = await hit(`/t/${link.code.toLowerCase()}`);
    expect(a.status).toBe(302);
    expect(b.status).toBe(302);
    const ids = clicks().map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("junk / unknown / PAUSED link / non-LIVE offer → identical generic 404, no click, no reason leak", async () => {
    const { adv, offer, aff, link } = await world();
    const expect404 = async (path: string) => {
      const res = await hit(path);
      expect(res.status, path).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("Resource not found");
      expect(JSON.stringify(body)).not.toMatch(/INELIGIBLE|PAUSED|CAP|LINK_NOT_FOUND|INVALID_CODE/);
    };
    await expect404("/t/nope");
    await expect404("/t/ABCDEF234567");
    await expect404("/t/" + encodeURIComponent("../../etc/passwd"));

    // Pause the link → 404; resume → 302 again.
    expect((await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links/${link.id}/transition`, { to: "PAUSED" })).status).toBe(200);
    await expect404(link.tracking_path);
    expect((await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links/${link.id}/transition`, { to: "ACTIVE" })).status).toBe(200);
    expect((await hit(link.tracking_path)).status).toBe(302);

    // Pause the OFFER → the still-ACTIVE link routes nothing.
    expect((await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/offers/${offer.id}/transition`, { to: "PAUSED", reason: "pause" })).status).toBe(200);
    await expect404(link.tracking_path);
    expect(clicks()).toHaveLength(1);
  });

  it("conversion cap exhausted → 404 and a DEFERRED KV invalidation through CACHE; a failing CACHE never changes the response", async () => {
    const { offer, link } = await world({ ...V1, daily_conversion_cap: 5 });
    kv.poke(offerCacheKey(offer.id), JSON.stringify({ stale: true }));
    exhaust(offer.id, "DAILY_CONVERSION", 5);

    const res = await hit(link.tracking_path);
    expect(res.status).toBe(404);
    expect(clicks()).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(kv.peek(offerCacheKey(offer.id))).toBeNull();

    kv.failing.delete = true;
    const again = await hit(link.tracking_path);
    expect(again.status).toBe(404);
    await expect(Promise.all(deferred)).resolves.toBeDefined();
  });

  it("budget exhausted → 404; a capped-but-open offer → 302", async () => {
    const { offer, link } = await world({ ...V1, budget_minor: 100_000, total_conversion_cap: 50 });
    expect((await hit(link.tracking_path)).status).toBe(302);
    exhaust(offer.id, "BUDGET", 100_000, "USD");
    expect((await hit(link.tracking_path)).status).toBe(404);
    expect(clicks()).toHaveLength(1);
  });

  it("ledger outage → 503 for a capped offer only; uncapped offers keep redirecting", async () => {
    const capped = await world({ ...V1, total_conversion_cap: 50 });
    ledger.status = async () => {
      throw new Error("DO down");
    };
    const res = await hit(capped.link.tracking_path);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
    expect(clicks()).toHaveLength(0);

    // A second, uncapped offer for the same affiliate: unaffected.
    const offer2 = await toLive(capped.adv.owner, capped.adv.orgId, capped.plat, { name: "Uncapped", version: V1 });
    const created = await h.as(capped.aff.owner, "POST", `/organizations/${capped.aff.orgId}/tracking-links`, { offer_id: offer2.id });
    expect(created.status).toBe(201);
    const { tracking_link: link2 } = await json<{ tracking_link: Link }>(created);
    expect((await hit(link2.tracking_path)).status).toBe(302);
  });

  it("is not under /api/v1 and ignores bearer tokens", async () => {
    const { link, aff } = await world();
    expect((await h.api("GET", link.tracking_path)).status).toBe(404);
    const res = await hit(link.tracking_path, { authorization: `Bearer ${aff.owner}` });
    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
describe("GET /s/:code — public SmartLink redirect", () => {
  /** SmartLink management routes are Phase 3 Unit 3's API surface; seed the rows directly. */
  function seedSmartLink(
    aff: { orgId: string; profileId: string },
    offers: { id: string; orgId: string; priority?: number; enabled?: number }[],
    over: { code?: string; routing_mode?: string; fallback_url?: string | null } = {},
  ) {
    const code = over.code ?? "SMART2345678";
    const id = `sl_${code}`;
    run(
      `INSERT INTO smartlinks (id, organization_id, affiliate_profile_id, code, name, routing_mode, routing_algorithm_version, status, fallback_url)
       VALUES (?, ?, ?, ?, 'Pool', ?, 'smartlink-v1.0.0', 'ACTIVE', ?)`,
      [id, aff.orgId, aff.profileId, code, over.routing_mode ?? "RULE_BASED", over.fallback_url ?? null],
    );
    offers.forEach((o, i) => {
      run(
        `INSERT INTO smartlink_offers (id, smartlink_id, organization_id, offer_id, offer_organization_id, weight, priority, enabled)
         VALUES (?, ?, ?, ?, ?, 100, ?, ?)`,
        [`slo_${code}_${i}`, id, aff.orgId, o.id, o.orgId, o.priority ?? i, o.enabled ?? 1],
      );
    });
    return { id, code };
  }

  it("routes to the best eligible offer, never to a PAUSED one (even with failover), records the decision", async () => {
    const { plat, adv, offer: live, aff } = await world();
    const paused = await toLive(adv.owner, adv.orgId, plat, { name: "Soon paused", version: V1 });
    expect((await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/offers/${paused.id}/transition`, { to: "PAUSED", reason: "x" })).status).toBe(200);
    const capped = await toLive(adv.owner, adv.orgId, plat, { name: "Capped", version: { ...V1, daily_conversion_cap: 1 } });
    exhaust(capped.id, "DAILY_CONVERSION", 1);

    const sl = seedSmartLink(aff, [
      { id: paused.id, orgId: adv.orgId, priority: 0 },
      { id: capped.id, orgId: adv.orgId, priority: 1 },
      { id: live.id, orgId: adv.orgId, priority: 2 },
    ]);
    const res = await hit(`/s/${sl.code}?sub1=pool`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith("https://track.example/click?src=tvh&click_id=")).toBe(true);

    const rows = clicks();
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.offer_id).toBe(live.id);
    expect(c.offer_version_id).toBe(live.current_version_id);
    expect(c.smartlink_id).toBe(sl.id);
    expect(c.tracking_link_id).toBeNull();
    expect(c.organization_id).toBe(aff.orgId);
    expect(c.offer_organization_id).toBe(adv.orgId);
    expect(c.routing_mode).toBe("RULE_BASED");
    expect(c.failover_from_offer_id).toBe(capped.id);
    expect(c.sub1).toBe("pool");
    await Promise.all(deferred);
    expect(kv.peek(offerCacheKey(capped.id))).toBeNull();
  });

  it("nothing eligible: fallback_url → 302 without a click; no fallback → 404; unknown code → 404", async () => {
    const { plat, adv, aff } = await world();
    const paused = await toLive(adv.owner, adv.orgId, plat, { name: "Paused", version: V1 });
    expect((await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/offers/${paused.id}/transition`, { to: "PAUSED", reason: "x" })).status).toBe(200);

    const withFallback = seedSmartLink(aff, [{ id: paused.id, orgId: adv.orgId }], { code: "FBACK2345678", fallback_url: "https://fallback.example/x" });
    const a = await hit(`/s/${withFallback.code}`);
    expect(a.status).toBe(302);
    expect(a.headers.get("location")).toBe("https://fallback.example/x");
    expect(clicks()).toHaveLength(0);

    const bare = seedSmartLink(aff, [{ id: paused.id, orgId: adv.orgId }], { code: "NFBACK234567" });
    expect((await hit(`/s/${bare.code}`)).status).toBe(404);
    expect((await hit("/s/UNKNOWN23456")).status).toBe(404);
    expect((await hit("/s/x")).status).toBe(404);
    expect(clicks()).toHaveLength(0);
  });
});
