import { Hono, type MiddlewareHandler } from "hono";
import {
  LogNotificationAdapter,
  NullCRMAdapter,
  NullFraudAdapter,
  NullTrackingAdapter,
  StubPaymentAdapter as StubChargeAdapter,
  type CRMAdapter,
  type FraudAdapter,
  type NotificationAdapter,
  type PaymentAdapter,
  type TrackingAdapter,
} from "./integrations";
import type { AppEnv } from "./lib/bindings";
import { AppError, errorResponse, requestId } from "./lib/errors";
import { requestIdMiddleware } from "./middleware/request-id";
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
import type { PaymentProvider } from "./modules/payouts/provider";
import { StubPaymentAdapter } from "./modules/payouts/stub-adapter";
import { EligibilityCache } from "./modules/tracking/eligibility-cache";
import { TrackingRepository } from "./modules/tracking/repository";
import { TrackingService } from "./modules/tracking/service";
import { FetchWebhookTransport, type WebhookTransport } from "./modules/webhooks/transport";
import { postbackRoutes } from "./routes/attribution";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { organizationRoutes } from "./routes/organizations";
import { redirectRoutes, type RedirectRouteOptions } from "./routes/redirect";

export interface CreateAppOptions {
  /** Override the email port (tests use MemoryEmailSender). */
  emailSender?: EmailSender;
  /** Test seams for the public redirect endpoints (Phase 3 Unit 2). */
  redirect?: RedirectRouteOptions;
  /**
   * Payment provider used by the PLATFORM payout `process` step (Phase 5).
   * Defaults to `StubPaymentAdapter` — KNOWN GAP: no real provider is wired
   * yet; tests inject scripted providers through this seam.
   */
  paymentProvider?: PaymentProvider;
  /**
   * Outbound transport for webhook deliveries (Phase 6 Unit 4). Defaults to
   * `FetchWebhookTransport`; tests inject `ScriptedWebhookTransport` (no network).
   */
  webhookTransport?: WebhookTransport;
  /**
   * Phase 6 Unit 5 — PRD §367 integration adapters. Each defaults to the
   * shipped stub/null implementation; a real vendor is injected here and
   * nowhere else. (`PayoutAdapter` is `paymentProvider` above — same port.)
   */
  trackingAdapter?: TrackingAdapter;
  paymentAdapter?: PaymentAdapter;
  notificationAdapter?: NotificationAdapter;
  crmAdapter?: CRMAdapter;
  fraudAdapter?: FraudAdapter;
}

/**
 * Builds the Hono application.
 * Kept separate from the Worker entry point so tests can import the app
 * directly without touching the Workers runtime.
 */
export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppEnv>();
  const emailSender = options.emailSender ?? new LogEmailSender();
  const paymentProvider: PaymentProvider = options.paymentProvider ?? new StubPaymentAdapter();
  const webhookTransport: WebhookTransport = options.webhookTransport ?? new FetchWebhookTransport();
  const trackingAdapter: TrackingAdapter = options.trackingAdapter ?? new NullTrackingAdapter();
  const paymentAdapter: PaymentAdapter = options.paymentAdapter ?? new StubChargeAdapter();
  const notificationAdapter: NotificationAdapter = options.notificationAdapter ?? new LogNotificationAdapter();
  const crmAdapter: CRMAdapter = options.crmAdapter ?? new NullCRMAdapter();
  const fraudAdapter: FraudAdapter = options.fraudAdapter ?? new NullFraudAdapter();

  // PRD §72 — `request_id` always present (Phase 6 Unit 1): resolved first,
  // echoed as `x-request-id` on every response including errors / 404s.
  app.use("*", requestIdMiddleware);

  // PRD §72 — uniform error envelope, no stack traces exposed.
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Resource not found",
          request_id: requestId(c),
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
    c.set("paymentProvider", paymentProvider);
    c.set("webhookTransport", webhookTransport);
    c.set("trackingAdapter", trackingAdapter);
    c.set("paymentAdapter", paymentAdapter);
    c.set("notificationAdapter", notificationAdapter);
    c.set("crmAdapter", crmAdapter);
    c.set("fraudAdapter", fraudAdapter);
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
    // Eligibility cache (Phase 3 Unit 5) over the CACHE KV binding. Optional:
    // without the binding (tests, misconfigured env) there is no cache and
    // therefore nothing stale to invalidate — the redirect reads D1 directly.
    const eligibilityCache = c.env.CACHE ? new EligibilityCache(c.env.CACHE) : undefined;
    c.set("offerService", new OfferService(new OfferRepository(c.env.DB), new AdvertiserRepository(c.env.DB), c.env.DB, eligibilityCache));
    c.set(
      "trackingService",
      new TrackingService(new TrackingRepository(c.env.DB), new AffiliateRepository(c.env.DB), new OfferRepository(c.env.DB), c.env.DB),
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

  // Public click endpoints (Phase 3 Unit 2): GET /t/:code, GET /s/:code.
  // Deliberately OUTSIDE /api/v1 and outside `wireServices` / auth — they
  // build their own minimal dependencies per request (hot path, PRD §107).
  app.route("/", redirectRoutes(options.redirect));

  // Public S2S postback (Phase 3 Unit 7e): POST /postback/v1/conversions.
  // Same placement as the redirects: outside /api/v1 and outside session auth
  // — the HMAC envelope over the raw body IS the authentication (PRD §74).
  app.route("/", postbackRoutes());

  return app;
}
