import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../lib/bindings";
import { CapObjectCore, CapObjectMismatchError, type CapObjectStorage } from "../modules/tracking/cap-object";
import { reserveRpcSchema, statusRpcSchema } from "../modules/tracking/cap-ledger";
import { CapStore } from "../modules/tracking/cap-store";

/**
 * CoordinatorObject — Durable Object (PRD §44–§45).
 *
 * Phase 3 Unit 4 gives the Phase 0 placeholder its first behaviour: ONE
 * object per offer holds that offer's live cap counters and performs the
 * atomic check-and-increment (`CapObjectCore`). This class is deliberately a
 * thin shell — request validation, dispatch, error envelope, alarm — so the
 * logic stays testable in plain vitest without the Workers runtime.
 *
 * Addressing: `idFromName("cap:" + offer_id)` (see `cap-ledger.ts`). Requests
 * arrive only from the Worker (`DurableCapLedger`); the DO is not reachable
 * from the public internet. Payloads are still validated — a bug in the
 * Worker must not be able to corrupt an advertiser's counters.
 *
 * Storage: the counters snapshot lives in the DO's own transactional storage
 * (`SNAPSHOT_KEY`); the alarm flushes it to D1 `offer_cap_counters` a few
 * seconds after the last change so dashboards/eligibility can read it without
 * talking to the DO. The class name is unchanged from Phase 0 and the storage
 * was empty before, so no new DO migration tag is needed.
 */
export class CoordinatorObject extends DurableObject<Bindings> {
  private readonly core: CapObjectCore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // `DurableObjectStorage` satisfies the `CapObjectStorage` port structurally.
    const storage: CapObjectStorage = ctx.storage;
    this.core = new CapObjectCore(storage, { store: env.DB ? new CapStore(env.DB) : null });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return error(405, "METHOD_NOT_ALLOWED", "POST only");
    const path = new URL(request.url).pathname;
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return error(400, "INVALID_REQUEST", "body must be JSON");
    }
    try {
      switch (path) {
        case "/reserve": {
          const p = reserveRpcSchema.safeParse(raw);
          if (!p.success) return error(400, "INVALID_REQUEST", "malformed reserve request");
          const d = await this.core.reserve(p.data.offer_id, p.data.organization_id, p.data.limits, p.data.event, p.data.now);
          return Response.json(d);
        }
        case "/status": {
          const p = statusRpcSchema.safeParse(raw);
          if (!p.success) return error(400, "INVALID_REQUEST", "malformed status request");
          const s = await this.core.status(p.data.offer_id, p.data.organization_id, p.data.limits, p.data.kind, p.data.now);
          return Response.json({ counters: s.counters });
        }
        default:
          return error(404, "NOT_FOUND", "unknown cap operation");
      }
    } catch (e) {
      if (e instanceof CapObjectMismatchError) return error(409, "OFFER_MISMATCH", "object is bound to another offer");
      // No details leak; the Worker fails closed on any non-2xx.
      return error(500, "INTERNAL_ERROR", "cap object failure");
    }
  }

  /** Runtime alarm hook: flush the snapshot to D1, prune closed periods. */
  override async alarm(): Promise<void> {
    await this.core.flush();
  }
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, request_id: null } }, { status });
}
