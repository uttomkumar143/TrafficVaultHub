import { describe, expect, it } from "vitest";
import { hashSignal } from "./ids";
import {
  classifyUserAgent,
  clickSignals,
  coarseCountry,
  coarseLanguage,
  coarseRegion,
  referrerHost,
  requestSignalsFromHeaders,
  type RequestSignals,
} from "./signals";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const EDGE_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const TV = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36";

const base: RequestSignals = {
  ip: "203.0.113.9",
  user_agent: CHROME_WIN,
  accept_language: "en-GB,en;q=0.9,de;q=0.8",
  referer: "https://Blog.Example.com:8443/post/1?utm=x",
  country: "gb",
  region: "eng",
};

describe("signals: geo / language / referrer", () => {
  it("normalises country codes and drops Cloudflare's XX / T1 placeholders", () => {
    expect(coarseCountry("gb")).toBe("GB");
    expect(coarseCountry("XX")).toBeNull();
    expect(coarseCountry("T1")).toBeNull();
    expect(coarseCountry("GBR")).toBeNull();
    expect(coarseCountry(null)).toBeNull();
  });

  it("bounds region codes and language tags", () => {
    expect(coarseRegion("eng")).toBe("ENG");
    expect(coarseRegion("this-is-far-too-long")).toBeNull();
    expect(coarseLanguage("en-GB,en;q=0.9")).toBe("en-gb");
    expect(coarseLanguage("x".repeat(17))).toBeNull();
    expect(coarseLanguage("en GB")).toBeNull();
    expect(coarseLanguage(null)).toBeNull();
  });

  it("keeps only the referrer host — no path, query or port", () => {
    expect(referrerHost("https://Blog.Example.com:8443/post/1?utm=x")).toBe("blog.example.com");
    expect(referrerHost("javascript:alert(1)")).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });
});

describe("signals: user agent → coarse families only", () => {
  it("classifies common agents by family, never by version", () => {
    expect(classifyUserAgent(CHROME_WIN)).toEqual({ device_type: "DESKTOP", os_family: "Windows", browser_family: "Chrome" });
    expect(classifyUserAgent(SAFARI_IPHONE)).toEqual({ device_type: "MOBILE", os_family: "iOS", browser_family: "Safari" });
    expect(classifyUserAgent(ANDROID_TABLET)).toEqual({ device_type: "TABLET", os_family: "Android", browser_family: "Chrome" });
    expect(classifyUserAgent(ANDROID_PHONE)).toEqual({ device_type: "MOBILE", os_family: "Android", browser_family: "Chrome" });
    expect(classifyUserAgent(EDGE_MAC)).toEqual({ device_type: "DESKTOP", os_family: "macOS", browser_family: "Edge" });
    expect(classifyUserAgent(TV).device_type).toBe("TV");
    for (const f of Object.values(classifyUserAgent(CHROME_WIN))) expect(String(f)).not.toMatch(/\d/);
  });

  it("unknown agent → OTHER with null families; missing agent → all null", () => {
    expect(classifyUserAgent("curl/8.4.0")).toEqual({ device_type: "OTHER", os_family: null, browser_family: null });
    expect(classifyUserAgent(null)).toEqual({ device_type: null, os_family: null, browser_family: null });
  });
});

describe("signals: clickSignals", () => {
  it("maps headers to the click columns and salts the hashes", () => {
    const s = clickSignals(base, "pepper");
    expect(s).toMatchObject({
      country_code: "GB",
      region_code: "ENG",
      device_type: "DESKTOP",
      os_family: "Windows",
      browser_family: "Chrome",
      language: "en-gb",
      referrer_host: "blog.example.com",
    });
    expect(s.ip_hash).toBe(hashSignal("203.0.113.9", "pepper"));
    expect(s.user_agent_hash).toBe(hashSignal(CHROME_WIN, "pepper"));
    expect(s.ip_hash).not.toContain("203.0.113.9");
    expect(s.ip_hash).not.toBe(hashSignal("203.0.113.9", "other-salt"));
  });

  it("never writes an unsalted hash: no salt → ip_hash / user_agent_hash are null", () => {
    for (const salt of [null, undefined, ""]) {
      const s = clickSignals(base, salt);
      expect(s.ip_hash).toBeNull();
      expect(s.user_agent_hash).toBeNull();
      expect(s.country_code).toBe("GB");
    }
  });

  it("reads the expected headers (case-insensitively via the getter) and treats empty as absent", () => {
    const headers = new Headers({
      "CF-Connecting-IP": "198.51.100.7",
      "User-Agent": SAFARI_IPHONE,
      "Accept-Language": "fr-FR",
      Referer: "",
      "CF-IPCountry": "FR",
    });
    const r = requestSignalsFromHeaders((n) => headers.get(n));
    expect(r).toEqual({
      ip: "198.51.100.7",
      user_agent: SAFARI_IPHONE,
      accept_language: "fr-FR",
      referer: null,
      country: "FR",
      region: null,
    });
  });
});
