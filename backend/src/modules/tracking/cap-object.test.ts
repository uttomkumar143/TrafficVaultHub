/**
 * Phase 3 Unit 4 — CapObjectCore with in-memory storage (no Workers runtime).
 * Proves the atomicity / durability contract the Durable Object relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { CapObjectCore, CapObjectMismatchError, MemoryCapStorage, SNAPSHOT_KEY } from "./cap-object";
import { CapStore, type CapSnapshot } from "./cap-store";
import { UNCAPPED, type CapLimits } from "./caps";

const ORG = "org-adv-1";
const OFFER = "offer-1";
const T0 = new Date("2026-03-15T10:00:00.000Z");
const CLICK = { kind: "CLICK" as const };
const conv = (amount_minor: number, currency = "USD") => ({ kind: "CONVERSION" as const, amount_minor, currency });

const clickCap = (n: number): CapLimits => ({ ...UNCAPPED, daily_click_cap: n });

describe("CapObjectCore: atomic check + increment", () => {
  it("N concurrent reserves against a cap of K admit exactly K", async () => {
    const storage = new MemoryCapStorage();
    const core = new CapObjectCore(storage, { now: () => T0 });
    const N = 50;
    const K = 7;
    const decisions = await Promise.all(
      Array.from({ length: N }, () => core.reserve(OFFER, ORG, clickCap(K), CLICK)),
    );
    const allowed = decisions.filter((d) => d.allowed);
    expect(allowed).toHaveLength(K);
    expect(decisions.filter((d) => !d.allowed && d.reason === "CAP_EXHAUSTED")).toHaveLength(N - K);
    // newly_exhausted fires exactly once, on the Kth admission.
    expect(allowed.flatMap((d) => (d.allowed ? d.newly_exhausted : []))).toEqual(["DAILY_CLICK"]);
    const st = await core.status(OFFER, ORG, clickCap(K), "CLICK");
    expect(st.counters.find((c) => c.cap_type === "DAILY_CLICK")!.current_value).toBe(K);
  });

  it("budget in minor units: concurrent conversions never exceed the budget", async () => {
    const core = new CapObjectCore(new MemoryCapStorage(), { now: () => T0 });
    const limits: CapLimits = { ...UNCAPPED, budget_minor: 1000, currency: "USD" };
    const decisions = await Promise.all(Array.from({ length: 20 }, () => core.reserve(OFFER, ORG, limits, conv(150))));
    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBe(6); // 6 * 150 = 900 <= 1000; a 7th (1050) must be denied
    const st = await core.status(OFFER, ORG, limits, "CONVERSION");
    expect(st.counters.find((c) => c.cap_type === "BUDGET")!.current_value).toBe(900);
    expect(decisions.some((d) => !d.allowed && d.reason === "BUDGET_EXHAUSTED")).toBe(true);
  });
});

describe("CapObjectCore: durability", () => {
  it("state survives eviction: a fresh core over the same storage continues the count", async () => {
    const storage = new MemoryCapStorage();
    const a = new CapObjectCore(storage, { now: () => T0 });
    for (let i = 0; i < 3; i++) expect((await a.reserve(OFFER, ORG, clickCap(5), CLICK)).allowed).toBe(true);

    const b = new CapObjectCore(storage, { now: () => T0 }); // "evicted and re-instantiated"
    expect((await b.reserve(OFFER, ORG, clickCap(5), CLICK)).allowed).toBe(true); // 4
    expect((await b.reserve(OFFER, ORG, clickCap(5), CLICK)).allowed).toBe(true); // 5
    const sixth = await b.reserve(OFFER, ORG, clickCap(5), CLICK);
    expect(sixth.allowed).toBe(false);
    const snap = (await storage.get<CapSnapshot>(SNAPSHOT_KEY))!;
    expect(snap.offer_id).toBe(OFFER);
    expect(snap.organization_id).toBe(ORG);
    expect(snap.counters.find((c) => c.cap_type === "DAILY_CLICK")!.current_value).toBe(5);
  });

  it("a denied reserve does not write storage", async () => {
    const storage = new MemoryCapStorage();
    const core = new CapObjectCore(storage, { now: () => T0 });
    await core.reserve(OFFER, ORG, clickCap(1), CLICK); // bind put + reserve put
    const before = storage.puts;
    expect((await core.reserve(OFFER, ORG, clickCap(1), CLICK)).allowed).toBe(false);
    expect(storage.puts).toBe(before);
  });

  it("a corrupt snapshot blob is discarded, not trusted", async () => {
    const storage = new MemoryCapStorage();
    storage.putRaw(SNAPSHOT_KEY, JSON.stringify({ v: 1, offer_id: OFFER, organization_id: ORG, counters: [{ cap_type: "DAILY_CLICK", period_key: "2026-03-15", limit_value: 5, current_value: -99, currency: null, exhausted_at: null }] }));
    const core = new CapObjectCore(storage, { now: () => T0 });
    const d = await core.reserve(OFFER, ORG, clickCap(5), CLICK);
    expect(d.allowed).toBe(true);
    expect(d.allowed && d.counters[0]!.current_value).toBe(1);
  });
});

describe("CapObjectCore: identity", () => {
  it("rejects a reserve for a different offer once bound", async () => {
    const core = new CapObjectCore(new MemoryCapStorage(), { now: () => T0 });
    await core.reserve(OFFER, ORG, clickCap(5), CLICK);
    await expect(core.reserve("offer-2", ORG, clickCap(5), CLICK)).rejects.toBeInstanceOf(CapObjectMismatchError);
    await expect(core.status("offer-2", ORG, clickCap(5), "CLICK")).rejects.toBeInstanceOf(CapObjectMismatchError);
    // And the same offer under a different org is refused too (fail closed).
    await expect(core.reserve(OFFER, "org-other", clickCap(5), CLICK)).rejects.toBeInstanceOf(CapObjectMismatchError);
  });

  it("a rehydrated core keeps the bound identity from the snapshot", async () => {
    const storage = new MemoryCapStorage();
    await new CapObjectCore(storage, { now: () => T0 }).reserve(OFFER, ORG, clickCap(5), CLICK);
    const b = new CapObjectCore(storage, { now: () => T0 });
    await expect(b.reserve("offer-2", ORG, clickCap(5), CLICK)).rejects.toBeInstanceOf(CapObjectMismatchError);
  });
});

describe("CapObjectCore: alarm flush to D1", () => {
  let db: TestD1;
  beforeEach(() => {
    db = createTestD1();
    db.sqlite.exec(`
      INSERT INTO organizations (id, type, name, slug) VALUES ('${ORG}', 'ADVERTISER', 'Adv', 'adv');
      INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ORG}', 'ACTIVE', 'Adv Co');
      INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
        VALUES ('${OFFER}', '${ORG}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    `);
  });
  afterEach(() => db.close());

  it("reserve arms ONE alarm; the alarm flushes counters to offer_cap_counters and disarms", async () => {
    const storage = new MemoryCapStorage();
    const store = new CapStore(db);
    const core = new CapObjectCore(storage, { store, now: () => T0, flushDelayMs: 5000 });
    expect(await storage.getAlarm()).toBeNull();
    await core.reserve(OFFER, ORG, clickCap(10), CLICK);
    await core.reserve(OFFER, ORG, clickCap(10), CLICK);
    expect(await storage.getAlarm()).toBe(T0.getTime() + 5000); // not re-armed / pushed out by the 2nd reserve

    // Nothing in D1 yet — the hot path never touches D1 for caps.
    expect(await store.load(OFFER)).toEqual([]);

    storage.takeAlarm();
    const r = await core.flush(T0);
    expect(r.flushed).toBe(3); // DAILY_CLICK, MONTHLY_CLICK, TOTAL_CLICK counters were opened
    const rows = await store.load(OFFER);
    const daily = rows.find((x) => x.cap_type === "DAILY_CLICK")!;
    expect(daily.current_value).toBe(2);
    expect(daily.limit_value).toBe(10);
    expect(daily.period_key).toBe("2026-03-15");
    expect(daily.organization_id).toBe(ORG);
    expect(await storage.getAlarm()).toBeNull();

    // A second flush with nothing dirty writes nothing.
    expect((await core.flush(T0)).flushed).toBe(0);
  });

  it("flush prunes closed periods after flushing their final value; TOTAL survives", async () => {
    const storage = new MemoryCapStorage();
    const store = new CapStore(db);
    const core = new CapObjectCore(storage, { store, now: () => T0 });
    await core.reserve(OFFER, ORG, clickCap(10), CLICK, T0);
    const nextDay = new Date("2026-03-16T00:00:01.000Z");
    const r = await core.flush(nextDay);
    expect(r.pruned).toBe(1); // DAILY_CLICK:2026-03-15 closed (month + total still open)
    const rows = await store.load(OFFER);
    expect(rows.find((x) => x.cap_type === "DAILY_CLICK" && x.period_key === "2026-03-15")!.current_value).toBe(1);
    // In-memory: the new day starts at 0, total keeps 1.
    const st = await core.status(OFFER, ORG, clickCap(10), "CLICK", nextDay);
    expect(st.counters.find((c) => c.cap_type === "DAILY_CLICK")!.current_value).toBe(0);
    expect(st.counters.find((c) => c.cap_type === "TOTAL_CLICK")!.current_value).toBe(1);
  });

  it("a brand-new object with empty storage rebuilds from the D1 snapshot (exhausted stays exhausted)", async () => {
    const store = new CapStore(db);
    await store.flush(
      {
        v: 1,
        offer_id: OFFER,
        organization_id: ORG,
        counters: [{ cap_type: "DAILY_CLICK", period_key: "2026-03-15", limit_value: 3, current_value: 3, currency: null, exhausted_at: T0.toISOString() }],
      },
      T0.toISOString(),
    );
    const core = new CapObjectCore(new MemoryCapStorage(), { store, now: () => T0 });
    const d = await core.reserve(OFFER, ORG, clickCap(3), CLICK);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.cap_type).toBe("DAILY_CLICK");
  });
});
