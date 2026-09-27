/**
 * Phase 3 Unit 1 — click id / tracking code generation and PRD §34
 * privacy-conscious sub-ID sanitisation. Pure-module tests (no D1).
 */
import { describe, expect, it } from "vitest";
import {
  generateClickId,
  generateTrackingCode,
  hashSignal,
  isTrackingCode,
  mergeSubIds,
  normalizeTrackingCode,
  sanitizeSubIds,
  SUB_ID_MAX_LENGTH,
  TRACKING_CODE_LENGTH,
} from "./ids";

describe("tracking ids: click id (PRD §32, §115)", () => {
  it("generates a globally unique v4 UUID click id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(generateClickId());
    expect(ids.size).toBe(10_000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("tracking ids: public tracking code", () => {
  it("mints 12-char Crockford base32 codes (no I/L/O/U) that pass the shape check", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateTrackingCode();
      expect(code).toHaveLength(TRACKING_CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      expect(isTrackingCode(code)).toBe(true);
      expect(isTrackingCode(code.toLowerCase())).toBe(true);
    }
  });

  it("does not collide across a large sample", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20_000; i++) codes.add(generateTrackingCode());
    expect(codes.size).toBe(20_000);
  });

  it("respects the schema's 6..32 bound and rejects anything else", () => {
    expect(generateTrackingCode(6)).toHaveLength(6);
    expect(generateTrackingCode(32)).toHaveLength(32);
    expect(() => generateTrackingCode(5)).toThrow(RangeError);
    expect(() => generateTrackingCode(33)).toThrow(RangeError);
    expect(() => generateTrackingCode(7.5)).toThrow(RangeError);
  });

  it("rejects junk before any lookup and normalises case", () => {
    expect(isTrackingCode("")).toBe(false);
    expect(isTrackingCode("ABC")).toBe(false);
    expect(isTrackingCode("ABCDEFGHIJKL")).toBe(false); // I and L are not in the alphabet
    expect(isTrackingCode("../../etc/passwd")).toBe(false);
    expect(isTrackingCode("A".repeat(33))).toBe(false);
    expect(normalizeTrackingCode("  abc123xyz456 ")).toBe("ABC123XYZ456");
  });
});

describe("tracking ids: sub-ID sanitisation (PRD §32, §34)", () => {
  it("accepts opaque strings, trims, strips control chars, and fills every slot", () => {
    const r = sanitizeSubIds({ sub1: "  campaign-42 ", sub3: "a\u0000b\u001fc", sub5: "" });
    expect(r.rejected).toEqual([]);
    expect(r.values).toEqual({ sub1: "campaign-42", sub2: null, sub3: "abc", sub4: null, sub5: null });
  });

  it("returns all-null for missing input", () => {
    expect(sanitizeSubIds(undefined).values).toEqual({ sub1: null, sub2: null, sub3: null, sub4: null, sub5: null });
    expect(sanitizeSubIds(null).rejected).toEqual([]);
  });

  it("rejects over-long values instead of truncating them", () => {
    const r = sanitizeSubIds({ sub1: "x".repeat(SUB_ID_MAX_LENGTH), sub2: "y".repeat(SUB_ID_MAX_LENGTH + 1) });
    expect(r.values.sub1).toHaveLength(SUB_ID_MAX_LENGTH);
    expect(r.values.sub2).toBeNull();
    expect(r.rejected).toEqual([{ key: "sub2", reason: "TOO_LONG" }]);
  });

  it("rejects email-shaped personal data", () => {
    const r = sanitizeSubIds({ sub1: "user@example.com", sub2: "not-an-email@", sub4: " Jane.Doe@corp.example " });
    expect(r.values.sub1).toBeNull();
    expect(r.values.sub2).toBe("not-an-email@");
    expect(r.values.sub4).toBeNull();
    expect(r.rejected).toEqual([
      { key: "sub1", reason: "PERSONAL_DATA" },
      { key: "sub4", reason: "PERSONAL_DATA" },
    ]);
  });

  it("rejects non-string values", () => {
    const r = sanitizeSubIds({ sub1: 42 as unknown as string, sub2: { a: 1 } as unknown as string });
    expect(r.values.sub1).toBeNull();
    expect(r.rejected.map((x) => x.reason)).toEqual(["INVALID_TYPE", "INVALID_TYPE"]);
  });

  it("merges click-time overrides over link defaults slot by slot", () => {
    const defaults = { sub1: "d1", sub2: "d2", sub3: null, sub4: null, sub5: "d5" };
    const overrides = { sub1: null, sub2: "o2", sub3: "o3", sub4: null, sub5: null };
    expect(mergeSubIds(defaults, overrides)).toEqual({ sub1: "d1", sub2: "o2", sub3: "o3", sub4: null, sub5: "d5" });
  });
});

describe("tracking ids: coarse-signal hashing (PRD §34)", () => {
  it("is deterministic per salt, differs across salts, and never hashes a missing value", () => {
    const a = hashSignal("203.0.113.9", "salt-a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSignal("203.0.113.9", "salt-a")).toBe(a);
    expect(hashSignal("203.0.113.9", "salt-b")).not.toBe(a);
    expect(hashSignal("203.0.113.10", "salt-a")).not.toBe(a);
    expect(hashSignal(null, "salt-a")).toBeNull();
    expect(hashSignal("", "salt-a")).toBeNull();
    expect(a).not.toContain("203.0.113.9");
  });
});
