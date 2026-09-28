/**
 * Phase 3 Unit 4 — DurableCapLedger against a fake namespace that speaks the
 * SAME RPC contract as `workers/coordinator-object.ts` (validation schemas
 * imported from cap-ledger.ts, logic from CapObjectCore). No Workers runtime.
 */
import { describe, expect, it } from "vitest";
import { CapObjectCore, CapObjectMismatchError, MemoryCapStorage } from "./cap-object";
import {
  CAP_RPC_ORIGIN,
  CapLedgerError,
  DurableCapLedger,
  capObjectName,
  reserveRpcSchema,
  statusRpcSchema,
  type CapNamespace,
} from "./cap-ledger";
import { UNCAPPED, type CapLimits } from "./caps";

const ORG = "org-adv-1";
const T0 = new Date("2026-03-15T10:00:00.000Z");
const CLICK = { kind: "CLICK" as const };
const clickCap = (n: number): CapLimits => ({ ...UNCAPPED, daily_click_cap: n });

/** Mirrors CoordinatorObject.fetch — one core per DO name, like the platform. */
class FakeCapNamespace implements CapNamespace {
  readonly cores = new Map<string, CapObjectCore>();
  readonly storages = new Map<string, MemoryCapStorage>();
  fetches = 0;
  /** When set, every fetch throws (simulates DO unreachable). */
  down = false;

  idFromName(name: string): DurableObjectId {
    return { toString: () => name, equals: (o: DurableObjectId) => o.toString() === name, name } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId) {
    const name = id.toString();
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        this.fetches += 1;
        if (this.down) throw new Error("connection reset");
        const req = new Request(input, init);
        return this.handle(name, req);
      },
    };
  }

  private coreFor(name: string): CapObjectCore {
    let c = this.cores.get(name);
    if (!c) {
      const storage = new MemoryCapStorage();
      this.storages.set(name, storage);
      c = new CapObjectCore(storage, { now: () => T0 });
      this.cores.set(name, c);
    }
    return c;
  }

  private async handle(name: string, request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const raw = await request.json();
    const core = this.coreFor(name);
    try {
      if (path === "/reserve") {
        const p = reserveRpcSchema.safeParse(raw);
        if (!p.success) return err(400, "INVALID_REQUEST");
        return Response.json(await core.reserve(p.data.offer_id, p.data.organization_id, p.data.limits, p.data.event, p.data.now));
      }
      if (path === "/status") {
        const p = statusRpcSchema.safeParse(raw);
        if (!p.success) return err(400, "INVALID_REQUEST");
        const s = await core.status(p.data.offer_id, p.data.organization_id, p.data.limits, p.data.kind, p.data.now);
        return Response.json({ counters: s.counters });
      }
      return err(404, "NOT_FOUND");
    } catch (e) {
      if (e instanceof CapObjectMismatchError) return err(409, "OFFER_MISMATCH");
      return err(500, "INTERNAL_ERROR");
    }
  }
}

function err(status: number, code: string): Response {
  return Response.json({ error: { code, message: code, request_id: null } }, { status });
}

