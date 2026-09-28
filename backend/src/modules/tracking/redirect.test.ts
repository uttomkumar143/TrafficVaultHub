/**
 * Phase 3 Unit 2 — RedirectService (pure: fake reads + MemoryCapLedger,
 * injected clock/random/click-id). HTTP mount is covered in
 * src/test/redirect.test.ts (part 3).
 */
import { describe, expect, it } from "vitest";
import { MemoryCapLedger, type CapCounter } from "./caps";
import { buildDestination, CapLedgerUnavailableError, RedirectService, type RedirectReads, type RedirectRequest } from "./redirect";
import type { ClickInsert, ResolvedSmartLinkRow, ResolvedTrackingLinkRow, SmartLinkCandidateRow, TargetingRuleRow } from "./repository";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const CODE = "ABCDEF234567"; // 12 chars, valid alphabet
const SALT = "unit-test-salt";

function linkRow(over: Partial<ResolvedTrackingLinkRow> = {}): ResolvedTrackingLinkRow {
  return {
    id: "lnk_1",
    organization_id: "org_aff",
    affiliate_profile_id: "aff_1",
    offer_id: "off_1",
    offer_organization_id: "org_adv",
    traffic_source_id: "ts_1",
    code: CODE,
    name: null,
    creative_id: "cr_1",
    status: "ACTIVE",
    default_sub1: "default-1",
    default_sub2: null,
    default_sub3: null,
    default_sub4: null,
    default_sub5: null,
    archived_at: null,
    created_by_user_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    offer_status: "LIVE",
    offer_access_mode: "PUBLIC",
    offer_version_id: "ver_1",
    offer_destination_url: "https://adv.example/land?src=tvh",
    targeting_starts_at: null,
    targeting_ends_at: null,
    grant_status: null,
    daily_conversion_cap: null,
    total_conversion_cap: null,
    budget_minor: null,
    offer_currency: "USD",
    ...over,
  };
}

function smartRow(over: Partial<ResolvedSmartLinkRow> = {}): ResolvedSmartLinkRow {
  return {
    id: "sl_1",
    organization_id: "org_aff",
    affiliate_profile_id: "aff_1",
    traffic_source_id: null,
    code: CODE,
    routing_mode: "RULE_BASED",
    status: "ACTIVE",
    fallback_url: null,
    ...over,
  };
}

function candRow(offerId: string, over: Partial<SmartLinkCandidateRow> = {}): SmartLinkCandidateRow {
  return {
    offer_id: offerId,
    offer_organization_id: "org_adv",
    weight: 100,
    priority: 100,
    enabled: 1,
    offer_status: "LIVE",
    offer_access_mode: "PUBLIC",
    offer_version_id: `ver_${offerId}`,
    offer_destination_url: `https://${offerId}.example/land`,
    targeting_starts_at: null,
    targeting_ends_at: null,
    grant_status: null,
    daily_conversion_cap: null,
    total_conversion_cap: null,
    budget_minor: null,
    offer_currency: "USD",
    ...over,
  };
}

class FakeReads implements RedirectReads {
  link: ResolvedTrackingLinkRow | null = null;
  smart: ResolvedSmartLinkRow | null = null;
  candidates: SmartLinkCandidateRow[] = [];
  targeting: TargetingRuleRow[] = [];
  clicks: ClickInsert[] = [];
  insertError: Error | null = null;
  lookups = 0;

  async findActiveByCode(code: string) {
    this.lookups++;
    return this.link && this.link.code === code ? this.link : null;
  }
  async findActiveSmartLinkByCode(code: string) {
    this.lookups++;
    return this.smart && this.smart.code === code ? this.smart : null;
  }
  async listSmartLinkCandidates() {
    return this.candidates;
  }
  async listTargetingForVersions() {
    return this.targeting;
  }
  async insertClick(c: ClickInsert) {
    if (this.insertError) throw this.insertError;
    this.clicks.push(c);
  }
}

interface Rig {
  reads: FakeReads;
  ledger: MemoryCapLedger;
  deferred: Promise<void>[];
  invalidated: string[];
  deferredErrors: unknown[];
  svc: RedirectService;
}

