/**
 * Worker environment bindings.
 * Mirrors `wrangler.jsonc`. Keep in sync when bindings change.
 */
export interface Bindings {
  // vars
  APP_ENV: string;
  API_VERSION: string;

  // Cloudflare resources (placeholders in Phase 0 — see wrangler.jsonc)
  DB: D1Database;
  CACHE: KVNamespace;
  STORAGE: R2Bucket;
  EVENTS_QUEUE: Queue;
}

export type AppEnv = { Bindings: Bindings };
