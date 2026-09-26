/**
 * Shared API contract types (PRD §70–72). These mirror the response shapes
 * produced by `backend/src/routes/{auth,organizations}.ts` — the frontend
 * never derives authority from them; they exist for typing and rendering only.
 */

/** PRD §72 error envelope. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string | null;
  };
}

/** @deprecated use ApiErrorEnvelope (kept for Phase 0 imports). */
export type ApiError = ApiErrorEnvelope;

// ---- identity (backend/src/modules/auth/service.ts) --------------------------

export type UserStatus = "ACTIVE" | "SUSPENDED" | "TERMINATED" | (string & {});

export interface MfaStatus {
  enabled: boolean;
  available: false;
  reason: "NOT_IMPLEMENTED";
}

export interface PublicUser {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
  status: UserStatus;
  timezone: string;
  locale: string;
  last_login_at: string | null;
  created_at: string;
  mfa: MfaStatus;
}

export interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
}

export interface SessionSummary extends SessionInfo {
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  user: PublicUser;
  session: SessionInfo;
}

export interface MeResponse {
  user: PublicUser;
  session: SessionInfo;
}

export interface SignupResponse {
  user: PublicUser;
  /** Only present when the backend runs with APP_ENV=development. */
  debug?: { verification_token: string };
}

export interface VerifyEmailResponse {
  user: PublicUser;
}

// ---- organizations (backend/src/modules/organizations/service.ts) -----------

export type OrganizationType = "PLATFORM" | "ADVERTISER" | "AFFILIATE" | "PARTNER" | "AGENCY";
/** Types a signed-in user may create for themselves (PLATFORM is never self-service). */
export const SELF_SERVICE_ORG_TYPES = ["ADVERTISER", "AFFILIATE", "PARTNER", "AGENCY"] as const;
export type SelfServiceOrgType = (typeof SELF_SERVICE_ORG_TYPES)[number];

export interface PublicRole {
  key: string;
  name: string;
  is_owner: boolean;
}

export interface PublicOrganization {
  id: string;
  type: OrganizationType;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  membership: { id: string; role: PublicRole; joined_at: string | null };
}

export interface PublicMember {
  id: string;
  user: { id: string; email: string; display_name: string | null };
  role: PublicRole;
  status: string;
  joined_at: string | null;
  created_at: string;
}

/** `GET /organizations/:orgId/me` — the caller's authority (UI gating only). */
export interface TenantMeResponse {
  organization: { id: string; type: OrganizationType; name: string };
  membership: { id: string; joined_at: string | null };
  role: { key: string; is_owner: boolean };
  permissions: string[];
}

// ---- offers & marketplace (backend/src/modules/offers/service.ts) ----------
//
// Money is ALWAYS integer minor units + a 3-letter currency (PRD §25). The
// frontend formats these for display only and never performs arithmetic on
// them or sends floats.

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

/** Statuses the marketplace can surface (mirror of the backend constant). */
export const MARKETPLACE_STATUSES = ["LIVE", "PAUSED", "CAP_REACHED", "BUDGET_EXHAUSTED"] as const;
export type MarketplaceStatus = (typeof MARKETPLACE_STATUSES)[number];

export const ACCESS_MODES = ["PUBLIC", "APPLICATION_REQUIRED", "PRIVATE", "INVITE_ONLY", "AFFILIATE_SPECIFIC"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const ACCESS_GRANT_STATUSES = ["INVITED", "REQUESTED", "APPROVED", "REJECTED", "REVOKED"] as const;
export type AccessGrantStatus = (typeof ACCESS_GRANT_STATUSES)[number];

export const PAYOUT_TYPES = ["CPA", "CPL", "CPC", "CPI", "CPM", "CPS", "REVSHARE"] as const;
export type PayoutType = (typeof PAYOUT_TYPES)[number];

export const TARGETING_DIMENSIONS = ["COUNTRY", "REGION", "DEVICE", "OS", "BROWSER", "LANGUAGE", "TRAFFIC_SOURCE"] as const;
export type TargetingDimension = (typeof TARGETING_DIMENSIONS)[number];

export type ActorKind = "TENANT" | "PLATFORM" | "SYSTEM";

export interface Targeting {
  dimension: TargetingDimension;
  value: string;
}

/** Full (owner-facing) immutable version row — includes confidential economics. */
export interface OfferVersion {
  id: string;
  offer_id: string;
  version_number: number;
  payout_type: PayoutType;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor: number;
  revshare_percent_bps: number | null;
  daily_conversion_cap: number | null;
  total_conversion_cap: number | null;
  budget_minor: number | null;
  attribution_window_seconds: number;
  conversion_event: string;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string;
  targeting: Targeting[];
}

export interface OfferSummary {
  id: string;
  organization_id: string;
  advertiser_profile_id: string;
  status: OfferStatus;
  access_mode: AccessMode;
  name: string;
  vertical: string | null;
  description: string | null;
  current_version_id: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Lifecycle targets the CALLER may move this offer to — UI hint only. */
  allowed_transitions: OfferStatus[];
}

export interface Offer extends OfferSummary {
  current_version: OfferVersion | null;
}

export interface OfferTransition {
  id: string;
  from_status: OfferStatus | null;
  to_status: OfferStatus;
  actor_kind: ActorKind;
  actor_user_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface AccessGrant {
  id: string;
  offer_id: string;
  affiliate_organization_id: string;
  status: AccessGrantStatus;
  reason: string | null;
  requested_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Affiliate-facing marketplace projection. The server has ALREADY removed
 * advertiser payout, network margin and budget; the frontend never sees them
 * and must not pretend otherwise (PRD §29).
 */
export interface MarketplaceOffer {
  id: string;
  name: string;
  vertical: string | null;
  description: string | null;
  access_mode: AccessMode;
  status: OfferStatus;
  advertiser: { name: string; slug: string; type: string };
  version: {
    version_number: number;
    payout_type: PayoutType;
    currency: string;
    affiliate_commission_minor: number;
    revshare_percent_bps: number | null;
    daily_conversion_cap: number | null;
    total_conversion_cap: number | null;
    attribution_window_seconds: number;
    conversion_event: string;
  };
  /** Detail only, and only once the affiliate may actually join. */
  destination_url?: string | null;
  /** Detail only. */
  targeting?: Targeting[];
  my_access: { status: AccessGrantStatus } | null;
  can_join: boolean;
  can_apply: boolean;
}

/** PRD §127 cursor page envelope. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
