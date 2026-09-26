/**
 * Pure presentational helpers shared by the advertiser (offers) and affiliate
 * (marketplace) pages. Nothing here fetches, decides authority or performs
 * money arithmetic — labels, badges and a few shared class strings only.
 *
 * Lifecycle facts mirrored from `backend/src/modules/offers/state-machine.ts`
 * are limited to what the UI needs for GATING WHAT TO SHOW (which statuses
 * demand a reason, which still accept a new version). The set of transitions
 * an actor may perform is never derived here — it always comes from the
 * server's `allowed_transitions` on the offer row.
 */
import type { ReactNode } from "react";
import type {
  AccessGrantStatus,
  AccessMode,
  ActorKind,
  OfferStatus,
  PayoutType,
  TargetingDimension,
} from "@/types/api";
import { cn } from "@/lib/utils";

// ---- lifecycle facts (mirror of the backend state machine) --------------------

/** PRD §124 — entering these statuses needs a human-readable reason. */
export const REASON_REQUIRED_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>([
  "COMPLIANCE_HOLD",
  "TRACKING_ISSUE",
  "ARCHIVED",
]);

export function requiresReason(to: OfferStatus): boolean {
  return REASON_REQUIRED_STATUSES.has(to);
}

/** A new immutable version may be appended in every status except the terminal one. */
export function isVersionable(status: OfferStatus): boolean {
  return status !== "ARCHIVED";
}

/** Access modes where the advertiser manages grants explicitly (PRD §92). */
export const GRANT_MANAGED_ACCESS_MODES: ReadonlySet<AccessMode> = new Set<AccessMode>([
  "APPLICATION_REQUIRED",
  "PRIVATE",
  "INVITE_ONLY",
  "AFFILIATE_SPECIFIC",
]);

// ---- human labels -------------------------------------------------------------

export const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  PUBLIC: "Public — any affiliate can join instantly",
  APPLICATION_REQUIRED: "Application required — affiliates apply, you approve",
  PRIVATE: "Private — only affiliates you approve",
  INVITE_ONLY: "Invite only — only affiliates you invite",
  AFFILIATE_SPECIFIC: "Affiliate-specific — built for named affiliates",
};

export const ACCESS_MODE_SHORT_LABELS: Record<AccessMode, string> = {
  PUBLIC: "Public",
  APPLICATION_REQUIRED: "Application required",
  PRIVATE: "Private",
  INVITE_ONLY: "Invite only",
  AFFILIATE_SPECIFIC: "Affiliate-specific",
};

export const PAYOUT_TYPE_LABELS: Record<PayoutType, string> = {
  CPA: "CPA — per action",
  CPL: "CPL — per lead",
  CPC: "CPC — per click",
  CPI: "CPI — per install",
  CPM: "CPM — per thousand impressions",
  CPS: "CPS — per sale",
  REVSHARE: "Revenue share",
};

export const TARGETING_DIMENSION_LABELS: Record<TargetingDimension, string> = {
  COUNTRY: "Country",
  REGION: "Region",
  DEVICE: "Device",
  OS: "Operating system",
  BROWSER: "Browser",
  LANGUAGE: "Language",
  TRAFFIC_SOURCE: "Traffic source",
};

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  LIVE: "Live",
  PAUSED: "Paused",
  CAP_REACHED: "Cap reached",
  BUDGET_EXHAUSTED: "Budget exhausted",
  TRACKING_ISSUE: "Tracking issue",
  COMPLIANCE_HOLD: "Compliance hold",
  EXPIRED: "Expired",
  ARCHIVED: "Archived",
};

export const ACCESS_GRANT_STATUS_LABELS: Record<AccessGrantStatus, string> = {
  INVITED: "Invited",
  REQUESTED: "Application pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  REVOKED: "Revoked",
};

export const ACTOR_KIND_LABELS: Record<ActorKind, string> = {
  TENANT: "Advertiser",
  PLATFORM: "Platform",
  SYSTEM: "System",
};

/** Verb shown on a lifecycle button for the TARGET status. */
export const TRANSITION_VERBS: Record<OfferStatus, string> = {
  DRAFT: "Send back to draft",
  SUBMITTED: "Submit for review",
  UNDER_REVIEW: "Start review",
  APPROVED: "Approve",
  LIVE: "Go live",
  PAUSED: "Pause",
  CAP_REACHED: "Mark cap reached",
  BUDGET_EXHAUSTED: "Mark budget exhausted",
  TRACKING_ISSUE: "Flag tracking issue",
  COMPLIANCE_HOLD: "Place on compliance hold",
  EXPIRED: "Mark expired",
  ARCHIVED: "Archive",
};

// ---- shared class strings (match components/ui/input.tsx) --------------------

export const selectClassName =
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm " +
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] " +
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50";

export const textareaClassName =
  "border-input placeholder:text-muted-foreground flex min-h-20 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none md:text-sm " +
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] " +
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50";

// ---- badges -------------------------------------------------------------------

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border bg-muted text-foreground",
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  danger: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};

const OFFER_STATUS_TONE: Record<OfferStatus, Tone> = {
  DRAFT: "neutral",
  SUBMITTED: "info",
  UNDER_REVIEW: "info",
  APPROVED: "info",
  LIVE: "success",
  PAUSED: "warning",
  CAP_REACHED: "warning",
  BUDGET_EXHAUSTED: "warning",
  TRACKING_ISSUE: "danger",
  COMPLIANCE_HOLD: "danger",
  EXPIRED: "neutral",
  ARCHIVED: "neutral",
};

const GRANT_STATUS_TONE: Record<AccessGrantStatus, Tone> = {
  INVITED: "info",
  REQUESTED: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  REVOKED: "neutral",
};

function Badge({ tone, label, className, testId }: { tone: Tone; label: string; className?: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", TONE_CLASSES[tone], className)}
    >
      {label}
    </span>
  );
}

export function OfferStatusBadge({ status, className }: { status: OfferStatus; className?: string }) {
  return (
    <Badge
      tone={OFFER_STATUS_TONE[status] ?? "neutral"}
      label={OFFER_STATUS_LABELS[status] ?? status}
      className={className}
      testId="offer-status-badge"
    />
  );
}

export function AccessGrantStatusBadge({ status, className }: { status: AccessGrantStatus; className?: string }) {
  return (
    <Badge
      tone={GRANT_STATUS_TONE[status] ?? "neutral"}
      label={ACCESS_GRANT_STATUS_LABELS[status] ?? status}
      className={className}
      testId="access-grant-status-badge"
    />
  );
}

export function AccessModeBadge({ mode, className }: { mode: AccessMode; className?: string }) {
  return <Badge tone={mode === "PUBLIC" ? "success" : "neutral"} label={ACCESS_MODE_SHORT_LABELS[mode] ?? mode} className={className} />;
}

/** `<dt>/<dd>` pair used by the read-only detail lists. */
export function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
