/**
 * Advertiser lifecycle state machine (Phase 2 Unit 1; PRD §16, §124, §132).
 *
 * Happy path:
 *   REGISTERED → EMAIL_VERIFIED → BUSINESS_REVIEW → COMPLIANCE_REVIEW
 *     → BILLING_SETUP → APPROVED → ACTIVE
 * Alternates: MORE_INFORMATION_REQUIRED, RESTRICTED, SUSPENDED, TERMINATED.
 *
 * Pure module — no I/O. The service asks `canTransition(from, to, actorKind)`
 * and the answer is final: no other code path may change `status`. Every
 * accepted transition is persisted as an append-only
 * `advertiser_status_transitions` row plus an `audit_logs` row.
 *
 * Authority split (PRD §5 — server-side only):
 *   TENANT   — the advertiser organization itself (`advertisers.manage`):
 *              may only *submit* for review (EMAIL_VERIFIED or
 *              MORE_INFORMATION_REQUIRED → BUSINESS_REVIEW).
 *   PLATFORM — network reviewers (`advertisers.review`): drive every review /
 *              approval / restriction step. Never the tenant (PRD §132: no
 *              self-approval).
 *   SYSTEM   — automatic steps derived from verified facts (REGISTERED →
 *              EMAIL_VERIFIED when the acting user's email is verified).
 *
 * Negative / restrictive transitions require a reason (PRD §124 "dangerous
 * actions require confirmation, reason, permission, audit").
 */

export const ADVERTISER_STATUSES = [
  "REGISTERED",
  "EMAIL_VERIFIED",
  "BUSINESS_REVIEW",
  "COMPLIANCE_REVIEW",
  "BILLING_SETUP",
  "APPROVED",
  "ACTIVE",
  "MORE_INFORMATION_REQUIRED",
  "RESTRICTED",
  "SUSPENDED",
  "TERMINATED",
] as const;
export type AdvertiserStatus = (typeof ADVERTISER_STATUSES)[number];

export const ACTOR_KINDS = ["TENANT", "PLATFORM", "SYSTEM"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Statuses a platform reviewer may move an advertiser INTO only with a reason. */
export const REASON_REQUIRED_STATUSES: ReadonlySet<AdvertiserStatus> = new Set<AdvertiserStatus>([
  "MORE_INFORMATION_REQUIRED",
  "RESTRICTED",
  "SUSPENDED",
  "TERMINATED",
]);

/** Terminal state — nothing leaves it. */
export const TERMINAL_STATUS: AdvertiserStatus = "TERMINATED";

type Edge = { to: AdvertiserStatus; by: readonly ActorKind[] };

const EDGES: Readonly<Record<AdvertiserStatus, readonly Edge[]>> = {
  REGISTERED: [{ to: "EMAIL_VERIFIED", by: ["SYSTEM"] }],
  EMAIL_VERIFIED: [{ to: "BUSINESS_REVIEW", by: ["TENANT"] }],
  BUSINESS_REVIEW: [
    { to: "COMPLIANCE_REVIEW", by: ["PLATFORM"] },
    { to: "MORE_INFORMATION_REQUIRED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  COMPLIANCE_REVIEW: [
    { to: "BILLING_SETUP", by: ["PLATFORM"] },
    { to: "MORE_INFORMATION_REQUIRED", by: ["PLATFORM"] },
    { to: "RESTRICTED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  BILLING_SETUP: [
    { to: "APPROVED", by: ["PLATFORM"] },
    { to: "MORE_INFORMATION_REQUIRED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  APPROVED: [
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "SUSPENDED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  ACTIVE: [
    { to: "RESTRICTED", by: ["PLATFORM"] },
    { to: "SUSPENDED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  MORE_INFORMATION_REQUIRED: [
    // The tenant answers the request by re-submitting; review starts over.
    { to: "BUSINESS_REVIEW", by: ["TENANT"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  RESTRICTED: [
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "SUSPENDED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  SUSPENDED: [
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "RESTRICTED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  TERMINATED: [],
};

export function isAdvertiserStatus(value: string): value is AdvertiserStatus {
  return (ADVERTISER_STATUSES as readonly string[]).includes(value);
}

/** True when `actor` may move an advertiser from `from` to `to`. */
export function canTransition(from: AdvertiserStatus, to: AdvertiserStatus, actor: ActorKind): boolean {
  return EDGES[from].some((e) => e.to === to && e.by.includes(actor));
}

/** Target statuses reachable from `from` by `actor` (for UI hints / tests). */
export function allowedTargets(from: AdvertiserStatus, actor: ActorKind): AdvertiserStatus[] {
  return EDGES[from].filter((e) => e.by.includes(actor)).map((e) => e.to);
}

/** Whether entering `to` needs a human-readable reason (PRD §124). */
export function requiresReason(to: AdvertiserStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to);
}

/** Statuses in which the tenant may (re-)submit the profile for review. */
export const SUBMITTABLE_STATUSES: readonly AdvertiserStatus[] = ["EMAIL_VERIFIED", "MORE_INFORMATION_REQUIRED"];

/**
 * Onboarding fields that must be present before a profile can be submitted
 * (PRD §17 — identity, business verification, contact; PRD §132 — missing
 * compliance information never implies approval). Billing information is a
 * Phase 5 concern (BILLING_SETUP is driven by platform), documents are Phase 4.
 */
export const SUBMISSION_REQUIRED_FIELDS = [
  "company_name",
  "website_url",
  "business_category",
  "legal_name",
  "country_code",
  "contact_name",
  "contact_email",
] as const;
export type SubmissionRequiredField = (typeof SUBMISSION_REQUIRED_FIELDS)[number];

/** Names of required onboarding fields that are still empty. */
export function missingSubmissionFields(
  profile: Partial<Record<SubmissionRequiredField, string | null | undefined>>,
): SubmissionRequiredField[] {
  return SUBMISSION_REQUIRED_FIELDS.filter((f) => {
    const v = profile[f];
    return v === null || v === undefined || v.trim() === "";
  });
}
