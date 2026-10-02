/**
 * Phase 6 Unit 1 — PRD §72 "request_id always present".
 *
 * Resolves one id per request and exposes it everywhere a correlation id is
 * needed: the `request_id` field of every error envelope (`lib/errors.ts`),
 * the `request_id` column of audit / auth-event rows (`lib/request-meta.ts`)
 * and the `x-request-id` response header so clients can quote it in support
 * tickets.
 *
 * Resolution order:
 *   1. `cf-ray` — Cloudflare's own edge id, when present (production).
 *   2. a well-formed inbound `x-request-id` (≤ 128 chars, `[A-Za-z0-9._-]`) —
 *      lets upstream proxies / tests correlate; anything else is ignored so a
 *      caller can never inject log-breaking or oversized values.
 *   3. a fresh UUID — so the id is never `null` (previously it was `null`
 *      anywhere outside Cloudflare, e.g. local dev and tests).
 */
import type { Context, MiddlewareHandler } from "hono";

export const REQUEST_ID_HEADER = "x-request-id";
const INBOUND_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Context variable key — read through `requestId()`, never directly. */
const CONTEXT_KEY = "requestId";

function acceptInbound(value: string | undefined): string | null {
  if (!value) return null;
  return INBOUND_ID_PATTERN.test(value) ? value : null;
}

/** Resolve (and memoise) the id for this request without the middleware. */
export function resolveRequestId(c: Context): string {
  const existing = c.get(CONTEXT_KEY as never) as string | undefined;
  if (existing) return existing;
  const id = c.req.header("cf-ray") ?? acceptInbound(c.req.header(REQUEST_ID_HEADER)) ?? crypto.randomUUID();
  c.set(CONTEXT_KEY as never, id as never);
  return id;
}

/** Hono middleware: resolve the id up-front and echo it on every response. */
export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const id = resolveRequestId(c);
  await next();
  // Set after `next()` so it is present on success, error and notFound paths.
  if (!c.res.headers.has(REQUEST_ID_HEADER)) c.res.headers.set(REQUEST_ID_HEADER, id);
};