function rig(over: { invalidate?: (id: string) => Promise<void>; clickIds?: string[]; salt?: string | null; random?: () => number } = {}): Rig {
  const reads = new FakeReads();
  const ledger = new MemoryCapLedger();
  const deferred: Promise<void>[] = [];
  const invalidated: string[] = [];
  const deferredErrors: unknown[] = [];
  const ids = [...(over.clickIds ?? [])];
  let n = 0;
  const svc = new RedirectService({
    reads,
    ledger,
    onCapExhausted:
      over.invalidate ??
      (async (id) => {
        invalidated.push(id);
      }),
    defer: (p) => deferred.push(p),
    onDeferredError: (e) => deferredErrors.push(e),
    clock: () => NOW,
    random: over.random ?? (() => 0),
    newClickId: () => ids.shift() ?? `clk_${++n}`,
    signalSalt: over.salt === undefined ? SALT : over.salt,
  });
  return { reads, ledger, deferred, invalidated, deferredErrors, svc };
}

function req(over: Partial<RedirectRequest> = {}, headers: Record<string, string> = {}): RedirectRequest {
  const h: Record<string, string> = {
    "cf-connecting-ip": "203.0.113.9",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "accept-language": "de-DE,de;q=0.9",
    referer: "https://blog.example/post?utm=1",
    "cf-ipcountry": "DE",
    "cf-region-code": "BE",
    ...headers,
  };
  return { code: CODE, query: {}, header: (name) => h[name.toLowerCase()], request_id: "req_1", ...over };
}

function seedExhausted(ledger: MemoryCapLedger, offerId: string, cap: CapCounter["cap_type"], limit: number, currency: string | null = null) {
  const period = cap.startsWith("DAILY") ? "2026-06-01" : cap.startsWith("MONTHLY") ? "2026-06" : "TOTAL";
  ledger.seed(offerId, [{ cap_type: cap, period_key: period, limit_value: limit, current_value: limit, currency, exhausted_at: NOW.toISOString() }]);
}

