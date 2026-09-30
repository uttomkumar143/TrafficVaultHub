/**
 * LedgerService — Phase 5 Unit 4 tests (PRD §56–§58, §114, §131).
 * Definition-of-Done tests (by name):
 *   - "duplicate conversion produces no duplicate commission"
 *   - "reversal posts compensating ledger entry"
 *   - "unverifiable amount is never posted and records a processing error"
 * Runs over the real migrations 0001–0010 via the SQLite-backed TestD1 shim.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AuditRepository } from "../audit/repository";
import { ConversionRepository } from "../conversions/repository";
import { ConversionService } from "../conversions/service";
import { LedgerRepository } from "./repository";
import { LedgerService } from "./service";

const ADV = "org-adv-1";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const VERSION = "ver-1";
const USER = "user-1";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };
const T_ADV = ADV as TenantId;

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${USER}', 'adv@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
  `);
}

/** APPROVED conversion whose stored commission matches the pinned version (4000 USD) unless overridden. */
function conversion(db: TestD1, id: string, commissionMinor = 4000, status = "APPROVED"): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, commission_amount_minor, commission_currency,
         occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', 'PENDING', ?, 10000, 'USD', ?, 'USD', ?, ?)`,
    )
    .run(id, ADV, OFFER, VERSION, AFF, `ext-${id}`, status, commissionMinor, NOW.toISOString(), NOW.toISOString());
}

