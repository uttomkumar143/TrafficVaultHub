import { isApiError } from "@/lib/api";

/**
 * Human-readable text for a failed request. Server messages are already safe
 * (PRD §72 — no stack traces), but a few codes get friendlier copy. Network
 * failures are reported honestly instead of being mistaken for auth errors.
 */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (isApiError(err)) {
    switch (err.code) {
      case "INVALID_CREDENTIALS":
        return "Incorrect email or password.";
      case "EMAIL_NOT_VERIFIED":
        return "Please verify your email address before signing in.";
      case "ACCOUNT_INACTIVE":
        return "This account is not active. Contact support.";
      case "EMAIL_ALREADY_REGISTERED":
        return "An account with this email already exists.";
      case "INVALID_TOKEN":
        return "This link is invalid or has expired. Request a new one.";
      case "VALIDATION_ERROR":
        return err.message || "Please check the highlighted fields.";
      case "UNAUTHENTICATED":
        return "Your session has ended. Please sign in again.";
      case "FORBIDDEN":
        return "You do not have permission to do that.";
      default:
        return err.message || fallback;
    }
  }
  if (err instanceof TypeError) {
    return "Cannot reach the server. Check your connection and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