describe("RedirectService — tracking links (/t/:code)", () => {
  it("redirects an ACTIVE link on a LIVE offer: one lookup, one click row, click_id handed to the advertiser", async () => {
    const r = rig({ clickIds: ["clk_fixed"] });
    r.reads.link = linkRow();
    const res = await r.svc.redirectTrackingLink(req({ query: { sub2: "camp-7" } }));
    expect(res).toEqual({
      kind: "REDIRECT",
      location: "https://adv.example/land?src=tvh&click_id=clk_fixed",
      click_id: "clk_fixed",
      decision_reason_code: "TRACKING_LINK",
    });
    expect(r.reads.lookups).toBe(1);
    expect(r.reads.clicks).toHaveLength(1);
    const c = r.reads.clicks[0]!;
    expect(c.id).toBe("clk_fixed");
    expect(c.organization_id).toBe("org_aff");
    expect(c.offer_organization_id).toBe("org_adv");
    expect(c.tracking_link_id).toBe("lnk_1");
    expect(c.smartlink_id).toBeNull();
    expect(c.offer_version_id).toBe("ver_1");
    expect(c.subs).toEqual({ sub1: "default-1", sub2: "camp-7", sub3: null, sub4: null, sub5: null });
    expect(c.country_code).toBe("DE");
    expect(c.region_code).toBe("BE");
    expect(c.device_type).toBe("MOBILE");
    expect(c.language).toBe("de-de");
    expect(c.referrer_host).toBe("blog.example");
    expect(c.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.destination_url).toBe("https://adv.example/land?src=tvh&click_id=clk_fixed");
    expect(c.request_id).toBe("req_1");
    // No deferred work on the plain happy path.
    expect(r.deferred).toHaveLength(0);
  });

  it("every click gets a unique click id (PRD §115)", async () => {
    const r = rig();
    r.reads.link = linkRow();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = await r.svc.redirectTrackingLink(req());
      if (res.kind !== "REDIRECT") throw new Error("expected redirect");
      ids.add(res.click_id!);
    }
    expect(ids.size).toBe(50);
    expect(new Set(r.reads.clicks.map((c) => c.id)).size).toBe(50);
  });

  it("expands {click_id}/{sub*} macros instead of appending when the destination declares them", async () => {
    const r = rig({ clickIds: ["clk_m"] });
    r.reads.link = linkRow({ offer_destination_url: "https://adv.example/l?cid={CLICK_ID}&s1={sub1}&s2={sub2}&x={unknown}" });
    const res = await r.svc.redirectTrackingLink(req({ query: { sub2: "a b&c" } }));
    expect(res.kind).toBe("REDIRECT");
    if (res.kind !== "REDIRECT") return;
    expect(res.location).toBe("https://adv.example/l?cid=clk_m&s1=default-1&s2=a%20b%26c&x={unknown}");
  });

  it("silently drops bad sub-IDs (email-shaped / too long) — the click is never lost (§130)", async () => {
    const r = rig();
    r.reads.link = linkRow();
    const res = await r.svc.redirectTrackingLink(req({ query: { sub1: "person@mail.example", sub3: "x".repeat(300), sub4: "ok" } }));
    expect(res.kind).toBe("REDIRECT");
    expect(r.reads.clicks[0]!.subs).toEqual({ sub1: "default-1", sub2: null, sub3: null, sub4: "ok", sub5: null });
  });

  it("is case-insensitive on the code and rejects junk without a lookup", async () => {
    const r = rig();
    r.reads.link = linkRow();
    expect((await r.svc.redirectTrackingLink(req({ code: CODE.toLowerCase() }))).kind).toBe("REDIRECT");
    for (const bad of ["", "abc", "ABCDEF23456O", "../etc/passwd", "ABCDEF2345678901234567890123456789012345"]) {
      const before = r.reads.lookups;
      expect(await r.svc.redirectTrackingLink(req({ code: bad }))).toEqual({ kind: "NOT_FOUND", reason: "INVALID_CODE" });
      expect(r.reads.lookups).toBe(before);
    }
  });

  it("unknown code → NOT_FOUND, no click", async () => {
    const r = rig();
    expect(await r.svc.redirectTrackingLink(req())).toEqual({ kind: "NOT_FOUND", reason: "LINK_NOT_FOUND" });
    expect(r.reads.clicks).toHaveLength(0);
  });

  it("ineligible offer (not LIVE / no version / expired / private without grant) → NOT_FOUND, never a click", async () => {
    const cases: Partial<ResolvedTrackingLinkRow>[] = [
      { offer_status: "PAUSED" },
      { offer_status: "ARCHIVED" },
      { offer_version_id: null, offer_destination_url: null },
      { targeting_ends_at: "2026-05-01T00:00:00.000Z" },
      { targeting_starts_at: "2026-07-01T00:00:00.000Z" },
      { offer_access_mode: "PRIVATE", grant_status: null },
      { offer_access_mode: "PRIVATE", grant_status: "REVOKED" },
    ];
    for (const over of cases) {
      const r = rig();
      r.reads.link = linkRow(over);
      expect(await r.svc.redirectTrackingLink(req())).toEqual({ kind: "NOT_FOUND", reason: "OFFER_INELIGIBLE" });
      expect(r.reads.clicks).toHaveLength(0);
    }
    const ok = rig();
    ok.reads.link = linkRow({ offer_access_mode: "PRIVATE", grant_status: "APPROVED" });
    expect((await ok.svc.redirectTrackingLink(req())).kind).toBe("REDIRECT");
  });

  it("uncapped offers never touch the ledger; conversion cap / budget exhaustion denies and schedules invalidation (deferred)", async () => {
    const r = rig();
    let ledgerCalls = 0;
    const origStatus = r.ledger.status.bind(r.ledger);
    r.ledger.status = async (...a: Parameters<MemoryCapLedger["status"]>) => {
      ledgerCalls++;
      return origStatus(...a);
    };
    r.reads.link = linkRow();
    expect((await r.svc.redirectTrackingLink(req())).kind).toBe("REDIRECT");
    expect(ledgerCalls).toBe(0);

    // Daily conversion cap reached → no traffic.
    r.reads.link = linkRow({ daily_conversion_cap: 10 });
    seedExhausted(r.ledger, "off_1", "DAILY_CONVERSION", 10);
    expect(await r.svc.redirectTrackingLink(req())).toEqual({ kind: "NOT_FOUND", reason: "CAP_EXHAUSTED" });
    expect(ledgerCalls).toBe(1);
    expect(r.reads.clicks).toHaveLength(1);
    // Invalidation is deferred, not awaited on the hot path.
    expect(r.deferred).toHaveLength(1);
    await Promise.all(r.deferred);
    expect(r.invalidated).toEqual(["off_1"]);

    // Budget exhausted → BUDGET_EXHAUSTED.
    const b = rig();
    b.reads.link = linkRow({ offer_id: "off_b", budget_minor: 50_000, offer_currency: "USD" });
    seedExhausted(b.ledger, "off_b", "BUDGET", 50_000, "USD");
    expect(await b.svc.redirectTrackingLink(req())).toEqual({ kind: "NOT_FOUND", reason: "BUDGET_EXHAUSTED" });

    // Cap configured but not reached → redirect.
    const c = rig();
    c.reads.link = linkRow({ daily_conversion_cap: 10, budget_minor: 100, offer_currency: "usd" });
    expect((await c.svc.redirectTrackingLink(req())).kind).toBe("REDIRECT");
  });

  it("a failing deferred invalidation never affects the redirect outcome", async () => {
    const r = rig({ invalidate: async () => Promise.reject(new Error("KV down")) });
    r.reads.link = linkRow({ daily_conversion_cap: 1 });
    seedExhausted(r.ledger, "off_1", "DAILY_CONVERSION", 1);
    const res = await r.svc.redirectTrackingLink(req());
    expect(res).toEqual({ kind: "NOT_FOUND", reason: "CAP_EXHAUSTED" });
    await expect(Promise.all(r.deferred)).resolves.toBeDefined();
    expect(r.deferredErrors).toHaveLength(1);
    expect((r.deferredErrors[0] as Error).message).toBe("KV down");
  });

  it("ledger infrastructure failure on a CAPPED offer fails closed (CapLedgerUnavailableError), no click", async () => {
    const r = rig();
    r.ledger.status = async () => {
      throw new Error("DO unreachable");
    };
    r.reads.link = linkRow({ total_conversion_cap: 5 });
    await expect(r.svc.redirectTrackingLink(req())).rejects.toBeInstanceOf(CapLedgerUnavailableError);
    expect(r.reads.clicks).toHaveLength(0);
    // …but an uncapped offer is unaffected by the outage.
    r.reads.link = linkRow();
    expect((await r.svc.redirectTrackingLink(req())).kind).toBe("REDIRECT");
  });

  it("without CLICK_SIGNAL_SALT no IP / UA hash is written; coarse signals still are", async () => {
    const r = rig({ salt: null });
    r.reads.link = linkRow();
    await r.svc.redirectTrackingLink(req());
    const c = r.reads.clicks[0]!;
    expect(c.ip_hash).toBeNull();
    expect(c.user_agent_hash).toBeNull();
    expect(c.country_code).toBe("DE");
  });
});

