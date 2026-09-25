import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./lib/bindings";
import { AppError, errorResponse } from "./lib/errors";
import { AdvertiserRepository } from "./modules/advertisers/repository";
import { AdvertiserService } from "./modules/advertisers/service";
import { AffiliateRepository } from "./modules/affiliates/repository";
import { AffiliateService } from "./modules/affiliates/service";
import { LogEmailSender, type EmailSender } from "./modules/auth/email";
import { AuthRepository } from "./modules/auth/repository";
import { AuthService } from "./modules/auth/service";
import { OfferRepository } from "./modules/offers/repository";
import { OfferService } from "./modules/offers/service";
import { OrganizationRepository } from "./modules/organizations/repository";
import { OrganizationService } from "./modules/organizations/service";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { organizationRoutes } from "./routes/organizations";

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

  // Per-request service wiring for every DB-backed module. Services are cheap
  // objects over the bound D1 database; constructing them per request keeps
  // the app stateless. `requireAuth` relies on `authService` being present,
  // so every protected module prefix MUST be listed here when mounted below.
  // (Not a blanket `/api/v1/*`: unknown paths must stay 404, never 503.)
  const wireServices: MiddlewareHandler<AppEnv> = async (c, next) => {
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
    c.set("organizationService", new OrganizationService(new OrganizationRepository(c.env.DB), c.env.DB));
    c.set("advertiserService", new AdvertiserService(new AdvertiserRepository(c.env.DB), c.env.DB));
    c.set("affiliateService", new AffiliateService(new AffiliateRepository(c.env.DB), c.env.DB));
    c.set(
      "offerService",
      new OfferService(new OfferRepository(c.env.DB), new AdvertiserRepository(c.env.DB), c.env.DB),
    );
    await next();
  };
  app.use("/api/v1/auth/*", wireServices);
  app.use("/api/v1/organizations", wireServices);
  app.use("/api/v1/organizations/*", wireServices);

  // API v1 (PRD §70)
  const v1 = new Hono<AppEnv>();
  v1.route("/health", healthRoutes);
  v1.route("/auth", authRoutes);
  v1.route("/organizations", organizationRoutes);

  app.route("/api/v1", v1);

  return app;
}
