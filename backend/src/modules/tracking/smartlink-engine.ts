/**
 * SmartLink routing engine (Phase 3 Units 3 + 6; PRD §42, §43, §46).
 *
 * PURE module: no D1, no KV, no Workers types. The caller (Unit 2 redirect)
 * loads the SmartLink's candidate pool with fresh offer facts, supplies the
 * click context and a random source, and gets back an EXPLAINABLE decision:
 * which offer, why, which candidates were rejected and for which reason,
 * and the engine's `algorithm_version` — recorded on every click (PRD §43).
 *
 * Invariants (tested):
 *   * Eligibility is `offerRoutability` from `./eligibility` (LIVE + version +
 *     destination + window + access grant) PLUS the click-time facts the caller
 *     knows (cap exhausted, tracking degraded, compliance/risk block, targeting
 *     mismatch against the click context). An ineligible offer is NEVER
 *     selected, in any mode, including on failover.
 *   * `weight = 0` or `enabled = 0` removes a candidate from selection.
 *   * Failover (`failover`) re-runs the full eligibility over the remaining
 *     pool with the failed offer excluded — it does not "pick the next one
 *     from the old list". If nothing remains it returns the SmartLink's own
 *     `fallback_url` (never an inactive offer) or NO_ELIGIBLE_OFFER.
 *   * Selection randomness is injected (`random: () => number` in [0, 1)) so
 *     decisions are reproducible in tests; production passes Math.random.
 *   * Money-free: PERFORMANCE_BASED uses integer counters (clicks, conversions
 *     in the stats window) and basis points, never floats of money.
 *
 * Modes (PRD §43):
 *   RULE_BASED        lowest `priority` wins; ties broken by highest weight, then id.
 *   WEIGHTED          weighted random over `weight`.
 *   PERFORMANCE_BASED highest conversion rate (bps) wins; candidates with fewer
 *                     than `MIN_SAMPLE_CLICKS` clicks get an exploration share
 *                     via weighted random so new offers are not starved.
 *   GEO_BASED         candidates whose COUNTRY targeting explicitly lists the
 *                     click country beat open (untargeted) ones; then RULE_BASED.
 *   DEVICE_BASED      same with the DEVICE dimension.
 *   HYBRID            GEO + DEVICE specificity score, then WEIGHTED among the
 *                     most specific tier.
 */
import type { TargetingDimension } from "../offers/state-machine";
import { offerRoutability, type IneligibilityReason, type OfferRoutingFacts } from "./eligibility";

/** Bump on any behavioural change to selection or eligibility (PRD §43). */
export const SMARTLINK_ALGORITHM_VERSION = "smartlink-v1.0.0" as const;

export const ROUTING_MODES = ["RULE_BASED", "WEIGHTED", "PERFORMANCE_BASED", "GEO_BASED", "DEVICE_BASED", "HYBRID"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];
export function isRoutingMode(v: unknown): v is RoutingMode {
  return typeof v === "string" && (ROUTING_MODES as readonly string[]).includes(v);
}

/** Below this many clicks in the stats window a candidate is still "exploring" (PERFORMANCE_BASED). */
export const MIN_SAMPLE_CLICKS = 100;
/** Exploration share (in basis points of total selection mass) reserved for under-sampled candidates. */
export const EXPLORATION_SHARE_BPS = 1000; // 10 %

export const CLICK_REJECTION_REASONS = [
  "CANDIDATE_DISABLED",
  "CANDIDATE_ZERO_WEIGHT",
  "CAP_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "TRACKING_DEGRADED",
  "COMPLIANCE_BLOCKED",
  "RISK_BLOCKED",
  "TARGETING_MISMATCH",
  "FAILOVER_EXCLUDED",
] as const;
export type ClickRejectionReason = (typeof CLICK_REJECTION_REASONS)[number];
export type RejectionReason = IneligibilityReason | ClickRejectionReason;

export interface TargetingRule {
  dimension: TargetingDimension;
  /** Normalised value as stored (upper-case country/device, etc.). */
  value: string;
}

/** One row of the SmartLink's pool joined with FRESH offer facts (never cached eligibility). */
export interface SmartLinkCandidate {
  offer_id: string;
  offer_organization_id: string;
  /** From `smartlink_offers` (affiliate hints). */
  weight: number;
  priority: number;
  enabled: boolean;
  /** Fresh routing facts (Unit 1 eligibility) incl. the affiliate's grant for this offer. */
  facts: OfferRoutingFacts;
  /** Allow-list targeting rows of the CURRENT version; empty = open on every dimension. */
  targeting: readonly TargetingRule[];
  /** Click-time facts known by the caller (Unit 4 caps, Phase 4 health/compliance). */
  cap_exhausted?: boolean;
  budget_exhausted?: boolean;
  tracking_degraded?: boolean;
  compliance_blocked?: boolean;
  risk_blocked?: boolean;
  /** PERFORMANCE_BASED inputs over the configured stats window — integers only. */
  stats?: { clicks: number; conversions: number };
}

