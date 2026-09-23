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
