/**
 * MFA hook — EXPLICIT STUB (ADR-001 §5, PRD §12).
 *
 * MFA is NOT implemented in Phase 1 Unit 1. This module exists so that the
 * login flow and the API have a single, honest integration point:
 *   - `getMfaStatus()` reports MFA as unavailable.
 *   - `beginMfaChallenge()` / `verifyMfaChallenge()` throw NOT_IMPLEMENTED.
 * Nothing here ever returns a passing verification. Wiring TOTP / WebAuthn
 * is a later task and requires an additive migration for secrets and
 * recovery codes.
 */
import { AppError } from "../../lib/errors";

export interface MfaStatus {
  /** Whether MFA is enabled on this user (from `users.mfa_enabled`). */
  enabled: boolean;
  /** Whether the platform can currently perform an MFA challenge. */
  available: false;
  reason: "NOT_IMPLEMENTED";
}

export function getMfaStatus(user: { mfa_enabled: number | boolean }): MfaStatus {
  return {
    enabled: Boolean(user.mfa_enabled),
    available: false,
    reason: "NOT_IMPLEMENTED",
  };
}

export function beginMfaChallenge(_userId: string): never {
  throw new AppError(501, "NOT_IMPLEMENTED", "MFA is not yet available");
}

export function verifyMfaChallenge(_userId: string, _code: string): never {
  throw new AppError(501, "NOT_IMPLEMENTED", "MFA is not yet available");
}
