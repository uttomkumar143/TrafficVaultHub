import { Hono } from "hono";
import type { AppEnv } from "./lib/bindings";
import { AppError, errorResponse } from "./lib/errors";
import { LogEmailSender, type EmailSender } from "./modules/auth/email";
import { AuthRepository } from "./modules/auth/repository";
import { AuthService } from "./modules/auth/service";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";

export interface CreateAppOptions {
  /** Override the email port (tests use MemoryEmailSender). */
  emailSender?: EmailSender;
}

/**
 * Builds the Hono application.
 * Kept separate from the Worker entry point so tests can import the app
 * directly without touching the Workers runtime.
 */
export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();
  const emailSender = options.emailSender ?? new LogEmailSender();

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

  // Per-request service wiring. Services are cheap objects over the bound
  // D1 database; constructing them per request keeps the app stateless.
  app.use("/api/v1/auth/*", async (c, next) => {
    if (!c.env?.DB) {
      // Misconfigured binding — fail closed with the uniform envelope.
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Database binding is not configured");
    }
    const ttl = Number(c.env.SESSION_TTL_SECONDS);
    c.set(
      "authService",
      new AuthService(new AuthRepository(c.env.DB), emailSender, {
        sessionTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
        exposeDebugTokens: c.env.APP_ENV === "development",
      }),
    );
    await next();
  });

  // API v1 (PRD §70)
  const v1 = new Hono<AppEnv>();
  v1.route("/health", healthRoutes);
  v1.route("/auth", authRoutes);

  app.route("/api/v1", v1);

  return app;
}
