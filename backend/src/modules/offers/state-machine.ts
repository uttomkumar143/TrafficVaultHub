/**
 * Offer lifecycle + access/targeting state machine (Phase 2 Units 3, 6; PRD
 * §22, §24, §28, §30, §124).
 *
 * Happy path:
 *   DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → LIVE
 * Operational / alternate states:
 *   PAUSED, CAP_REACHED, BUDGET_EXHAUSTED, TRACKING_ISSUE, COMPLIANCE_HOLD,
 *   EXPIRED, ARCHIVED (terminal).
 *
 * Pure module — no I/O. Mirrors `modules/affiliates/state-machine.ts`: the
 * service asks `canTransition(from, to, actorKind)` and the answer is final.
 * Every accepted transition is persisted as an append-only
 * `offer_status_transitions`-style audit row (here: `audit_logs`, plus the
 * offer row's status/timestamps).
 *
 * Authority split (PRD §5 — server-side only):
 *   TENANT   — the advertiser organization that owns the offer
 *              (`offers.create` / `offers.update` / `offers.pause`): drafts,
 *              submits, launches (APPROVED → LIVE), pauses/resumes, tops up a
 *              budget/cap-halted offer, archives its own draft/paused offer.
 *   PLATFORM — network reviewers (`offers.approve` / `offers.pause`): accept a
 *              submission into review, approve, send back to DRAFT, place a
 *              COMPLIANCE_HOLD / TRACKING_ISSUE, and archive. Never the tenant
 *              (PRD §132: no self-approval).
 *   SYSTEM   — automatic operational states derived from measured facts:
 *              CAP_REACHED, BUDGET_EXHAUSTED, TRACKING_ISSUE (auto-detected)
 *              and EXPIRED (time window elapsed).
 *
 * Restrictive transitions require a reason (PRD §124).
 */

export const OFFER_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "LIVE",
  "PAUSED",
  "CAP_REACHED",
  "BUDGET_EXHAUSTED",
  "TRACKING_ISSUE",
  "COMPLIANCE_HOLD",
  "EXPIRED",
  "ARCHIVED",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const ACTOR_KINDS = ["TENANT", "PLATFORM", "SYSTEM"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Statuses an actor may move an offer INTO only with a human-readable reason (PRD §124). */
export const REASON_REQUIRED_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  "COMPLIANCE_HOLD",
  "TRACKING_ISSUE",
  "ARCHIVED",
]);

/** Terminal state — nothing leaves it. */
export const TERMINAL_STATUS: OfferStatus = "ARCHIVED";

/** Statuses in which a new immutable version may still be created. */
export const VERSIONABLE_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>(
  OFFER_STATUSES.filter((s) => s !== "ARCHIVED"),
);

type Edge = { to: OfferStatus; by: readonly ActorKind[] };

