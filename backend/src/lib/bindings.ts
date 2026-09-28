/**
 * Worker environment bindings.
 * Mirrors `wrangler.jsonc`. Keep in sync when bindings change.
 */
import type { TenantContext } from "../middleware/require-org";
import type { AdvertiserService } from "../modules/advertisers/service";
import type { AffiliateService } from "../modules/affiliates/service";
import type { AuthService, AuthenticatedContext } from "../modules/auth/service";
import type { OfferService } from "../modules/offers/service";
import type { OrganizationService } from "../modules/organizations/service";
import type { TrackingService } from "../modules/tracking/service";

export interface Bindings {
  // vars
  APP_ENV: string;
  API_VERSION: string;
  /** Optional override of the 30-day default (ADR-001 §2). */
  SESSION_TTL_SECONDS?: string;

  // secrets (`wrangler secret put` / `.dev.vars`; never in wrangler.jsonc)
  /**
   * Phase 3 Unit 2 — salt for the click row's `ip_hash` / `user_agent_hash`
   * (PRD §34). Optional: when absent those columns stay NULL rather than
   * storing an unsalted (brute-forceable) hash. Rotating it changes every
   * subsequent hash; existing rows are not rewritten.
   */
  CLICK_SIGNAL_SALT?: string;

  // Cloudflare resources (placeholders in Phase 0 — see wrangler.jsonc)
  DB: D1Database;
  CACHE: KVNamespace;
  STORAGE: R2Bucket;
  EVENTS_QUEUE: Queue;

  /**
   * Durable Object namespace — `CoordinatorObject` (Phase 3 Unit 4): one
   * object per offer holding the live cap counters; addressed through
   * `DurableCapLedger` (`modules/tracking/cap-ledger.ts`), never directly.
   */
  COORDINATOR: DurableObjectNamespace;
}

/** Per-request variables set by middleware. */
export interface Variables {
  authService: AuthService;
  organizationService: OrganizationService;
  /** Phase 2 Unit 1 — advertiser profile + lifecycle. */
  advertiserService: AdvertiserService;
  /** Phase 2 Unit 2 — affiliate profile, traffic sources + lifecycle. */
  affiliateService: AffiliateService;
  /** Phase 2 Units 3–7 — offers, versioning, economics, access, marketplace. */
  offerService: OfferService;
  /** Phase 3 Unit 1 — tracking links + click reads. */
  trackingService: TrackingService;
  /** Present only after `requireAuth` has run. */
  auth: AuthenticatedContext;
  /** Present only after `requireOrg` has run (RBAC + tenant scope, Unit 4). */
  tenant: TenantContext;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
