/**
 * Minimal API client bound to the versioned REST base path (PRD §70).
 * Only the health probe exists in Phase 0.
 */
export const API_BASE = "/api/v1";

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
