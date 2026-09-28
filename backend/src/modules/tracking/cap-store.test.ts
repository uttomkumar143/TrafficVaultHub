/**
 * Phase 3 Unit 4 — cap snapshot persistence against the REAL 0008 schema
 * (node:sqlite shim running the migration files).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { CAP_SNAPSHOT_VERSION, CapStore, parseCapSnapshot, type CapSnapshot } from "./cap-store";
import type { CapCounter } from "./caps";

const ORG = "org-adv-1";
const OFFER = "offer-1";

function seedOfferGraph(db: TestD1): void {
  // Minimal parents for the FKs on offer_cap_counters (organizations, offers).
  db.sqlite.exec(`
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ORG}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ORG}', 'ACTIVE', 'Adv Co');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ORG}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
  `);
}

const counter = (over: Partial<CapCounter> = {}): CapCounter => ({
  cap_type: "DAILY_CONVERSION",
  period_key: "2026-03-15",
  limit_value: 10,
  current_value: 3,
  currency: null,
  exhausted_at: null,
  ...over,
});

const snapshot = (counters: CapCounter[]): CapSnapshot => ({
  v: CAP_SNAPSHOT_VERSION,
  offer_id: OFFER,
  organization_id: ORG,
  counters,
});

describe("cap-store: parseCapSnapshot", () => {
  it("accepts a well-formed snapshot and rejects garbage", () => {
    const ok = snapshot([counter(), counter({ cap_type: "BUDGET", period_key: "TOTAL", currency: "USD", limit_value: 50000 })]);
    expect(parseCapSnapshot(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    expect(parseCapSnapshot(null)).toBeNull();
    expect(parseCapSnapshot({ ...ok, v: 99 })).toBeNull();
    expect(parseCapSnapshot({ ...ok, counters: [{ cap_type: "NOPE", period_key: "x", limit_value: null, current_value: 0, currency: null, exhausted_at: null }] })).toBeNull();
    expect(parseCapSnapshot({ ...ok, counters: [counter({ current_value: -1 })] })).toBeNull();
    expect(parseCapSnapshot({ ...ok, counters: [counter({ current_value: 1.5 })] })).toBeNull();
    expect(parseCapSnapshot({ ...ok, counters: [counter({ currency: "US" })] })).toBeNull();
  });
});

describe("cap-store: CapStore over offer_cap_counters", () => {
  let db: TestD1;
  beforeEach(() => {
    db = createTestD1();
    seedOfferGraph(db);
  });
  afterEach(() => db.close());

  it("flushes and loads counters using the real columns", async () => {
    const store = new CapStore(db);
    await store.flush(
      snapshot([counter(), counter({ cap_type: "BUDGET", period_key: "TOTAL", currency: "USD", limit_value: 50000, current_value: 1999 })]),
      "2026-03-15T10:00:00.000Z",
    );
    const rows = await store.load(OFFER);
    expect(rows).toHaveLength(2);
    const budget = rows.find((r) => r.cap_type === "BUDGET")!;
    expect(budget.organization_id).toBe(ORG);
    expect(budget.currency).toBe("USD");
    expect(budget.limit_value).toBe(50000);
    expect(budget.current_value).toBe(1999);
    expect(budget.last_flushed_at).toBe("2026-03-15T10:00:00.000Z");
    expect(await store.load("other-offer")).toEqual([]);
  });

  it("upserts on (offer, cap_type, period): count never goes backwards, exhausted_at sticks", async () => {
    const store = new CapStore(db);
    await store.flush(snapshot([counter({ current_value: 7 })]), "2026-03-15T10:00:00.000Z");
    await store.flush(snapshot([counter({ current_value: 10, exhausted_at: "2026-03-15T10:05:00.000Z" })]), "2026-03-15T10:05:00.000Z");
    // A stale flush from an older in-memory state must not regress the row.
    await store.flush(snapshot([counter({ current_value: 8, exhausted_at: null })]), "2026-03-15T10:06:00.000Z");
    const rows = await store.load(OFFER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.current_value).toBe(10);
    expect(rows[0]!.exhausted_at).toBe("2026-03-15T10:05:00.000Z");
    expect(rows[0]!.last_flushed_at).toBe("2026-03-15T10:06:00.000Z");
    // Only one row: the UNIQUE key was honoured, not a fresh id per flush.
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM offer_cap_counters").get()).toEqual({ n: 1 });
  });

  it("a limit change is written through (mid-period cap refresh)", async () => {
    const store = new CapStore(db);
    await store.flush(snapshot([counter({ limit_value: 10 })]), "2026-03-15T10:00:00.000Z");
    await store.flush(snapshot([counter({ limit_value: 25 })]), "2026-03-15T11:00:00.000Z");
    expect((await store.load(OFFER))[0]!.limit_value).toBe(25);
  });

  it("empty snapshot is a no-op", async () => {
    const store = new CapStore(db);
    await store.flush(snapshot([]), "2026-03-15T10:00:00.000Z");
    expect(await store.load(OFFER)).toEqual([]);
  });
});
