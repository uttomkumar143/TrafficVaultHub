/**
 * Fraud risk engine — Phase 4 Unit 6 tests (PRD §41–§43).
 */
import { describe, expect, it } from "vitest";
import { assessRisk, levelFor, RULE_VERSION, type RiskFacts, THRESHOLDS } from "./risk-engine";

describe("assessRisk", () => {
  it("empty or missing facts fire no signals: score 0, LOW, versioned (never guesses)", () => {
    for (const facts of [{}, { velocity: { window_seconds: 3600 } }, { geo: {} }, { timing: { clicked_at: "2026-01-01T00:00:00Z" } }]) {
      const r = assessRisk(facts as RiskFacts);
      expect(r).toEqual({ rule_version: RULE_VERSION, score: 0, level: "LOW", signals: [] });
    }
    // malformed timestamps → timing signal absent, not guessed
    expect(assessRisk({ timing: { clicked_at: "not-a-date", occurred_at: "2026-01-01T00:00:00Z" } }).signals).toEqual([]);
  });

  it("is deterministic and every signal carries evidence", () => {
    const facts: RiskFacts = {
      velocity: { window_seconds: 3600, conversions_in_window: 50, clicks_in_window: 100 },
      duplicates: { same_transaction_id_count: 2, same_fingerprint_count: 3 },
      timing: { clicked_at: "2026-03-15T11:00:00.000Z", occurred_at: "2026-03-15T11:00:02.000Z" },
      geo: { click_country: "us", conversion_country: "DE", restricted_countries: ["de"] },
      traffic_source: { referrer: "https://evil.example/x", allowed_referrer_hosts: ["good.example"] },
      automation: { user_agent: "Mozilla/5.0 HeadlessChrome/120", same_user_agent_click_count: 50 },
    };
    const a = assessRisk(facts);
    const b = assessRisk(JSON.parse(JSON.stringify(facts)) as RiskFacts);
    expect(a).toEqual(b);
    expect(a.signals.map((s) => s.code)).toEqual([
      "VELOCITY_CONVERSIONS",
      "DUPLICATE_TRANSACTION_ID",
      "DUPLICATE_FINGERPRINT",
      "CLICK_TO_CONVERSION_TOO_FAST",
      "GEO_MISMATCH",
      "GEO_RESTRICTED",
      "REFERRER_DISALLOWED",
      "USER_AGENT_AUTOMATION",
      "USER_AGENT_FANOUT",
    ]);
    for (const s of a.signals) {
      expect(s.weight).toBeGreaterThan(0);
      expect(Object.keys(s.evidence).length).toBeGreaterThan(0);
    }
    expect(a.signals.find((s) => s.code === "GEO_MISMATCH")?.evidence).toEqual({ click_country: "US", conversion_country: "DE" });
    expect(a.signals.find((s) => s.code === "USER_AGENT_AUTOMATION")?.evidence.matched_token).toBe("headless");
    expect(a.score).toBe(100); // clamped
    expect(a.level).toBe("CRITICAL");
  });

  it("maps score to level at the versioned thresholds and clamps to 0..100", () => {
    expect(levelFor(0)).toBe("LOW");
    expect(levelFor(THRESHOLDS.levels.medium - 1)).toBe("LOW");
    expect(levelFor(THRESHOLDS.levels.medium)).toBe("MEDIUM");
    expect(levelFor(THRESHOLDS.levels.high)).toBe("HIGH");
    expect(levelFor(THRESHOLDS.levels.critical)).toBe("CRITICAL");
    expect(levelFor(100)).toBe("CRITICAL");

    // single weak signal stays LOW: a score is evidence, not a verdict
    const weak = assessRisk({ traffic_source: { referrer: null } });
    expect(weak.signals.map((s) => s.code)).toEqual(["REFERRER_MISSING"]);
    expect(weak.level).toBe("LOW");
  });

  it("timing: conversion before click is the strongest timing signal; normal delay fires nothing", () => {
    const before = assessRisk({ timing: { clicked_at: "2026-03-15T11:00:10.000Z", occurred_at: "2026-03-15T11:00:00.000Z" } });
    expect(before.signals.map((s) => s.code)).toEqual(["CONVERSION_BEFORE_CLICK"]);
    expect(before.signals[0]?.evidence.delta_seconds).toBe(-10);

    const normal = assessRisk({ timing: { clicked_at: "2026-03-15T11:00:00.000Z", occurred_at: "2026-03-15T11:30:00.000Z" } });
    expect(normal.signals).toEqual([]);
  });

  it("traffic source: rate anomaly needs both rates and a meaningful baseline; allowed referrer host (incl. subdomain) passes", () => {
    expect(assessRisk({ traffic_source: { conversion_rate_bps: 5000 } }).signals).toEqual([]);
    expect(assessRisk({ traffic_source: { conversion_rate_bps: 5000, baseline_conversion_rate_bps: 1 } }).signals).toEqual([]); // below min baseline
    const anomaly = assessRisk({ traffic_source: { conversion_rate_bps: 6000, baseline_conversion_rate_bps: 1000 } });
    expect(anomaly.signals.map((s) => s.code)).toEqual(["CONVERSION_RATE_ANOMALY"]);
    expect(anomaly.signals[0]?.evidence.ratio_bps).toBe(60_000);

    const ok = assessRisk({ traffic_source: { referrer: "https://blog.good.example/post", allowed_referrer_hosts: ["good.example"] } });
    expect(ok.signals).toEqual([]);
    const noList = assessRisk({ traffic_source: { referrer: "https://anything.example/" } });
    expect(noList.signals).toEqual([]);
  });

  it("velocity and duplicates respect thresholds exactly (below → absent, at/over → present)", () => {
    expect(assessRisk({ velocity: { window_seconds: 3600, conversions_in_window: 20 } }).signals).toEqual([]);
    expect(assessRisk({ velocity: { window_seconds: 3600, conversions_in_window: 21 } }).signals.map((s) => s.code)).toEqual([
      "VELOCITY_CONVERSIONS",
    ]);
    expect(
      assessRisk({ duplicates: { same_transaction_id_count: 1, same_external_id_count: 1, same_fingerprint_count: 2 } }).signals,
    ).toEqual([]);
    expect(assessRisk({ duplicates: { same_external_id_count: 2 } }).signals.map((s) => s.code)).toEqual(["DUPLICATE_EXTERNAL_ID"]);
    expect(assessRisk({ automation: { user_agent: "Mozilla/5.0 (iPhone) Safari", same_user_agent_click_count: 49 } }).signals).toEqual([]);
    expect(assessRisk({ automation: { user_agent: "" } }).signals.map((s) => s.code)).toEqual(["USER_AGENT_MISSING"]);
    // compound tokens: "Googlebot", "python-requests/2.31" are automation; "robotics-news.example" in a UA is not a token hit
    expect(assessRisk({ automation: { user_agent: "Mozilla/5.0 (compatible; Googlebot/2.1)" } }).signals[0]?.evidence.matched_token).toBe(
      "bot",
    );
    expect(assessRisk({ automation: { user_agent: "python-requests/2.31" } }).signals[0]?.evidence.matched_token).toBe("python-requests");
    expect(assessRisk({ automation: { user_agent: "Mozilla/5.0 robotics-news" } }).signals).toEqual([]);
  });
});
