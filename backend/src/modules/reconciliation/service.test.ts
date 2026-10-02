/**
 * ReconciliationService — Phase 4 Unit 9 tests (PRD §48, §115, §127).
 * Real migrations 0001–0009 over node:sqlite; every assertion reads the DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { diffConversions, foldLifecycleStatus, ReconciliationRepository, ReconciliationService, type Mismatch } from "./service";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const OFFER2 = "offer-2";
const VERSION = "ver-1";
const USER = "user-1";
const NOW = new Date("2026-04-01T09:00:00.000Z");
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };
const T_ADV = ADV as TenantId;
const T_ADV2 = ADV2 as TenantId;
const PERIOD = { period_start: "2026-03-01T00:00:00.000Z", period_end: "2026-04-01T00:00:00.000Z" };

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${USER}', 'adv@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap2', '${ADV2}', 'ACTIVE', 'Adv2 Co');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('fp1', '${AFF}', 'ACTIVE', 'Aff');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER2}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer 2');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('offer-x', '${ADV2}', 'ap2', 'LIVE', 'PUBLIC', 'Offer X');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
    UPDATE offers SET current_version_id = '${VERSION}' WHERE id = '${OFFER}';
  `);
}

interface ConvOpts {
  org?: string;
  offer?: string;
  amount?: number | null;
  currency?: string | null;
  occurred_at?: string;
}

function conversion(db: TestD1, id: string, ext: string, lifecycle: string, opts: ConvOpts = {}): void {
  const org = opts.org ?? ADV;
  const offer = opts.offer ?? OFFER;
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, affiliate_organization_id, external_conversion_id, conversion_event,
         status, lifecycle_status, sale_amount_minor, currency, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'signup', 'PENDING', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      org,
      offer,
      AFF,
      ext,
      lifecycle,
      opts.amount === undefined ? 10000 : opts.amount,
      opts.currency === undefined ? "USD" : opts.currency,
      opts.occurred_at ?? "2026-03-10T10:00:00.000Z",
      "2026-03-10T10:00:01.000Z",
    );
}

function tenantFor(orgId: string, type: "ADVERTISER" | "PLATFORM", perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type, name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
const ctx = { user: { id: USER, email: "adv@example.com" }, session: {} } as unknown as AuthenticatedContext;
const manager = tenantFor(ADV, "ADVERTISER", ["reconciliation.read", "reconciliation.manage"]);
const reader = tenantFor(ADV, "ADVERTISER", ["reconciliation.read"]);
const nobody = tenantFor(ADV, "ADVERTISER", ["conversions.read"]);
const manager2 = tenantFor(ADV2, "ADVERTISER", ["reconciliation.read", "reconciliation.manage"]);

function count(db: TestD1, sql: string, ...args: string[]): number {
  return (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}
function audits(db: TestD1, action: string): number {
  return count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?", action);
}
async function rejects(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}
const byType = (ms: readonly Mismatch[]) => ms.map((m) => `${m.mismatch_type}:${m.external_conversion_id}`).sort();

describe("diffConversions (pure)", () => {
  it("folds the 12-state lifecycle to APPROVED / REJECTED / PENDING", () => {
    for (const s of ["APPROVED", "LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"] as const) expect(foldLifecycleStatus(s)).toBe("APPROVED");
    for (const s of ["REJECTED", "REVERSED"] as const) expect(foldLifecycleStatus(s)).toBe("REJECTED");
    for (const s of ["RECEIVED", "VALIDATING", "PENDING", "FRAUD_REVIEW", "DISPUTED"] as const) expect(foldLifecycleStatus(s)).toBe("PENDING");
  });

  it("detects every mismatch type, matches identical pairs, and counts approved/rejected on the TVH side", () => {
    const tvh = [
      { id: "c-ok", external_conversion_id: "ok", lifecycle_status: "PAID" as const, sale_amount_minor: 1000, currency: "USD" },
      { id: "c-amt", external_conversion_id: "amt", lifecycle_status: "APPROVED" as const, sale_amount_minor: 1000, currency: "USD" },
      { id: "c-cur", external_conversion_id: "cur", lifecycle_status: "APPROVED" as const, sale_amount_minor: 1000, currency: "USD" },
      { id: "c-sta", external_conversion_id: "sta", lifecycle_status: "REVERSED" as const, sale_amount_minor: 1000, currency: "USD" },
      { id: "c-both", external_conversion_id: "both", lifecycle_status: "PENDING" as const, sale_amount_minor: null, currency: null },
      { id: "c-miss", external_conversion_id: "miss-adv", lifecycle_status: "REJECTED" as const, sale_amount_minor: 1000, currency: "USD" },
    ];
    const reported = [
      { external_conversion_id: "ok", status: "APPROVED" as const, amount_minor: 1000, currency: "USD" },
      { external_conversion_id: "amt", status: "APPROVED" as const, amount_minor: 1500, currency: "USD" },
      { external_conversion_id: "cur", status: "APPROVED" as const, amount_minor: 1500, currency: "EUR" }, // currency wins; amount not compared
      { external_conversion_id: "sta", status: "APPROVED" as const, amount_minor: 1000, currency: "USD" },
      { external_conversion_id: "both", status: "APPROVED" as const, amount_minor: 200, currency: null }, // null vs 200 = amount mismatch, PENDING vs APPROVED = status
      { external_conversion_id: "miss-tvh", status: "APPROVED" as const, amount_minor: 300, currency: "USD" },
    ];
    const d = diffConversions(reported, tvh);
    expect(byType(d.mismatches)).toEqual(
      [
        "AMOUNT_MISMATCH:amt",
        "CURRENCY_MISMATCH:cur",
        "STATUS_MISMATCH:sta",
        "AMOUNT_MISMATCH:both",
        "STATUS_MISMATCH:both",
        "MISSING_IN_TVH:miss-tvh",
        "MISSING_AT_ADVERTISER:miss-adv",
      ].sort(),
    );
    expect(d.mismatches.some((m) => m.mismatch_type === "AMOUNT_MISMATCH" && m.external_conversion_id === "cur")).toBe(false);
    expect(d.mismatches.map((m) => m.mismatch_type)).not.toContain("LEDGER_MISMATCH");
    const missTvh = d.mismatches.find((m) => m.mismatch_type === "MISSING_IN_TVH");
    expect(missTvh).toMatchObject({ conversion_id: null, reported_amount_minor: 300, tvh_amount_minor: null, reported_status: "APPROVED", tvh_status: null });
    const missAdv = d.mismatches.find((m) => m.mismatch_type === "MISSING_AT_ADVERTISER");
    expect(missAdv).toMatchObject({ conversion_id: "c-miss", reported_amount_minor: null, tvh_amount_minor: 1000, reported_status: null, tvh_status: "REJECTED" });
    expect(d).toMatchObject({ reported_count: 6, tvh_count: 6, approved_count: 3, rejected_count: 2 });
    expect(diffConversions([], []).mismatches).toEqual([]);
  });
});

describe("ReconciliationService", () => {
  let db: TestD1;
  let repo: ReconciliationRepository;
  let svc: ReconciliationService;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new ReconciliationRepository(db);
    svc = new ReconciliationService(repo, db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it("a run persists the run row, one case per mismatch and the audit row in one batch; ledger side flags PAID c-1 without commission (ledger_status MISMATCHED); permission and input are checked before any write", async () => {
    conversion(db, "c-1", "ext-1", "PAID"); // matches
    conversion(db, "c-2", "ext-2", "APPROVED", { amount: 1000 }); // amount mismatch
    conversion(db, "c-3", "ext-3", "APPROVED", { currency: "USD" }); // currency mismatch
    conversion(db, "c-4", "ext-4", "REVERSED"); // status mismatch (REJECTED vs reported APPROVED)
    conversion(db, "c-5", "ext-5", "PENDING"); // not reported → MISSING_AT_ADVERTISER
    conversion(db, "c-out", "ext-out", "APPROVED", { occurred_at: "2026-04-02T00:00:00.000Z" }); // outside period → ignored
    conversion(db, "c-x", "ext-x", "APPROVED", { org: ADV2, offer: "offer-x" }); // other tenant → invisible

    const reported = [
      { external_conversion_id: "ext-1", status: "APPROVED" as const, amount_minor: 10000, currency: "USD" },
      { external_conversion_id: "ext-2", status: "APPROVED" as const, amount_minor: 1234, currency: "USD" },
      { external_conversion_id: "ext-3", status: "APPROVED" as const, amount_minor: 10000, currency: "EUR" },
      { external_conversion_id: "ext-4", status: "APPROVED" as const, amount_minor: 10000, currency: "USD" },
      { external_conversion_id: "ext-6", status: "REJECTED" as const, amount_minor: 50 },
    ];

    // permission + validation before any write
    await rejects(svc.run(ctx, reader, { ...PERIOD, reported }, META), 403, "FORBIDDEN");
    await rejects(svc.run(ctx, nobody, { ...PERIOD, reported }, META), 403, "FORBIDDEN");
    await rejects(svc.run(ctx, manager, { period_start: PERIOD.period_end, period_end: PERIOD.period_start, reported }, META), 400, "INVALID_PERIOD");
    await rejects(svc.run(ctx, manager, { ...PERIOD, reported: [...reported, reported[0]!] }, META), 400, "DUPLICATE_REPORTED");
    await rejects(svc.run(ctx, manager, { ...PERIOD, reported: [{ external_conversion_id: "z", status: "APPROVED", amount_minor: 1.5 }] }, META), 400, "INVALID_REPORTED");
    await rejects(svc.run(ctx, manager, { ...PERIOD, reported: [{ external_conversion_id: "z", status: "APPROVED", currency: "usd" }] }, META), 400, "INVALID_REPORTED");
    await rejects(svc.run(ctx, manager, { ...PERIOD, reported: [{ external_conversion_id: "z", status: "MAYBE" as never }] }, META), 400, "INVALID_REPORTED");
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_runs")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(0);

    const { run, cases } = await svc.run(ctx, manager, { ...PERIOD, reported }, META);
    expect(run).toMatchObject({
      organization_id: ADV,
      trigger: "MANUAL",
      status: "COMPLETED",
      reported_count: 5,
      tvh_count: 5,
      approved_count: 3, // c-1 PAID, c-2, c-3
      rejected_count: 1, // c-4 REVERSED
      mismatch_count: 6,
      ledger_status: "MISMATCHED",
      started_by_user_id: USER,
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
    });
    expect(byType(cases as unknown as Mismatch[])).toEqual(
      ["AMOUNT_MISMATCH:ext-2", "CURRENCY_MISMATCH:ext-3", "STATUS_MISMATCH:ext-4", "MISSING_AT_ADVERTISER:ext-5", "MISSING_IN_TVH:ext-6", "LEDGER_MISMATCH:ext-1"].sort(),
    );
    expect(cases.every((c) => c.status === "OPEN" && c.run_id === run.id && c.organization_id === ADV)).toBe(true);
    expect(cases.find((c) => c.mismatch_type === "AMOUNT_MISMATCH")).toMatchObject({ conversion_id: "c-2", reported_amount_minor: 1234, tvh_amount_minor: 1000, reported_status: "APPROVED", tvh_status: "APPROVED" });
    expect(cases.find((c) => c.mismatch_type === "STATUS_MISMATCH")).toMatchObject({ conversion_id: "c-4", reported_status: "APPROVED", tvh_status: "REJECTED" });
    expect(cases.find((c) => c.mismatch_type === "MISSING_IN_TVH")).toMatchObject({ conversion_id: null, external_conversion_id: "ext-6", reported_status: "REJECTED", reported_amount_minor: 50 });
    expect(cases.some((c) => c.external_conversion_id === "ext-x" || c.external_conversion_id === "ext-out")).toBe(false);
    // ledger side: c-1 is PAID (ledger-bearing) but no commission row exists → one LEDGER_MISMATCH case
    expect(cases.filter((c) => c.mismatch_type === "LEDGER_MISMATCH")).toHaveLength(1);
    expect(cases.find((c) => c.mismatch_type === "LEDGER_MISMATCH")).toMatchObject({ conversion_id: "c-1", external_conversion_id: "ext-1", tvh_status: "COMMISSION_MISSING" });

    // DB truth
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases WHERE run_id = ?", run.id)).toBe(6);
    expect(db.sqlite.prepare("SELECT ledger_status FROM reconciliation_runs WHERE id = ?").get(run.id)).toEqual({ ledger_status: "MISMATCHED" });
    expect(audits(db, "reconciliation.run.completed")).toBe(1);
    const audit = db.sqlite.prepare("SELECT actor_user_id, organization_id, target_id, metadata, request_id FROM audit_logs WHERE action = 'reconciliation.run.completed'").get() as Record<string, string>;
    expect(audit).toMatchObject({ actor_user_id: USER, organization_id: ADV, target_id: run.id, request_id: "req-1" });
    expect(JSON.parse(audit.metadata!)).toMatchObject({
      trigger: "MANUAL",
      mismatch_count: 6,
      ledger_status: "MISMATCHED",
      ledger_mismatch_count: 1,
      ledger_mismatches_by_detail: { COMMISSION_MISSING: 1 },
      mismatches_by_type: { AMOUNT_MISMATCH: 1, CURRENCY_MISMATCH: 1, STATUS_MISMATCH: 1, MISSING_AT_ADVERTISER: 1, MISSING_IN_TVH: 1, LEDGER_MISMATCH: 1 },
    });

    // reads: getRun returns the same cases; reader may read, nobody may not
    const fetched = await svc.getRun(reader, run.id);
    expect(fetched.run.id).toBe(run.id);
    expect(fetched.cases.map((c) => c.id).sort()).toEqual(cases.map((c) => c.id).sort());
    expect((await svc.listRuns(reader, { limit: 10, cursor: null })).items.map((r) => r.id)).toEqual([run.id]);
    expect((await svc.listCases(reader, { limit: 10, cursor: null }, { run_id: run.id, mismatch_type: "MISSING_IN_TVH" })).items).toHaveLength(1);
    await rejects(svc.getRun(nobody, run.id), 403, "FORBIDDEN");
    await rejects(svc.listCases(nobody, { limit: 10, cursor: null }), 403, "FORBIDDEN");
  });

  it("the batch is atomic: a failing statement inside the run batch leaves no run, no cases and no audit", async () => {
    conversion(db, "c-1", "ext-1", "APPROVED");
    class Sabotaged extends ReconciliationRepository {
      override caseStatement(...args: Parameters<ReconciliationRepository["caseStatement"]>): D1PreparedStatement {
        // second case row violates the mismatch_type CHECK → whole batch rolls back
        const [tenantId, runId, caseId, m, now] = args;
        return super.caseStatement(tenantId, runId, caseId, m.external_conversion_id === "ext-9" ? { ...m, mismatch_type: "BOGUS" as never } : m, now);
      }
    }
    const sabotaged = new ReconciliationService(new Sabotaged(db), db, { now: () => NOW });
    await expect(
      sabotaged.run(
        ctx,
        manager,
        { ...PERIOD, reported: [{ external_conversion_id: "ext-1", status: "REJECTED" }, { external_conversion_id: "ext-9", status: "APPROVED" }] },
        META,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_runs")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(0);

    // the same input through the real repository succeeds (proves the sabotage, not the input, failed)
    const ok = await svc.run(ctx, manager, { ...PERIOD, reported: [{ external_conversion_id: "ext-1", status: "REJECTED" }, { external_conversion_id: "ext-9", status: "APPROVED" }] }, META);
    // ext-1: reported REJECTED / no amount vs TVH APPROVED / 10000 → AMOUNT + STATUS; ext-9 → MISSING_IN_TVH
    expect(ok.run.mismatch_count).toBe(3);
    expect(byType(ok.cases as unknown as Mismatch[])).toEqual(["AMOUNT_MISMATCH:ext-1", "MISSING_IN_TVH:ext-9", "STATUS_MISMATCH:ext-1"]);
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases")).toBe(3);
  });

  it("runScheduled needs no permission, records trigger SCHEDULED with NULL actor; cross-offer external-id collisions are refused unless offer-scoped", async () => {
    conversion(db, "c-1", "ext-1", "APPROVED");
    const res = await svc.runScheduled(T_ADV, { ...PERIOD, reported: [], request_id: "cron-1" });
    // c-1 is APPROVED (pre-posting): no commission expected → ledger side is clean
    expect(res.run).toMatchObject({ trigger: "SCHEDULED", started_by_user_id: null, tvh_count: 1, reported_count: 0, mismatch_count: 1, ledger_status: "MATCHED" });
    expect(res.cases[0]).toMatchObject({ mismatch_type: "MISSING_AT_ADVERTISER", conversion_id: "c-1" });
    const audit = db.sqlite.prepare("SELECT actor_user_id, organization_id, request_id FROM audit_logs WHERE action = 'reconciliation.run.completed'").get();
    expect(audit).toEqual({ actor_user_id: null, organization_id: ADV, request_id: "cron-1" });

    // same external id on two offers of the tenant → ambiguous unless offer_id given
    conversion(db, "c-dup", "ext-1", "REJECTED", { offer: OFFER2 });
    await rejects(svc.run(ctx, manager, { ...PERIOD, reported: [] }, META), 409, "AMBIGUOUS_EXTERNAL_IDS");
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_runs")).toBe(1);
    const scoped = await svc.run(ctx, manager, { ...PERIOD, offer_id: OFFER2, reported: [{ external_conversion_id: "ext-1", status: "REJECTED" }] }, META);
    expect(scoped.run).toMatchObject({ tvh_count: 1, rejected_count: 1 });
    expect(byType(scoped.cases as unknown as Mismatch[])).toEqual(["AMOUNT_MISMATCH:ext-1"]); // reported no amount vs TVH 10000
  });

  it("tenant isolation: runs and cases of one advertiser are invisible to another (404, no write) and TVH conversions never cross tenants", async () => {
    conversion(db, "c-1", "ext-1", "APPROVED");
    conversion(db, "c-x", "ext-1", "APPROVED", { org: ADV2, offer: "offer-x" }); // same external id, other tenant — must NOT be ambiguous
    const a = await svc.run(ctx, manager, { ...PERIOD, reported: [] }, META);
    const b = await svc.run(ctx, manager2, { ...PERIOD, reported: [] }, META);
    expect(a.run.tvh_count).toBe(1);
    expect(b.run.tvh_count).toBe(1);
    expect(a.cases[0]?.conversion_id).toBe("c-1");
    expect(b.cases[0]?.conversion_id).toBe("c-x");

    await rejects(svc.getRun(manager2, a.run.id), 404, "NOT_FOUND");
    await rejects(svc.getCase(manager2, a.cases[0]!.id), 404, "NOT_FOUND");
    await rejects(svc.resolveCase(ctx, manager2, a.cases[0]!.id, { status: "RESOLVED", reason_code: "X" }, META), 404, "NOT_FOUND");
    expect((await svc.listRuns(manager2, { limit: 10, cursor: null })).items.map((r) => r.id)).toEqual([b.run.id]);
    expect((await svc.listCases(manager2, { limit: 10, cursor: null })).items.map((c) => c.run_id)).toEqual([b.run.id]);
    expect(await repo.findCase(T_ADV2, a.cases[0]!.id)).toBeNull();
    expect(await repo.findRun(T_ADV, b.run.id)).toBeNull();
    expect(db.sqlite.prepare("SELECT status FROM reconciliation_cases WHERE id = ?").get(a.cases[0]!.id)).toEqual({ status: "OPEN" });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'reconciliation.case.%'")).toBe(0);
  });

  it("resolveCase: OPEN → RESOLVED | IGNORED with a reason code, audited; needs reconciliation.manage; already-decided or concurrently-decided case → 409 and nothing written", async () => {
    conversion(db, "c-1", "ext-1", "APPROVED");
    conversion(db, "c-2", "ext-2", "APPROVED");
    conversion(db, "c-3", "ext-3", "APPROVED");
    const { cases } = await svc.run(ctx, manager, { ...PERIOD, reported: [] }, META);
    const [k1, k2, k3] = cases.map((c) => c.id) as [string, string, string];

    await rejects(svc.resolveCase(ctx, reader, k1, { status: "RESOLVED", reason_code: "ADVERTISER_CONFIRMED" }, META), 403, "FORBIDDEN");
    await rejects(svc.resolveCase(ctx, manager, k1, { status: "OPEN" as never, reason_code: "X" }, META), 400, "INVALID_STATUS");
    await rejects(svc.resolveCase(ctx, manager, k1, { status: "RESOLVED", reason_code: "bad code" }, META), 400, "INVALID_REASON_CODE");
    await rejects(svc.resolveCase(ctx, manager, "nope", { status: "RESOLVED", reason_code: "X" }, META), 404, "NOT_FOUND");
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases WHERE status <> 'OPEN'")).toBe(0);

    const resolved = await svc.resolveCase(ctx, manager, k1, { status: "RESOLVED", reason_code: "ADVERTISER_CONFIRMED" }, META);
    expect(resolved).toMatchObject({ status: "RESOLVED", resolution_reason_code: "ADVERTISER_CONFIRMED", resolved_by_user_id: USER, resolved_at: NOW.toISOString() });
    const ignored = await svc.resolveCase(ctx, manager, k2, { status: "IGNORED", reason_code: "TEST_TRAFFIC" }, META);
    expect(ignored).toMatchObject({ status: "IGNORED", resolution_reason_code: "TEST_TRAFFIC" });
    expect(audits(db, "reconciliation.case.resolved")).toBe(1);
    expect(audits(db, "reconciliation.case.ignored")).toBe(1);

    // already decided → 409, no second audit, row unchanged
    await rejects(svc.resolveCase(ctx, manager, k1, { status: "IGNORED", reason_code: "AGAIN" }, META), 409, "CASE_STATE_CONFLICT");
    expect(db.sqlite.prepare("SELECT status, resolution_reason_code FROM reconciliation_cases WHERE id = ?").get(k1)).toEqual({ status: "RESOLVED", resolution_reason_code: "ADVERTISER_CONFIRMED" });
    expect(audits(db, "reconciliation.case.ignored")).toBe(1);

    // concurrent decision between the read and the batch → guarded UPDATE trips, batch rolls back, no audit
    class Racing extends ReconciliationRepository {
      override async findCase(...args: Parameters<ReconciliationRepository["findCase"]>) {
        const row = await super.findCase(...args);
        if (row && row.id === k3 && row.status === "OPEN") {
          db.sqlite.prepare("UPDATE reconciliation_cases SET status = 'IGNORED', resolution_reason_code = 'RACE' WHERE id = ?").run(k3);
        }
        return row;
      }
    }
    const racing = new ReconciliationService(new Racing(db), db, { now: () => NOW });
    await rejects(racing.resolveCase(ctx, manager, k3, { status: "RESOLVED", reason_code: "LATE" }, META), 409, "CASE_STATE_CONFLICT");
    expect(db.sqlite.prepare("SELECT status, resolution_reason_code, resolved_by_user_id FROM reconciliation_cases WHERE id = ?").get(k3)).toEqual({
      status: "IGNORED",
      resolution_reason_code: "RACE",
      resolved_by_user_id: null,
    });
    expect(audits(db, "reconciliation.case.resolved")).toBe(1);
    expect((await svc.listCases(reader, { limit: 10, cursor: null }, { status: "OPEN" })).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Unit 15 — ledger side (§114 #6)
// ---------------------------------------------------------------------------

/** Raw ledger fixtures over migrations 0010/0011 (no LedgerService: we test detection of tampered rows). */
function ledgerAccounts(db: TestD1, org: string): void {
  db.sqlite.exec(`
    INSERT INTO ledger_accounts (id, organization_id, code, account_type, currency, name)
      VALUES ('la-rec-${org}', '${org}', 'ADVERTISER_RECEIVABLE', 'ASSET', 'USD', 'Receivable');
    INSERT INTO ledger_accounts (id, organization_id, code, account_type, currency, name)
      VALUES ('la-pay-${org}', '${org}', 'AFFILIATE_PAYABLE', 'LIABILITY', 'USD', 'Payable');
  `);
}
function journal(db: TestD1, id: string, org: string, refType: "CONVERSION" | "PAYOUT", refId: string, total: number, currency = "USD", postedAt = "2026-03-10T10:00:02.000Z"): void {
  db.sqlite
    .prepare(
      `INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, idempotency_key, actor_type, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SYSTEM', ?)`,
    )
    .run(id, org, refType === "CONVERSION" ? "CONVERSION_COMMISSION" : "PAYOUT", currency, total, refType, refId, `idem-${id}`, postedAt);
}
/** `gross` is the advertiser payout = expected journal total; affiliate share 80%, platform margin the remainder. */
function commission(db: TestD1, id: string, conversionId: string, journalId: string, gross = 5000, currency = "USD", org = ADV): void {
  const affiliate = Math.floor(gross * 0.8);
  db.sqlite
    .prepare(
      `INSERT INTO commissions (id, organization_id, conversion_id, affiliate_organization_id, offer_id, offer_version_id, payout_type, currency,
         affiliate_commission_minor, advertiser_payout_minor, platform_margin_minor, journal_id)
       VALUES (?, ?, ?, ?, ?, ?, 'CPA', ?, ?, ?, ?, ?)`,
    )
    .run(id, org, conversionId, AFF, OFFER, VERSION, currency, affiliate, gross, gross - affiliate, journalId);
}
/** Posted conversion with a consistent commission + CONVERSION journal. */
function posted(db: TestD1, id: string, ext: string, lifecycle: string, amount = 5000): void {
  conversion(db, id, ext, lifecycle);
  journal(db, `j-${id}`, ADV, "CONVERSION", id, amount);
  commission(db, `cm-${id}`, id, `j-${id}`, amount);
}
function payoutMethod(db: TestD1, org: string): string {
  const id = `pm-${org}`;
  db.sqlite
    .prepare(
      `INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
       VALUES (?, ?, ?, 'PAYPAL', 'stub', ?, 'PayPal', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, org, org === AFF ? "fp1" : "fp2", `tok-${org}`);
  return id;
}
function paidPayout(db: TestD1, id: string, org: string, amount: number, journalId: string | null, paidAt = "2026-03-15T00:00:00.000Z"): void {
  db.sqlite
    .prepare(
      `INSERT INTO payouts (id, organization_id, payout_method_id, amount_minor, currency, status, idempotency_key, requested_actor_type,
         requested_by_user_id, approved_by_user_id, approved_at, paid_at, journal_id)
       VALUES (?, ?, ?, ?, 'USD', 'PAID', ?, 'TENANT', ?, ?, ?, ?, ?)`,
    )
    .run(id, org, `pm-${org}`, amount, `idem-${id}`, USER, "user-approver", paidAt, paidAt, journalId);
}
const affManager = tenantFor(AFF, "ADVERTISER", ["reconciliation.read", "reconciliation.manage"]);

describe("ReconciliationService — ledger side (§114 #6)", () => {
  let db: TestD1;
  let svc: ReconciliationService;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    ledgerAccounts(db, ADV);
    ledgerAccounts(db, AFF);
    db.sqlite.exec("INSERT INTO users (id, email) VALUES ('user-approver', 'fin@example.com')");
    svc = new ReconciliationService(new ReconciliationRepository(db), db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it("(a) clean ledger → MATCHED: posted conversions carry a matching CONVERSION journal, pre-posting ones carry none, PAID payout has its PAYOUT journal", async () => {
    posted(db, "c-1", "ext-1", "LEDGER_POSTED");
    posted(db, "c-2", "ext-2", "EARNED");
    posted(db, "c-3", "ext-3", "PAYOUT_ELIGIBLE", 125);
    posted(db, "c-4", "ext-4", "PAID");
    conversion(db, "c-5", "ext-5", "APPROVED"); // pre-posting
    conversion(db, "c-6", "ext-6", "REJECTED");
    conversion(db, "c-7", "ext-7", "REVERSED"); // reversed from APPROVED: never posted, no commission → not a mismatch
    const reported = [1, 2, 3, 4, 5].map((n) => ({ external_conversion_id: `ext-${n}`, status: "APPROVED" as const, amount_minor: 10000, currency: "USD" }));
    reported.push({ external_conversion_id: "ext-6", status: "REJECTED" as never, amount_minor: 10000, currency: "USD" }, { external_conversion_id: "ext-7", status: "REJECTED" as never, amount_minor: 10000, currency: "USD" });
    const { run, cases } = await svc.run(ctx, manager, { ...PERIOD, reported }, META);
    expect(run).toMatchObject({ status: "COMPLETED", mismatch_count: 0, ledger_status: "MATCHED", tvh_count: 7 });
    expect(cases).toEqual([]);
    expect(db.sqlite.prepare("SELECT ledger_status FROM reconciliation_runs WHERE id = ?").get(run.id)).toEqual({ ledger_status: "MATCHED" });
    const meta = JSON.parse((db.sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'reconciliation.run.completed'").get() as { metadata: string }).metadata);
    expect(meta).toMatchObject({ ledger_status: "MATCHED", ledger_mismatch_count: 0 });

    // affiliate tenant: PAID payout with its PAYOUT journal → MATCHED
    payoutMethod(db, AFF);
    journal(db, "j-p1", AFF, "PAYOUT", "p-1", 7000, "USD", "2026-03-15T00:00:00.000Z");
    paidPayout(db, "p-1", AFF, 7000, "j-p1");
    const aff = await svc.runScheduled(AFF as TenantId, { ...PERIOD, reported: [], request_id: "cron-aff" });
    expect(aff.run).toMatchObject({ organization_id: AFF, mismatch_count: 0, ledger_status: "MATCHED" });
  });

  it("(b) tampered/missing journals → MISMATCHED with one LEDGER_MISMATCH case per discrepancy, tenant-scoped, audited and resolvable", async () => {
    // JOURNAL_MISSING: commission points at a journal that references another conversion
    conversion(db, "c-1", "ext-1", "EARNED");
    conversion(db, "c-9", "ext-9", "APPROVED", { occurred_at: "2026-01-05T00:00:00.000Z" }); // out of period, anchors the stray journal
    journal(db, "j-stray", ADV, "CONVERSION", "c-9", 5000);
    commission(db, "cm-1", "c-1", "j-stray");
    // JOURNAL_AMOUNT_MISMATCH
    conversion(db, "c-2", "ext-2", "PAID");
    journal(db, "j-2", ADV, "CONVERSION", "c-2", 4999);
    commission(db, "cm-2", "c-2", "j-2", 5000);
    // JOURNAL_CURRENCY_MISMATCH
    conversion(db, "c-3", "ext-3", "LEDGER_POSTED");
    journal(db, "j-3", ADV, "CONVERSION", "c-3", 5000, "EUR");
    commission(db, "cm-3", "c-3", "j-3", 5000, "USD");
    // COMMISSION_MISSING ×2
    conversion(db, "c-4", "ext-4", "EARNED");
    conversion(db, "c-5", "ext-5", "PAYOUT_ELIGIBLE");
    // COMMISSION_WITHOUT_POSTING
    conversion(db, "c-6", "ext-6", "PENDING");
    journal(db, "j-6", ADV, "CONVERSION", "c-6", 5000);
    commission(db, "cm-6", "c-6", "j-6");
    // JOURNAL_WITHOUT_COMMISSION: orphan CONVERSION journal for an in-period conversion
    conversion(db, "c-7", "ext-7", "APPROVED");
    journal(db, "j-orphan", ADV, "CONVERSION", "c-7", 5000);
    // clean posted row
    posted(db, "c-8", "ext-8", "PAID");
    // other tenant's dirty rows must never leak
    ledgerAccounts(db, ADV2);
    conversion(db, "x-1", "ext-x1", "PAID", { org: ADV2, offer: "offer-x" });
    journal(db, "j-x", ADV2, "CONVERSION", "x-1", 1);

    const { run, cases } = await svc.run(ctx, manager, { ...PERIOD, reported: [] }, META);
    const ledger = cases.filter((c) => c.mismatch_type === "LEDGER_MISMATCH");
    expect(run.ledger_status).toBe("MISMATCHED");
    expect(run.mismatch_count).toBe(cases.length);
    expect(ledger.map((c) => `${c.tvh_status}:${c.external_conversion_id}`).sort()).toEqual(
      ["JOURNAL_MISSING:ext-1", "JOURNAL_AMOUNT_MISMATCH:ext-2", "JOURNAL_CURRENCY_MISMATCH:ext-3", "COMMISSION_MISSING:ext-4", "COMMISSION_MISSING:ext-5", "COMMISSION_WITHOUT_POSTING:ext-6", "JOURNAL_WITHOUT_COMMISSION:ext-7"].sort(),
    );
    expect(ledger.find((c) => c.external_conversion_id === "ext-2")).toMatchObject({ conversion_id: "c-2", reported_amount_minor: 4999, tvh_amount_minor: 5000, reported_status: null });
    expect(ledger.find((c) => c.external_conversion_id === "ext-1")).toMatchObject({ conversion_id: "c-1", reported_amount_minor: null, tvh_amount_minor: 5000 });
    expect(ledger.find((c) => c.external_conversion_id === "ext-7")).toMatchObject({ conversion_id: "c-7", reported_amount_minor: 5000, tvh_amount_minor: null });
    expect(ledger.some((c) => c.external_conversion_id === "ext-x1" || c.external_conversion_id === "ext-8")).toBe(false); // clean + foreign rows never produce ledger cases
    expect(cases.filter((c) => c.mismatch_type === "MISSING_AT_ADVERTISER")).toHaveLength(8); // reported [] → every in-period TVH conversion of ADV
    expect(cases.every((c) => c.organization_id === ADV && c.status === "OPEN")).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases WHERE mismatch_type = 'LEDGER_MISMATCH'")).toBe(7);

    const meta = JSON.parse((db.sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'reconciliation.run.completed'").get() as { metadata: string }).metadata);
    expect(meta).toMatchObject({
      ledger_status: "MISMATCHED",
      ledger_mismatch_count: 7,
      ledger_mismatches_by_detail: { JOURNAL_MISSING: 1, JOURNAL_AMOUNT_MISMATCH: 1, JOURNAL_CURRENCY_MISMATCH: 1, COMMISSION_MISSING: 2, COMMISSION_WITHOUT_POSTING: 1, JOURNAL_WITHOUT_COMMISSION: 1 },
    });
    expect(meta.mismatches_by_type.LEDGER_MISMATCH).toBe(7);

    // other tenant sees nothing of it; its own run is clean apart from its own dirty rows
    expect((await svc.listCases(manager2, { limit: 50, cursor: null })).items).toHaveLength(0);

    // a LEDGER_MISMATCH case is resolvable like any other
    const target = ledger.find((c) => c.external_conversion_id === "ext-2")!;
    const resolved = await svc.resolveCase(ctx, manager, target.id, { status: "RESOLVED", reason_code: "LEDGER_CORRECTED" }, META);
    expect(resolved).toMatchObject({ id: target.id, status: "RESOLVED" });
    expect(db.sqlite.prepare("SELECT status FROM reconciliation_cases WHERE id = ?").get(target.id)).toEqual({ status: "RESOLVED" });
    expect(audits(db, "reconciliation.case.resolved")).toBe(1);
  });

  it("(c) PAID payouts without / with a mismatching PAYOUT journal → PAYOUT_JOURNAL_MISSING / PAYOUT_JOURNAL_MISMATCH keyed payout:<id>; out-of-period and other tenants ignored", async () => {
    payoutMethod(db, AFF);
    paidPayout(db, "p-miss", AFF, 5000, null);
    journal(db, "j-pbad", AFF, "PAYOUT", "p-bad", 4999, "USD", "2026-03-16T00:00:00.000Z");
    paidPayout(db, "p-bad", AFF, 5000, "j-pbad");
    journal(db, "j-pok", AFF, "PAYOUT", "p-ok", 6000, "USD", "2026-03-17T00:00:00.000Z");
    paidPayout(db, "p-ok", AFF, 6000, "j-pok");
    paidPayout(db, "p-old", AFF, 5000, null, "2026-02-01T00:00:00.000Z"); // outside period
    // other affiliate tenant with a dirty PAID payout
    db.sqlite.exec(`
      INSERT INTO organizations (id, type, name, slug) VALUES ('org-aff-2', 'AFFILIATE', 'Aff2', 'aff2');
      INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('fp2', 'org-aff-2', 'ACTIVE', 'Aff2');
    `);
    payoutMethod(db, "org-aff-2");
    paidPayout(db, "p-other", "org-aff-2", 5000, null);

    const { run, cases } = await svc.run(ctx, affManager, { ...PERIOD, reported: [] }, META);
    expect(run).toMatchObject({ organization_id: AFF, mismatch_count: 2, ledger_status: "MISMATCHED" });
    expect(cases.map((c) => `${c.tvh_status}:${c.external_conversion_id}`).sort()).toEqual(["PAYOUT_JOURNAL_MISMATCH:payout:p-bad", "PAYOUT_JOURNAL_MISSING:payout:p-miss"]);
    expect(cases.every((c) => c.mismatch_type === "LEDGER_MISMATCH" && c.conversion_id === null && c.organization_id === AFF)).toBe(true);
    expect(cases.find((c) => c.external_conversion_id === "payout:p-bad")).toMatchObject({ reported_amount_minor: 4999, tvh_amount_minor: 5000 });
    expect(cases.find((c) => c.external_conversion_id === "payout:p-miss")).toMatchObject({ reported_amount_minor: null, tvh_amount_minor: 5000 });
    expect(db.sqlite.prepare("SELECT conversion_id, external_conversion_id FROM reconciliation_cases WHERE run_id = ? ORDER BY external_conversion_id").all(run.id)).toEqual([
      { conversion_id: null, external_conversion_id: "payout:p-bad" },
      { conversion_id: null, external_conversion_id: "payout:p-miss" },
    ]);
    const meta = JSON.parse((db.sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'reconciliation.run.completed'").get() as { metadata: string }).metadata);
    expect(meta.ledger_mismatches_by_detail).toEqual({ PAYOUT_JOURNAL_MISSING: 1, PAYOUT_JOURNAL_MISMATCH: 1 });
  });

  it("(d) the atomic batch is preserved: a case insert that violates the 0009 external id length CHECK leaves 0 runs, 0 cases, 0 audit rows", async () => {
    conversion(db, "c-1", "ext-1", "PAID"); // ledger case COMMISSION_MISSING would be written in the same batch
    const tooLong = "x".repeat(129);
    await expect(svc.run(ctx, manager, { ...PERIOD, reported: [{ external_conversion_id: tooLong, status: "APPROVED", amount_minor: 1, currency: "USD" }] }, META)).rejects.toBeDefined();
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_runs")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM reconciliation_cases")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(0);
  });
});
