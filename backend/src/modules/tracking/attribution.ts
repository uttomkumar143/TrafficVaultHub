/**
 * Attribution engine — PURE decision logic (Phase 3 Unit 7; PRD §35–§36,
 * §39). No I/O: the caller (attribution service) loads the candidate clicks
 * and the current policy version, calls `decide()`, and persists the
 * resulting `attributions` row. Keeping the rule set free of D1 makes every
 * decision reproducible from its inputs — the PRD §35 "explainable, never a
 * black box" requirement.
 *
 * Inputs
 *   * policy      — the `attribution_policies` row that is current for the
 *                   offer (model, window, dedup scope, fallback rule). Its
 *                   `id` is recorded as `rule_version` on the decision.
 *   * conversion  — the postback facts: which offer, when the event occurred,
 *                   the optional click_id the advertiser echoed back, and the
 *                   dedup identifiers.
 *   * candidates  — clicks the repository found for the conversion (already
 *                   narrowed by offer_id; the engine re-checks every fact).
 *   * duplicateOf — set when the repository found an earlier conversion with
 *                   the same dedup key (the decision is then DUPLICATE and
 *                   nothing else is evaluated).
 *
 * Output: `{ decision, reason_code, click_id, affiliate_organization_id,
 * click_to_conversion_seconds }` — exactly the columns of `attributions`.
 *
 * Rules (in order):
 *   1. DUPLICATE     — a prior conversion shares the dedup key (§39). Reason
 *                      names the scope: DUPLICATE_EXTERNAL_ID /
 *                      DUPLICATE_TRANSACTION_ID / DUPLICATE_CLICK_EVENT.
 *   2. Echoed click  — when the postback carries `click_id` it MUST be one of
 *                      the candidates for THIS offer; a click for a different
 *                      offer is CLICK_OFFER_MISMATCH (REJECTED — never
 *                      silently re-attributed to another offer). A click that
 *                      exists but is outside the window is WINDOW_EXPIRED.
 *   3. Model         — LAST_CLICK picks the newest in-window click at or
 *                      before `occurred_at`; FIRST_CLICK the oldest.
 *                      Clicks AFTER the conversion never qualify.
 *   4. Fallback      — no in-window click: `fallback_rule` REJECT →
 *                      REJECTED/NO_CLICK_IN_WINDOW; HOLD_FOR_REVIEW →
 *                      HELD/NO_CLICK_IN_WINDOW (kept for a human, §130).
 *
 * Money never enters here (Phase 4 prices the conversion); all durations are
 * integer seconds.
 */

export const ATTRIBUTION_MODELS = ["LAST_CLICK", "FIRST_CLICK"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const DEDUP_SCOPES = ["EXTERNAL_CONVERSION_ID", "CLICK_ID_EVENT", "TRANSACTION_ID"] as const;
export type DedupScope = (typeof DEDUP_SCOPES)[number];

export const FALLBACK_RULES = ["REJECT", "HOLD_FOR_REVIEW"] as const;
export type FallbackRule = (typeof FALLBACK_RULES)[number];

export const ATTRIBUTION_DECISIONS = ["ATTRIBUTED", "REJECTED", "DUPLICATE", "HELD"] as const;
export type AttributionDecision = (typeof ATTRIBUTION_DECISIONS)[number];

/** Machine reason codes (persisted verbatim in `attributions.reason_code`). */
export const ATTRIBUTION_REASON_CODES = [
  "CLICK_MATCHED_LAST",
  "CLICK_MATCHED_FIRST",
  "CLICK_MATCHED_ECHOED",
  "NO_CLICK_IN_WINDOW",
  "WINDOW_EXPIRED",
  "CLICK_OFFER_MISMATCH",
  "CLICK_NOT_FOUND",
  "CLICK_AFTER_CONVERSION",
  "DUPLICATE_EXTERNAL_ID",
  "DUPLICATE_TRANSACTION_ID",
  "DUPLICATE_CLICK_EVENT",
] as const;
export type AttributionReasonCode = (typeof ATTRIBUTION_REASON_CODES)[number];

/** The subset of an `attribution_policies` row the engine reads. */
export interface AttributionPolicyInput {
  id: string;
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
}

/** The subset of a `clicks` row the engine reads. */
export interface ClickCandidate {
  id: string;
  offer_id: string;
  /** Affiliate organization that owns the click (`clicks.organization_id`). */
  organization_id: string;
  clicked_at: string;
}

export interface ConversionInput {
  offer_id: string;
  /** ISO-8601 UTC; when the advertiser says the event happened. */
  occurred_at: string;
  /** Click id echoed back by the advertiser (from the `{click_id}` macro), if any. */
  click_id: string | null;
}

export interface AttributionResult {
  decision: AttributionDecision;
  reason_code: AttributionReasonCode;
  click_id: string | null;
  affiliate_organization_id: string | null;
  click_to_conversion_seconds: number | null;
}

export interface DecideInput {
  policy: AttributionPolicyInput;
  conversion: ConversionInput;
  candidates: readonly ClickCandidate[];
  /** True when an earlier conversion with the same dedup key already exists. */
  duplicateOf: boolean;
}

const DUPLICATE_REASON: Readonly<Record<DedupScope, AttributionReasonCode>> = {
  EXTERNAL_CONVERSION_ID: "DUPLICATE_EXTERNAL_ID",
  TRANSACTION_ID: "DUPLICATE_TRANSACTION_ID",
  CLICK_ID_EVENT: "DUPLICATE_CLICK_EVENT",
};

/** Whole seconds between two ISO timestamps (`to - from`), or null when either is unparseable. */
export function secondsBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 1000);
}

