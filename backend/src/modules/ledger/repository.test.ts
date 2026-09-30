/**
 * LedgerRepository — Phase 5 Unit 3 tests (PRD §56–§58, §114, §131).
 * Runs over the real migrations 0001–0010 via the SQLite-backed TestD1 shim,
 * so the append-only triggers and UNIQUE keys under test are the production ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AuditRepository } from "../audit/repository";
import { buildCompensatingJournal, buildJournal, type JournalDraft } from "./journal";
import { LedgerRepository, type LedgerAccountRow } from "./repository";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const VERSION = "ver-1";
const USER = "user-1";
const NOW = "2026-03-15T12:00:00.000Z";
const T_ADV = ADV as TenantId;
const T_ADV2 = ADV2 as TenantId;
const HEADER = { actor_type: "INTERNAL" as const, posted_by_user_id: null, request_id: "req-1", posted_at: NOW };

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

function conversion(db: TestD1, id: string, status = "APPROVED"): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, commission_amount_minor, commission_currency,
         occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', 'PENDING', ?, 10000, 'USD', 4000, 'USD', ?, ?)`,
    )
    .run(id, ADV, OFFER, VERSION, AFF, `ext-${id}`, status, NOW, NOW);
}

function count(db: TestD1, sql: string): number {
  return (db.sqlite.prepare(sql).get() as { n: number }).n;
}

interface Accounts {
  receivable: LedgerAccountRow;
  payable: LedgerAccountRow;
  revenue: LedgerAccountRow;
  map: Map<string, LedgerAccountRow>;
}

async function chart(repo: LedgerRepository, org = ADV): Promise<Accounts> {
  const receivable = await repo.createAccount({ organization_id: org, code: "ADVERTISER_RECEIVABLE", account_type: "ASSET", currency: "USD", name: "A/R" });
  const payable = await repo.createAccount({ organization_id: org, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency: "USD", name: "A/P" });
  const revenue = await repo.createAccount({ organization_id: org, code: "PLATFORM_REVENUE", account_type: "REVENUE", currency: "USD", name: "Rev" });
  const map = await repo.accountsOf(org as TenantId);
  return { receivable, payable, revenue, map };
}

function commissionDraft(a: Accounts, conversionId: string): JournalDraft {
  return buildJournal(
    {
      organization_id: ADV,
      journal_type: "CONVERSION_COMMISSION",
      currency: "USD",
      reference_type: "CONVERSION",
      reference_id: conversionId,
      idempotency_key: `CONVERSION_COMMISSION:${conversionId}`,
      legs: [
        { account_id: a.receivable.id, direction: "DEBIT", amount_minor: 5000 },
        { account_id: a.payable.id, direction: "CREDIT", amount_minor: 4000 },
        { account_id: a.revenue.id, direction: "CREDIT", amount_minor: 1000 },
      ],
    },
    a.map,
  );
}

const COMMISSION = (conversionId: string) => ({
  conversion_id: conversionId,
  organization_id: ADV,
  affiliate_organization_id: AFF,
  offer_id: OFFER,
  offer_version_id: VERSION,
  payout_type: "CPA" as const,
  currency: "USD",
  affiliate_commission_minor: 4000,
  advertiser_payout_minor: 5000,
  platform_margin_minor: 1000,
});

describe("LedgerRepository", () => {
  let db: TestD1;
  let repo: LedgerRepository;
  let audit: AuditRepository;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new LedgerRepository(db);
    audit = new AuditRepository(db);
  });
  afterEach(() => db.close());

  it("posts journal + legs + commission + audit in ONE batch and computes balances from ledger_entries", async () => {
    const a = await chart(repo);
    conversion(db, "c1");
    const draft = commissionDraft(a, "c1");
    const journalId = "j-1";

    const posted = await repo.postJournal(draft, { ...HEADER, id: journalId }, [
      repo.commissionStatement(COMMISSION("c1"), journalId),
      audit.statement({
        organization_id: ADV,
        actor_user_id: null,
        action: "ledger.commission.posted",
        target_type: "journal_entry",
        target_id: journalId,
        meta: { ip_address: null, user_agent: null, request_id: "req-1" },
      }),
    ]);
    expect(posted.journal_id).toBe(journalId);
    expect(posted.entry_ids).toHaveLength(3);

    const journal = await repo.findJournal(T_ADV, journalId);
    expect(journal).toMatchObject({ journal_type: "CONVERSION_COMMISSION", total_minor: 5000, currency: "USD", idempotency_key: "CONVERSION_COMMISSION:c1", actor_type: "INTERNAL" });
    expect(await repo.findJournal(T_ADV2, journalId)).toBeNull(); // tenant scoped

    const legs = await repo.listEntries(T_ADV, journalId);
    expect(legs.map((l) => [l.entry_index, l.direction, l.amount_minor])).toEqual([
      [0, "DEBIT", 5000],
      [1, "CREDIT", 4000],
      [2, "CREDIT", 1000],
    ]);
    expect(await repo.findCommissionByConversion(T_ADV, "c1")).toMatchObject({ journal_id: journalId, affiliate_commission_minor: 4000, platform_margin_minor: 1000 });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.commission.posted'")).toBe(1);
    expect(await repo.postingFacts(T_ADV, "c1")).toEqual({ already_posted: true, reversed: false });
    expect(await repo.postingFacts(T_ADV, "c-none")).toEqual({ already_posted: false, reversed: false });

    // balances are Σ ledger_entries (credit − debit)
    expect(await repo.computeBalance(T_ADV, a.receivable.id)).toMatchObject({ debit_total_minor: 5000, credit_total_minor: 0, balance_minor: -5000, entry_count: 1 });
    expect(await repo.computeBalance(T_ADV, a.payable.id)).toMatchObject({ debit_total_minor: 0, credit_total_minor: 4000, balance_minor: 4000, entry_count: 1 });
    expect(await repo.computeBalance(T_ADV, a.revenue.id)).toMatchObject({ balance_minor: 1000 });
    await expect(repo.computeBalance(T_ADV2, a.payable.id)).rejects.toMatchObject({ status: 404 });

    // snapshot = cache: appended, never consulted; a later posting changes computeBalance but not the old snapshot
    const snap = await repo.snapshotBalance(T_ADV, a.payable.id, NOW);
    expect(snap).toMatchObject({ balance_minor: 4000, entry_count: 1, last_entry_id: posted.entry_ids[1] });
    conversion(db, "c2");
    await repo.postJournal(commissionDraft(a, "c2"), HEADER);
    expect((await repo.computeBalance(T_ADV, a.payable.id)).balance_minor).toBe(8000);
    expect((await repo.latestSnapshot(T_ADV, a.payable.id))?.balance_minor).toBe(4000);
    expect(count(db, "SELECT COUNT(*) AS n FROM balance_snapshots")).toBe(1);
  });

  it("duplicate idempotency key cannot post twice — the whole retry batch (legs, commission, audit) is rolled back", async () => {
    const a = await chart(repo);
    conversion(db, "c1");
    const draft = commissionDraft(a, "c1");
    await repo.postJournal(draft, { ...HEADER, id: "j-1" }, [repo.commissionStatement(COMMISSION("c1"), "j-1")]);

    const before = {
      journals: count(db, "SELECT COUNT(*) AS n FROM journal_entries"),
      legs: count(db, "SELECT COUNT(*) AS n FROM ledger_entries"),
      commissions: count(db, "SELECT COUNT(*) AS n FROM commissions"),
      audits: count(db, "SELECT COUNT(*) AS n FROM audit_logs"),
    };
    expect(before).toEqual({ journals: 1, legs: 3, commissions: 1, audits: 0 });

    // Retry with a fresh journal id + fresh commission id, same idempotency key: refused at the DB.
    await expect(
      repo.postJournal(draft, { ...HEADER, id: "j-retry" }, [
        repo.commissionStatement({ ...COMMISSION("c1"), conversion_id: "c1" }, "j-retry", "com-retry"),
        audit.statement({ organization_id: ADV, actor_user_id: null, action: "ledger.retry", target_type: "journal_entry", target_id: "j-retry", meta: { ip_address: null, user_agent: null, request_id: null } }),
      ]),
    ).rejects.toMatchObject({ status: 409, code: "JOURNAL_DUPLICATE_IDEMPOTENCY_KEY" });

    // A different key but the same conversion is stopped by commissions.conversion_id UNIQUE — still nothing written.
    const otherKey = buildJournal({ ...draft, idempotency_key: "CONVERSION_COMMISSION:c1:again", legs: draft.legs }, a.map);
    await expect(
      repo.postJournal(otherKey, { ...HEADER, id: "j-other" }, [repo.commissionStatement(COMMISSION("c1"), "j-other")]),
    ).rejects.toMatchObject({ status: 409, code: "COMMISSION_ALREADY_POSTED" });

    expect({
      journals: count(db, "SELECT COUNT(*) AS n FROM journal_entries"),
      legs: count(db, "SELECT COUNT(*) AS n FROM ledger_entries"),
      commissions: count(db, "SELECT COUNT(*) AS n FROM commissions"),
      audits: count(db, "SELECT COUNT(*) AS n FROM audit_logs"),
    }).toEqual(before);
    expect(await repo.findJournal(T_ADV, "j-retry")).toBeNull();
    expect(await repo.findJournal(T_ADV, "j-other")).toBeNull();
    expect((await repo.findJournalByIdempotencyKey(T_ADV, "CONVERSION_COMMISSION:c1"))?.id).toBe("j-1");
    expect((await repo.computeBalance(T_ADV, a.payable.id)).balance_minor).toBe(4000);
  });

  it("UPDATE / DELETE on posted journal rows, legs, commissions, snapshots and processing errors fail (append-only triggers)", async () => {
    const a = await chart(repo);
    conversion(db, "c1");
    await repo.postJournal(commissionDraft(a, "c1"), { ...HEADER, id: "j-1" }, [repo.commissionStatement(COMMISSION("c1"), "j-1")]);
    await repo.snapshotBalance(T_ADV, a.payable.id, NOW);
    await repo.recordProcessingError({ organization_id: ADV, operation: "POST_CONVERSION_COMMISSION", reference_type: "CONVERSION", reference_id: "c9", reason_code: "POSTING_COMMISSION_MISMATCH" });

    const attempts: Array<[string, RegExp]> = [
      ["UPDATE journal_entries SET total_minor = 1 WHERE id = 'j-1'", /JOURNAL_ENTRIES_APPEND_ONLY/],
      ["UPDATE journal_entries SET description = 'x' WHERE id = 'j-1'", /JOURNAL_ENTRIES_APPEND_ONLY/],
      ["UPDATE journal_entries SET idempotency_key = 'CONVERSION_COMMISSION:other' WHERE id = 'j-1'", /JOURNAL_ENTRIES_APPEND_ONLY/],
      ["DELETE FROM journal_entries WHERE id = 'j-1'", /JOURNAL_ENTRIES_APPEND_ONLY/],
      ["UPDATE ledger_entries SET amount_minor = 1 WHERE journal_id = 'j-1'", /LEDGER_ENTRIES_APPEND_ONLY/],
      ["UPDATE ledger_entries SET direction = 'DEBIT' WHERE journal_id = 'j-1'", /LEDGER_ENTRIES_APPEND_ONLY/],
      ["DELETE FROM ledger_entries WHERE journal_id = 'j-1'", /LEDGER_ENTRIES_APPEND_ONLY/],
      ["UPDATE commissions SET affiliate_commission_minor = 1 WHERE conversion_id = 'c1'", /COMMISSIONS_APPEND_ONLY/],
      ["DELETE FROM commissions WHERE conversion_id = 'c1'", /COMMISSIONS_APPEND_ONLY/],
      ["UPDATE balance_snapshots SET balance_minor = 0, credit_total_minor = 0", /BALANCE_SNAPSHOTS_APPEND_ONLY/],
      ["DELETE FROM balance_snapshots", /BALANCE_SNAPSHOTS_APPEND_ONLY/],
      ["UPDATE financial_processing_errors SET reason_code = 'OK'", /FINANCIAL_PROCESSING_ERRORS_APPEND_ONLY/],
      ["DELETE FROM financial_processing_errors", /FINANCIAL_PROCESSING_ERRORS_APPEND_ONLY/],
      // the chart of accounts: identity is frozen, rows are never deleted
      ["UPDATE ledger_accounts SET currency = 'EUR' WHERE id = '" + a.payable.id + "'", /LEDGER_ACCOUNT_IMMUTABLE/],
      ["DELETE FROM ledger_accounts WHERE id = '" + a.payable.id + "'", /LEDGER_ACCOUNT_IMMUTABLE/],
    ];
    for (const [sql, code] of attempts) {
      expect(() => db.sqlite.exec(sql), sql).toThrow(code);
    }
    // the repository itself exposes no such method
    expect(Object.getOwnPropertyNames(LedgerRepository.prototype).filter((m) => /update|delete|remove|edit/i.test(m))).toEqual([]);

    expect(await repo.findJournal(T_ADV, "j-1")).toMatchObject({ total_minor: 5000 });
    expect((await repo.listEntries(T_ADV, "j-1")).map((l) => l.amount_minor)).toEqual([5000, 4000, 1000]);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM balance_snapshots")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors")).toBe(1);
  });

  it("refuses a tampered or unbalanced draft before the DB and rolls back a batch whose leg hits a closed account", async () => {
    const a = await chart(repo);
    conversion(db, "c1");
    const draft = commissionDraft(a, "c1");

    // tampered after validation (frozen draft → build a mutated copy)
    const tampered = { ...draft, total_minor: 4999 } as JournalDraft;
    await expect(repo.postJournal(tampered, HEADER)).rejects.toMatchObject({ reason_code: "JOURNAL_TOTAL_MISMATCH" });
    const unbalanced = { ...draft, legs: draft.legs.map((l, i) => (i === 0 ? { ...l, amount_minor: 4999 } : l)) } as JournalDraft;
    await expect(repo.postJournal(unbalanced, HEADER)).rejects.toMatchObject({ reason_code: "JOURNAL_UNBALANCED" });
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);

    // account closed between validation and posting → DB trigger aborts the whole batch
    expect(await repo.closeAccount(T_ADV, a.revenue.id, NOW)).toBe(true);
    expect(await repo.closeAccount(T_ADV, a.revenue.id, NOW)).toBe(false); // already closed
    await expect(repo.postJournal(draft, { ...HEADER, id: "j-1" }, [repo.commissionStatement(COMMISSION("c1"), "j-1")])).rejects.toMatchObject({
      status: 409,
      code: "LEDGER_ACCOUNT_NOT_OPEN",
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM commissions")).toBe(0);

    // a processing error needs a stable reason code
    expect(() =>
      repo.processingErrorStatement({ organization_id: ADV, operation: "POST_CONVERSION_COMMISSION", reference_type: "CONVERSION", reference_id: "c1", reason_code: "bad code" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_PROCESSING_REASON_CODE" }));
    await repo.recordProcessingError({ organization_id: ADV, operation: "POST_CONVERSION_COMMISSION", reference_type: "CONVERSION", reference_id: "c1", reason_code: "JOURNAL_ACCOUNT_CLOSED", detail: "revenue closed", request_id: "req-1" });
    const errors = await repo.listProcessingErrors(T_ADV, "CONVERSION", "c1");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ operation: "POST_CONVERSION_COMMISSION", reason_code: "JOURNAL_ACCOUNT_CLOSED", detail: "revenue closed", request_id: "req-1" });
    expect(await repo.listProcessingErrors(T_ADV2, "CONVERSION", "c1")).toEqual([]);
  });

  it("reads a posted journal back for reversal, posts the compensating journal once, and leaves the original untouched", async () => {
    const a = await chart(repo);
    conversion(db, "c1");
    await repo.postJournal(commissionDraft(a, "c1"), { ...HEADER, id: "j-1" }, [repo.commissionStatement(COMMISSION("c1"), "j-1")]);

    const original = await repo.getPostedJournal(T_ADV, "j-1");
    expect(original).toMatchObject({ id: "j-1", already_reversed: false, total_minor: 5000, reverses_journal_id: null });
    expect(original?.legs).toHaveLength(3);
    expect(await repo.getPostedJournal(T_ADV2, "j-1")).toBeNull();

    const reversal = buildCompensatingJournal(
      { original: original!, reference_type: "CONVERSION_REVERSAL", reference_id: "c1", idempotency_key: "CONVERSION_REVERSAL:c1" },
      a.map,
    );
    const originalRows = db.sqlite.prepare("SELECT * FROM journal_entries WHERE id = 'j-1'").all();
    const originalLegs = db.sqlite.prepare("SELECT * FROM ledger_entries WHERE journal_id = 'j-1' ORDER BY entry_index").all();

    await repo.postJournal(reversal, { ...HEADER, id: "j-rev" });
    expect(await repo.findReversalOf(T_ADV, "j-1")).toMatchObject({ id: "j-rev", journal_type: "CONVERSION_REVERSAL", reverses_journal_id: "j-1", total_minor: 5000 });
    expect((await repo.listEntries(T_ADV, "j-rev")).map((l) => [l.direction, l.amount_minor])).toEqual([
      ["CREDIT", 5000],
      ["DEBIT", 4000],
      ["DEBIT", 1000],
    ]);
    expect((await repo.getPostedJournal(T_ADV, "j-1"))?.already_reversed).toBe(true);
    expect(await repo.postingFacts(T_ADV, "c1")).toEqual({ already_posted: true, reversed: true });

    // original rows byte-for-byte unchanged; net balances back to zero
    expect(db.sqlite.prepare("SELECT * FROM journal_entries WHERE id = 'j-1'").all()).toEqual(originalRows);
    expect(db.sqlite.prepare("SELECT * FROM ledger_entries WHERE journal_id = 'j-1' ORDER BY entry_index").all()).toEqual(originalLegs);
    expect((await repo.computeBalance(T_ADV, a.payable.id)).balance_minor).toBe(0);
    expect((await repo.computeBalance(T_ADV, a.receivable.id)).balance_minor).toBe(0);

    // a second compensating journal (fresh key) is refused by the DB
    const again = { ...reversal, idempotency_key: "CONVERSION_REVERSAL:c1:again" } as JournalDraft;
    await expect(repo.postJournal(again, { ...HEADER, id: "j-rev2" })).rejects.toMatchObject({ status: 409, code: "JOURNAL_ALREADY_REVERSED" });
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(2);
  });
});
