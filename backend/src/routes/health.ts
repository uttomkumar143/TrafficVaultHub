import { Hono } from "hono";
import type { AppEnv } from "../lib/bindings";

/**
 * GET /api/v1/health
 * Liveness probe. Returns a fixed payload; performs no database or
 * external calls and reports no fabricated system data.
 */
export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/", (c) => c.json({ status: "ok" }));
