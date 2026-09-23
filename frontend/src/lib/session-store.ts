/**
 * Browser-side holder for the opaque session token issued by
 * `POST /api/v1/auth/login` (ADR-001). The token is kept in memory and
 * mirrored to `sessionStorage` so a page reload inside the same tab keeps the
 * user signed in, while closing the tab drops it.
 *
 * The token is NEVER logged, never placed in the URL and never written to
 * `localStorage` (PRD §101, §116 "secret never returned to frontend" applies
 * to server secrets; the session token is the user's own credential and is
 * confined to this module).
 */
const STORAGE_KEY = "tvh.session";

type Listener = (token: string | null) => void;

let inMemoryToken: string | null | undefined;
const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    // Storage may be blocked (privacy mode). Fall back to memory only.
    return null;
  }
}

export function getSessionToken(): string | null {
  if (inMemoryToken === undefined) {
    inMemoryToken = storage()?.getItem(STORAGE_KEY) ?? null;
  }
  return inMemoryToken;
}

export function setSessionToken(token: string | null): void {
  inMemoryToken = token;
  const s = storage();
  if (s) {
    if (token) s.setItem(STORAGE_KEY, token);
    else s.removeItem(STORAGE_KEY);
  }
  for (const l of listeners) l(token);
}

export function clearSessionToken(): void {
  setSessionToken(null);
}

/** Subscribe to token changes (used by the auth context to react to 401s). */
export function subscribeSessionToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper — reset module state without touching listeners. */
export function __resetSessionStoreForTests(): void {
  inMemoryToken = undefined;
  storage()?.removeItem(STORAGE_KEY);
}
