/**
 * Phase 3 Unit 4 — cap protection pure core (PRD §30, §44, §45).
 * Deterministic: every call passes `now`.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryCapLedger,
  UNCAPPED,
  capLimitsFromVersion,
  capStateFromRows,
  emptyCapState,
  hasClickCaps,
  hasConversionCaps,
  isExhausted,
  periodKeyFor,
  pruneClosedPeriods,
  reserve,
  status,
  type CapLimits,
} from "./caps";

const T0 = new Date("2026-03-15T10:00:00.000Z");
const NEXT_DAY = new Date("2026-03-16T00:00:00.000Z");
const NEXT_MONTH = new Date("2026-04-01T00:00:00.000Z");

const conv = (amount_minor: number, currency = "USD") => ({ kind: "CONVERSION" as const, amount_minor, currency });
const CLICK = { kind: "CLICK" as const };

describe("caps: period keys", () => {
  it("derives UTC day / month / TOTAL keys per cap type", () => {
    expect(periodKeyFor("DAILY_CLICK", T0)).toBe("2026-03-15");
    expect(periodKeyFor("DAILY_CONVERSION", T0)).toBe("2026-03-15");
    expect(periodKeyFor("MONTHLY_CLICK", T0)).toBe("2026-03");
    expect(periodKeyFor("MONTHLY_CONVERSION", T0)).toBe("2026-03");
    expect(periodKeyFor("TOTAL_CLICK", T0)).toBe("TOTAL");
    expect(periodKeyFor("TOTAL_CONVERSION", T0)).toBe("TOTAL");
    expect(periodKeyFor("BUDGET", T0)).toBe("TOTAL");
    // 23:59:59.999Z stays on the same UTC day.
    expect(periodKeyFor("DAILY_CLICK", new Date("2026-03-15T23:59:59.999Z"))).toBe("2026-03-15");
  });
});

describe("caps: click caps", () => {
  it("allows up to the daily limit and denies the (n+1)th click without incrementing", () => {
    const s = emptyCapState();
    const limits: CapLimits = { ...UNCAPPED, daily_click_cap: 3 };
    for (let i = 1; i <= 3; i++) {
      const d = reserve(s, limits, CLICK, T0);
      expect(d.allowed, `click ${i}`).toBe(true);
    }
    const denied = reserve(s, limits, CLICK, T0);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("CAP_EXHAUSTED");
      expect(denied.cap_type).toBe("DAILY_CLICK");
    }
    const daily = status(s, limits, "CLICK", T0).find((c) => c.cap_type === "DAILY_CLICK")!;
    expect(daily.current_value).toBe(3); // NOT 4
    expect(daily.exhausted_at).toBe(T0.toISOString());
    expect(isExhausted(s, limits, "CLICK", T0)).toBe(true);
  });

  it("reports newly_exhausted exactly once, on the increment that reaches the limit", () => {
    const s = emptyCapState();
    const limits: CapLimits = { ...UNCAPPED, total_click_cap: 2 };
    const a = reserve(s, limits, CLICK, T0);
    const b = reserve(s, limits, CLICK, T0);
    expect(a.allowed && a.newly_exhausted).toEqual([]);
    expect(b.allowed && b.newly_exhausted).toEqual(["TOTAL_CLICK"]);
    const c = reserve(s, limits, CLICK, T0);
    expect(c.allowed).toBe(false);
  });

  it("resets DAILY and MONTHLY counters on a new period while TOTAL persists", () => {
    const s = emptyCapState();
    const limits: CapLimits = { ...UNCAPPED, daily_click_cap: 1, monthly_click_cap: 2, total_click_cap: 3 };
    expect(reserve(s, limits, CLICK, T0).allowed).toBe(true);
    expect(reserve(s, limits, CLICK, T0).allowed).toBe(false); // daily hit
    expect(reserve(s, limits, CLICK, NEXT_DAY).allowed).toBe(true); // new day, monthly=2 → hit
    const md = reserve(s, limits, CLICK, new Date("2026-03-17T00:00:00.000Z"));
    expect(md.allowed).toBe(false);
    if (!md.allowed) expect(md.cap_type).toBe("MONTHLY_CLICK");
    expect(reserve(s, limits, CLICK, NEXT_MONTH).allowed).toBe(true); // total=3 → hit
    const td = reserve(s, limits, CLICK, new Date("2026-05-01T00:00:00.000Z"));
    expect(td.allowed).toBe(false);
    if (!td.allowed) expect(td.cap_type).toBe("TOTAL_CLICK");
    // Old periods can be pruned; TOTAL never is.
    const removed = pruneClosedPeriods(s, new Date("2026-05-01T00:00:00.000Z"));
    // Every period a reserve touched (including the denied ones, which open the counter) is closed.
    expect(removed.map((c) => c.period_key).sort()).toEqual(["2026-03", "2026-03-15", "2026-03-16", "2026-03-17", "2026-04", "2026-04-01"]);
    expect([...s.values()].map((c) => c.period_key)).toEqual(["TOTAL"]);
  });

  it("treats a null limit as uncapped (still counts) and a 0 limit as deny-all", () => {
    const s = emptyCapState();
    for (let i = 0; i < 50; i++) expect(reserve(s, UNCAPPED, CLICK, T0).allowed).toBe(true);
    expect(status(s, UNCAPPED, "CLICK", T0).find((c) => c.cap_type === "TOTAL_CLICK")!.current_value).toBe(50);
    expect(isExhausted(s, UNCAPPED, "CLICK", T0)).toBe(false);
    const zero = reserve(emptyCapState(), { ...UNCAPPED, daily_click_cap: 0 }, CLICK, T0);
    expect(zero.allowed).toBe(false);
  });

  it("never lets a click touch conversion caps or vice versa", () => {
    const s = emptyCapState();
    const limits: CapLimits = { ...UNCAPPED, daily_click_cap: 1, daily_conversion_cap: 1 };
    expect(reserve(s, limits, CLICK, T0).allowed).toBe(true);
    expect(reserve(s, limits, CLICK, T0).allowed).toBe(false);
    expect(reserve(s, limits, conv(0), T0).allowed).toBe(true); // conversion cap untouched by clicks
    expect(reserve(s, limits, conv(0), T0).allowed).toBe(false);
  });
});

describe("caps: conversion + budget caps (integer minor units)", () => {
  const limits: CapLimits = { ...UNCAPPED, daily_conversion_cap: 10, budget_minor: 10_000, currency: "USD" };

  it("spends integer minor units against the budget and denies the reserve that would overshoot", () => {
    const s = emptyCapState();
    expect(reserve(s, limits, conv(4_000), T0).allowed).toBe(true);
    expect(reserve(s, limits, conv(4_000), T0).allowed).toBe(true);
    const over = reserve(s, limits, conv(2_001), T0); // 8000 + 2001 > 10000
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.reason).toBe("BUDGET_EXHAUSTED");
      expect(over.cap_type).toBe("BUDGET");
    }
    const budget = status(s, limits, "CONVERSION", T0).find((c) => c.cap_type === "BUDGET")!;
    expect(budget.current_value).toBe(8_000); // denial did not spend
    expect(budget.currency).toBe("USD");
    // The exact remainder fits and exhausts.
    const exact = reserve(s, limits, conv(2_000), T0);
    expect(exact.allowed && exact.newly_exhausted).toEqual(["BUDGET"]);
    expect(isExhausted(s, limits, "CONVERSION", T0)).toBe(true);
    // Conversion count advanced only for the 3 accepted reserves.
    expect(status(s, limits, "CONVERSION", T0).find((c) => c.cap_type === "DAILY_CONVERSION")!.current_value).toBe(3);
  });

  it("denies a float, negative or unsafe amount before touching any counter", () => {
    const s = emptyCapState();
    for (const bad of [12.5, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = reserve(s, limits, conv(bad), T0);
      expect(d.allowed, String(bad)).toBe(false);
      if (!d.allowed) expect(d.reason).toBe("INVALID_AMOUNT");
    }
    expect(status(s, limits, "CONVERSION", T0).every((c) => c.current_value === 0)).toBe(true);
  });

  it("denies a currency mismatch against a budget cap (fail closed) but ignores currency when unbudgeted", () => {
    const s = emptyCapState();
    const d = reserve(s, limits, conv(100, "EUR"), T0);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("CURRENCY_MISMATCH");
    expect(reserve(s, limits, conv(100, "usd"), T0).allowed).toBe(true); // case-insensitive
    const noBudget: CapLimits = { ...UNCAPPED, daily_conversion_cap: 5 };
    expect(reserve(emptyCapState(), noBudget, conv(100, "EUR"), T0).allowed).toBe(true);
  });

  it("checks all applicable caps atomically: a conversion-count breach spends no budget", () => {
    const s = emptyCapState();
    const tight: CapLimits = { ...UNCAPPED, daily_conversion_cap: 1, budget_minor: 1_000_000, currency: "USD" };
    expect(reserve(s, tight, conv(500), T0).allowed).toBe(true);
    const d = reserve(s, tight, conv(500), T0);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.cap_type).toBe("DAILY_CONVERSION");
    expect(status(s, tight, "CONVERSION", T0).find((c) => c.cap_type === "BUDGET")!.current_value).toBe(500);
  });

  it("applies a raised limit mid-period and un-exhausts the counter", () => {
    const s = emptyCapState();
    const l1: CapLimits = { ...UNCAPPED, total_conversion_cap: 1 };
    expect(reserve(s, l1, conv(0), T0).allowed).toBe(true);
    expect(reserve(s, l1, conv(0), T0).allowed).toBe(false);
    const l2: CapLimits = { ...UNCAPPED, total_conversion_cap: 3 };
    const d = reserve(s, l2, conv(0), T0);
    expect(d.allowed).toBe(true);
    expect(status(s, l2, "CONVERSION", T0).find((c) => c.cap_type === "TOTAL_CONVERSION")!.exhausted_at).toBeNull();
  });
});

describe("caps: limits from an offer version & state rebuild", () => {
  it("maps 0007 version caps to limits; corrupt values fail closed (0), never uncapped", () => {
    const l = capLimitsFromVersion({ daily_conversion_cap: 5, total_conversion_cap: null, budget_minor: 250_000, currency: "usd" });
    expect(l.daily_conversion_cap).toBe(5);
    expect(l.total_conversion_cap).toBeNull();
    expect(l.budget_minor).toBe(250_000);
    expect(l.currency).toBe("USD");
    expect(hasConversionCaps(l)).toBe(true);
    expect(hasClickCaps(l)).toBe(false);
    const corrupt = capLimitsFromVersion({ daily_conversion_cap: 2.5, total_conversion_cap: -1, budget_minor: null, currency: "USD" });
    expect(corrupt.daily_conversion_cap).toBe(0);
    expect(corrupt.total_conversion_cap).toBe(0);
    expect(corrupt.currency).toBeNull();
    const none = capLimitsFromVersion({ daily_conversion_cap: null, total_conversion_cap: null, budget_minor: null, currency: "USD" });
    expect(hasConversionCaps(none)).toBe(false);
  });

  it("rebuilds from persisted rows and continues counting from the snapshot", () => {
    const s = capStateFromRows([
      { cap_type: "TOTAL_CLICK", period_key: "TOTAL", limit_value: 5, current_value: 4, currency: null, exhausted_at: null },
    ]);
    const limits: CapLimits = { ...UNCAPPED, total_click_cap: 5 };
    const d = reserve(s, limits, CLICK, T0);
    expect(d.allowed && d.newly_exhausted).toEqual(["TOTAL_CLICK"]);
    expect(reserve(s, limits, CLICK, T0).allowed).toBe(false);
  });

  it("MemoryCapLedger isolates offers and honours the port contract", async () => {
    const ledger = new MemoryCapLedger();
    const limits: CapLimits = { ...UNCAPPED, total_click_cap: 1 };
    const base = { organization_id: "org-adv", limits, event: CLICK, now: T0 };
    expect((await ledger.reserve({ ...base, offer_id: "o1" })).allowed).toBe(true);
    expect((await ledger.reserve({ ...base, offer_id: "o1" })).allowed).toBe(false);
    expect((await ledger.reserve({ ...base, offer_id: "o2" })).allowed).toBe(true);
    const st = await ledger.status("o1", limits, "CLICK", T0);
    expect(st.find((c) => c.cap_type === "TOTAL_CLICK")!.current_value).toBe(1);
  });
});
