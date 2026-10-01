/**
 * Payout state machine (Phase 5 Unit 10) — PURE.
 *
 * Mirrors 0011 `trg_payouts_legal_transition` EXACTLY (§65):
 *   REQUESTED         → ELIGIBILITY_CHECK | CANCELLED
 *   ELIGIBILITY_CHECK → UNDER_REVIEW | FAILED | CANCELLED
 *   UNDER_REVIEW      → APPROVED | CANCELLED
 *   APPROVED          → PROCESSING | CANCELLED
 *   PROCESSING        → PAID | FAILED
 *   FAILED            → PROCESSING | CANCELLED      (recoverable, §66)
 *   PAID, CANCELLED   → (final; trg_payouts_terminal)
 *
 * The test suite asserts every (from, to) pair here against the real trigger
 * on the TestD1 shim, so the two can never drift silently.
 *
 * This file knows nothing about money, the ledger, D1 or actors — it answers
 * only "is this edge legal and what row invariants come with it".
 */

export const PAYOUT_STATUSES = [
  "REQUESTED",
  "ELIGIBILITY_CHECK",
  "UNDER_REVIEW",
  "APPROVED",
  "PROCESSING",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export function isPayoutStatus(value: string): value is PayoutStatus {
  return (PAYOUT_STATUSES as readonly string[]).includes(value);
}

/** The legal edges, one entry per source state. Order within each list is irrelevant. */
export const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = Object.freeze({
  REQUESTED: ["ELIGIBILITY_CHECK", "CANCELLED"],
  ELIGIBILITY_CHECK: ["UNDER_REVIEW", "FAILED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "CANCELLED"],
  APPROVED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PAID", "FAILED"],
  FAILED: ["PROCESSING", "CANCELLED"],
  PAID: [],
  CANCELLED: [],
});

export const PAYOUT_FINAL_STATUSES: readonly PayoutStatus[] = ["PAID", "CANCELLED"];

export function isFinalPayoutStatus(s: PayoutStatus): boolean {
  return PAYOUT_FINAL_STATUSES.includes(s);
}

/** True when `to` is a legal next status from `from`. Self-transitions are NOT edges (the trigger ignores them; we refuse them). */
export function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function nextPayoutStatuses(from: PayoutStatus): readonly PayoutStatus[] {
  return PAYOUT_TRANSITIONS[from];
}

/** Every (from, to) pair with from ≠ to, flagged legal or not — used by tests to compare with the DB trigger. */
export function allPayoutEdges(): ReadonlyArray<{ from: PayoutStatus; to: PayoutStatus; legal: boolean }> {
  const out: Array<{ from: PayoutStatus; to: PayoutStatus; legal: boolean }> = [];
  for (const from of PAYOUT_STATUSES) {
    for (const to of PAYOUT_STATUSES) {
      if (from !== to) out.push({ from, to, legal: canTransitionPayout(from, to) });
    }
  }
  return out;
}

export type PayoutTransitionError =
  | { code: "PAYOUT_FINAL"; message: string }
  | { code: "PAYOUT_ILLEGAL_TRANSITION"; message: string }
  | { code: "PAYOUT_FAILURE_CODE_REQUIRED"; message: string }
  | { code: "PAYOUT_APPROVER_REQUIRED"; message: string }
  | { code: "PAYOUT_APPROVER_IS_REQUESTER"; message: string };

export type PayoutTransitionResult = { ok: true } | { ok: false; error: PayoutTransitionError };

/** Facts the row-level CHECKs in 0011 depend on when entering a status. */
export interface PayoutTransitionFacts {
  /** payouts.failure_code to be written (required when entering FAILED; GLOB [A-Z0-9_]*, 1..64). */
  readonly failure_code?: string | null;
  /** payouts.requested_by_user_id (null for SYSTEM-requested payouts). */
  readonly requested_by_user_id?: string | null;
  /** The approver when entering APPROVED (0011: approved_at required for APPROVED/PROCESSING/PAID; approver ≠ requester §132). */
  readonly approved_by_user_id?: string | null;
}

const FAILURE_CODE_RE = /^[A-Z0-9_]{1,64}$/;

/**
 * Full transition check: edge legality (same as the trigger) plus the 0011
 * row invariants the edge implies. Mirrors the DB error names so a caller can
 * reject before touching D1 and still see the same code the database would raise.
 */
export function checkPayoutTransition(from: PayoutStatus, to: PayoutStatus, facts: PayoutTransitionFacts = {}): PayoutTransitionResult {
  if (isFinalPayoutStatus(from)) {
    return { ok: false, error: { code: "PAYOUT_FINAL", message: `${from} is final` } };
  }
  if (!canTransitionPayout(from, to)) {
    return { ok: false, error: { code: "PAYOUT_ILLEGAL_TRANSITION", message: `${from} → ${to} is not a legal payout transition` } };
  }
  if (to === "FAILED") {
    const fc = facts.failure_code;
    if (typeof fc !== "string" || !FAILURE_CODE_RE.test(fc)) {
      return { ok: false, error: { code: "PAYOUT_FAILURE_CODE_REQUIRED", message: "entering FAILED requires failure_code matching [A-Z0-9_]{1,64}" } };
    }
  }
  if (to === "APPROVED") {
    const approver = facts.approved_by_user_id;
    if (typeof approver !== "string" || approver.length === 0) {
      return { ok: false, error: { code: "PAYOUT_APPROVER_REQUIRED", message: "entering APPROVED requires approved_by_user_id" } };
    }
    if (facts.requested_by_user_id != null && facts.requested_by_user_id === approver) {
      return { ok: false, error: { code: "PAYOUT_APPROVER_IS_REQUESTER", message: "approver must differ from requester (§132)" } };
    }
  }
  return { ok: true };
}
