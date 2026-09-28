import { describe, expect, it } from "vitest";
import { decide, dedupKey, secondsBetween, type AttributionPolicyInput, type ClickCandidate } from "./attribution";

const OFFER = "offer-a";
const OTHER = "offer-b";
const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

const policy = (over: Partial<AttributionPolicyInput> = {}): AttributionPolicyInput => ({
  id: "policy-v1",
  model: "LAST_CLICK",
  window_seconds: 3600,
  dedup_scope: "EXTERNAL_CONVERSION_ID",
  fallback_rule: "REJECT",
  ...over,
});

const click = (id: string, at: number, offer_id = OFFER, organization_id = "aff-1"): ClickCandidate => ({
  id,
  offer_id,
  organization_id,
  clicked_at: iso(at),
});

const conv = (over: Partial<{ offer_id: string; occurred_at: string; click_id: string | null }> = {}) => ({
  offer_id: OFFER,
  occurred_at: iso(0),
  click_id: null,
  ...over,
});

describe("attribution engine — decide()", () => {
  it("LAST_CLICK picks the newest in-window click at or before the conversion and records the click→conversion age", () => {
    const r = decide({
      policy: policy(),
      conversion: conv(),
      candidates: [click("c-old", -3000), click("c-new", -120), click("c-future", 30)],
      duplicateOf: false,
    });
    expect(r).toEqual({
      decision: "ATTRIBUTED",
      reason_code: "CLICK_MATCHED_LAST",
      click_id: "c-new",
      affiliate_organization_id: "aff-1",
      click_to_conversion_seconds: 120,
    });
  });

  it("FIRST_CLICK picks the oldest in-window click", () => {
    const r = decide({
      policy: policy({ model: "FIRST_CLICK" }),
      conversion: conv(),
      candidates: [click("c-new", -120), click("c-old", -3000, OFFER, "aff-2")],
      duplicateOf: false,
    });
    expect(r.decision).toBe("ATTRIBUTED");
    expect(r.reason_code).toBe("CLICK_MATCHED_FIRST");
    expect(r.click_id).toBe("c-old");
    expect(r.affiliate_organization_id).toBe("aff-2");
    expect(r.click_to_conversion_seconds).toBe(3000);
  });

  it("is deterministic on ties regardless of candidate order", () => {
    const a = decide({ policy: policy(), conversion: conv(), candidates: [click("c-1", -10), click("c-2", -10)], duplicateOf: false });
    const b = decide({ policy: policy(), conversion: conv(), candidates: [click("c-2", -10), click("c-1", -10)], duplicateOf: false });
    expect(a.click_id).toBe("c-2");
    expect(b.click_id).toBe("c-2");
  });

  it("a click exactly at the window edge still qualifies; one second past it does not", () => {
    const edge = decide({ policy: policy(), conversion: conv(), candidates: [click("c", -3600)], duplicateOf: false });
    expect(edge.decision).toBe("ATTRIBUTED");
    const past = decide({ policy: policy(), conversion: conv(), candidates: [click("c", -3601)], duplicateOf: false });
    expect(past).toMatchObject({ decision: "REJECTED", reason_code: "WINDOW_EXPIRED", click_id: null });
  });

  it("a longer configured window attributes what a shorter one rejects (configurable windows)", () => {
    const short = decide({ policy: policy({ window_seconds: 60 }), conversion: conv(), candidates: [click("c", -3000)], duplicateOf: false });
    const long = decide({ policy: policy({ window_seconds: 86400 }), conversion: conv(), candidates: [click("c", -3000)], duplicateOf: false });
    expect(short.decision).toBe("REJECTED");
    expect(long.decision).toBe("ATTRIBUTED");
  });

  it("no click at all → REJECTED/NO_CLICK_IN_WINDOW under REJECT, HELD under HOLD_FOR_REVIEW", () => {
    const rejected = decide({ policy: policy(), conversion: conv(), candidates: [], duplicateOf: false });
    expect(rejected).toMatchObject({ decision: "REJECTED", reason_code: "NO_CLICK_IN_WINDOW", affiliate_organization_id: null });
    const held = decide({ policy: policy({ fallback_rule: "HOLD_FOR_REVIEW" }), conversion: conv(), candidates: [], duplicateOf: false });
    expect(held).toMatchObject({ decision: "HELD", reason_code: "NO_CLICK_IN_WINDOW", click_id: null });
  });

  it("clicks after the conversion never qualify and are explained as CLICK_AFTER_CONVERSION", () => {
    const r = decide({ policy: policy(), conversion: conv(), candidates: [click("c", 5)], duplicateOf: false });
    expect(r).toMatchObject({ decision: "REJECTED", reason_code: "CLICK_AFTER_CONVERSION" });
  });

  it("clicks for another offer are ignored, never re-attributed", () => {
    const r = decide({ policy: policy(), conversion: conv(), candidates: [click("x", -10, OTHER)], duplicateOf: false });
    expect(r).toMatchObject({ decision: "REJECTED", reason_code: "NO_CLICK_IN_WINDOW", click_id: null });
  });

  describe("echoed click_id", () => {
    it("attributes to the echoed click even when a newer click exists", () => {
      const r = decide({
        policy: policy(),
        conversion: conv({ click_id: "c-old" }),
        candidates: [click("c-old", -3000, OFFER, "aff-old"), click("c-new", -10, OFFER, "aff-new")],
        duplicateOf: false,
      });
      expect(r).toMatchObject({
        decision: "ATTRIBUTED",
        reason_code: "CLICK_MATCHED_ECHOED",
        click_id: "c-old",
        affiliate_organization_id: "aff-old",
        click_to_conversion_seconds: 3000,
      });
    });

    it("an echoed click belonging to a different offer is CLICK_OFFER_MISMATCH — REJECTED regardless of fallback rule", () => {
      const r = decide({
        policy: policy({ fallback_rule: "HOLD_FOR_REVIEW" }),
        conversion: conv({ click_id: "x" }),
        candidates: [click("x", -10, OTHER), click("ok", -20)],
        duplicateOf: false,
      });
      expect(r).toMatchObject({ decision: "REJECTED", reason_code: "CLICK_OFFER_MISMATCH", click_id: null });
    });

    it("an echoed click that is not among the candidates → CLICK_NOT_FOUND via the fallback rule", () => {
      const r = decide({ policy: policy(), conversion: conv({ click_id: "ghost" }), candidates: [click("ok", -20)], duplicateOf: false });
      expect(r).toMatchObject({ decision: "REJECTED", reason_code: "CLICK_NOT_FOUND" });
      const held = decide({
        policy: policy({ fallback_rule: "HOLD_FOR_REVIEW" }),
        conversion: conv({ click_id: "ghost" }),
        candidates: [],
        duplicateOf: false,
      });
      expect(held.decision).toBe("HELD");
    });

    it("an echoed click outside the window → WINDOW_EXPIRED; after the conversion → CLICK_AFTER_CONVERSION", () => {
      const expired = decide({ policy: policy(), conversion: conv({ click_id: "c" }), candidates: [click("c", -7200)], duplicateOf: false });
      expect(expired).toMatchObject({ decision: "REJECTED", reason_code: "WINDOW_EXPIRED" });
      const after = decide({ policy: policy(), conversion: conv({ click_id: "c" }), candidates: [click("c", 60)], duplicateOf: false });
      expect(after).toMatchObject({ decision: "REJECTED", reason_code: "CLICK_AFTER_CONVERSION" });
    });
  });

  it("DUPLICATE short-circuits everything and names the dedup scope", () => {
    const base = { conversion: conv({ click_id: "c" }), candidates: [click("c", -10)], duplicateOf: true };
    expect(decide({ ...base, policy: policy() })).toMatchObject({ decision: "DUPLICATE", reason_code: "DUPLICATE_EXTERNAL_ID", click_id: null });
    expect(decide({ ...base, policy: policy({ dedup_scope: "TRANSACTION_ID" }) }).reason_code).toBe("DUPLICATE_TRANSACTION_ID");
    expect(decide({ ...base, policy: policy({ dedup_scope: "CLICK_ID_EVENT" }) }).reason_code).toBe("DUPLICATE_CLICK_EVENT");
  });

  it("never throws on unparseable timestamps — the click just fails to qualify", () => {
    const r = decide({
      policy: policy(),
      conversion: conv(),
      candidates: [{ id: "bad", offer_id: OFFER, organization_id: "aff", clicked_at: "not-a-date" }],
      duplicateOf: false,
    });
    expect(r.decision).toBe("REJECTED");
  });
});

describe("secondsBetween / dedupKey", () => {
  it("secondsBetween floors to whole seconds and returns null on garbage", () => {
    expect(secondsBetween(iso(0), iso(90))).toBe(90);
    expect(secondsBetween("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.999Z")).toBe(1);
    expect(secondsBetween("nope", iso(0))).toBeNull();
  });

  it("dedupKey follows the scope and is null when the scope's field is absent", () => {
    const c = { external_conversion_id: "ext-1", transaction_id: null, click_id: null, conversion_event: "signup" };
    expect(dedupKey("EXTERNAL_CONVERSION_ID", c)).toEqual({ column: "external_conversion_id", value: "ext-1" });
    expect(dedupKey("TRANSACTION_ID", c)).toBeNull();
    expect(dedupKey("TRANSACTION_ID", { ...c, transaction_id: "tx-9" })).toEqual({ column: "transaction_id", value: "tx-9" });
    expect(dedupKey("CLICK_ID_EVENT", c)).toBeNull();
    expect(dedupKey("CLICK_ID_EVENT", { ...c, click_id: "ck" })).toEqual({ column: "click_event", value: "ck\u0000signup" });
  });
});