function none(decision: AttributionDecision, reason_code: AttributionReasonCode): AttributionResult {
  return { decision, reason_code, click_id: null, affiliate_organization_id: null, click_to_conversion_seconds: null };
}

function attributed(click: ClickCandidate, age: number, reason_code: AttributionReasonCode): AttributionResult {
  return {
    decision: "ATTRIBUTED",
    reason_code,
    click_id: click.id,
    affiliate_organization_id: click.organization_id,
    click_to_conversion_seconds: age,
  };
}

/**
 * Decide the attribution for one conversion. Deterministic: same inputs →
 * same output. Never throws on data shape — unparseable timestamps simply
 * fail to qualify.
 */
export function decide(input: DecideInput): AttributionResult {
  const { policy, conversion, candidates } = input;

  if (input.duplicateOf) return none("DUPLICATE", DUPLICATE_REASON[policy.dedup_scope]);

  // Only clicks for THIS offer, at or before the conversion, inside the window.
  const sameOffer = candidates.filter((c) => c.offer_id === conversion.offer_id);
  const qualified: Array<{ click: ClickCandidate; age: number }> = [];
  let sawAfterConversion = false;
  let sawExpired = false;
  for (const click of sameOffer) {
    const age = secondsBetween(click.clicked_at, conversion.occurred_at);
    if (age === null) continue;
    if (age < 0) {
      sawAfterConversion = true;
      continue;
    }
    if (age > policy.window_seconds) {
      sawExpired = true;
      continue;
    }
    qualified.push({ click, age });
  }

  // Echoed click id: must be one of ours for this offer, and in window.
  if (conversion.click_id !== null) {
    const echoed = candidates.find((c) => c.id === conversion.click_id);
    if (!echoed) return fallback(policy, "CLICK_NOT_FOUND");
    if (echoed.offer_id !== conversion.offer_id) return none("REJECTED", "CLICK_OFFER_MISMATCH");
    const hit = qualified.find((q) => q.click.id === echoed.id);
    if (hit) return attributed(hit.click, hit.age, "CLICK_MATCHED_ECHOED");
    const age = secondsBetween(echoed.clicked_at, conversion.occurred_at);
    if (age !== null && age < 0) return none("REJECTED", "CLICK_AFTER_CONVERSION");
    return fallback(policy, "WINDOW_EXPIRED");
  }

  if (qualified.length === 0) {
    if (sawExpired && !sawAfterConversion) return fallback(policy, "WINDOW_EXPIRED");
    if (sawAfterConversion && !sawExpired) return fallback(policy, "CLICK_AFTER_CONVERSION");
    return fallback(policy, "NO_CLICK_IN_WINDOW");
  }

  // Deterministic order: clicked_at then id, so ties never depend on input order.
  qualified.sort((a, b) => a.click.clicked_at.localeCompare(b.click.clicked_at) || a.click.id.localeCompare(b.click.id));
  const pick = policy.model === "FIRST_CLICK" ? qualified[0] : qualified[qualified.length - 1];
  if (!pick) return fallback(policy, "NO_CLICK_IN_WINDOW");
  return attributed(pick.click, pick.age, policy.model === "FIRST_CLICK" ? "CLICK_MATCHED_FIRST" : "CLICK_MATCHED_LAST");
}

/** No qualifying click: the policy's fallback rule decides REJECTED vs HELD; the reason explains why nothing matched. */
function fallback(policy: AttributionPolicyInput, reason_code: AttributionReasonCode): AttributionResult {
  return none(policy.fallback_rule === "HOLD_FOR_REVIEW" ? "HELD" : "REJECTED", reason_code);
}

/**
 * The dedup key for a conversion under a policy's scope (§39). `null` means
 * the scope cannot be applied to this postback (e.g. TRANSACTION_ID scope
 * without a transaction id) — the caller then falls back to the always-on
 * UNIQUE (organization_id, offer_id, external_conversion_id) constraint.
 */
export function dedupKey(
  scope: DedupScope,
  c: { external_conversion_id: string; transaction_id: string | null; click_id: string | null; conversion_event: string },
): { column: "external_conversion_id" | "transaction_id" | "click_event"; value: string } | null {
  switch (scope) {
    case "EXTERNAL_CONVERSION_ID":
      return { column: "external_conversion_id", value: c.external_conversion_id };
    case "TRANSACTION_ID":
      return c.transaction_id ? { column: "transaction_id", value: c.transaction_id } : null;
    case "CLICK_ID_EVENT":
      return c.click_id ? { column: "click_event", value: `${c.click_id}\u0000${c.conversion_event}` } : null;
  }
}