const EDGES: Readonly<Record<OfferStatus, readonly Edge[]>> = {
  DRAFT: [
    { to: "SUBMITTED", by: ["TENANT"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  SUBMITTED: [
    { to: "UNDER_REVIEW", by: ["PLATFORM"] },
    // Advertiser withdraws; platform sends back for changes (reason via COMPLIANCE? no — plain send-back).
    { to: "DRAFT", by: ["TENANT", "PLATFORM"] },
  ],
  UNDER_REVIEW: [
    { to: "APPROVED", by: ["PLATFORM"] },
    { to: "DRAFT", by: ["PLATFORM"] },
    { to: "COMPLIANCE_HOLD", by: ["PLATFORM"] },
  ],
  APPROVED: [
    { to: "LIVE", by: ["TENANT", "PLATFORM"] },
    { to: "COMPLIANCE_HOLD", by: ["PLATFORM"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  LIVE: [
    { to: "PAUSED", by: ["TENANT", "PLATFORM"] },
    { to: "CAP_REACHED", by: ["SYSTEM"] },
    { to: "BUDGET_EXHAUSTED", by: ["SYSTEM"] },
    { to: "TRACKING_ISSUE", by: ["SYSTEM", "PLATFORM"] },
    { to: "COMPLIANCE_HOLD", by: ["PLATFORM"] },
    { to: "EXPIRED", by: ["SYSTEM"] },
  ],
  PAUSED: [
    { to: "LIVE", by: ["TENANT", "PLATFORM"] },
    { to: "COMPLIANCE_HOLD", by: ["PLATFORM"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
    { to: "EXPIRED", by: ["SYSTEM"] },
  ],
  CAP_REACHED: [
    // Cap raised (new version) → back LIVE; or paused / expired.
    { to: "LIVE", by: ["TENANT", "PLATFORM", "SYSTEM"] },
    { to: "PAUSED", by: ["TENANT", "PLATFORM"] },
    { to: "EXPIRED", by: ["SYSTEM"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  BUDGET_EXHAUSTED: [
    // Budget topped up (new version) → back LIVE.
    { to: "LIVE", by: ["TENANT", "PLATFORM", "SYSTEM"] },
    { to: "PAUSED", by: ["TENANT", "PLATFORM"] },
    { to: "EXPIRED", by: ["SYSTEM"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  TRACKING_ISSUE: [
    { to: "LIVE", by: ["PLATFORM", "SYSTEM"] },
    { to: "PAUSED", by: ["TENANT", "PLATFORM"] },
    { to: "COMPLIANCE_HOLD", by: ["PLATFORM"] },
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  COMPLIANCE_HOLD: [
    { to: "LIVE", by: ["PLATFORM"] },
    { to: "ARCHIVED", by: ["PLATFORM"] },
  ],
  EXPIRED: [
    { to: "ARCHIVED", by: ["TENANT", "PLATFORM"] },
  ],
  ARCHIVED: [],
};

export function isOfferStatus(value: string): value is OfferStatus {
  return (OFFER_STATUSES as readonly string[]).includes(value);
}

/** True when `actor` may move an offer from `from` to `to`. */
export function canTransition(from: OfferStatus, to: OfferStatus, actor: ActorKind): boolean {
  return EDGES[from].some((e) => e.to === to && e.by.includes(actor));
}

/** Target statuses reachable from `from` by `actor` (for UI hints / tests). */
export function allowedTargets(from: OfferStatus, actor: ActorKind): OfferStatus[] {
  return EDGES[from].filter((e) => e.by.includes(actor)).map((e) => e.to);
}

/** Whether entering `to` needs a human-readable reason (PRD §124). */
export function requiresReason(to: OfferStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to);
}

// ---- access modes (PRD §28) --------------------------------------------------

/**
 * Marketplace access modes, enforced SERVER-SIDE (PRD §28, §116):
 *   PUBLIC              — any affiliate may see and join.
 *   APPLICATION_REQUIRED— listed to all; confidential detail and join gated on
 *                         an APPROVED `affiliate_offer_access` grant.
 *   PRIVATE             — never listed; visible only to an affiliate with an
 *                         APPROVED grant (direct link / invitation).
 *   INVITE_ONLY         — visible only to affiliates the advertiser INVITED
 *                         (INVITED or APPROVED grant).
 *   AFFILIATE_SPECIFIC  — visible only to specifically granted affiliates
 *                         (APPROVED grant); the tightest allow-list mode.
 */
export const ACCESS_MODES = [
  "PUBLIC",
  "APPLICATION_REQUIRED",
  "PRIVATE",
  "INVITE_ONLY",
  "AFFILIATE_SPECIFIC",
] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export function isAccessMode(value: string): value is AccessMode {
  return (ACCESS_MODES as readonly string[]).includes(value);
}

/** Access-grant lifecycle for `affiliate_offer_access` (PRD §92). */
export const ACCESS_GRANT_STATUSES = ["INVITED", "REQUESTED", "APPROVED", "REJECTED", "REVOKED"] as const;
export type AccessGrantStatus = (typeof ACCESS_GRANT_STATUSES)[number];

export function isAccessGrantStatus(value: string): value is AccessGrantStatus {
  return (ACCESS_GRANT_STATUSES as readonly string[]).includes(value);
}

// ---- economics + targeting vocabularies (PRD §25, §30) ----------------------

/** Payout models (matches the 0007 CHECK constraint). Money is always minor units. */
export const PAYOUT_TYPES = ["CPA", "CPL", "CPC", "CPI", "CPM", "CPS", "REVSHARE"] as const;
export type PayoutType = (typeof PAYOUT_TYPES)[number];

export function isPayoutType(value: string): value is PayoutType {
  return (PAYOUT_TYPES as readonly string[]).includes(value);
}

/** Targeting dimensions (matches the 0007 CHECK constraint). Allow-list semantics. */
export const TARGETING_DIMENSIONS = [
  "COUNTRY",
  "REGION",
  "DEVICE",
  "OS",
  "BROWSER",
  "LANGUAGE",
  "TRAFFIC_SOURCE",
] as const;
export type TargetingDimension = (typeof TARGETING_DIMENSIONS)[number];

export function isTargetingDimension(value: string): value is TargetingDimension {
  return (TARGETING_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Offer-only statuses in which the marketplace should surface an offer to
 * affiliates at all (a DRAFT/UNDER_REVIEW offer is never in the marketplace).
 * LIVE is the primary state; PAUSED/CAP_REACHED/etc. remain discoverable so an
 * affiliate who already joined can still see them, but only LIVE is joinable.
 */
export const MARKETPLACE_VISIBLE_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  "LIVE",
  "PAUSED",
  "CAP_REACHED",
  "BUDGET_EXHAUSTED",
]);
