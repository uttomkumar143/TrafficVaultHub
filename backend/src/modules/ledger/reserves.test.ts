/**
 * Reserves — Phase 5 Unit 6 tests (PRD §60).
 * Runs over the real migrations 0001–0010 via the SQLite-backed TestD1 shim.
 *
 * Mixed-currency decision (tested below): an other-currency reserve is
 * IGNORED by computeAvailable (filtered by currency) — it is not refused,
 * because it legitimately reduces that other currency's available figure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AuditRepository } from "../audit/repository";
import { buildJournal } from "./journal";
import { LedgerRepository, type LedgerAccountRow } from "./repository";
import { ReserveRepository, ReserveService } from "./reserves";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const VERSION = "ver-1";
const USER = "user-1";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };
const T_ADV = ADV as TenantId;
const HEADER = { actor_type: "INTERNAL" as const, posted_by_user_id: null, request_id: "req-1", posted_at: NOW_ISO };

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

function conversion(db: TestD1, id: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, commission_amount_minor, commission_currency,
         occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', 'PENDING', 'APPROVED', 10000, 'USD', 4000, 'USD', ?, ?)`,
    )
    .run(id, ADV, OFFER, VERSION, AFF, `ext-${id}`, NOW_ISO, NOW_ISO);
}

function hold(db: TestD1, id: string, holdType: string, conversionId: string | null, status = "ACTIVE"): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type, released_at)
       VALUES (?, ?, ?, ?, ?, ?, 'REVIEW', 'MANUAL', ?)`,
    )
    .run(id, ADV, conversionId, AFF, holdType, status, status === "RELEASED" ? NOW_ISO : null);
}

interface Chart {
  receivable: LedgerAccountRow;
  payable: LedgerAccountRow;
  revenue: LedgerAccountRow;
}

async function chart(repo: LedgerRepository, org = ADV, currency = "USD"): Promise<Chart> {
  const receivable = await repo.createAccount({ organization_id: org, code: "ADVERTISER_RECEIVABLE", account_type: "ASSET", currency, name: "A/R" });
  const payable = await repo.createAccount({ organization_id: org, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency, name: "A/P" });
  const revenue = await repo.createAccount({ organization_id: org, code: "PLATFORM_REVENUE", account_type: "REVENUE", currency, name: "Rev" });
  return { receivable, payable, revenue };
}

/** Posts one CPA commission journal (payable +4000) and its commissions row for `conversionId`. */
async function postCommission(db: TestD1, repo: LedgerRepository, c: Chart, conversionId: string, org = ADV): Promise<void> {
  conversion(db, conversionId);
  const draft = buildJournal(
    {
      organization_id: org,
      journal_type: "CONVERSION_COMMISSION",
      currency: "USD",
      reference_type: "CONVERSION",
      reference_id: conversionId,
      idempotency_key: `CONVERSION_COMMISSION:${conversionId}`,
      legs: [
        { account_id: c.receivable.id, direction: "DEBIT", amount_minor: 5000 },
        { account_id: c.payable.id, direction: "CREDIT", amount_minor: 4000 },
        { account_id: c.revenue.id, direction: "CREDIT", amount_minor: 1000 },
      ],
    },
    await repo.accountsOf(org as TenantId),
  );
  const journalId = `j-${conversionId}`;
  await repo.postJournal(draft, { ...HEADER, id: journalId }, [
    repo.commissionStatement(
      {
        conversion_id: conversionId,
        organization_id: org,
        affiliate_organization_id: AFF,
        offer_id: OFFER,
        offer_version_id: VERSION,
        payout_type: "CPA",
        currency: "USD",
        affiliate_commission_minor: 4000,
        advertiser_payout_minor: 5000,
        platform_margin_minor: 1000,
      },
      journalId,
    ),
  ]);
}

