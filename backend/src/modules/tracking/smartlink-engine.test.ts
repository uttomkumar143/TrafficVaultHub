import { describe, expect, it } from "vitest";
import type { OfferRoutingFacts } from "./eligibility";
import {
  MIN_SAMPLE_CLICKS,
  SMARTLINK_ALGORITHM_VERSION,
  candidateEligibility,
  conversionRateBps,
  failover,
  isRoutingMode,
  route,
  targetingMatches,
  weightedPick,
  type ClickContext,
  type RoutingDecision,
  type SmartLinkCandidate,
  type SmartLinkDefinition,
} from "./smartlink-engine";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function liveFacts(over: Partial<OfferRoutingFacts> = {}): OfferRoutingFacts {
  return {
    status: "LIVE",
    access_mode: "PUBLIC",
    current_version_id: "v1",
    destination_url: "https://adv.example/land",
    targeting_starts_at: null,
    targeting_ends_at: null,
    grant_status: null,
    ...over,
  };
}

function cand(id: string, over: Partial<SmartLinkCandidate> = {}): SmartLinkCandidate {
  return {
    offer_id: id,
    offer_organization_id: `org-${id}`,
    weight: 100,
    priority: 100,
    enabled: true,
    facts: liveFacts({ current_version_id: `${id}-v1`, destination_url: `https://adv.example/${id}` }),
    targeting: [],
    ...over,
  };
}

function ctx(over: Partial<ClickContext> = {}): ClickContext {
  return {
    country_code: "US",
    region_code: null,
    device_type: "MOBILE",
    os_family: null,
    browser_family: null,
    language: null,
    traffic_source_id: null,
    now: NOW,
    ...over,
  };
}

function link(mode: SmartLinkDefinition["routing_mode"], over: Partial<SmartLinkDefinition> = {}): SmartLinkDefinition {
  return { smartlink_id: "sl1", routing_mode: mode, status: "ACTIVE", fallback_url: null, ...over };
}

