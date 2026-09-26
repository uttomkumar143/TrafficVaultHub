import { describe, expect, it } from "vitest";
import { formatBps, formatMinor, formatSeconds, minorToMajorString, parseMajorToMinor } from "@/lib/money";

/**
 * Money is integer minor units + currency (PRD §25). These helpers must
 * round-trip without floating point so the browser never fabricates cents.
 */
describe("money helpers", () => {
  it("formats minor units per currency exponent using string math", () => {
    expect(formatMinor(4000, "USD")).toBe("USD 40.00");
    expect(formatMinor(5, "usd")).toBe("USD 0.05");
    expect(formatMinor(0, "EUR")).toBe("EUR 0.00");
    expect(formatMinor(123456789, "GBP")).toBe("GBP 1,234,567.89");
    expect(formatMinor(1234567, "JPY")).toBe("JPY 1,234,567");
    expect(formatMinor(12345, "KWD")).toBe("KWD 12.345");
    expect(formatMinor(-250, "USD")).toBe("-USD 2.50");
    // Exact for large integers where `/ 100` would lose nothing but we still avoid floats.
    expect(formatMinor(1_000_000_000_000_000, "USD")).toBe("USD 10,000,000,000,000.00");
  });

  it("refuses to format a non-integer amount (a float is a bug upstream)", () => {
    expect(formatMinor(12.5, "USD")).toBe("USD —");
  });

  it("parses user-typed major amounts to integer minor units without floats", () => {
    expect(parseMajorToMinor("40", "USD")).toBe(4000);
    expect(parseMajorToMinor("40.5", "USD")).toBe(4050);
    expect(parseMajorToMinor("40.05", "USD")).toBe(4005);
    expect(parseMajorToMinor("0.29", "USD")).toBe(29); // 0.29 * 100 = 28.999… in float
    expect(parseMajorToMinor("1,234.56", "USD")).toBe(123456);
    expect(parseMajorToMinor("100", "JPY")).toBe(100);
    expect(parseMajorToMinor("1.234", "KWD")).toBe(1234);
  });

  it("rejects amounts with too much precision, negatives or garbage", () => {
    expect(parseMajorToMinor("40.005", "USD")).toBeNull();
    expect(parseMajorToMinor("1.5", "JPY")).toBeNull();
    expect(parseMajorToMinor("-5", "USD")).toBeNull();
    expect(parseMajorToMinor("abc", "USD")).toBeNull();
    expect(parseMajorToMinor("", "USD")).toBeNull();
  });

  it("round-trips minor → major string → minor", () => {
    for (const minor of [0, 1, 99, 100, 4000, 123456789]) {
      expect(parseMajorToMinor(minorToMajorString(minor, "USD"), "USD")).toBe(minor);
    }
    expect(minorToMajorString(4000, "USD")).toBe("40.00");
    expect(minorToMajorString(7, "USD")).toBe("0.07");
    expect(minorToMajorString(500, "JPY")).toBe("500");
  });

  it("formats basis points and durations", () => {
    expect(formatBps(2500)).toBe("25.00%");
    expect(formatBps(1)).toBe("0.01%");
    expect(formatBps(10000)).toBe("100.00%");
    expect(formatSeconds(2_592_000)).toBe("30 days");
    expect(formatSeconds(86_400)).toBe("1 day");
    expect(formatSeconds(7_200)).toBe("2 hours");
    expect(formatSeconds(90)).toBe("90 seconds");
  });
});