function tenantFor(orgId: string, perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type: "ADVERTISER", name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
const ctx = { user: { id: USER, email: "adv@example.com" }, session: {} } as unknown as AuthenticatedContext;
const treasury = tenantFor(ADV, ["ledger.read", "ledger.reserve"]);
const reader = tenantFor(ADV, ["ledger.read"]);
const adjuster = tenantFor(ADV, ["ledger.read", "ledger.adjust", "ledger.approve"]);
const otherTenant = tenantFor(ADV2, ["ledger.read", "ledger.reserve"]);

function count(db: TestD1, sql: string, ...params: unknown[]): number {
  return (db.sqlite.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

describe("ReserveService", () => {
  let db: TestD1;
  let ledger: LedgerRepository;
  let svc: ReserveService;
  let c: Chart;

  const place = (overrides: Partial<Parameters<ReserveService["place"]>[2]> = {}, tenant = treasury) =>
    svc.place(ctx, tenant, { reserve_type: "RISK", currency: "USD", amount_minor: 1000, reason_code: "RISK_REVIEW", ...overrides }, META);

  beforeEach(async () => {
    db = createTestD1();
    seed(db);
    ledger = new LedgerRepository(db);
    svc = new ReserveService(new ReserveRepository(db), ledger, new AuditRepository(db), { now: () => NOW });
    c = await chart(ledger);
    await postCommission(db, ledger, c, "c1"); // payable balance 4000 USD
  });
  afterEach(() => db.close());

  it("reserve reduces available but NOT the ledger balance; journal_entries count unchanged", async () => {
    const journalsBefore = count(db, "SELECT COUNT(*) AS n FROM journal_entries");
    const legsBefore = count(db, "SELECT COUNT(*) AS n FROM ledger_entries");
    expect(journalsBefore).toBe(1);
    const before = await svc.available(reader, "USD");
    expect(before).toMatchObject({ balance_minor: 4000, held_commission_minor: 0, reserved_minor: 0, available_minor: 4000, payable_minor: 4000, shortfall_minor: 0 });

    const result = await place({ amount_minor: 1500, reference_type: "FRAUD_CASE", reference_id: "fc-1" });
    expect(result.reserve).toMatchObject({
      status: "ACTIVE",
      reserve_type: "RISK",
      amount_minor: 1500,
      currency: "USD",
      reason_code: "RISK_REVIEW",
      reference_type: "FRAUD_CASE",
      reference_id: "fc-1",
      actor_type: "TENANT",
      created_by_user_id: USER,
      request_id: "req-1",
      created_at: NOW_ISO,
      released_at: null,
    });
    expect(result.available_before.available_minor).toBe(4000);
    expect(result.available_after).toMatchObject({ balance_minor: 4000, reserved_minor: 1500, active_reserve_count: 1, available_minor: 2500, payable_minor: 2500, shortfall_minor: 0 });

    // Ledger untouched: balance from ledger_entries is identical, no journal/legs were written.
    expect((await ledger.computeBalance(T_ADV, c.payable.id)).balance_minor).toBe(4000);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(journalsBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(legsBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM balance_snapshots")).toBe(0);
    // Audit row in the same batch.
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.reserve.placed' AND target_id = ?", result.reserve.id)).toBe(1);
  });

  it("release restores available; a released reserve cannot be released or edited again", async () => {
    const { reserve } = await place({ amount_minor: 1500 });
    expect((await svc.available(reader, "USD")).available_minor).toBe(2500);

    const released = await svc.release(ctx, treasury, reserve.id, "cleared by review", META);
    expect(released).toMatchObject({ status: "RELEASED", released_at: NOW_ISO, released_by_user_id: USER, release_reason: "cleared by review", amount_minor: 1500 });
    expect((await svc.available(reader, "USD")).available_minor).toBe(4000);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.reserve.released' AND target_id = ?", reserve.id)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(1); // still no ledger writes

    // Second release refused by the service; nothing written.
    await expect(svc.release(ctx, treasury, reserve.id, null, META)).rejects.toMatchObject({ status: 409, code: "RESERVE_ALREADY_RELEASED" });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.reserve.released'")).toBe(1);

    // Bypassing the service: the DB refuses re-activation and any edit of money columns.
    expect(() => db.sqlite.prepare("UPDATE reserves SET status = 'ACTIVE', released_at = NULL WHERE id = ?").run(reserve.id)).toThrow(/RESERVE_ALREADY_RELEASED/);
    expect(() => db.sqlite.prepare("UPDATE reserves SET amount_minor = 1 WHERE id = ?").run(reserve.id)).toThrow(/RESERVE_IMMUTABLE/);
    expect(() => db.sqlite.prepare("UPDATE reserves SET currency = 'EUR' WHERE id = ?").run(reserve.id)).toThrow(/RESERVE_IMMUTABLE/);
    expect(() => db.sqlite.prepare("DELETE FROM reserves WHERE id = ?").run(reserve.id)).toThrow(/RESERVE_IMMUTABLE/);
    // An ACTIVE reserve has no edit path either — release is the only transition.
    const { reserve: active } = await place({ amount_minor: 10 });
    expect(() => db.sqlite.prepare("UPDATE reserves SET amount_minor = 20 WHERE id = ?").run(active.id)).toThrow(/RESERVE_IMMUTABLE/);
    expect(() => db.sqlite.prepare("UPDATE reserves SET reason_code = 'X' WHERE id = ?").run(active.id)).toThrow(/RESERVE_IMMUTABLE/);
  });

  it("active PAYOUT/CONVERSION holds reduce available; released and COMPLIANCE_BLOCK holds do not", async () => {
    await postCommission(db, ledger, c, "c2"); // payable 8000, two commissions of 4000
    await postCommission(db, ledger, c, "c3"); // payable 12000
    expect((await svc.available(reader, "USD")).available_minor).toBe(12000);

    hold(db, "h1", "CONVERSION_HOLD", "c1");
    expect(await svc.available(reader, "USD")).toMatchObject({ balance_minor: 12000, held_commission_minor: 4000, held_commission_count: 1, available_minor: 8000 });

    hold(db, "h2", "PAYOUT_HOLD", "c2");
    expect(await svc.available(reader, "USD")).toMatchObject({ held_commission_minor: 8000, held_commission_count: 2, available_minor: 4000 });

    // A second hold on the same conversion does not double count.
    hold(db, "h3", "PAYOUT_HOLD", "c1");
    expect((await svc.available(reader, "USD")).held_commission_minor).toBe(8000);

    // COMPLIANCE_BLOCK is a workflow block, not a money hold; a RELEASED hold no longer counts.
    hold(db, "h4", "COMPLIANCE_BLOCK", "c3");
    hold(db, "h5", "CONVERSION_HOLD", "c3", "RELEASED");
    expect((await svc.available(reader, "USD")).held_commission_minor).toBe(8000);

    // Holds and reserves stack.
    await place({ amount_minor: 1000, reserve_type: "AFFILIATE" });
    expect(await svc.available(reader, "USD")).toMatchObject({ held_commission_minor: 8000, reserved_minor: 1000, available_minor: 3000, payable_minor: 3000 });

    // Affiliate-level PAYOUT_HOLD (no conversion_id) covers every commission of that affiliate.
    db.sqlite.prepare("UPDATE conversion_holds SET status = 'RELEASED', released_at = ? WHERE id IN ('h1','h2','h3')").run(NOW_ISO);
    expect((await svc.available(reader, "USD")).held_commission_minor).toBe(0);
    hold(db, "h6", "PAYOUT_HOLD", null);
    expect(await svc.available(reader, "USD")).toMatchObject({ held_commission_minor: 12000, held_commission_count: 3, available_minor: -1000, payable_minor: 0, shortfall_minor: 1000 });
  });

  it("mixed currency: an other-currency reserve is accepted but IGNORED by the USD computation", async () => {
    await chart(ledger, ADV, "EUR"); // EUR chart with zero balance
    const eur = await place({ amount_minor: 700, currency: "EUR", reserve_type: "CHARGEBACK", reason_code: "CB_RISK" });
    expect(eur.reserve.currency).toBe("EUR");
    // USD available is untouched by the EUR reserve.
    expect(await svc.available(reader, "USD")).toMatchObject({ reserved_minor: 0, active_reserve_count: 0, available_minor: 4000 });
    // EUR available reflects only EUR: balance 0 − reserve 700.
    expect(await svc.available(reader, "EUR")).toMatchObject({ balance_minor: 0, reserved_minor: 700, active_reserve_count: 1, available_minor: -700, payable_minor: 0, shortfall_minor: 700 });

    await place({ amount_minor: 1000 });
    expect(await svc.available(reader, "USD")).toMatchObject({ reserved_minor: 1000, active_reserve_count: 1, available_minor: 3000 });
    expect((await svc.available(reader, "EUR")).reserved_minor).toBe(700);

    // A currency with no AFFILIATE_PAYABLE account: balance 0, account_id null, still computable.
    expect(await svc.available(reader, "GBP")).toMatchObject({ account_id: null, balance_minor: 0, available_minor: 0 });
    // Invalid currency is rejected before any lookup (available() validates synchronously after the permission check).
    await expect(place({ currency: "usd" })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_MONEY" });
    expect(() => svc.available(reader, "US")).toThrow(expect.objectContaining({ status: 400, code: "RESERVE_INVALID_MONEY" }));
  });

  it("reserve > balance: available goes negative, payable is 0 and the shortfall is reported", async () => {
    const result = await place({ amount_minor: 6500 });
    expect(result.reserve.status).toBe("ACTIVE");
    expect(result.available_after).toMatchObject({ balance_minor: 4000, reserved_minor: 6500, available_minor: -2500, payable_minor: 0, shortfall_minor: 2500 });
    // The ledger balance itself is unchanged and never negative because of the reserve.
    expect((await ledger.computeBalance(T_ADV, c.payable.id)).balance_minor).toBe(4000);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(3);

    // Earning more later shrinks the shortfall.
    await postCommission(db, ledger, c, "c2");
    expect(await svc.available(reader, "USD")).toMatchObject({ balance_minor: 8000, available_minor: 1500, payable_minor: 1500, shortfall_minor: 0 });

    // Audit metadata records the before/after figures.
    const audit = db.sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'ledger.reserve.placed' AND target_id = ?").get(result.reserve.id) as { metadata: string };
    expect(JSON.parse(audit.metadata)).toMatchObject({ amount_minor: 6500, available_before_minor: 4000, available_after_minor: -2500, require_coverage: false });
  });

  it("require_coverage refuses an over-reserve with 409 and writes nothing", async () => {
    await expect(place({ amount_minor: 4001, require_coverage: true })).rejects.toMatchObject({ status: 409, code: "RESERVE_EXCEEDS_AVAILABLE" });
    expect(count(db, "SELECT COUNT(*) AS n FROM reserves")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'ledger.reserve.%'")).toBe(0);

    // Exactly the available amount is covered.
    const full = await place({ amount_minor: 4000, require_coverage: true });
    expect(full.available_after.available_minor).toBe(0);
    // Coverage looks at AVAILABLE (after holds/reserves), not the raw balance.
    await expect(place({ amount_minor: 1, require_coverage: true })).rejects.toMatchObject({ status: 409, code: "RESERVE_EXCEEDS_AVAILABLE" });
    expect(count(db, "SELECT COUNT(*) AS n FROM reserves")).toBe(1);
    // Without the flag the same reserve is accepted (negative available).
    const over = await place({ amount_minor: 1 });
    expect(over.available_after.available_minor).toBe(-1);

    // Request-time validation (400) happens before any read.
    await expect(place({ reserve_type: "BOGUS" as never })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_TYPE" });
    await expect(place({ amount_minor: 0 })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_MONEY" });
    await expect(place({ amount_minor: 10.5 })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_MONEY" });
    await expect(place({ reason_code: "lower case" })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_REASON" });
    await expect(place({ reference_type: "PAYOUT" })).rejects.toMatchObject({ status: 400, code: "RESERVE_REFERENCE_INCOMPLETE" });
    await expect(place({ reference_type: "TICKET" as never, reference_id: "t" })).rejects.toMatchObject({ status: 400, code: "RESERVE_INVALID_REFERENCE_TYPE" });
    expect(count(db, "SELECT COUNT(*) AS n FROM reserves")).toBe(2);
  });

  it("403 FORBIDDEN without ledger.reserve (synchronously, nothing written); tenant isolation", async () => {
    // Permission check is SYNCHRONOUS: the 403 is thrown before any async work starts (no promise, no I/O).
    const sync403 = expect.objectContaining({ status: 403, code: "FORBIDDEN" });
    for (const tenant of [reader, adjuster]) {
      expect(() => place({}, tenant)).toThrow(sync403);
    }
    const { reserve } = await place({ amount_minor: 500 });
    expect(() => svc.release(ctx, reader, reserve.id, null, META)).toThrow(sync403);
    expect(() => svc.release(ctx, adjuster, reserve.id, null, META)).toThrow(sync403);
    expect(count(db, "SELECT COUNT(*) AS n FROM reserves")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'ledger.reserve.%'")).toBe(1);
    // ledger.read is required for reads.
    const noRead = tenantFor(ADV, ["ledger.reserve"]);
    expect(() => svc.available(noRead, "USD")).toThrow(sync403);
    expect(() => svc.get(noRead, reserve.id)).toThrow(sync403);

    // Tenant isolation: another org cannot see, release or be affected by ADV's reserve.
    expect(await svc.get(otherTenant, reserve.id)).toBeNull();
    expect(await svc.list(otherTenant)).toEqual([]);
    await expect(svc.release(ctx, otherTenant, reserve.id, null, META)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect((await svc.get(treasury, reserve.id))?.status).toBe("ACTIVE");
    expect((await svc.available(otherTenant, "USD")).reserved_minor).toBe(0);
    // ADV2 places its own reserve — ADV's figures do not move.
    await chart(ledger, ADV2);
    await place({ amount_minor: 300 }, otherTenant);
    expect(await svc.available(otherTenant, "USD")).toMatchObject({ balance_minor: 0, reserved_minor: 300, available_minor: -300 });
    expect(await svc.available(reader, "USD")).toMatchObject({ reserved_minor: 500, available_minor: 3500 });
    expect((await svc.list(treasury, { status: "ACTIVE" })).map((r) => r.id)).toEqual([reserve.id]);
  });
});
