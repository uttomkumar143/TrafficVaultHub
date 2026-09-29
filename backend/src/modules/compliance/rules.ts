/**
 * Compliance rules engine — Phase 4 Unit 8a (PRD §45–§47, §115, §132).
 *
 * Pure and deterministic: a versioned rule definition + subject facts → one
 * evaluation outcome. Nothing here touches the database.
 *
 * FAIL-SAFE (PRD §132): every rule declares the facts it needs. When a
 * required fact is missing the outcome is INSUFFICIENT_INFORMATION — the
 * engine never guesses and never auto-approves on missing data. PASS is only
 * produced when every required fact is present and every check succeeds.
 *
 * Rule kinds (definition_json.kind):
 *   TRAFFIC_SOURCE      declared traffic sources ⊆ allowed, none in disallowed
 *   GEOGRAPHY           target countries ⊆ allowed, none in restricted
 *   BRAND_USAGE         brand bidding / brand-in-domain forbidden unless permitted
 *   KEYWORDS            forbidden keywords must not appear in declared keywords / creatives text
 *   INCENTIVES          incentivized traffic must be declared and allowed
 *   LANDING_PAGES       landing hosts ⊆ approved hosts; https required if configured
 *   CREATIVES           creatives ⊆ approved creative ids; unapproved creatives fail
 *   PROMOTIONAL_METHOD  promotional methods ⊆ allowed, none in disallowed
 *   ACCOUNT_STATUS      subject account status ∈ allowed statuses; verification flags
 */

export const COMPLIANCE_RULE_KINDS = [
  "TRAFFIC_SOURCE",
  "GEOGRAPHY",
  "BRAND_USAGE",
  "KEYWORDS",
  "INCENTIVES",
  "LANDING_PAGES",
  "CREATIVES",
  "PROMOTIONAL_METHOD",
  "ACCOUNT_STATUS",
] as const;
export type ComplianceRuleKind = (typeof COMPLIANCE_RULE_KINDS)[number];

export const COMPLIANCE_OUTCOMES = ["PASS", "FAIL", "INSUFFICIENT_INFORMATION"] as const;
export type ComplianceOutcome = (typeof COMPLIANCE_OUTCOMES)[number];

export type ComplianceSeverity = "INFO" | "WARNING" | "BLOCKING";
export type ComplianceSubjectType = "AFFILIATE" | "ADVERTISER" | "OFFER" | "CONVERSION";

/** Versioned rule definition (stored as compliance_rules.definition_json). */
export type RuleDefinition =
  | { kind: "TRAFFIC_SOURCE"; allowed?: readonly string[]; disallowed?: readonly string[] }
  | { kind: "GEOGRAPHY"; allowed_countries?: readonly string[]; restricted_countries?: readonly string[] }
  | { kind: "BRAND_USAGE"; brand_terms: readonly string[]; allow_brand_bidding?: boolean; allow_brand_in_domain?: boolean }
  | { kind: "KEYWORDS"; forbidden: readonly string[] }
  | { kind: "INCENTIVES"; allow_incentivized: boolean }
  | { kind: "LANDING_PAGES"; approved_hosts: readonly string[]; require_https?: boolean }
  | { kind: "CREATIVES"; approved_creative_ids: readonly string[] }
  | { kind: "PROMOTIONAL_METHOD"; allowed?: readonly string[]; disallowed?: readonly string[] }
  | { kind: "ACCOUNT_STATUS"; allowed_statuses: readonly string[]; require_verified?: boolean; require_tax_info?: boolean };

/** Facts about the subject. Any field may be absent → rules needing it return INSUFFICIENT_INFORMATION. */
export interface ComplianceFacts {
  traffic_sources?: readonly string[];
  target_countries?: readonly string[];
  bids_on_brand_terms?: boolean;
  domains?: readonly string[];
  keywords?: readonly string[];
  creative_texts?: readonly string[];
  incentivized_traffic?: boolean;
  landing_page_urls?: readonly string[];
  creative_ids?: readonly string[];
  promotional_methods?: readonly string[];
  account_status?: string | null;
  identity_verified?: boolean;
  tax_info_on_file?: boolean;
}

