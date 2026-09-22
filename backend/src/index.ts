/**
 * Cloudflare Worker entry point for the TrafficVaultHub API.
 */
import { createApp } from "./app";

// Durable Object classes must be exported from the Worker entry point so the
// runtime can bind them (see `durable_objects.bindings` in wrangler.jsonc).
export { CoordinatorObject } from "./workers/coordinator-object";

const app = createApp();

export default app;