/** A deterministic random source cycling through the given values. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function offerOf(d: RoutingDecision): string {
  if (d.outcome !== "OFFER") throw new Error(`expected OFFER, got ${d.outcome}`);
  return d.offer_id;
}

describe("smartlink engine — eligibility", () => {
  it("re-uses offerRoutability: PAUSED / no version / no destination / window / access are rejected with their reason", () => {
    const c = ctx();
    expect(candidateEligibility(cand("a", { facts: liveFacts({ status: "PAUSED" }) }), c)).toEqual({ eligible: false, reason: "OFFER_NOT_LIVE" });
    expect(candidateEligibility(cand("a", { facts: liveFacts({ current_version_id: null }) }), c)).toEqual({ eligible: false, reason: "OFFER_NO_VERSION" });
    expect(candidateEligibility(cand("a", { facts: liveFacts({ destination_url: null }) }), c)).toEqual({ eligible: false, reason: "OFFER_NO_DESTINATION" });
    expect(candidateEligibility(cand("a", { facts: liveFacts({ targeting_ends_at: "2026-01-01T00:00:00Z" }) }), c)).toEqual({ eligible: false, reason: "OFFER_EXPIRED" });
    expect(candidateEligibility(cand("a", { facts: liveFacts({ access_mode: "PRIVATE", grant_status: "REVOKED" }) }), c)).toEqual({ eligible: false, reason: "ACCESS_DENIED" });
    expect(candidateEligibility(cand("a"), c)).toEqual({ eligible: true });
  });

  it("click-time facts: disabled, zero weight, caps, budget, tracking, compliance, risk, targeting", () => {
    const c = ctx();
    expect(candidateEligibility(cand("a", { enabled: false }), c)).toEqual({ eligible: false, reason: "CANDIDATE_DISABLED" });
    expect(candidateEligibility(cand("a", { weight: 0 }), c)).toEqual({ eligible: false, reason: "CANDIDATE_ZERO_WEIGHT" });
    expect(candidateEligibility(cand("a", { cap_exhausted: true }), c)).toEqual({ eligible: false, reason: "CAP_EXHAUSTED" });
    expect(candidateEligibility(cand("a", { budget_exhausted: true }), c)).toEqual({ eligible: false, reason: "BUDGET_EXHAUSTED" });
    expect(candidateEligibility(cand("a", { tracking_degraded: true }), c)).toEqual({ eligible: false, reason: "TRACKING_DEGRADED" });
    expect(candidateEligibility(cand("a", { compliance_blocked: true }), c)).toEqual({ eligible: false, reason: "COMPLIANCE_BLOCKED" });
    expect(candidateEligibility(cand("a", { risk_blocked: true }), c)).toEqual({ eligible: false, reason: "RISK_BLOCKED" });
    expect(candidateEligibility(cand("a", { targeting: [{ dimension: "COUNTRY", value: "DE" }] }), c)).toEqual({ eligible: false, reason: "TARGETING_MISMATCH" });
  });

  it("targeting is an allow-list per dimension, case-insensitive, and an unknown click value on a restricted dimension fails closed", () => {
    const rules = [
      { dimension: "COUNTRY" as const, value: "US" },
      { dimension: "COUNTRY" as const, value: "CA" },
      { dimension: "DEVICE" as const, value: "MOBILE" },
    ];
    expect(targetingMatches(rules, ctx({ country_code: "ca", device_type: "MOBILE" }))).toBe(true);
    expect(targetingMatches(rules, ctx({ country_code: "US", device_type: "DESKTOP" }))).toBe(false);
    expect(targetingMatches(rules, ctx({ country_code: null }))).toBe(false);
    expect(targetingMatches([], ctx({ country_code: null, device_type: null }))).toBe(true);
  });
});

describe("smartlink engine — modes", () => {
  it("RULE_BASED: lowest priority wins, ties by highest weight then id; decision is explainable", () => {
    const d = route(link("RULE_BASED"), [cand("b", { priority: 10, weight: 50 }), cand("a", { priority: 10, weight: 90 }), cand("c", { priority: 1, facts: liveFacts({ status: "PAUSED" }) })], ctx());
    expect(offerOf(d)).toBe("a");
    if (d.outcome !== "OFFER") throw new Error();
    expect(d.algorithm_version).toBe(SMARTLINK_ALGORITHM_VERSION);
    expect(d.routing_mode).toBe("RULE_BASED");
    expect(d.decision_reason_code).toBe("RULE_PRIORITY");
    expect(d.offer_version_id).toBe("a-v1");
    expect(d.destination_url).toBe("https://adv.example/a");
    expect(d.eligible_offer_ids.sort()).toEqual(["a", "b"]);
    expect(d.rejected).toEqual([{ offer_id: "c", reason: "OFFER_NOT_LIVE" }]);
    expect(d.failover_from_offer_id).toBeNull();
  });

  it("WEIGHTED: weighted random is deterministic under an injected random and proportional to weight", () => {
    const pool = [cand("a", { weight: 300 }), cand("b", { weight: 100 })];
    expect(offerOf(route(link("WEIGHTED"), pool, ctx(), { random: () => 0.0 }))).toBe("a");
    expect(offerOf(route(link("WEIGHTED"), pool, ctx(), { random: () => 0.74 }))).toBe("a");
    expect(offerOf(route(link("WEIGHTED"), pool, ctx(), { random: () => 0.75 }))).toBe("b");
    expect(offerOf(route(link("WEIGHTED"), pool, ctx(), { random: () => 0.999 }))).toBe("b");
    // Frequency check over a uniform sweep: 3:1.
    let a = 0;
    for (let i = 0; i < 400; i++) if (offerOf(route(link("WEIGHTED"), pool, ctx(), { random: () => i / 400 })) === "a") a++;
    expect(a).toBe(300);
  });

  it("weightedPick rejects a non-[0,1) random and a zero total", () => {
    expect(() => weightedPick([{ weight: 1 }], () => 1)).toThrow();
    expect(() => weightedPick([{ weight: 0 }], () => 0.5)).toThrow();
  });

  it("PERFORMANCE_BASED: best conversion rate (integer bps) wins once sampled; under-sampled candidates get an exploration share", () => {
    expect(conversionRateBps({ clicks: 200, conversions: 7 })).toBe(350);
    expect(conversionRateBps({ clicks: 0, conversions: 0 })).toBe(0);
    expect(conversionRateBps({ clicks: 10, conversions: 50 })).toBe(10_000);
    const pool = [
      cand("low", { stats: { clicks: 1000, conversions: 10 } }),
      cand("high", { stats: { clicks: 1000, conversions: 50 } }),
      cand("new", { stats: { clicks: MIN_SAMPLE_CLICKS - 1, conversions: 5 } }),
    ];
    // random ≥ 0.10 → exploit best CR
    const exploit = route(link("PERFORMANCE_BASED"), pool, ctx(), { random: seq([0.5]) });
    expect(offerOf(exploit)).toBe("high");
    expect(exploit.decision_reason_code).toBe("PERFORMANCE_BEST_CR");
    // random < 0.10 → explore the under-sampled one
    const explore = route(link("PERFORMANCE_BASED"), pool, ctx(), { random: seq([0.05, 0.0]) });
    expect(offerOf(explore)).toBe("new");
    expect(explore.decision_reason_code).toBe("PERFORMANCE_EXPLORE");
    // nothing sampled yet → weighted exploration among all
    expect(offerOf(route(link("PERFORMANCE_BASED"), [cand("x"), cand("y")], ctx(), { random: () => 0.9 }))).toBe("y");
  });

  it("GEO_BASED: a candidate explicitly targeting the click country beats open ones; falls back to open candidates otherwise", () => {
    const pool = [cand("open", { priority: 1 }), cand("de", { priority: 50, targeting: [{ dimension: "COUNTRY", value: "DE" }] }), cand("us", { priority: 50, targeting: [{ dimension: "COUNTRY", value: "US" }] })];
    const us = route(link("GEO_BASED"), pool, ctx({ country_code: "US" }));
    expect(offerOf(us)).toBe("us");
    expect(us.decision_reason_code).toBe("GEO_MATCH:RULE_PRIORITY");
    if (us.outcome !== "OFFER") throw new Error();
    expect(us.rejected).toEqual([{ offer_id: "de", reason: "TARGETING_MISMATCH" }]);
    const fr = route(link("GEO_BASED"), pool, ctx({ country_code: "FR" }));
    expect(offerOf(fr)).toBe("open");
    expect(fr.decision_reason_code).toBe("GEO_OPEN:RULE_PRIORITY");
  });

  it("DEVICE_BASED: device-specific candidate wins on match", () => {
    const pool = [cand("open", { priority: 1 }), cand("mob", { priority: 99, targeting: [{ dimension: "DEVICE", value: "MOBILE" }] })];
    expect(offerOf(route(link("DEVICE_BASED"), pool, ctx({ device_type: "MOBILE" })))).toBe("mob");
    expect(offerOf(route(link("DEVICE_BASED"), pool, ctx({ device_type: "DESKTOP" })))).toBe("open");
  });

  it("HYBRID: most specific tier (country + device) then weighted random inside the tier", () => {
    const pool = [
      cand("open", { weight: 1000 }),
      cand("geo", { weight: 100, targeting: [{ dimension: "COUNTRY", value: "US" }] }),
      cand("both-a", { weight: 100, targeting: [{ dimension: "COUNTRY", value: "US" }, { dimension: "DEVICE", value: "MOBILE" }] }),
      cand("both-b", { weight: 100, targeting: [{ dimension: "COUNTRY", value: "US" }, { dimension: "DEVICE", value: "MOBILE" }] }),
    ];
    const a = route(link("HYBRID"), pool, ctx(), { random: () => 0.1 });
    const b = route(link("HYBRID"), pool, ctx(), { random: () => 0.9 });
    expect(offerOf(a)).toBe("both-a");
    expect(offerOf(b)).toBe("both-b");
    expect(a.decision_reason_code).toBe("HYBRID_MATCH:WEIGHTED_RANDOM");
  });

  it("isRoutingMode guards the PRD §43 vocabulary", () => {
    expect(isRoutingMode("HYBRID")).toBe(true);
    expect(isRoutingMode("RANDOM")).toBe(false);
    expect(isRoutingMode(null)).toBe(false);
  });
});

describe("smartlink engine — never routes to an inactive offer (PRD §46, §115)", () => {
  const MODES = ["RULE_BASED", "WEIGHTED", "PERFORMANCE_BASED", "GEO_BASED", "DEVICE_BASED", "HYBRID"] as const;

  it("in every mode an inactive offer is never selected, even when it is the only high-priority / high-weight / best-performing candidate", () => {
    const inactive = cand("inactive", {
      priority: 0,
      weight: 10_000,
      facts: liveFacts({ status: "PAUSED", current_version_id: "iv", destination_url: "https://adv.example/inactive" }),
      targeting: [{ dimension: "COUNTRY", value: "US" }, { dimension: "DEVICE", value: "MOBILE" }],
      stats: { clicks: 10_000, conversions: 9_000 },
    });
    const live = cand("live", { priority: 999, weight: 1, stats: { clicks: 10_000, conversions: 1 } });
    for (const mode of MODES) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = route(link(mode), [inactive, live], ctx(), { random: () => r });
        expect(offerOf(d)).toBe("live");
      }
    }
  });

  it("with no eligible offer: fallback_url when configured (never an inactive offer), else NO_ELIGIBLE_OFFER with reasons", () => {
    const pool = [cand("p", { facts: liveFacts({ status: "PAUSED" }) }), cand("c", { cap_exhausted: true })];
    const fb = route(link("WEIGHTED", { fallback_url: "https://aff.example/safe" }), pool, ctx());
    expect(fb.outcome).toBe("FALLBACK_URL");
    if (fb.outcome !== "FALLBACK_URL") throw new Error();
    expect(fb.destination_url).toBe("https://aff.example/safe");
    expect(fb.decision_reason_code).toBe("NO_ELIGIBLE_OFFER_FALLBACK");
    expect(fb.rejected).toEqual([{ offer_id: "p", reason: "OFFER_NOT_LIVE" }, { offer_id: "c", reason: "CAP_EXHAUSTED" }]);
    const none = route(link("WEIGHTED"), pool, ctx());
    expect(none.outcome).toBe("NO_ELIGIBLE_OFFER");
    expect(none.decision_reason_code).toBe("NO_ELIGIBLE_OFFER");
    expect(none.algorithm_version).toBe(SMARTLINK_ALGORITHM_VERSION);
  });

  it("a PAUSED / ARCHIVED SmartLink routes nothing (SMARTLINK_INACTIVE) — not even to its fallback", () => {
    const d = route(link("RULE_BASED", { status: "PAUSED", fallback_url: "https://aff.example/safe" }), [cand("a")], ctx());
    expect(d.outcome).toBe("NO_ELIGIBLE_OFFER");
    expect(d.decision_reason_code).toBe("SMARTLINK_INACTIVE");
  });

  it("failover excludes the failed offer, RE-EVALUATES eligibility and records failover_from_offer_id; never lands on an inactive offer", () => {
    const pool = [
      cand("first", { priority: 1 }),
      cand("inactive", { priority: 2, facts: liveFacts({ status: "COMPLIANCE_HOLD" }) }),
      cand("second", { priority: 3 }),
    ];
    const initial = route(link("RULE_BASED"), pool, ctx());
    expect(offerOf(initial)).toBe("first");
    const fo = failover(link("RULE_BASED"), pool, ctx(), "first");
    expect(offerOf(fo)).toBe("second");
    if (fo.outcome !== "OFFER") throw new Error();
    expect(fo.failover_from_offer_id).toBe("first");
    expect(fo.decision_reason_code).toBe("FAILOVER:RULE_PRIORITY");
    expect(fo.rejected).toEqual([
      { offer_id: "first", reason: "FAILOVER_EXCLUDED" },
      { offer_id: "inactive", reason: "OFFER_NOT_LIVE" },
    ]);
    // Facts changed between decision and failover (second went PAUSED): failover sees the fresh facts.
    const changed = pool.map((c) => (c.offer_id === "second" ? cand("second", { priority: 3, facts: liveFacts({ status: "PAUSED" }) }) : c));
    const fo2 = failover(link("RULE_BASED", { fallback_url: "https://aff.example/safe" }), changed, ctx(), "first");
    expect(fo2.outcome).toBe("FALLBACK_URL");
    // Chained failover: excludes accumulate.
    const fo3 = failover(link("RULE_BASED"), pool, ctx(), "second", { exclude: new Set(["first"]) });
    expect(fo3.outcome).toBe("NO_ELIGIBLE_OFFER");
    expect(fo3.failover_from_offer_id).toBe("second");
  });

  it("the selected offer always carries a concrete version id and destination (never null)", () => {
    for (let i = 0; i < 50; i++) {
      const d = route(link("WEIGHTED"), [cand("a"), cand("b"), cand("nov", { facts: liveFacts({ current_version_id: null }) })], ctx(), { random: () => (i % 50) / 50 });
      if (d.outcome !== "OFFER") throw new Error();
      expect(d.offer_version_id).toMatch(/-v1$/);
      expect(d.destination_url).toMatch(/^https:\/\//);
      expect(d.offer_id).not.toBe("nov");
    }
  });
});
