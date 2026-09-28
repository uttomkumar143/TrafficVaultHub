/**
 * Public click endpoints (Phase 3 Unit 2) — mounted at the ROOT, outside
 * `/api/v1` and outside every auth middleware:
 *
 *   GET /t/:code   tracking link redirect
 *   GET /s/:code   SmartLink redirect
 *
 * Contract (PRD §31–§34, §72, §107, §130):
 *   - 302 with `Location` on success; `Cache-Control: no-store` always (a
 *     cached redirect would skip click recording);
 *   - generic 404 envelope for unknown / inactive / ineligible / capped —
 *     the internal denial reason never leaves the Worker;
 *   - 503 (generic envelope) only when the cap ledger is unreachable for a
 *     CAPPED offer — fail closed, never over-deliver an advertiser's budget;
 *   - deferred work runs through `c.executionCtx.waitUntil` when the runtime
 *     provides it (Workers); otherwise it is fire-and-forget. Either way a
 *     deferred failure cannot change the response (RedirectService swallows).
 *
 * Dependencies are built per request from the bindings: D1 (`DB`), the
 * `COORDINATOR` Durable Object namespace (→ `DurableCapLedger`; absent in
 * tests → `MemoryCapLedger`), `CACHE` KV through `OfferService` for the
 * Unit 5 invalidation hook, and the `CLICK_SIGNAL_SALT` secret (optional;
 * without it no IP / UA hashes are written — see signals.ts).
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../lib/bindings";
import { requestId } from "../lib/errors";
import { AdvertiserRepository } from "../modules/advertisers/repository";
import { OfferRepository } from "../modules/offers/repository";
import { OfferService } from "../modules/offers/service";
import { DurableCapLedger } from "../modules/tracking/cap-ledger";
import { MemoryCapLedger } from "../modules/tracking/caps";
import { EligibilityCache } from "../modules/tracking/eligibility-cache";
import { CapLedgerUnavailableError, RedirectService, type RedirectCapLedger, type RedirectRequest, type RedirectResult } from "../modules/tracking/redirect";
import { TrackingRepository } from "../modules/tracking/repository";

export interface RedirectRouteOptions {
  /** Test seam: replaces the ledger built from `COORDINATOR` (or the per-request memory ledger). */
  ledger?: RedirectCapLedger;
  /** Test seam: observe the deferred tasks the handler hands to `waitUntil`. */
  onDefer?: (task: Promise<void>) => void;
}

type Ctx = Context<AppEnv>;

export function redirectRoutes(options: RedirectRouteOptions = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const buildService = (c: Ctx): RedirectService => {
    const db = c.env.DB;
    const reads = new TrackingRepository(db);
    const ledger: RedirectCapLedger =
      options.ledger ?? (c.env.COORDINATOR ? new DurableCapLedger(c.env.COORDINATOR) : new MemoryCapLedger());
    const eligibilityCache = c.env.CACHE ? new EligibilityCache(c.env.CACHE) : undefined;
    const offerService = new OfferService(new OfferRepository(db), new AdvertiserRepository(db), db, eligibilityCache);
    let waitUntil: ((p: Promise<unknown>) => void) | null = null;
    try {
      const ctx = c.executionCtx;
      waitUntil = (p) => ctx.waitUntil(p);
    } catch {
      // No ExecutionContext (unit tests / non-Workers runtime): fire-and-forget.
    }
    return new RedirectService({
      reads,
      ledger,
      onCapExhausted: (offerId) => offerService.invalidateOfferRouting(offerId),
      defer: (task) => {
        options.onDefer?.(task);
        if (waitUntil) waitUntil(task);
      },
      signalSalt: c.env.CLICK_SIGNAL_SALT ?? null,
    });
  };

  const requestOf = (c: Ctx): RedirectRequest => ({
    code: c.req.param("code") ?? "",
    query: c.req.query(),
    header: (name) => c.req.header(name),
    request_id: requestId(c),
  });

  const respond = (c: Ctx, result: RedirectResult): Response => {
    c.header("cache-control", "no-store");
    if (result.kind === "REDIRECT") {
      return c.redirect(result.location, 302);
    }
    return c.json({ error: { code: "NOT_FOUND", message: "Resource not found", request_id: requestId(c) } }, 404);
  };

  const guarded = async (c: Ctx, run: (svc: RedirectService, req: RedirectRequest) => Promise<RedirectResult>) => {
    if (!c.env?.DB) {
      return c.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", request_id: requestId(c) } }, 503);
    }
    try {
      return respond(c, await run(buildService(c), requestOf(c)));
    } catch (e) {
      if (e instanceof CapLedgerUnavailableError) {
        c.header("cache-control", "no-store");
        return c.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable", request_id: requestId(c) } }, 503);
      }
      throw e; // app.onError → generic 500 envelope
    }
  };

  routes.get("/t/:code", (c) => guarded(c, (svc, req) => svc.redirectTrackingLink(req)));
  routes.get("/s/:code", (c) => guarded(c, (svc, req) => svc.redirectSmartLink(req)));

  return routes;
}
