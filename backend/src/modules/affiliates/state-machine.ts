/**
 * Affiliate lifecycle state machine (Phase 2 Unit 2; PRD §19, §21, §124, §132).
 *
 * Happy path:
 *   APPLIED → EMAIL_VERIFIED → UNDER_REVIEW → APPROVED → ACTIVE
 * Alternates: MORE_INFORMATION_REQUIRED, RESTRICTED, SUSPENDED, APPEAL, TERMINATED.
 *
 * Pure module — no I/O. Mirrors `modules/advertisers/state-machine.ts`: the
 * service asks `canTransition(from, to, actorKind)` and the answer is final.
 * Every accepted transition is persisted as an append-only
 * `affiliate_status_transitions` row plus an `audit_logs` row.
 *
 * Authority split (PRD §5 — server-side only):
 *   TENANT   — the affiliate organization itself (`affiliates.manage`):
 *              may *submit* the application (EMAIL_VERIFIED or
 *              MORE_INFORMATION_REQUIRED → UNDER_REVIEW) and may *appeal* a
 *              restriction or suspension (RESTRICTED | SUSPENDED → APPEAL).
 *   PLATFORM — network reviewers (`affiliates.review`): drive every review /
 *              approval / restriction step and decide appeals. Never the
 *              tenant (PRD §132: no self-approval).
 *   SYSTEM   — automatic steps derived from verified facts (APPLIED →
 *              EMAIL_VERIFIED when the acting user's email is verified).
 *
 * Restrictive transitions require a reason (PRD §124).
 */

export const AFFILIATE_STATUSES = [
  "APPLIED",
  "EMAIL_VERIFIED",
  "UNDER_REVIEW",
  "APPROVED",
  "ACTIVE",
  "MORE_INFORMATION_REQUIRED",
  "RESTRICTED",
  "SUSPENDED",
  "APPEAL",
  "TERMINATED",
] as const;
export type AffiliateStatus = (typeof AFFILIATE_STATUSES)[number];

export const ACTOR_KINDS = ["TENANT", "PLATFORM", "SYSTEM"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Statuses a platform reviewer may move an affiliate INTO only with a reason. */
export const REASON_REQUIRED_STATUSES: ReadonlySet<AffiliateStatus> = new Set<AffiliateStatus>([
  "MORE_INFORMATION_REQUIRED",
  "RESTRICTED",
  "SUSPENDED",
  "TERMINATED",
]);

/** Terminal state — nothing leaves it. */
export const TERMINAL_STATUS: AffiliateStatus = "TERMINATED";

type Edge = { to: AffiliateStatus; by: readonly ActorKind[] };

const EDGES: Readonly<Record<AffiliateStatus, readonly Edge[]>> = {
  APPLIED: [{ to: "EMAIL_VERIFIED", by: ["SYSTEM"] }],
  EMAIL_VERIFIED: [{ to: "UNDER_REVIEW", by: ["TENANT"] }],
  UNDER_REVIEW: [
    { to: "APPROVED", by: ["PLATFORM"] },
    { to: "MORE_INFORMATION_REQUIRED", by: ["PLATFORM"] },
    { to: "RESTRICTED", by: ["PLATFORM"] },
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
    { to: "UNDER_REVIEW", by: ["TENANT"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  RESTRICTED: [
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "SUSPENDED", by: ["PLATFORM"] },
    { to: "APPEAL", by: ["TENANT"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  SUSPENDED: [
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "RESTRICTED", by: ["PLATFORM"] },
    { to: "APPEAL", by: ["TENANT"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  APPEAL: [
    // Platform decides the appeal: reinstate, keep restricted, re-suspend or terminate.
    { to: "ACTIVE", by: ["PLATFORM"] },
    { to: "RESTRICTED", by: ["PLATFORM"] },
    { to: "SUSPENDED", by: ["PLATFORM"] },
    { to: "TERMINATED", by: ["PLATFORM"] },
  ],
  TERMINATED: [],
};

export function isAffiliateStatus(value: string): value is AffiliateStatus {
  return (AFFILIATE_STATUSES as readonly string[]).includes(value);
}

/** True when `actor` may move an affiliate from `from` to `to`. */
export function canTransition(from: AffiliateStatus, to: AffiliateStatus, actor: ActorKind): boolean {
  return EDGES[from].some((e) => e.to === to && e.by.includes(actor));
}

/** Target statuses reachable from `from` by `actor` (for UI hints / tests). */
export function allowedTargets(from: AffiliateStatus, actor: ActorKind): AffiliateStatus[] {
  return EDGES[from].filter((e) => e.by.includes(actor)).map((e) => e.to);
}

/** Whether entering `to` needs a human-readable reason (PRD §124). */
export function requiresReason(to: AffiliateStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to);
}

/** Statuses in which the tenant may (re-)submit the application for review. */
export const SUBMITTABLE_STATUSES: readonly AffiliateStatus[] = ["EMAIL_VERIFIED", "MORE_INFORMATION_REQUIRED"];

/** Statuses from which the tenant may lodge an appeal (PRD §19). */
export const APPEALABLE_STATUSES: readonly AffiliateStatus[] = ["RESTRICTED", "SUSPENDED"];

/**
 * Application fields that must be present before submission (PRD §21 review
 * signals: website/app information, promotional methods, contact; PRD §132 —
 * missing information never implies approval). At least one declared traffic
 * source is also required (PRD §27) — checked by the service, not here.
 */
export const SUBMISSION_REQUIRED_FIELDS = [
  "display_name",
  "promotional_methods",
  "country_code",
  "contact_name",
  "contact_email",
] as const;
export type SubmissionRequiredField = (typeof SUBMISSION_REQUIRED_FIELDS)[number];

/** Names of required application fields that are still empty. */
export function missingSubmissionFields(
  profile: Partial<Record<SubmissionRequiredField, string | null | undefined>> & {
    website_url?: string | null;
    app_url?: string | null;
  },
): string[] {
  const missing: string[] = SUBMISSION_REQUIRED_FIELDS.filter((f) => {
    const v = profile[f];
    return v === null || v === undefined || v.trim() === "";
  });
  // PRD §21: "website/app information" — at least one of the two.
  const hasWeb = !!profile.website_url && profile.website_url.trim() !== "";
  const hasApp = !!profile.app_url && profile.app_url.trim() !== "";
  if (!hasWeb && !hasApp) missing.push("website_url_or_app_url");
  return missing;
}

/** PRD §27 traffic source catalogue (matches the 0006 CHECK constraint). */
export const TRAFFIC_SOURCE_TYPES = [
  "SEO",
  "PAID_SEARCH",
  "SOCIAL",
  "CONTENT",
  "EMAIL",
  "APP",
  "INFLUENCER",
  "WEBSITE",
  "DIRECT",
  "OTHER",
] as const;
export type TrafficSourceType = (typeof TRAFFIC_SOURCE_TYPES)[number];

/** PRD §20 acquisition channels (matches the 0006 CHECK constraint). */
export const ACQUISITION_CHANNELS = [
  "DIRECT",
  "INVITATION",
  "AFFILIATE_REFERRAL",
  "MANAGER_INVITATION",
  "PARTNER_REFERRAL",
] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];