export interface ComplianceEvaluation {
  outcome: ComplianceOutcome;
  /** Stable machine-readable reason, ^[A-Z0-9_]{1,64}$. */
  reason_code: string;
  /** Reviewer-verifiable details: what was checked, what was missing or violated. */
  details: Record<string, string | number | boolean | null | readonly string[]>;
}

export interface RuleInput {
  rule_key: string;
  version_number: number;
  severity: ComplianceSeverity;
  definition: RuleDefinition;
}

const norm = (s: string): string => s.trim().toLowerCase();
const normAll = (xs: readonly string[]): string[] => xs.map(norm);

function insufficient(missing: readonly string[], extra: ComplianceEvaluation["details"] = {}): ComplianceEvaluation {
  return { outcome: "INSUFFICIENT_INFORMATION", reason_code: "MISSING_REQUIRED_FACTS", details: { missing: [...missing], ...extra } };
}
function pass(reason: string, details: ComplianceEvaluation["details"] = {}): ComplianceEvaluation {
  return { outcome: "PASS", reason_code: reason, details };
}
function fail(reason: string, details: ComplianceEvaluation["details"] = {}): ComplianceEvaluation {
  return { outcome: "FAIL", reason_code: reason, details };
}

function requireList(facts: ComplianceFacts, key: keyof ComplianceFacts): readonly string[] | null {
  const v = facts[key];
  return Array.isArray(v) ? (v as readonly string[]) : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function listRule(
  factKey: "traffic_sources" | "promotional_methods",
  facts: ComplianceFacts,
  allowed: readonly string[] | undefined,
  disallowed: readonly string[] | undefined,
  codes: { missing: string; disallowed: string; notAllowed: string; ok: string },
): ComplianceEvaluation {
  const values = requireList(facts, factKey);
  if (values === null) return insufficient([factKey]);
  const v = normAll(values);
  if (disallowed) {
    const hit = v.filter((x) => normAll(disallowed).includes(x));
    if (hit.length) return fail(codes.disallowed, { violations: hit });
  }
  if (allowed) {
    const outside = v.filter((x) => !normAll(allowed).includes(x));
    if (outside.length) return fail(codes.notAllowed, { violations: outside, allowed: [...allowed] });
  }
  return pass(codes.ok, { checked: v });
}

/** Evaluate ONE rule against the facts. Deterministic; never throws on missing facts. */
export function evaluateRule(rule: RuleInput, facts: ComplianceFacts): ComplianceEvaluation {
  const d = rule.definition;
  switch (d.kind) {
    case "TRAFFIC_SOURCE":
      return listRule("traffic_sources", facts, d.allowed, d.disallowed, {
        missing: "traffic_sources",
        disallowed: "TRAFFIC_SOURCE_DISALLOWED",
        notAllowed: "TRAFFIC_SOURCE_NOT_ALLOWED",
        ok: "TRAFFIC_SOURCE_OK",
      });

    case "PROMOTIONAL_METHOD":
      return listRule("promotional_methods", facts, d.allowed, d.disallowed, {
        missing: "promotional_methods",
        disallowed: "PROMOTIONAL_METHOD_DISALLOWED",
        notAllowed: "PROMOTIONAL_METHOD_NOT_ALLOWED",
        ok: "PROMOTIONAL_METHOD_OK",
      });

    case "GEOGRAPHY": {
      const countries = requireList(facts, "target_countries");
      if (countries === null) return insufficient(["target_countries"]);
      const c = countries.map((x) => x.trim().toUpperCase());
      if (d.restricted_countries) {
        const restricted = d.restricted_countries.map((x) => x.toUpperCase());
        const hit = c.filter((x) => restricted.includes(x));
        if (hit.length) return fail("GEO_RESTRICTED", { violations: hit });
      }
      if (d.allowed_countries) {
        const allowed = d.allowed_countries.map((x) => x.toUpperCase());
        const outside = c.filter((x) => !allowed.includes(x));
        if (outside.length) return fail("GEO_NOT_ALLOWED", { violations: outside, allowed });
      }
      return pass("GEO_OK", { checked: c });
    }

    case "BRAND_USAGE": {
      const missing: string[] = [];
      if (typeof facts.bids_on_brand_terms !== "boolean") missing.push("bids_on_brand_terms");
      const domains = requireList(facts, "domains");
      if (domains === null) missing.push("domains");
      if (missing.length) return insufficient(missing);
      if (facts.bids_on_brand_terms && !d.allow_brand_bidding) return fail("BRAND_BIDDING_FORBIDDEN", { brand_terms: [...d.brand_terms] });
      const terms = normAll(d.brand_terms);
      const brandDomains = normAll(domains as readonly string[]).filter((host) => terms.some((t) => t.length > 0 && host.includes(t)));
      if (brandDomains.length && !d.allow_brand_in_domain) return fail("BRAND_IN_DOMAIN_FORBIDDEN", { violations: brandDomains });
      return pass("BRAND_USAGE_OK", { domains_checked: domains ? domains.length : 0 });
    }

    case "KEYWORDS": {
      const keywords = requireList(facts, "keywords");
      const texts = requireList(facts, "creative_texts");
      if (keywords === null && texts === null) return insufficient(["keywords", "creative_texts"]);
      const haystack = [...(keywords ?? []), ...(texts ?? [])].map(norm);
      const forbidden = normAll(d.forbidden).filter((f) => f.length > 0);
      const hits = forbidden.filter((f) => haystack.some((h) => h.includes(f)));
      if (hits.length) return fail("FORBIDDEN_KEYWORD", { violations: hits });
      return pass("KEYWORDS_OK", { checked: haystack.length });
    }

    case "INCENTIVES": {
      if (typeof facts.incentivized_traffic !== "boolean") return insufficient(["incentivized_traffic"]);
      if (facts.incentivized_traffic && !d.allow_incentivized) return fail("INCENTIVIZED_TRAFFIC_FORBIDDEN");
      return pass("INCENTIVES_OK", { incentivized: facts.incentivized_traffic });
    }

    case "LANDING_PAGES": {
      const urls = requireList(facts, "landing_page_urls");
      if (urls === null) return insufficient(["landing_page_urls"]);
      const approved = normAll(d.approved_hosts);
      const bad: string[] = [];
      const insecure: string[] = [];
      for (const u of urls) {
        const host = hostOf(u);
        if (!host) {
          bad.push(u);
          continue;
        }
        if (!approved.some((a) => host === a || host.endsWith(`.${a}`))) bad.push(host);
        if (d.require_https && !u.toLowerCase().startsWith("https://")) insecure.push(u);
      }
      if (bad.length) return fail("LANDING_PAGE_NOT_APPROVED", { violations: bad, approved });
      if (insecure.length) return fail("LANDING_PAGE_INSECURE", { violations: insecure });
      return pass("LANDING_PAGES_OK", { checked: urls.length });
    }

    case "CREATIVES": {
      const ids = requireList(facts, "creative_ids");
      if (ids === null) return insufficient(["creative_ids"]);
      const unapproved = ids.filter((id) => !d.approved_creative_ids.includes(id));
      if (unapproved.length) return fail("CREATIVE_NOT_APPROVED", { violations: unapproved });
      return pass("CREATIVES_OK", { checked: ids.length });
    }

    case "ACCOUNT_STATUS": {
      const missing: string[] = [];
      if (typeof facts.account_status !== "string" || facts.account_status.length === 0) missing.push("account_status");
      if (d.require_verified && typeof facts.identity_verified !== "boolean") missing.push("identity_verified");
      if (d.require_tax_info && typeof facts.tax_info_on_file !== "boolean") missing.push("tax_info_on_file");
      if (missing.length) return insufficient(missing);
      const status = (facts.account_status as string).toUpperCase();
      if (!d.allowed_statuses.map((s) => s.toUpperCase()).includes(status)) {
        return fail("ACCOUNT_STATUS_NOT_ALLOWED", { status, allowed: d.allowed_statuses.map((s) => s.toUpperCase()) });
      }
      if (d.require_verified && facts.identity_verified !== true) return fail("ACCOUNT_NOT_VERIFIED", { status });
      if (d.require_tax_info && facts.tax_info_on_file !== true) return fail("TAX_INFO_MISSING", { status });
      return pass("ACCOUNT_STATUS_OK", { status });
    }
  }
}

export interface RuleSetResult {
  /** Aggregate: FAIL if any rule fails, else INSUFFICIENT_INFORMATION if any is missing data, else PASS. */
  outcome: ComplianceOutcome;
  /** True when a BLOCKING rule produced FAIL or INSUFFICIENT_INFORMATION (fail-safe). */
  blocking: boolean;
  results: Array<{ rule_key: string; version_number: number; severity: ComplianceSeverity; evaluation: ComplianceEvaluation }>;
}

/** Evaluate every rule; the aggregate never auto-approves while information is missing. */
export function evaluateRules(rules: readonly RuleInput[], facts: ComplianceFacts): RuleSetResult {
  const results = rules.map((rule) => ({
    rule_key: rule.rule_key,
    version_number: rule.version_number,
    severity: rule.severity,
    evaluation: evaluateRule(rule, facts),
  }));
  const anyFail = results.some((r) => r.evaluation.outcome === "FAIL");
  const anyMissing = results.some((r) => r.evaluation.outcome === "INSUFFICIENT_INFORMATION");
  const blocking = results.some((r) => r.severity === "BLOCKING" && r.evaluation.outcome !== "PASS");
  return { outcome: anyFail ? "FAIL" : anyMissing ? "INSUFFICIENT_INFORMATION" : "PASS", blocking, results };
}

/** Validates an untrusted definition object; returns a typed definition or null. */
export function parseRuleDefinition(raw: unknown): RuleDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== "string" || !(COMPLIANCE_RULE_KINDS as readonly string[]).includes(kind)) return null;
  const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  const optList = (v: unknown): boolean => v === undefined || strList(v);
  const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";
  switch (kind as ComplianceRuleKind) {
    case "TRAFFIC_SOURCE":
    case "PROMOTIONAL_METHOD":
      if (!optList(o.allowed) || !optList(o.disallowed)) return null;
      if (o.allowed === undefined && o.disallowed === undefined) return null;
      return o as unknown as RuleDefinition;
    case "GEOGRAPHY":
      if (!optList(o.allowed_countries) || !optList(o.restricted_countries)) return null;
      if (o.allowed_countries === undefined && o.restricted_countries === undefined) return null;
      return o as unknown as RuleDefinition;
    case "BRAND_USAGE":
      if (!strList(o.brand_terms) || !optBool(o.allow_brand_bidding) || !optBool(o.allow_brand_in_domain)) return null;
      return o as unknown as RuleDefinition;
    case "KEYWORDS":
      return strList(o.forbidden) ? (o as unknown as RuleDefinition) : null;
    case "INCENTIVES":
      return typeof o.allow_incentivized === "boolean" ? (o as unknown as RuleDefinition) : null;
    case "LANDING_PAGES":
      if (!strList(o.approved_hosts) || !optBool(o.require_https)) return null;
      return o as unknown as RuleDefinition;
    case "CREATIVES":
      return strList(o.approved_creative_ids) ? (o as unknown as RuleDefinition) : null;
    case "ACCOUNT_STATUS":
      if (!strList(o.allowed_statuses) || !optBool(o.require_verified) || !optBool(o.require_tax_info)) return null;
      return o as unknown as RuleDefinition;
  }
}