describe("DurableCapLedger", () => {
  it("routes each offer to its own object and enforces the cap across concurrent callers", async () => {
    const ns = new FakeCapNamespace();
    const ledger = new DurableCapLedger(ns);
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => ledger.reserve({ offer_id: "offer-A", organization_id: ORG, limits: clickCap(4), event: CLICK, now: T0 })),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(4);
    // A different offer has its own object and its own counters.
    const other = await ledger.reserve({ offer_id: "offer-B", organization_id: ORG, limits: clickCap(4), event: CLICK, now: T0 });
    expect(other.allowed).toBe(true);
    expect(Array.from(ns.cores.keys()).sort()).toEqual([capObjectName("offer-A"), capObjectName("offer-B")]);
    expect(capObjectName("x")).toBe("cap:x");
  });

  it("status returns validated counters; money and periods round-trip through JSON", async () => {
    const ns = new FakeCapNamespace();
    const ledger = new DurableCapLedger(ns);
    const limits: CapLimits = { ...UNCAPPED, budget_minor: 1000, currency: "USD" };
    const d = await ledger.reserve({ offer_id: "offer-A", organization_id: ORG, limits, event: { kind: "CONVERSION", amount_minor: 250, currency: "usd" }, now: T0 });
    expect(d.allowed).toBe(true);
    const counters = await ledger.status("offer-A", limits, "CONVERSION", T0, ORG);
    const budget = counters.find((c) => c.cap_type === "BUDGET")!;
    expect(budget.current_value).toBe(250);
    expect(budget.currency).toBe("USD");
    expect(budget.period_key).toBe("TOTAL");
    expect(counters.find((c) => c.cap_type === "DAILY_CONVERSION")!.period_key).toBe("2026-03-15");
  });

  it("denials come back typed (BUDGET_EXHAUSTED / INVALID_AMOUNT / CURRENCY_MISMATCH), never thrown", async () => {
    const ledger = new DurableCapLedger(new FakeCapNamespace());
    const limits: CapLimits = { ...UNCAPPED, budget_minor: 100, currency: "USD" };
    const req = (amount_minor: number, currency = "USD") =>
      ledger.reserve({ offer_id: "o", organization_id: ORG, limits, event: { kind: "CONVERSION", amount_minor, currency }, now: T0 });
    expect(await req(101)).toMatchObject({ allowed: false, reason: "BUDGET_EXHAUSTED", cap_type: "BUDGET" });
    expect(await req(1.5)).toMatchObject({ allowed: false, reason: "INVALID_AMOUNT" });
    expect(await req(-1)).toMatchObject({ allowed: false, reason: "INVALID_AMOUNT" });
    expect(await req(10, "EUR")).toMatchObject({ allowed: false, reason: "CURRENCY_MISMATCH" });
  });

  it("infrastructure failures THROW CapLedgerError so the caller can fail closed", async () => {
    const ns = new FakeCapNamespace();
    const ledger = new DurableCapLedger(ns);
    ns.down = true;
    await expect(ledger.reserve({ offer_id: "o", organization_id: ORG, limits: clickCap(1), event: CLICK })).rejects.toMatchObject({
      name: "CapLedgerError",
      status: 0,
      code: "TRANSPORT",
    });
    ns.down = false;
    // Object bound to offer "o" under ORG; same name but another org → 409 from the object → thrown.
    await ledger.reserve({ offer_id: "o", organization_id: ORG, limits: clickCap(5), event: CLICK });
    await expect(ledger.reserve({ offer_id: "o", organization_id: "org-other", limits: clickCap(5), event: CLICK })).rejects.toMatchObject({
      status: 409,
      code: "OFFER_MISMATCH",
    });
  });

  it("refuses a malformed reply from the object", async () => {
    const ns: CapNamespace = {
      idFromName: (name) => ({ toString: () => name }) as unknown as DurableObjectId,
      get: () => ({ fetch: async () => Response.json({ allowed: true }) }), // missing counters/newly_exhausted
    };
    const ledger = new DurableCapLedger(ns);
    await expect(ledger.reserve({ offer_id: "o", organization_id: ORG, limits: clickCap(1), event: CLICK })).rejects.toBeInstanceOf(CapLedgerError);
  });

  it("RPC schemas are strict: unknown fields, bad limits and non-ISO `now` are rejected before the core sees them", () => {
    const base = { offer_id: "o", organization_id: ORG, limits: clickCap(1), event: CLICK };
    expect(reserveRpcSchema.safeParse(base).success).toBe(true);
    expect(reserveRpcSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(reserveRpcSchema.safeParse({ ...base, limits: { ...clickCap(1), daily_click_cap: -1 } }).success).toBe(false);
    expect(reserveRpcSchema.safeParse({ ...base, limits: { ...clickCap(1), daily_click_cap: 1.5 } }).success).toBe(false);
    expect(reserveRpcSchema.safeParse({ ...base, now: "yesterday" }).success).toBe(false);
    expect(reserveRpcSchema.safeParse({ ...base, now: T0.toISOString() }).success).toBe(true);
    expect(reserveRpcSchema.safeParse({ ...base, offer_id: "" }).success).toBe(false);
    expect(statusRpcSchema.safeParse({ offer_id: "o", organization_id: ORG, limits: clickCap(1), kind: "CLICK" }).success).toBe(true);
    expect(statusRpcSchema.safeParse({ offer_id: "o", organization_id: ORG, limits: clickCap(1), kind: "VIEW" }).success).toBe(false);
    expect(CAP_RPC_ORIGIN.startsWith("https://")).toBe(true);
  });
});
