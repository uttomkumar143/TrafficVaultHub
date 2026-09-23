/**
 * Auth API bindings — one function per `/api/v1/auth/*` endpoint
 * (`backend/src/routes/auth.ts`). Thin wrappers over `apiRequest`; no
 * business logic lives here and no secrets are cached (PRD §5, §101).
 */
import { apiRequest } from "@/lib/api";
import type {
  LoginResponse,
  MeResponse,
  SessionSummary,
  SignupResponse,
  VerifyEmailResponse,
} from "@/types/api";

export interface LoginInput {
  email: string;
  password: string;
}

export interface SignupInput {
  email: string;
  password: string;
  display_name?: string;
}

export interface ResetPasswordInput {
  token: string;
  password: string;
}

export function login(input: LoginInput): Promise<LoginResponse> {
  return apiRequest<LoginResponse>("/auth/login", { method: "POST", body: input, auth: false });
}

export function signup(input: SignupInput): Promise<SignupResponse> {
  return apiRequest<SignupResponse>("/auth/signup", { method: "POST", body: input, auth: false });
}

export function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  return apiRequest<VerifyEmailResponse>("/auth/verify-email", {
    method: "POST",
    body: { token },
    auth: false,
  });
}

/** 202 — the server never reveals whether the address is registered. */
export function resendVerification(email: string): Promise<unknown> {
  return apiRequest<unknown>("/auth/resend-verification", {
    method: "POST",
    body: { email },
    auth: false,
  });
}

/** 202 — the server never reveals whether the address is registered. */
export function forgotPassword(email: string): Promise<unknown> {
  return apiRequest<unknown>("/auth/forgot-password", {
    method: "POST",
    body: { email },
    auth: false,
  });
}

export function resetPassword(input: ResetPasswordInput): Promise<void> {
  return apiRequest<void>("/auth/reset-password", { method: "POST", body: input, auth: false });
}

export function logout(): Promise<void> {
  return apiRequest<void>("/auth/logout", { method: "POST" });
}

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest<MeResponse>("/auth/me", { signal });
}

export function listSessions(signal?: AbortSignal): Promise<{ sessions: SessionSummary[] }> {
  return apiRequest<{ sessions: SessionSummary[] }>("/auth/sessions", { signal });
}

export function revokeSession(id: string): Promise<void> {
  return apiRequest<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function revokeOtherSessions(): Promise<{ revoked_count: number }> {
  return apiRequest<{ revoked_count: number }>("/auth/sessions/revoke-others", { method: "POST" });
}