/** Coarse click signals (PRD §34 — never raw IP / fingerprint). */
export interface ClickContext {
  country_code: string | null;
  region_code: string | null;
  device_type: string | null;
  os_family: string | null;
  browser_family: string | null;
  language: string | null;
  traffic_source_id: string | null;
  now: Date;
}

export interface SmartLinkDefinition {
  smartlink_id: string;
  routing_mode: RoutingMode;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  fallback_url: string | null;
}

export interface RejectedCandidate {
  offer_id: string;
  reason: RejectionReason;
}

export type RoutingDecision =
  | {
      outcome: "OFFER";
      offer_id: string;
      offer_organization_id: string;
      offer_version_id: string;
      destination_url: string;
      routing_mode: RoutingMode;
      algorithm_version: typeof SMARTLINK_ALGORITHM_VERSION;
      /** Machine-readable reason for the pick (recorded in `clicks.decision_reason_code`). */
      decision_reason_code: string;
      eligible_offer_ids: string[];
      rejected: RejectedCandidate[];
      failover_from_offer_id: string | null;
    }
  | {
      outcome: "FALLBACK_URL";
      destination_url: string;
      routing_mode: RoutingMode;
      algorithm_version: typeof SMARTLINK_ALGORITHM_VERSION;
      decision_reason_code: "NO_ELIGIBLE_OFFER_FALLBACK";
      rejected: RejectedCandidate[];
      failover_from_offer_id: string | null;
    }
  | {
      outcome: "NO_ELIGIBLE_OFFER";
      routing_mode: RoutingMode;
      algorithm_version: typeof SMARTLINK_ALGORITHM_VERSION;
      decision_reason_code: "NO_ELIGIBLE_OFFER" | "SMARTLINK_INACTIVE";
      rejected: RejectedCandidate[];
      failover_from_offer_id: string | null;
    };

