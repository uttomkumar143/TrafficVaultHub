/**
 * Auth foundation constants (ADR-001). Single place to tune parameters.
 * None of these are secrets.
 */

/** scrypt parameters — OWASP-accepted, within Workers CPU budget (ADR-001 §1). */
export const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const;
export const SCRYPT_SALT_BYTES = 16;

/** Session lifetime default; overridable via `SESSION_TTL_SECONDS` var. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_SECRET_BYTES = 32; // 256-bit
export const SESSION_TOKEN_PREFIX = "tvh_s_";

/** One-time token lifetimes (ADR-001 §3). */
export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24 h
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60; // 1 h
export const ONE_TIME_TOKEN_BYTES = 32;

/** Password policy (PRD §98 input validation). Length only — no composition rules. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export type TokenPurpose = "EMAIL_VERIFICATION" | "PASSWORD_RESET";

export type AuthEventType =
  | "SIGNUP"
  | "EMAIL_VERIFIED"
  | "LOGIN_SUCCEEDED"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED";
