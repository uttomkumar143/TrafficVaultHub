/**
 * Conversion lifecycle state machine (Phase 4 Unit 2; PRD §38, §115).
 *
 * Happy path:
 *   RECEIVED → VALIDATING → PENDING → APPROVED → LEDGER_POSTED → EARNED
 *   → PAYOUT_ELIGIBLE → PAID
 * Alternate / exception states:
 *   REJECTED, FRAUD_REVIEW, DISPUTED, REVERSED (terminal), PAID (terminal).
 *
 * Pure module — no I/O. Mirrors `modules/offers/state-machine.ts`: the service
 * asks `canTransition(from, to, actor)` plus `guardTransition(to, holds)` and
 * the answer is final. Every accepted transition is persisted as an
 * INSERT-only `conversion_status_history` row + an `audit_logs` entry in the
 * same batch (service layer).
 *
 * Authority split (PRD §5 — server-side only):
 *   TENANT   — the advertiser organization that owns the offer
 *              (`conversions.approve` / `conversions.reject` /
 *              `conversions.reverse`): approve/reject pending conversions,
 *              dispute a rejection, reverse an approved conversion.
 *   PLATFORM — network reviewers (`fraud.review`, `conversions.*`): everything
 *              TENANT may do plus resolving FRAUD_REVIEW and DISPUTED.
 *   SYSTEM   — automatic intake (RECEIVED → VALIDATING → PENDING, and the
 *              validation outcome PENDING → REJECTED | FRAUD_REVIEW).
 *   INTERNAL — the money pipeline (APPROVED → LEDGER_POSTED → EARNED →
 *              PAYOUT_ELIGIBLE → PAID). NEVER reachable from HTTP: no route
 *              maps to INTERNAL, and the service exposes these as
 *              `markLedgerPosted()`-style functions consumed by Phase 5 code.
 *
 * Holds (`conversion_holds`, PRD §44, §47):
 *   an ACTIVE CONVERSION_HOLD blocks → APPROVED;
 *   an ACTIVE PAYOUT_HOLD or COMPLIANCE_BLOCK blocks → PAYOUT_ELIGIBLE;
 *   an open FRAUD_REVIEW on the affiliate blocks → PAYOUT_ELIGIBLE as well.
 */

export const CONVERSION_STATUSES = [
  "RECEIVED",
  "VALIDATING",
  "PENDING",
  "APPROVED",
  "LEDGER_POSTED",
  "EARNED",
  "PAYOUT_ELIGIBLE",
  "PAID",
  "REJECTED",
  "FRAUD_REVIEW",
  "DISPUTED",
  "REVERSED",
] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export const CONVERSION_ACTORS = ["TENANT", "PLATFORM", "SYSTEM", "INTERNAL"] as const;
export type ConversionActor = (typeof CONVERSION_ACTORS)[number];

export const HOLD_TYPES = ["CONVERSION_HOLD", "PAYOUT_HOLD", "COMPLIANCE_BLOCK"] as const;
export type HoldType = (typeof HOLD_TYPES)[number];

/** Terminal states — nothing leaves them. */
export const TERMINAL_STATUSES: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>(["PAID", "REVERSED"]);

/** Statuses a human actor may move a conversion INTO only with a reason code (PRD §124). */
export const REASON_REQUIRED_STATUSES: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>([
  "REJECTED",
  "FRAUD_REVIEW",
  "DISPUTED",
  "REVERSED",
]);

/** Statuses in which the conversion counts as economically approved (commission fixed). */
export const APPROVED_FAMILY: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>([
  "APPROVED",
  "LEDGER_POSTED",
  "EARNED",
  "PAYOUT_ELIGIBLE",
  "PAID",
]);

type Edge = { to: ConversionStatus; by: readonly ConversionActor[] };