export interface RouteOptions {
  /** Uniform random in [0, 1). Injected for determinism. */
  random?: () => number;
  /** Offer ids excluded because they already failed for this click (failover). */
  exclude?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Eligibility (click-time)
// ---------------------------------------------------------------------------

const DIMENSION_OF_CONTEXT: Record<TargetingDimension, keyof ClickContext> = {
  COUNTRY: "country_code",
  REGION: "region_code",
  DEVICE: "device_type",
  OS: "os_family",
  BROWSER: "browser_family",
  LANGUAGE: "language",
  TRAFFIC_SOURCE: "traffic_source_id",
};

/**
 * Allow-list targeting: for each dimension that has ≥1 rule, the click value
 * must be present (case-insensitive). An unknown click value (null) on a
 * restricted dimension is a MISMATCH (fail closed — PRD §42 targeting is a
 * hard constraint, not a hint).
 */
export function targetingMatches(rules: readonly TargetingRule[], ctx: ClickContext): boolean {
  if (rules.length === 0) return true;
  const byDim = new Map<TargetingDimension, Set<string>>();
  for (const r of rules) {
    const set = byDim.get(r.dimension) ?? new Set<string>();
    set.add(r.value.toUpperCase());
    byDim.set(r.dimension, set);
  }
  for (const [dim, allowed] of byDim) {
    const raw = ctx[DIMENSION_OF_CONTEXT[dim]];
    if (typeof raw !== "string" || raw.length === 0) return false;
    if (!allowed.has(raw.toUpperCase())) return false;
  }
  return true;
}

/** Full click-time eligibility of one candidate, in a fixed order (first failing reason is recorded). */
export function candidateEligibility(
  c: SmartLinkCandidate,
  ctx: ClickContext,
  exclude?: ReadonlySet<string>,
): { eligible: true } | { eligible: false; reason: RejectionReason } {
  if (exclude?.has(c.offer_id)) return { eligible: false, reason: "FAILOVER_EXCLUDED" };
  if (!c.enabled) return { eligible: false, reason: "CANDIDATE_DISABLED" };
  const r = offerRoutability(c.facts, ctx.now);
  if (!r.eligible) return r;
  if (c.compliance_blocked) return { eligible: false, reason: "COMPLIANCE_BLOCKED" };
  if (c.risk_blocked) return { eligible: false, reason: "RISK_BLOCKED" };
  if (c.tracking_degraded) return { eligible: false, reason: "TRACKING_DEGRADED" };
  if (c.budget_exhausted) return { eligible: false, reason: "BUDGET_EXHAUSTED" };
  if (c.cap_exhausted) return { eligible: false, reason: "CAP_EXHAUSTED" };
  if (!targetingMatches(c.targeting, ctx)) return { eligible: false, reason: "TARGETING_MISMATCH" };
  if (!Number.isInteger(c.weight) || c.weight <= 0) return { eligible: false, reason: "CANDIDATE_ZERO_WEIGHT" };
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Selection strategies (operate ONLY on already-eligible candidates)
// ---------------------------------------------------------------------------

function byPriorityThenWeightThenId(a: SmartLinkCandidate, b: SmartLinkCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0;
}

function pickRuleBased(pool: SmartLinkCandidate[]): { pick: SmartLinkCandidate; code: string } {
  const sorted = [...pool].sort(byPriorityThenWeightThenId);
  const pick = sorted[0];
  if (!pick) throw new Error("pickRuleBased: empty pool");
  return { pick, code: "RULE_PRIORITY" };
}

/** Weighted random over integer weights; `random()` in [0,1). Deterministic given `random`. */
export function weightedPick<T extends { weight: number }>(pool: readonly T[], random: () => number): T {
  const total = pool.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) throw new Error("weightedPick: total weight must be positive");
  const r = random();
  if (!(r >= 0 && r < 1)) throw new Error("weightedPick: random() must return a number in [0, 1)");
  let cursor = Math.floor(r * total);
  let last: T | undefined;
  for (const c of pool) {
    if (cursor < c.weight) return c;
    cursor -= c.weight;
    last = c;
  }
  if (!last) throw new Error("weightedPick: empty pool");
  return last;
}

function pickWeighted(pool: SmartLinkCandidate[], random: () => number): { pick: SmartLinkCandidate; code: string } {
  return { pick: weightedPick(pool, random), code: "WEIGHTED_RANDOM" };
}

/** Conversion rate in basis points (integer). 0 clicks → 0. */
export function conversionRateBps(stats: { clicks: number; conversions: number } | undefined): number {
  if (!stats || !Number.isInteger(stats.clicks) || !Number.isInteger(stats.conversions) || stats.clicks <= 0) return 0;
  const conv = Math.max(0, Math.min(stats.conversions, stats.clicks));
  return Math.floor((conv * 10_000) / stats.clicks);
}

function pickPerformance(pool: SmartLinkCandidate[], random: () => number): { pick: SmartLinkCandidate; code: string } {
  const sampled = pool.filter((c) => (c.stats?.clicks ?? 0) >= MIN_SAMPLE_CLICKS);
  const exploring = pool.filter((c) => (c.stats?.clicks ?? 0) < MIN_SAMPLE_CLICKS);
  if (sampled.length === 0) return { pick: weightedPick(exploring, random), code: "PERFORMANCE_EXPLORE" };
  if (exploring.length > 0) {
    // Reserve EXPLORATION_SHARE_BPS of the mass for under-sampled candidates.
    const r = random();
    if (Math.floor(r * 10_000) < EXPLORATION_SHARE_BPS) {
      return { pick: weightedPick(exploring, random), code: "PERFORMANCE_EXPLORE" };
    }
  }
  const best = [...sampled].sort((a, b) => {
    const d = conversionRateBps(b.stats) - conversionRateBps(a.stats);
    return d !== 0 ? d : byPriorityThenWeightThenId(a, b);
  })[0];
  if (!best) throw new Error("pickPerformance: empty pool");
  return { pick: best, code: "PERFORMANCE_BEST_CR" };
}

/** 1 if the candidate explicitly targets the click's value on `dim`, else 0. */
function specificity(c: SmartLinkCandidate, dim: TargetingDimension, ctx: ClickContext): number {
  const value = ctx[DIMENSION_OF_CONTEXT[dim]];
  if (typeof value !== "string" || value.length === 0) return 0;
  return c.targeting.some((t) => t.dimension === dim && t.value.toUpperCase() === value.toUpperCase()) ? 1 : 0;
}

function pickMostSpecific(
  pool: SmartLinkCandidate[],
  dims: TargetingDimension[],
  ctx: ClickContext,
  tieBreak: (tier: SmartLinkCandidate[]) => { pick: SmartLinkCandidate; code: string },
  codePrefix: string,
): { pick: SmartLinkCandidate; code: string } {
  const scored = pool.map((c) => ({ c, score: dims.reduce((s, d) => s + specificity(c, d, ctx), 0) }));
  const top = Math.max(...scored.map((s) => s.score));
  const tier = scored.filter((s) => s.score === top).map((s) => s.c);
  const { pick, code } = tieBreak(tier);
  return { pick, code: top > 0 ? `${codePrefix}_MATCH:${code}` : `${codePrefix}_OPEN:${code}` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route one click through a SmartLink. Never selects an ineligible offer.
 * `options.exclude` implements failover: excluded offers are rejected with
 * FAILOVER_EXCLUDED and everything else is re-evaluated from scratch.
 */
export function route(
  link: SmartLinkDefinition,
  candidates: readonly SmartLinkCandidate[],
  ctx: ClickContext,
  options: RouteOptions = {},
): RoutingDecision {
  const random = options.random ?? Math.random;
  const mode = link.routing_mode;
  const failoverFrom: string | null = options.exclude && options.exclude.size > 0 ? ([...options.exclude].pop() ?? null) : null;
  const base = { routing_mode: mode, algorithm_version: SMARTLINK_ALGORITHM_VERSION, failover_from_offer_id: failoverFrom };

  if (link.status !== "ACTIVE") {
    return { outcome: "NO_ELIGIBLE_OFFER", ...base, decision_reason_code: "SMARTLINK_INACTIVE", rejected: [] };
  }

  const rejected: RejectedCandidate[] = [];
  const eligible: SmartLinkCandidate[] = [];
  for (const c of candidates) {
    const e = candidateEligibility(c, ctx, options.exclude);
    if (e.eligible) eligible.push(c);
    else rejected.push({ offer_id: c.offer_id, reason: e.reason });
  }

  if (eligible.length === 0) {
    if (link.fallback_url) {
      return { outcome: "FALLBACK_URL", ...base, destination_url: link.fallback_url, decision_reason_code: "NO_ELIGIBLE_OFFER_FALLBACK", rejected };
    }
    return { outcome: "NO_ELIGIBLE_OFFER", ...base, decision_reason_code: "NO_ELIGIBLE_OFFER", rejected };
  }

  let picked: { pick: SmartLinkCandidate; code: string };
  switch (mode) {
    case "RULE_BASED":
      picked = pickRuleBased(eligible);
      break;
    case "WEIGHTED":
      picked = pickWeighted(eligible, random);
      break;
    case "PERFORMANCE_BASED":
      picked = pickPerformance(eligible, random);
      break;
    case "GEO_BASED":
      picked = pickMostSpecific(eligible, ["COUNTRY"], ctx, pickRuleBased, "GEO");
      break;
    case "DEVICE_BASED":
      picked = pickMostSpecific(eligible, ["DEVICE"], ctx, pickRuleBased, "DEVICE");
      break;
    case "HYBRID":
      picked = pickMostSpecific(eligible, ["COUNTRY", "DEVICE"], ctx, (tier) => pickWeighted(tier, random), "HYBRID");
      break;
  }

  const { pick, code } = picked;
  // Defensive: the strategies only see eligible candidates, but the recorded
  // click must never point at an inactive offer — re-check the invariant.
  const recheck = candidateEligibility(pick, ctx, options.exclude);
  if (!recheck.eligible || !pick.facts.current_version_id || !pick.facts.destination_url) {
    throw new Error(`smartlink engine invariant violated: selected ineligible offer ${pick.offer_id}`);
  }
  return {
    outcome: "OFFER",
    ...base,
    offer_id: pick.offer_id,
    offer_organization_id: pick.offer_organization_id,
    offer_version_id: pick.facts.current_version_id,
    destination_url: pick.facts.destination_url,
    decision_reason_code: failoverFrom ? `FAILOVER:${code}` : code,
    eligible_offer_ids: eligible.map((c) => c.offer_id),
    rejected,
  };
}

/**
 * Failover after `failedOfferId` could not be used (e.g. its cap reserve was
 * denied between eligibility and the click INSERT, or its destination is
 * down). Re-runs the FULL eligibility with the failed offer(s) excluded.
 */
export function failover(
  link: SmartLinkDefinition,
  candidates: readonly SmartLinkCandidate[],
  ctx: ClickContext,
  failedOfferId: string,
  options: RouteOptions = {},
): RoutingDecision {
  const exclude = new Set(options.exclude ?? []);
  exclude.add(failedOfferId);
  return route(link, candidates, ctx, { ...options, exclude });
}