describe("RedirectService — SmartLinks (/s/:code)", () => {
  it("routes through the engine, records mode/algorithm/reason, and hands the click_id to the picked offer", async () => {
    const r = rig({ clickIds: ["clk_s"] });
    r.reads.smart = smartRow();
    r.reads.candidates = [candRow("o2", { priority: 20 }), candRow("o1", { priority: 10 })];
    const res = await r.svc.redirectSmartLink(req({ query: { sub1: "s" } }));
    expect(res.kind).toBe("REDIRECT");
    if (res.kind !== "REDIRECT") return;
    expect(res.location).toBe("https://o1.example/land?click_id=clk_s");
    const c = r.reads.clicks[0]!;
    expect(c.smartlink_id).toBe("sl_1");
    expect(c.tracking_link_id).toBeNull();
    expect(c.offer_id).toBe("o1");
    expect(c.offer_version_id).toBe("ver_o1");
    expect(c.routing_mode).toBe("RULE_BASED");
    expect(c.routing_algorithm_version).toMatch(/^smartlink-v/);
    expect(c.decision_reason_code).toBeTruthy();
    expect(c.failover_from_offer_id).toBeNull();
    expect(c.subs.sub1).toBe("s");
  });

  it("an inactive offer in the pool never receives traffic — not even via failover (PRD §115)", async () => {
    const r = rig();
    r.reads.smart = smartRow();
    r.reads.candidates = [
      candRow("paused", { priority: 1, offer_status: "PAUSED" }),
      candRow("capped", { priority: 2, daily_conversion_cap: 3 }),
      candRow("archived", { priority: 3, offer_status: "ARCHIVED" }),
      candRow("live", { priority: 4 }),
    ];
    seedExhausted(r.ledger, "capped", "DAILY_CONVERSION", 3);
    const res = await r.svc.redirectSmartLink(req());
    expect(res.kind).toBe("REDIRECT");
    if (res.kind !== "REDIRECT") return;
    expect(res.location.startsWith("https://live.example/")).toBe(true);
    const c = r.reads.clicks[0]!;
    expect(c.offer_id).toBe("live");
    expect(c.failover_from_offer_id).toBe("capped");
    await Promise.all(r.deferred);
    expect(r.invalidated).toEqual(["capped"]);
  });

  it("targeting mismatch excludes a candidate (fail closed on unknown country)", async () => {
    const r = rig();
    r.reads.smart = smartRow({ routing_mode: "GEO_BASED" });
    r.reads.candidates = [candRow("us_only", { priority: 1 }), candRow("open", { priority: 2 })];
    r.reads.targeting = [{ offer_version_id: "ver_us_only", dimension: "COUNTRY", value: "US" }];
    const de = await r.svc.redirectSmartLink(req());
    expect(de.kind === "REDIRECT" && r.reads.clicks[0]!.offer_id).toBe("open");
    const us = await r.svc.redirectSmartLink(req({}, { "cf-ipcountry": "US" }));
    expect(us.kind === "REDIRECT" && r.reads.clicks[1]!.offer_id).toBe("us_only");
    const unknown = await r.svc.redirectSmartLink(req({}, { "cf-ipcountry": "XX" }));
    expect(unknown.kind === "REDIRECT" && r.reads.clicks[2]!.offer_id).toBe("open");
  });

  it("no eligible offer: fallback_url → redirect WITHOUT a click row; no fallback → NOT_FOUND", async () => {
    const r = rig();
    r.reads.smart = smartRow({ fallback_url: "https://fallback.example/" });
    r.reads.candidates = [candRow("p", { offer_status: "PAUSED" })];
    const res = await r.svc.redirectSmartLink(req());
    expect(res).toEqual({
      kind: "REDIRECT",
      location: "https://fallback.example/",
      click_id: null,
      decision_reason_code: "NO_ELIGIBLE_OFFER_FALLBACK",
    });
    expect(r.reads.clicks).toHaveLength(0);

    const n = rig();
    n.reads.smart = smartRow();
    n.reads.candidates = [candRow("p", { offer_status: "PAUSED" })];
    expect(await n.svc.redirectSmartLink(req())).toEqual({ kind: "NOT_FOUND", reason: "NO_ELIGIBLE_OFFER" });
    const e = rig();
    e.reads.smart = smartRow();
    expect(await e.svc.redirectSmartLink(req())).toEqual({ kind: "NOT_FOUND", reason: "NO_ELIGIBLE_OFFER" });
  });

  it("unknown / invalid SmartLink code → NOT_FOUND", async () => {
    const r = rig();
    expect(await r.svc.redirectSmartLink(req())).toEqual({ kind: "NOT_FOUND", reason: "SMARTLINK_NOT_FOUND" });
    expect(await r.svc.redirectSmartLink(req({ code: "nope" }))).toEqual({ kind: "NOT_FOUND", reason: "INVALID_CODE" });
  });

  it("when every candidate is cap-exhausted the SmartLink routes nothing (or the fallback)", async () => {
    const r = rig();
    r.reads.smart = smartRow();
    r.reads.candidates = [candRow("a", { daily_conversion_cap: 1 }), candRow("b", { total_conversion_cap: 1 })];
    seedExhausted(r.ledger, "a", "DAILY_CONVERSION", 1);
    seedExhausted(r.ledger, "b", "TOTAL_CONVERSION", 1);
    expect(await r.svc.redirectSmartLink(req())).toEqual({ kind: "NOT_FOUND", reason: "NO_ELIGIBLE_OFFER" });
    expect(r.reads.clicks).toHaveLength(0);
  });
});

describe("buildDestination", () => {
  it("appends click_id when absent, respects existing query, expands case-insensitive macros", () => {
    const v = { click_id: "c1", offer_id: "o1", sub1: "x", sub2: null, sub3: null, sub4: null, sub5: null };
    expect(buildDestination("https://a.example/", v)).toBe("https://a.example/?click_id=c1");
    expect(buildDestination("https://a.example/p?q=1", v)).toBe("https://a.example/p?q=1&click_id=c1");
    expect(buildDestination("https://a.example/p?c={Click_Id}&o={offer_id}&s={sub2}", v)).toBe("https://a.example/p?c=c1&o=o1&s=");
    expect(buildDestination("https://a.example/", { ...v, click_id: null })).toBe("https://a.example/");
  });
});
