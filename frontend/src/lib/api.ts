/**
 * API client bound to the versioned REST base path (PRD §70).
 *
 * - Attaches `Authorization: Bearer <session token>` when a session exists.
 * - Normalises every non-2xx response into an `ApiError` carrying the PRD §72
 *   envelope (`code`, `message`, `request_id`) plus the HTTP status.
 * - A `401 UNAUTHENTICATED` on an authenticated call clears the local session
 *   (the server has already rejected it — revoked or expired), so the auth
 *   context flips to "signed out" without any client-side guessing.
 *
 * Nothing in this module logs request bodies or tokens.
 */
import type { ApiErrorEnvelope } from "@/types/api";
import { clearSessionToken, getSessionToken } from "@/lib/session-store";

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Send the bearer token (default true). Public auth endpoints set false. */
  auth?: boolean;
}

async function parseEnvelope(res: Response): Promise<ApiError> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    envelope = (await res.json()) as ApiErrorEnvelope;
  } catch {
    envelope = null;
  }
  const code = envelope?.error?.code ?? `HTTP_${res.status}`;
  const message = envelope?.error?.message ?? `Request failed with HTTP ${res.status}`;
  return new ApiError(res.status, code, message, envelope?.error?.request_id ?? null);
}

/**
 * Perform a JSON request against `/api/v1`. Resolves with the parsed JSON
 * body (or `undefined` for 204). Rejects with `ApiError`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal, auth = true } = options;
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";

  const token = auth ? getSessionToken() : null;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await parseEnvelope(res);
    if (err.status === 401 && token) {
      // Server-authoritative: the session is gone. Drop it locally.
      clearSessionToken();
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- health (Phase 0) -------------------------------------------------------

export interface HealthResponse {
  status: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, { signal });
  if (!res.ok) {
    throw new Error(`Health check failed with HTTP ${res.status}`);
  }
  return (await res.json()) as HealthResponse;
}