const EDGES: Readonly<Record<ConversionStatus, readonly Edge[]>> = {
  RECEIVED: [{ to: "VALIDATING", by: ["SYSTEM"] }],
  VALIDATING: [
    { to: "PENDING", by: ["SYSTEM"] },
    { to: "REJECTED", by: ["SYSTEM"] },
    { to: "FRAUD_REVIEW", by: ["SYSTEM"] },
  ],
  PENDING: [
    { to: "APPROVED", by: ["TENANT", "PLATFORM"] },
    { to: "REJECTED", by: ["TENANT", "PLATFORM", "SYSTEM"] },
    { to: "FRAUD_REVIEW", by: ["PLATFORM", "SYSTEM"] },
  ],
  FRAUD_REVIEW: [
    { to: "APPROVED", by: ["PLATFORM"] },
    { to: "REJECTED", by: ["PLATFORM"] },
  ],
  REJECTED: [{ to: "DISPUTED", by: ["TENANT", "PLATFORM"] }],
  DISPUTED: [
    { to: "APPROVED", by: ["PLATFORM"] },
    { to: "REJECTED", by: ["PLATFORM"] },
  ],
  APPROVED: [
    { to: "REVERSED", by: ["TENANT", "PLATFORM"] },
    { to: "LEDGER_POSTED", by: ["INTERNAL"] },
  ],
  LEDGER_POSTED: [{ to: "EARNED", by: ["INTERNAL"] }],
  EARNED: [{ to: "PAYOUT_ELIGIBLE", by: ["INTERNAL"] }],
  PAYOUT_ELIGIBLE: [{ to: "PAID", by: ["INTERNAL"] }],
  PAID: [],
  REVERSED: [],
};

export function isConversionStatus(value: string): value is ConversionStatus {
  return (CONVERSION_STATUSES as readonly string[]).includes(value);
}

export function isConversionActor(value: string): value is ConversionActor {
  return (CONVERSION_ACTORS as readonly string[]).includes(value);
}

export function isHoldType(value: string): value is HoldType {
  return (HOLD_TYPES as readonly string[]).includes(value);
}

/** True when `actor` may move a conversion from `from` to `to` (holds not considered). */
export function canTransition(from: ConversionStatus, to: ConversionStatus, actor: ConversionActor): boolean {
  return EDGES[from].some((e) => e.to === to && e.by.includes(actor));
}

/** All targets reachable by `actor` from `from`. */
export function allowedTargets(from: ConversionStatus, actor: ConversionActor): ConversionStatus[] {
  return EDGES[from].filter((e) => e.by.includes(actor)).map((e) => e.to);
}

export function requiresReason(to: ConversionStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to);
}

/** True when the edge INTO `to` exists for INTERNAL only — i.e. HTTP can never trigger it. */
export function isInternalOnlyTarget(to: ConversionStatus): boolean {
  const edges = CONVERSION_STATUSES.flatMap((from) => EDGES[from].filter((e) => e.to === to));
  return edges.length > 0 && edges.every((e) => e.by.length === 1 && e.by[0] === "INTERNAL");
}

/** Facts the service pre-fetches so the guard stays pure. */
export type HoldFacts = {
  /** hold_type of every ACTIVE `conversion_holds` row scoped to this conversion or its affiliate. */
  readonly activeHoldTypes: readonly HoldType[];
  /** True when an OPEN/UNDER_REVIEW/APPEALED fraud case targets the affiliate or this conversion. */
  readonly fraudReviewOpen: boolean;
};

export type GuardResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Hold guard. Applied AFTER `canTransition` — an edge may exist for the actor
 * yet be blocked by an active hold. Only → APPROVED and → PAYOUT_ELIGIBLE are
 * guarded; every other edge is unaffected by holds.
 */
export function guardTransition(to: ConversionStatus, facts: HoldFacts): GuardResult {
  if (to === "APPROVED" && facts.activeHoldTypes.includes("CONVERSION_HOLD")) {
    return { ok: false, code: "CONVERSION_ON_HOLD", message: "An active conversion hold blocks approval" };
  }
  if (to === "PAYOUT_ELIGIBLE") {
    if (facts.activeHoldTypes.includes("PAYOUT_HOLD")) {
      return { ok: false, code: "PAYOUT_ON_HOLD", message: "An active payout hold blocks payout eligibility" };
    }
    if (facts.activeHoldTypes.includes("COMPLIANCE_BLOCK")) {
      return { ok: false, code: "COMPLIANCE_BLOCKED", message: "An active compliance block blocks payout eligibility" };
    }
    if (facts.fraudReviewOpen) {
      return { ok: false, code: "FRAUD_REVIEW_OPEN", message: "An open fraud review blocks payout eligibility" };
    }
  }
  return { ok: true };
}

/** True when no hold/fraud fact would block → PAYOUT_ELIGIBLE (used by `isPayoutBlocked()`). */
export function isPayoutBlockedBy(facts: HoldFacts): boolean {
  return !guardTransition("PAYOUT_ELIGIBLE", facts).ok;
}
