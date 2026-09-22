import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../lib/bindings";

/**
 * CoordinatorObject — Durable Object placeholder (Phase 0).
 *
 * PRD §44–§45 reserve Durable Objects for coordination and hot state
 * (e.g. rate-limit windows, budget caps, per-tenant counters). No module
 * requires coordination in Phase 0, so this class exists only so that the
 * `COORDINATOR` binding in `wrangler.jsonc` resolves to a real exported
 * class and the Worker deploys. It holds no business logic and stores no
 * fabricated state.
 *
 * The first module that needs coordination will replace the `fetch` handler
 * (or add RPC methods) and add a Durable Object migration tag if the storage
 * shape changes.
 */
export class CoordinatorObject extends DurableObject<Bindings> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      {
        error: {
          code: "NOT_IMPLEMENTED",
          message: "CoordinatorObject has no behaviour in Phase 0",
          request_id: null,
        },
      },
      { status: 501 },
    );
  }
}
