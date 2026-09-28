/**
 * Worker-side `CapLedger` over the COORDINATOR Durable Object namespace
 * (Phase 3 Unit 4; PRD §44, §45). Also defines the fetch-based RPC contract
 * the DO shell (`workers/coordinator-object.ts`) validates against, so both
 * ends share ONE wire format and ONE validator.
 *
 * Routing: one DO per offer — `namespace.idFromName("cap:" + offer_id)` —
 * so every reserve for an offer serialises on the same object (that is the
 * whole atomicity story; see `cap-object.ts`).
 *
 * Wire format (JSON over an internal `https://cap.internal/...` URL that
 * never leaves the Worker → DO hop):
 *   POST /reserve  { offer_id, organization_id, limits, event, now? }  → CapDecision
 *   POST /status   { offer_id, organization_id, limits, kind,  now? }  → { counters }
 * Errors: 400 {error:{code:"INVALID_REQUEST"}} · 409 OFFER_MISMATCH ·
 *         404 NOT_FOUND · 500 INTERNAL_ERROR. The adapter turns every non-2xx
 *         into a thrown `CapLedgerError`; the CALLER decides fail-open/closed
 *         (the redirect fails CLOSED for capped offers — PRD §44: never
 *         over-deliver an advertiser's cap because infrastructure hiccuped).
 *
 * Money stays integer minor units end to end; `now` travels as ISO-8601 so
 * tests can pin periods. Nothing here trusts the payload: the DO re-validates.
 */
import { z } from "zod";
import {
  CAP_TYPES,
  type CapCounter,
  type CapDecision,
  type CapEvent,
  type CapLedger,
  type CapLimits,
  type ReserveRequest,
} from "./caps";

export const CAP_RPC_ORIGIN = "https://cap.internal";
export const CAP_DO_NAME_PREFIX = "cap:";

/** Name under which an offer's cap object is addressed in the namespace. */
export function capObjectName(offerId: string): string {
  return `${CAP_DO_NAME_PREFIX}${offerId}`;
}

const limitSchema = z.union([z.null(), z.number().int().nonnegative()]);

export const capLimitsSchema: z.ZodType<CapLimits> = z
  .object({
    daily_click_cap: limitSchema,
    monthly_click_cap: limitSchema,
    total_click_cap: limitSchema,
    daily_conversion_cap: limitSchema,
    monthly_conversion_cap: limitSchema,
    total_conversion_cap: limitSchema,
    budget_minor: limitSchema,
    currency: z.union([z.null(), z.string().length(3)]),
  })
  .strict();

export const capEventSchema: z.ZodType<CapEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLICK") }).strict(),
  z
    .object({
      kind: z.literal("CONVERSION"),
      // Validation of range/integer-ness is the core's job (it must DENY, not
      // 400, so the reason is recorded) — here we only require a finite number.
      amount_minor: z.number().finite(),
      currency: z.string().min(1).max(8),
    })
    .strict(),
]);

const isoDate = z
  .string()
  .datetime()
  .transform((s) => new Date(s));

const idField = z.string().min(1).max(128);

export const reserveRpcSchema = z
  .object({
    offer_id: idField,
    organization_id: idField,
    limits: capLimitsSchema,
    event: capEventSchema,
    now: isoDate.optional(),
  })
  .strict();
export type ReserveRpc = z.infer<typeof reserveRpcSchema>;

export const statusRpcSchema = z
  .object({
    offer_id: idField,
    organization_id: idField,
    limits: capLimitsSchema,
    kind: z.enum(["CLICK", "CONVERSION"]),
    now: isoDate.optional(),
  })
  .strict();
export type StatusRpc = z.infer<typeof statusRpcSchema>;

const capTypeSchema = z.enum(CAP_TYPES);

const counterSchema: z.ZodType<CapCounter> = z
  .object({
    cap_type: capTypeSchema,
    period_key: z.string().min(1),
    limit_value: limitSchema,
    current_value: z.number().int().nonnegative(),
    currency: z.union([z.null(), z.string().length(3)]),
    exhausted_at: z.union([z.null(), z.string()]),
  })
  .strict();

/** Response validator — the adapter refuses to act on a malformed DO reply. */
export const capDecisionSchema: z.ZodType<CapDecision> = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true), counters: z.array(counterSchema), newly_exhausted: z.array(capTypeSchema) }).strict(),
  z
    .object({
      allowed: z.literal(false),
      reason: z.enum(["CAP_EXHAUSTED", "BUDGET_EXHAUSTED", "INVALID_AMOUNT", "CURRENCY_MISMATCH"]),
      cap_type: z.union([z.null(), capTypeSchema]),
      counters: z.array(counterSchema),
    })
    .strict(),
]);

export const statusResponseSchema = z.object({ counters: z.array(counterSchema) }).strict();

/** Infrastructure failure talking to the DO. Carries the HTTP status (0 = transport). */
export class CapLedgerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapLedgerError";
  }
}

/**
 * The slice of `DurableObjectNamespace` the adapter needs. Real namespaces
 * satisfy it structurally; tests pass a fake that routes to a `CapObjectCore`.
 */
export interface CapNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

export class DurableCapLedger implements CapLedger {
  constructor(private readonly ns: CapNamespace) {}

  async reserve(req: ReserveRequest): Promise<CapDecision> {
    const body = {
      offer_id: req.offer_id,
      organization_id: req.organization_id,
      limits: req.limits,
      event: req.event,
      ...(req.now ? { now: req.now.toISOString() } : {}),
    };
    const json = await this.call(req.offer_id, "/reserve", body);
    const parsed = capDecisionSchema.safeParse(json);
    if (!parsed.success) throw new CapLedgerError(502, "BAD_RESPONSE", "cap object returned a malformed decision");
    return parsed.data;
  }

  /** Extra optional `organizationId` beyond the port so a never-seen object can be bound on a status probe. */
  async status(offerId: string, limits: CapLimits, kind: CapEvent["kind"], now?: Date, organizationId?: string): Promise<CapCounter[]> {
    const json = await this.call(offerId, "/status", {
      offer_id: offerId,
      // The port's `status` has no org parameter; the DO only needs it to
      // bind a never-seen object. Callers that know the org pass it; a
      // status probe on an unbound object with an empty org is rejected by
      // the DO (400), which the caller treats as "no counters yet".
      organization_id: organizationId ?? "",
      limits,
      kind,
      ...(now ? { now: now.toISOString() } : {}),
    });
    const parsed = statusResponseSchema.safeParse(json);
    if (!parsed.success) throw new CapLedgerError(502, "BAD_RESPONSE", "cap object returned malformed counters");
    return parsed.data.counters;
  }

  private async call(offerId: string, path: string, body: unknown): Promise<unknown> {
    const stub = this.ns.get(this.ns.idFromName(capObjectName(offerId)));
    let res: Response;
    try {
      res = await stub.fetch(`${CAP_RPC_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new CapLedgerError(0, "TRANSPORT", e instanceof Error ? e.message : "cap object unreachable");
    }
    if (!res.ok) {
      let code = "UPSTREAM_ERROR";
      try {
        const err = (await res.json()) as { error?: { code?: unknown } };
        if (typeof err?.error?.code === "string") code = err.error.code;
      } catch {
        // body not JSON — keep the generic code
      }
      throw new CapLedgerError(res.status, code, `cap object responded ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new CapLedgerError(502, "BAD_RESPONSE", "cap object returned non-JSON");
    }
  }
}
