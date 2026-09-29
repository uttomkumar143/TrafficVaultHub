/**
 * Compliance rules engine — Phase 4 Unit 8a tests (PRD §45–§47, §132).
 * Definition-of-Done test (by name):
 *   - "missing required information yields INSUFFICIENT_INFORMATION, never PASS"
 */
import { describe, expect, it } from "vitest";
import { COMPLIANCE_RULE_KINDS, evaluateRule, evaluateRules, parseRuleDefinition, type RuleInput } from "./rules";

const rule = (definition: RuleInput["definition"], severity: RuleInput["severity"] = "BLOCKING"): RuleInput => ({
  rule_key: `${definition.kind.toLowerCase()}_v1`,
  version_number: 1,
  severity,
  definition,
});

describe("compliance rules engine", () => {
  it("missing required information yields INSUFFICIENT_INFORMATION, never PASS", () => {
    const rules: RuleInput[] = [
      rule({ kind: "TRAFFIC_SOURCE", allowed: ["search"] }),
      rule({ kind: "GEOGRAPHY", allowed_countries: ["US"] }),
      rule({ kind: "BRAND_USAGE", brand_terms: ["acme"] }),
      rule({ kind: "KEYWORDS", forbidden: ["free money"] }),
      rule({ kind: "INCENTIVES", allow_incentivized: false }),
      rule({ kind: "LANDING_PAGES", approved_hosts: ["acme.example"] }),
      rule({ kind: "CREATIVES", approved_creative_ids: ["cr-1"] }),
      rule({ kind: "PROMOTIONAL_METHOD", disallowed: ["spam"] }),
      rule({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true, require_tax_info: true }),
    ];
    expect(rules.map((r) => r.definition.kind).sort()).toEqual([...COMPLIANCE_RULE_KINDS].sort());
    // empty facts: every rule is missing something
    for (const r of rules) {
      const e = evaluateRule(r, {});
      expect(e.outcome).toBe("INSUFFICIENT_INFORMATION");
      expect(e.reason_code).toBe("MISSING_REQUIRED_FACTS");
      expect(Array.isArray(e.details.missing) && (e.details.missing as string[]).length > 0).toBe(true);
    }
    const agg = evaluateRules(rules, {});
    expect(agg.outcome).toBe("INSUFFICIENT_INFORMATION");
    expect(agg.blocking).toBe(true); // fail-safe: blocking rule without information blocks

    // partial facts on a multi-fact rule still do not pass
    expect(
      evaluateRule(rule({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true }), { account_status: "ACTIVE" }),
    ).toMatchObject({
      outcome: "INSUFFICIENT_INFORMATION",
      details: { missing: ["identity_verified"] },
    });
    expect(evaluateRule(rule({ kind: "BRAND_USAGE", brand_terms: ["acme"] }), { bids_on_brand_terms: false })).toMatchObject({
      outcome: "INSUFFICIENT_INFORMATION",
      details: { missing: ["domains"] },
    });
    // an INFO rule missing data does not block but the aggregate is still not PASS
    const info = evaluateRules([rule({ kind: "INCENTIVES", allow_incentivized: true }, "INFO")], {});
    expect(info.outcome).toBe("INSUFFICIENT_INFORMATION");
    expect(info.blocking).toBe(false);
  });

  it("every rule kind is deterministic: PASS with compliant facts, FAIL with a violation and a stable reason code", () => {
    const cases: Array<{ r: RuleInput; ok: Parameters<typeof evaluateRule>[1]; bad: Parameters<typeof evaluateRule>[1]; code: string }> = [
      {
        r: rule({ kind: "TRAFFIC_SOURCE", allowed: ["search", "email"], disallowed: ["adult"] }),
        ok: { traffic_sources: ["Search", "email"] },
        bad: { traffic_sources: ["search", "adult"] },
        code: "TRAFFIC_SOURCE_DISALLOWED",
      },
      {
        r: rule({ kind: "TRAFFIC_SOURCE", allowed: ["search"] }),
        ok: { traffic_sources: ["search"] },
        bad: { traffic_sources: ["social"] },
        code: "TRAFFIC_SOURCE_NOT_ALLOWED",
      },
      {
        r: rule({ kind: "GEOGRAPHY", allowed_countries: ["US", "CA"], restricted_countries: ["KP"] }),
        ok: { target_countries: ["us", "CA"] },
        bad: { target_countries: ["US", "KP"] },
        code: "GEO_RESTRICTED",
      },
      {
        r: rule({ kind: "GEOGRAPHY", allowed_countries: ["US"] }),
        ok: { target_countries: ["US"] },
        bad: { target_countries: ["DE"] },
        code: "GEO_NOT_ALLOWED",
      },
      {
        r: rule({ kind: "BRAND_USAGE", brand_terms: ["Acme"] }),
        ok: { bids_on_brand_terms: false, domains: ["deals.example"] },
        bad: { bids_on_brand_terms: true, domains: ["deals.example"] },
        code: "BRAND_BIDDING_FORBIDDEN",
      },
      {
        r: rule({ kind: "BRAND_USAGE", brand_terms: ["Acme"], allow_brand_bidding: true }),
        ok: { bids_on_brand_terms: true, domains: ["deals.example"] },
        bad: { bids_on_brand_terms: true, domains: ["acme-coupons.example"] },
        code: "BRAND_IN_DOMAIN_FORBIDDEN",
      },
      {
        r: rule({ kind: "KEYWORDS", forbidden: ["Free Money", "guaranteed"] }),
        ok: { keywords: ["best offer"], creative_texts: ["Save today"] },
        bad: { keywords: ["get FREE money now"] },
        code: "FORBIDDEN_KEYWORD",
      },
      {
        r: rule({ kind: "INCENTIVES", allow_incentivized: false }),
        ok: { incentivized_traffic: false },
        bad: { incentivized_traffic: true },
        code: "INCENTIVIZED_TRAFFIC_FORBIDDEN",
      },
      {
        r: rule({ kind: "LANDING_PAGES", approved_hosts: ["acme.example"], require_https: true }),
        ok: { landing_page_urls: ["https://www.acme.example/lp", "https://acme.example/"] },
        bad: { landing_page_urls: ["https://evil.example/lp"] },
        code: "LANDING_PAGE_NOT_APPROVED",
      },
      {
        r: rule({ kind: "LANDING_PAGES", approved_hosts: ["acme.example"], require_https: true }),
        ok: { landing_page_urls: ["https://acme.example/"] },
        bad: { landing_page_urls: ["http://acme.example/"] },
        code: "LANDING_PAGE_INSECURE",
      },
      {
        r: rule({ kind: "CREATIVES", approved_creative_ids: ["cr-1", "cr-2"] }),
        ok: { creative_ids: ["cr-1"] },
        bad: { creative_ids: ["cr-1", "cr-9"] },
        code: "CREATIVE_NOT_APPROVED",
      },
      {
        r: rule({ kind: "PROMOTIONAL_METHOD", allowed: ["content", "email"], disallowed: ["spam"] }),
        ok: { promotional_methods: ["content"] },
        bad: { promotional_methods: ["spam"] },
        code: "PROMOTIONAL_METHOD_DISALLOWED",
      },
      {
        r: rule({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true, require_tax_info: true }),
        ok: { account_status: "active", identity_verified: true, tax_info_on_file: true },
        bad: { account_status: "SUSPENDED", identity_verified: true, tax_info_on_file: true },
        code: "ACCOUNT_STATUS_NOT_ALLOWED",
      },
      {
        r: rule({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true }),
        ok: { account_status: "ACTIVE", identity_verified: true },
        bad: { account_status: "ACTIVE", identity_verified: false },
        code: "ACCOUNT_NOT_VERIFIED",
      },
      {
        r: rule({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_tax_info: true }),
        ok: { account_status: "ACTIVE", tax_info_on_file: true },
        bad: { account_status: "ACTIVE", tax_info_on_file: false },
        code: "TAX_INFO_MISSING",
      },
    ];
    for (const c of cases) {
      const okRes = evaluateRule(c.r, c.ok);
      expect(okRes.outcome, `${c.code} ok`).toBe("PASS");
      expect(okRes.reason_code).toMatch(/^[A-Z0-9_]{1,64}$/);
      const badRes = evaluateRule(c.r, c.bad);
      expect(badRes.outcome, `${c.code} bad`).toBe("FAIL");
      expect(badRes.reason_code).toBe(c.code);
      // deterministic
      expect(evaluateRule(c.r, c.bad)).toEqual(badRes);
    }
  });

  it("aggregate: any FAIL wins over missing data; blocking reflects only BLOCKING rules; PASS requires everything present", () => {
    const rules = [
      rule({ kind: "INCENTIVES", allow_incentivized: false }, "WARNING"),
      rule({ kind: "GEOGRAPHY", allowed_countries: ["US"] }, "BLOCKING"),
    ];
    const failing = evaluateRules(rules, { incentivized_traffic: true });
    expect(failing.outcome).toBe("FAIL");
    expect(failing.blocking).toBe(true); // GEOGRAPHY blocking rule is missing data
    expect(failing.results.map((r) => r.evaluation.outcome)).toEqual(["FAIL", "INSUFFICIENT_INFORMATION"]);

    const warnOnly = evaluateRules(rules, { incentivized_traffic: true, target_countries: ["US"] });
    expect(warnOnly.outcome).toBe("FAIL");
    expect(warnOnly.blocking).toBe(false);

    const allGood = evaluateRules(rules, { incentivized_traffic: false, target_countries: ["US"] });
    expect(allGood).toMatchObject({ outcome: "PASS", blocking: false });
    expect(evaluateRules([], {})).toMatchObject({ outcome: "PASS", blocking: false, results: [] });
  });

  it("parseRuleDefinition accepts only well-formed versioned definitions", () => {
    expect(parseRuleDefinition({ kind: "TRAFFIC_SOURCE", allowed: ["search"] })).toEqual({ kind: "TRAFFIC_SOURCE", allowed: ["search"] });
    expect(parseRuleDefinition({ kind: "TRAFFIC_SOURCE" })).toBeNull(); // no lists at all
    expect(parseRuleDefinition({ kind: "GEOGRAPHY", allowed_countries: ["US", 5] })).toBeNull();
    expect(parseRuleDefinition({ kind: "BRAND_USAGE" })).toBeNull();
    expect(parseRuleDefinition({ kind: "KEYWORDS", forbidden: [""] })).toBeNull();
    expect(parseRuleDefinition({ kind: "INCENTIVES", allow_incentivized: "yes" })).toBeNull();
    expect(parseRuleDefinition({ kind: "LANDING_PAGES", approved_hosts: ["a.example"], require_https: 1 })).toBeNull();
    expect(parseRuleDefinition({ kind: "CREATIVES", approved_creative_ids: [] })).toEqual({ kind: "CREATIVES", approved_creative_ids: [] });
    expect(parseRuleDefinition({ kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true })).not.toBeNull();
    expect(parseRuleDefinition({ kind: "NOPE" })).toBeNull();
    expect(parseRuleDefinition(null)).toBeNull();
    expect(parseRuleDefinition("TRAFFIC_SOURCE")).toBeNull();
  });
});
