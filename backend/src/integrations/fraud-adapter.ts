/**
 * FraudAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * Phase 4's `assessRisk()` (modules/fraud/risk-engine.ts) is OUR deterministic
 * rules engine and stays the authority: it turns `RiskFacts` into a versioned
 * `RiskAssessment` (score / level / evidence). An external fraud-scoring vendor
 * (device-intelligence, IP reputation, ML scorer) is consulted through this
 * port and its answer is folded in as ONE MORE SIGNAL — evidence, never a
 * verdict. The case workflow still decides.
 *
 * Shapes are therefore aligned with the engine's: the adapter takes the same
 * `RiskFacts` plus the coarse subject identity, and returns a `RiskLevel` on
 * the same 0..100 scale together with vendor reason codes. A vendor that
 * returns nothing (null) is "no opinion" — exactly like an absent fact in the
 * engine, it fires no signal.
 *
 * Isolation: imports Phase 4's PURE types only (no D1 / KV / Hono / service).
 * Privacy: the vendor sees the same coarse facts we store — no raw IP, no raw UA.
 * Failure: a vendor outage returns `available: false`, never throws, so the
 * pipeline degrades to the local engine instead of blocking conversions.
 */

import { levelFor, type RiskFacts, type RiskLevel } from "../modules/fraud/risk-engine";

export type { RiskFacts, RiskLevel } from "../modules/fraud/risk-engine";

export const FRAUD_SUBJECT_TYPES = ["CLICK", "CONVERSION", "AFFILIATE"] as const;
export type FraudAdapterSubjectType = (typeof FRAUD_SUBJECT_TYPES)[number];

export interface FraudScoreRequest {
  /** Caller-owned key (conversion id, click id) — same key ⇒ vendors may return the cached verdict. 1..256 chars. */
  readonly idempotency_key: string;
  readonly organization_id: string;
  readonly subject_type: FraudAdapterSubjectType;
  readonly subject_id: string;
  /** The same coarse facts the local engine scores. */
  readonly facts: RiskFacts;
}

export interface FraudScoreResult {
  readonly provider: string;
  /** False when the vendor could not answer (timeout, 5xx, quota). Then `score`/`level` are null. */
  readonly available: boolean;
  /** Vendor score normalised to 0..100 (integer), or null for "no opinion". */
  readonly score: number | null;
  readonly level: RiskLevel | null;
  /** Vendor reason codes, GLOB [A-Z0-9_]*, surfaced as evidence on the assessment. */
  readonly reason_codes: readonly string[];
  /** Vendor's own id for the lookup, when it issues one. */
  readonly provider_reference?: string;
}

/** Feedback loop: tell the vendor what the reviewer decided so its model can learn. Fire-and-forget. */
export const FRAUD_OUTCOMES = ["CONFIRMED_FRAUD", "CLEARED", "INCONCLUSIVE"] as const;
export type FraudOutcome = (typeof FRAUD_OUTCOMES)[number];

export interface FraudOutcomeReport {
  readonly idempotency_key: string;
  readonly subject_type: FraudAdapterSubjectType;
  readonly subject_id: string;
  readonly outcome: FraudOutcome;
  /** ISO-8601 UTC. */
  readonly decided_at: string;
}

export interface FraudAdapter {
  readonly name: string;
  /** Never throws for a vendor-side failure — returns available:false. */
  score(req: FraudScoreRequest): Promise<FraudScoreResult>;
  /** Idempotent on idempotency_key. Never throws for a vendor-side failure. */
  reportOutcome(report: FraudOutcomeReport): Promise<void>;
}

/** Clamp any vendor number onto the engine's integer 0..100 scale. Non-finite ⇒ null (no opinion). */
export function normaliseVendorScore(raw: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ---- implementations -----------------------------------------------------------------

/** Default: no vendor connected — "no opinion" on everything, so only the local engine's signals fire. */
export class NullFraudAdapter implements FraudAdapter {
  readonly name = "null";
  async score(_req: FraudScoreRequest): Promise<FraudScoreResult> {
    return { provider: this.name, available: true, score: null, level: null, reason_codes: [] };
  }
  async reportOutcome(_report: FraudOutcomeReport): Promise<void> {
    /* nothing to tell */
  }
}

/**
 * Test adapter — a scripted vendor. Tests queue scores by idempotency_key (or a
 * default); unknown keys get `defaultScore`. `unavailable = true` simulates an
 * outage. Records every request and outcome report for assertions.
 */
export class ScriptedFraudAdapter implements FraudAdapter {
  readonly name = "scripted";
  readonly requests: FraudScoreRequest[] = [];
  readonly outcomes: FraudOutcomeReport[] = [];
  private readonly byKey = new Map<string, { score: number; reason_codes: readonly string[] }>();
  private readonly seenOutcomes = new Set<string>();
  unavailable = false;
  defaultScore: number | null = null;

  /** Script the vendor's answer for one idempotency_key. */
  scriptScore(idempotency_key: string, score: number, reason_codes: readonly string[] = []): void {
    this.byKey.set(idempotency_key, { score, reason_codes });
  }

  async score(req: FraudScoreRequest): Promise<FraudScoreResult> {
    this.requests.push(req);
    if (this.unavailable) return { provider: this.name, available: false, score: null, level: null, reason_codes: [] };
    const scripted = this.byKey.get(req.idempotency_key);
    const raw = scripted ? scripted.score : this.defaultScore;
    const score = raw === null ? null : normaliseVendorScore(raw);
    return {
      provider: this.name,
      available: true,
      score,
      level: score === null ? null : levelFor(score),
      reason_codes: scripted ? scripted.reason_codes : [],
      provider_reference: `scripted_${req.idempotency_key}`,
    };
  }

  async reportOutcome(report: FraudOutcomeReport): Promise<void> {
    if (this.seenOutcomes.has(report.idempotency_key)) return;
    this.seenOutcomes.add(report.idempotency_key);
    this.outcomes.push(report);
  }
}
