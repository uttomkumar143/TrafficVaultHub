/**
 * ConversionRepository — Phase 4 Unit 5a tests (PRD §38, §40, §115).
 * Runs over migrations 0001–0009 via the SQLite-backed TestD1 shim.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { ConversionRepository } from "./repository";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const VERSION = "ver-1";
const USER = "user-1";
const NOW = "2026-03-15T12:00:00.000Z";
const T_ADV = ADV as TenantId;
const T_ADV2 = ADV2 as TenantId;

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${USER}', 'adv@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
  `);
}

function conversion(db: TestD1, id: string, status: string, createdAt: string, affiliate: string | null = AFF): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', 'PENDING', ?, 10000, 'USD', ?, ?)`,
    )
    .run(id, ADV, OFFER, VERSION, affiliate, `ext-${id}`, status, createdAt, createdAt);
}

function count(db: TestD1, sql: string): number {
  return (db.sqlite.prepare(sql).get() as { n: number }).n;
}

describe("ConversionRepository", () => {
  let db: TestD1;
  let repo: ConversionRepository;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new ConversionRepository(db);
  });
  afterEach(() => db.close());

  it("finds and lists conversions strictly within the tenant, with lifecycle filter and cursor", async () => {
    conversion(db, "c1", "PENDING", "2026-03-01T00:00:00.000Z");
    conversion(db, "c2", "APPROVED", "2026-03-02T00:00:00.000Z");
    conversion(db, "c3", "PENDING", "2026-03-03T00:00:00.000Z");

    expect((await repo.findById(T_ADV, "c1"))?.lifecycle_status).toBe("PENDING");
    expect(await repo.findById(T_ADV2, "c1")).toBeNull();

    const p1 = await repo.list(T_ADV, { limit: 2, cursor: null }, {});
    expect(p1.items.map((r) => r.id)).toEqual(["c3", "c2"]);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await repo.list(T_ADV, { limit: 2, cursor: { created_at: "2026-03-02T00:00:00.000Z", id: "c2" } }, {});
    expect(p2.items.map((r) => r.id)).toEqual(["c1"]);
    expect(p2.next_cursor).toBeNull();

    const pending = await repo.list(T_ADV, { limit: 10, cursor: null }, { lifecycle_status: "PENDING" });
    expect(pending.items.map((r) => r.id)).toEqual(["c3", "c1"]);
    expect((await repo.list(T_ADV2, { limit: 10, cursor: null }, {})).items).toEqual([]);
  });

  it("transition updates lifecycle_status, appends history and extra statements atomically", async () => {
    conversion(db, "c1", "PENDING", NOW);
    await repo.transition(
      T_ADV,
      {
        conversion_id: "c1",
        expected_from: "PENDING",
        to: "APPROVED",
        actor_type: "TENANT",
        actor_user_id: USER,
        reason_code: "MANUAL_APPROVAL",
        note: null,
        request_id: "r1",
        now: NOW,
      },
      [repo.commissionStatement(T_ADV, "c1", 4000, "USD")],
    );
    const row = await repo.findById(T_ADV, "c1");
    expect(row?.lifecycle_status).toBe("APPROVED");
    expect(row?.status).toBe("PENDING"); // legacy intake column untouched
    expect(row?.commission_amount_minor).toBe(4000);
    expect(row?.commission_currency).toBe("USD");
    const history = await repo.listHistory(T_ADV, "c1");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: "PENDING",
      to_status: "APPROVED",
      actor_type: "TENANT",
      actor_user_id: USER,
      reason_code: "MANUAL_APPROVAL",
    });

    // commission is written once: a second statement is a no-op
    await db.batch([repo.commissionStatement(T_ADV, "c1", 1, "EUR")]);
    const again = await repo.findById(T_ADV, "c1");
    expect(again?.commission_amount_minor).toBe(4000);
    expect(again?.commission_currency).toBe("USD");
    expect(() => repo.commissionStatement(T_ADV, "c1", 12.5, "USD")).toThrow(AppError);
  });

  it("stale expected_from → 409 and NOTHING is written (history, audit, reversal all rolled back)", async () => {
    conversion(db, "c1", "APPROVED", NOW);
    const before = count(db, "SELECT COUNT(*) AS n FROM conversion_status_history");
    await expect(
      repo.transition(
        T_ADV,
        {
          conversion_id: "c1",
          expected_from: "PENDING",
          to: "REJECTED",
          actor_type: "TENANT",
          actor_user_id: USER,
          reason_code: "X",
          note: null,
          request_id: null,
          now: NOW,
        },
        [
          repo.reversalStatement(
            T_ADV,
            {
              id: "rv1",
              conversion_id: "c1",
              reason_code: "REFUND",
              amount_minor: 4000,
              currency: "USD",
              reversed_by_user_id: USER,
              actor_type: "TENANT",
              note: null,
              request_id: null,
            },
            NOW,
          ),
        ],
      ),
    ).rejects.toMatchObject({ status: 409, code: "CONVERSION_STATE_CONFLICT" });
    expect((await repo.findById(T_ADV, "c1"))?.lifecycle_status).toBe("APPROVED");
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(before);
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_reversals")).toBe(0);

    // cross-tenant / unknown → 404, nothing written
    await expect(
      repo.transition(T_ADV2, {
        conversion_id: "c1",
        expected_from: "APPROVED",
        to: "REVERSED",
        actor_type: "TENANT",
        actor_user_id: USER,
        reason_code: "X",
        note: null,
        request_id: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(before);
  });

  it("reversal row is UNIQUE per conversion and the original row keeps its money fields", async () => {
    conversion(db, "c1", "APPROVED", NOW);
    const reversal = {
      id: "rv1",
      conversion_id: "c1",
      reason_code: "REFUND" as const,
      amount_minor: 4000,
      currency: "USD",
      reversed_by_user_id: USER,
      actor_type: "TENANT" as const,
      note: "refund",
      request_id: "r9",
    };
    await repo.transition(
      T_ADV,
      {
        conversion_id: "c1",
        expected_from: "APPROVED",
        to: "REVERSED",
        actor_type: "TENANT",
        actor_user_id: USER,
        reason_code: "REFUND",
        note: "refund",
        request_id: "r9",
        now: NOW,
      },
      [repo.reversalStatement(T_ADV, reversal, NOW)],
    );
    const row = await repo.findById(T_ADV, "c1");
    expect(row).toMatchObject({
      lifecycle_status: "REVERSED",
      sale_amount_minor: 10000,
      currency: "USD",
      external_conversion_id: "ext-c1",
    });
    expect(await repo.findReversal(T_ADV, "c1")).toMatchObject({ id: "rv1", amount_minor: 4000, currency: "USD", reason_code: "REFUND" });
    expect(await repo.findReversal(T_ADV2, "c1")).toBeNull();
    await expect(db.batch([repo.reversalStatement(T_ADV, { ...reversal, id: "rv2" }, NOW)])).rejects.toThrow(/UNIQUE/);
  });

  it("holds: per-conversion and per-affiliate scopes feed holdFacts; release is idempotent", async () => {
    conversion(db, "c1", "APPROVED", NOW);
    conversion(db, "c2", "APPROVED", NOW);
    conversion(db, "c3", "APPROVED", NOW, null);
    await repo.insertHold(
      T_ADV,
      {
        id: "h1",
        conversion_id: "c1",
        affiliate_organization_id: null,
        hold_type: "CONVERSION_HOLD",
        reason_code: "MANUAL_REVIEW",
        source_type: "MANUAL",
        source_id: null,
        created_by_user_id: USER,
      },
      NOW,
    );
    await repo.insertHold(
      T_ADV,
      {
        id: "h2",
        conversion_id: null,
        affiliate_organization_id: AFF,
        hold_type: "PAYOUT_HOLD",
        reason_code: "FRAUD_CASE",
        source_type: "FRAUD_CASE",
        source_id: "fc1",
        created_by_user_id: null,
      },
      NOW,
    );

    expect((await repo.listActiveHolds(T_ADV, { conversion_id: "c1", affiliate_organization_id: AFF })).map((h) => h.id)).toEqual([
      "h1",
      "h2",
    ]);
    expect((await repo.listActiveHolds(T_ADV, { conversion_id: "c2", affiliate_organization_id: AFF })).map((h) => h.id)).toEqual(["h2"]);
    expect(await repo.listActiveHolds(T_ADV, { conversion_id: "c3", affiliate_organization_id: null })).toEqual([]);
    expect(await repo.listActiveHolds(T_ADV2, { conversion_id: "c1", affiliate_organization_id: AFF })).toEqual([]);

    expect(await repo.holdFacts(T_ADV, { conversion_id: "c1", affiliate_organization_id: AFF })).toEqual({
      activeHoldTypes: ["CONVERSION_HOLD", "PAYOUT_HOLD"],
      fraudReviewOpen: false,
    });

    db.sqlite.exec(`INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code)
      VALUES ('fc1', '${ADV}', '${AFF}', 'OPEN', 'HIGH', 'VELOCITY')`);
    expect((await repo.holdFacts(T_ADV, { conversion_id: "c2", affiliate_organization_id: AFF })).fraudReviewOpen).toBe(true);
    expect((await repo.holdFacts(T_ADV, { conversion_id: "c3", affiliate_organization_id: null })).fraudReviewOpen).toBe(false);

    expect(await repo.releaseHold(T_ADV, "h2", USER, "CASE_DISMISSED", NOW)).toBe(true);
    expect(await repo.releaseHold(T_ADV, "h2", USER, "CASE_DISMISSED", NOW)).toBe(false);
    expect(await repo.releaseHold(T_ADV2, "h1", USER, "X", NOW)).toBe(false);
    expect(await repo.findHold(T_ADV, "h2")).toMatchObject({
      status: "RELEASED",
      released_by_user_id: USER,
      released_reason_code: "CASE_DISMISSED",
      released_at: NOW,
    });
    expect(await repo.holdFacts(T_ADV, { conversion_id: "c2", affiliate_organization_id: AFF })).toMatchObject({ activeHoldTypes: [] });
  });
});
