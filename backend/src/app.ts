import { Hono } from "hono";
import type { AppEnv } from "./lib/bindings";
import { errorResponse } from "./lib/errors";
import { healthRoutes } from "./routes/health";

/**
 * Builds the Hono application.
 * Kept separate from the Worker entry point so tests can import the app
 * directly without touching the Workers runtime.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  // PRD §72 — uniform error envelope, no stack traces exposed.
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Resource not found",
          request_id: c.req.header("cf-ray") ?? null,
        },
      },
      404,
    ),
  );

  // AppError → its own status/code; anything else → 500 without details.
  app.onError((err, c) => errorResponse(err, c));

  // API v1 (PRD §70)
  const v1 = new Hono<AppEnv>();
  v1.route("/health", healthRoutes);

  app.route("/api/v1", v1);

  return app;
}
