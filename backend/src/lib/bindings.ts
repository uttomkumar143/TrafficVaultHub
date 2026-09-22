/**
 * Worker environment bindings.
 * Mirrors `wrangler.jsonc`. Keep in sync when bindings change.
 */
import type { TenantContext } from "../middleware/require-org";
import type { AuthService, AuthenticatedContext } from "../modules/auth/service";
import type { OrganizationService } from "../modules/organizations/service";

export interface Bindings {
  // vars
  APP_ENV: string;
  API_VERSION: string;
  /** Optional override of the 30-day default (ADR-001 §2). */
  SESSION_TTL_SECONDS?: string;

  // Cloudflare resources (placeholders in Phase 0 — see wrangler.jsonc)
  DB: D1Database;
  CACHE: KVNamespace;
  STORAGE: R2Bucket;
  EVENTS_QUEUE: Queue;

  // Durable Object namespace — placeholder class, no behaviour in Phase 0.
  COORDINATOR: DurableObjectNamespace;
}

/** Per-request variables set by middleware. */
export interface Variables {
  authService: AuthService;
  organizationService: OrganizationService;
  /** Present only after `requireAuth` has run. */
  auth: AuthenticatedContext;
  /** Present only after `requireOrg` has run (RBAC + tenant scope, Unit 4). */
  tenant: TenantContext;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
