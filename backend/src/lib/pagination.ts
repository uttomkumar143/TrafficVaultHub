/**
 * Cursor pagination helpers (PRD §127 — large datasets must never be loaded
 * completely; use cursor pagination + server-side filtering/sorting).
 *
 * Cursors are opaque to clients: a base64url-encoded JSON tuple of the sort
 * key(s) of the last row returned. They carry no authority — every paginated
 * query still runs inside the caller's tenant/permission scope — so a
 * tampered cursor can at worst skip rows, never reveal them.
 *
 * Convention used by repositories:
 *   ORDER BY created_at DESC, id DESC
 *   WHERE (created_at, id) < (?, ?)          -- when a cursor is present
 *   LIMIT limit + 1                          -- fetch one extra to detect more
 *
 * `slicePage()` turns the `limit + 1` result set into `{ items, next_cursor }`.
 */
import { z } from "zod";
import { AppError } from "./errors";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  /** Sort key of the last row on the previous page (ISO-8601 UTC). */
  created_at: string;
  /** Tie-breaker: id of that row. */
  id: string;
}

const cursorSchema = z.object({
  created_at: z.string().min(1).max(40),
  id: z.string().uuid(),
});

export interface PageRequest {
  limit: number;
  cursor: Cursor | null;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `?cursor=` to fetch the next page; null when exhausted. */
  next_cursor: string | null;
}

export function encodeCursor(c: Cursor): string {
  return base64UrlEncode(JSON.stringify({ created_at: c.created_at, id: c.id }));
}

/** Throws 400 INVALID_CURSOR for anything that is not a cursor we minted. */
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Invalid pagination cursor");
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new AppError(400, "INVALID_CURSOR", "Invalid pagination cursor");
  return result.data;
}

/**
 * Read `?limit=` and `?cursor=` from a query-string accessor. Out-of-range
 * or non-numeric limits are a 400 VALIDATION_ERROR (never silently clamped
 * upwards); a missing limit uses the default.
 */
export function parsePageRequest(query: (name: string) => string | undefined): PageRequest {
  const rawLimit = query("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== undefined && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      throw new AppError(400, "VALIDATION_ERROR", `Invalid request: limit (1..${MAX_PAGE_SIZE})`);
    }
    limit = n;
  }
  const rawCursor = query("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  return { limit, cursor };
}

/**
 * Given rows fetched with `LIMIT limit + 1`, return exactly `limit` items and
 * the cursor for the following page (or null).
 */
export function slicePage<T extends { created_at: string; id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) return { items: rows, next_cursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  if (!last) return { items, next_cursor: null };
  return { items, next_cursor: encodeCursor({ created_at: last.created_at, id: last.id }) };
}

// ---- base64url (Web APIs only — no Node Buffer in Workers) -----------------

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
