/**
 * Affiliate dashboard routes (Phase 7 Unit 3) — read-only.
 *
 * Mounted at `/organizations/:orgId/affiliate/dashboard` (tenant-resolved by
 * the parent router's `requireOrg`). Permission + org-type checks live in the
 * service so the ordering (sync 403 → 404 → async) is unit-testable; the
 * `requirePermission` middleware here is the belt to that braces.
 *
 *   GET /overview?from&to   clicks, conversions by lifecycle_status, earnings
 *                           per currency, pending/approved/paid payouts
 *   GET /offers?limit&cursor approved/available offers (affiliate economics only)
 *   GET /links?limit&cursor  own tracking links + per-link click count
 */
import { Hono } from "hono";
import type { AppEnv } from "../lib/bindings";
import { parsePageRequest } from "../lib/pagination";
import { requirePermission } from "../middleware/require-org";
import { AffiliateDashboardService } from "../modules/affiliate-dashboard/service";

export const affiliateDashboardRoutes = new Hono<AppEnv>();

affiliateDashboardRoutes.get("/overview", requirePermission("tracking.read"), async (c) => {
  const range = AffiliateDashboardService.parseRange(c.req.query("from"), c.req.query("to"));
  const overview = await c.get("affiliateDashboardService").overview(c.get("tenant"), range);
  return c.json({ overview });
});

affiliateDashboardRoutes.get("/offers", requirePermission("offers.read"), async (c) => {
  const page = parsePageRequest((name) => c.req.query(name));
  const result = await c.get("affiliateDashboardService").listOffers(c.get("tenant"), page);
  return c.json(result);
});

affiliateDashboardRoutes.get("/links", requirePermission("tracking.read"), async (c) => {
  const page = parsePageRequest((name) => c.req.query(name));
  const result = await c.get("affiliateDashboardService").listLinks(c.get("tenant"), page);
  return c.json(result);
});