async function chart(repo: LedgerRepository): Promise<void> {
  await repo.createAccount({ organization_id: ADV, code: "ADVERTISER_RECEIVABLE", account_type: "ASSET", currency: "USD", name: "A/R" });
  await repo.createAccount({ organization_id: ADV, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency: "USD", name: "A/P" });
  await repo.createAccount({ organization_id: ADV, code: "PLATFORM_REVENUE", account_type: "REVENUE", currency: "USD", name: "Rev" });
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
const finance = tenantFor(ADV, ["ledger.read", "ledger.adjust"]);
const reader = tenantFor(ADV, ["ledger.read"]);

function count(db: TestD1, sql: string, ...params: unknown[]): number {
  return (db.sqlite.prepare(sql).get(...(params as never[])) as { n: number }).n;
}
function rows(db: TestD1, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

describe("LedgerService", () => {
  let db: TestD1;
  let ledger: LedgerRepository;
  let svc: LedgerService;

  beforeEach(async () => {
    db = createTestD1();
    seed(db);
    ledger = new LedgerRepository(db);
    const conversions = new ConversionRepository(db);
    const conversionSvc = new ConversionService(conversions, db, { now: () => NOW });
    svc = new LedgerService({ ledger, conversions, conversionOps: conversionSvc.internal }, new AuditRepository(db), { now: () => NOW });
    await chart(ledger);
  });
  afterEach(() => db.close());

  it("duplicate conversion produces no duplicate commission", async () => {
    conversion(db, "c1");

    const first = await svc.postConversionCommission(ctx, finance, "c1", META);
    expect(first.outcome).toBe("POSTED");
    if (first.outcome !== "POSTED") throw new Error("unreachable");
    expect(first.commission.affiliate_commission_minor).toBe(4000);
    expect(first.commission.conversion_id).toBe("c1");
    expect(first.journal.idempotency_key).toBe("CONVERSION_COMMISSION:c1");
    // One batch: journal, 3 legs (5000 = 4000 + 1000 margin), commission, and the conversion moved on.
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(1);
    expect(rows(db, "SELECT lifecycle_status FROM conversions WHERE id = 'c1'")[0]?.lifecycle_status).toBe("LEDGER_POSTED");
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.posted'")).toBe(1);

    // Retry of the same conversion: verify rejects it BEFORE any write (already posted / no longer APPROVED).
    const second = await svc.postConversionCommission(ctx, finance, "c1", META);
    expect(second.outcome).toBe("REJECTED");
    if (second.outcome !== "REJECTED") throw new Error("unreachable");
    expect(["POSTING_ALREADY_POSTED", "POSTING_CONVERSION_NOT_APPROVED"]).toContain(second.reason_code);
    expect(second.processing_error.operation).toBe("POST_CONVERSION_COMMISSION");
    expect(second.processing_error.reference_id).toBe("c1");

    // Still exactly one of everything; the original rows are unchanged.
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions WHERE conversion_id = 'c1'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.posted'")).toBe(1);

    // Belt and braces: even a direct duplicate insert is stopped by the DB (UNIQUE commissions.conversion_id).
    expect(() =>
      db.sqlite
        .prepare(
          `INSERT INTO commissions (id, organization_id, conversion_id, affiliate_organization_id, offer_id, offer_version_id, payout_type, currency,
             affiliate_commission_minor, advertiser_payout_minor, platform_margin_minor, journal_id)
           VALUES ('dup', ?, 'c1', ?, ?, ?, 'CPA', 'USD', 4000, 5000, 1000, ?)`,
        )
        .run(ADV, AFF, OFFER, VERSION, first.journal.id),
    ).toThrow(/UNIQUE/);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(1);
  });

  it("reversal posts compensating ledger entry", async () => {
    conversion(db, "c1");
    const posted = await svc.postConversionCommission(ctx, finance, "c1", META);
    if (posted.outcome !== "POSTED") throw new Error("setup: commission not posted");
    const originalJournal = rows(db, "SELECT * FROM journal_entries WHERE id = ?", posted.journal.id);
    const originalLegs = rows(db, "SELECT * FROM ledger_entries WHERE journal_id = ? ORDER BY entry_index", posted.journal.id);
    const originalCommission = rows(db, "SELECT * FROM commissions WHERE conversion_id = 'c1'");

    const reversal = await svc.postReversal(ctx, finance, { conversion_id: "c1" }, META);
    expect(reversal.journal_type).toBe("CONVERSION_REVERSAL");
    expect(reversal.reverses_journal_id).toBe(posted.journal.id);
    expect(reversal.reference_type).toBe("CONVERSION_REVERSAL");
    expect(reversal.reference_id).toBe("c1");
    expect(reversal.total_minor).toBe(posted.journal.total_minor);
    expect(reversal.currency).toBe("USD");
    expect(reversal.idempotency_key).toBe("CONVERSION_REVERSAL:c1");

    // Mirrored legs: same accounts, same amounts, opposite direction, same order.
    const reversalLegs = rows(db, "SELECT * FROM ledger_entries WHERE journal_id = ? ORDER BY entry_index", reversal.id);
    expect(reversalLegs).toHaveLength(originalLegs.length);
    reversalLegs.forEach((leg, i) => {
      const orig = originalLegs[i]!;
      expect(leg.account_id).toBe(orig.account_id);
      expect(leg.amount_minor).toBe(orig.amount_minor);
      expect(leg.direction).toBe(orig.direction === "DEBIT" ? "CREDIT" : "DEBIT");
    });

    // Original rows are byte-identical; nothing was updated or deleted. Net balance per account is zero.
    expect(rows(db, "SELECT * FROM journal_entries WHERE id = ?", posted.journal.id)).toEqual(originalJournal);
    expect(rows(db, "SELECT * FROM ledger_entries WHERE journal_id = ? ORDER BY entry_index", posted.journal.id)).toEqual(originalLegs);
    expect(rows(db, "SELECT * FROM commissions WHERE conversion_id = 'c1'")).toEqual(originalCommission);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(2);
    for (const leg of originalLegs) {
      const bal = await ledger.computeBalance(T_ADV, leg.account_id as string);
      expect(bal.balance_minor).toBe(0);
      expect(bal.entry_count).toBe(2);
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.reversed'")).toBe(1);

    // A second reversal is refused (already reversed) and writes nothing more to the ledger.
    await expect(svc.postReversal(ctx, finance, { conversion_id: "c1" }, META)).rejects.toMatchObject({ code: "REVERSAL_ALREADY_REVERSED" });
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors WHERE operation = 'POST_CONVERSION_REVERSAL'")).toBe(1);
  });

  it("unverifiable amount is never posted and records a processing error", async () => {
    // Stored commission 4001 vs pinned version 4000 — the ±1 tamper must be refused.
    conversion(db, "c-bad", 4001);

    const result = await svc.postConversionCommission(ctx, finance, "c-bad", META);
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome !== "REJECTED") throw new Error("unreachable");
    expect(result.reason_code).toBe("POSTING_COMMISSION_MISMATCH");
    expect(result.processing_error.operation).toBe("POST_CONVERSION_COMMISSION");
    expect(result.processing_error.reference_type).toBe("CONVERSION");
    expect(result.processing_error.reference_id).toBe("c-bad");
    expect(result.processing_error.request_id).toBe("req-1");
    expect(result.processing_error.detail).toMatch(/4001/);

    // NOTHING posted: no journal, no legs, no commission, conversion still APPROVED.
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(0);
    expect(rows(db, "SELECT lifecycle_status FROM conversions WHERE id = 'c-bad'")[0]?.lifecycle_status).toBe("APPROVED");
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.rejected'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.posted'")).toBe(0);

    // Same for a missing commission amount: rejected, recorded, nothing posted.
    db.sqlite.exec(`UPDATE conversions SET commission_amount_minor = NULL WHERE id = 'c-bad'`);
    const missing = await svc.postConversionCommission(ctx, finance, "c-bad", META);
    expect(missing.outcome).toBe("REJECTED");
    if (missing.outcome !== "REJECTED") throw new Error("unreachable");
    expect(missing.reason_code).toBe("POSTING_COMMISSION_MISSING");
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors")).toBe(2);
    const errs = await ledger.listProcessingErrors(T_ADV, "CONVERSION", "c-bad");
    expect(errs.map((e) => e.reason_code)).toEqual(["POSTING_COMMISSION_MISMATCH", "POSTING_COMMISSION_MISSING"]);
  });

  it("requires ledger.adjust to post or reverse (403 FORBIDDEN, nothing written)", async () => {
    conversion(db, "c1");
    // The permission check runs synchronously before any async work (same shape as ConversionService.require).
    expect(() => svc.postConversionCommission(ctx, reader, "c1", META)).toThrow(expect.objectContaining({ status: 403, code: "FORBIDDEN" }));
    expect(() => svc.postReversal(ctx, reader, { conversion_id: "c1" }, META)).toThrow(expect.objectContaining({ status: 403, code: "FORBIDDEN" }));
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(0);
  });
});
