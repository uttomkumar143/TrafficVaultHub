/**
 * Financial adjustments — Phase 5 Unit 5 tests (PRD §59, §114, §131).
 * Definition-of-Done test (by name):
 *   - "manual adjustment is audited and cannot post without approval"
 * Runs over the real migrations 0001–0010 via the SQLite-backed TestD1 shim.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AuditRepository } from "../audit/repository";
import { AdjustmentRepository, AdjustmentService, type AdjustmentRow } from "./adjustments";
import { LedgerRepository } from "./repository";

const ADV = "org-adv-1";
const PLAT = "org-plat-1";
const REQUESTER = "user-req";
const APPROVER = "user-app";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${REQUESTER}', 'req@example.com');
    INSERT INTO users (id, email) VALUES ('${APPROVER}', 'app@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${PLAT}', 'PLATFORM', 'Plat', 'plat');
  `);
}

function tenantFor(orgId: string, type: "ADVERTISER" | "PLATFORM", perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type, name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
function ctxFor(userId: string): AuthenticatedContext {
  return { user: { id: userId, email: `${userId}@example.com` }, session: {} } as unknown as AuthenticatedContext;
}
const reqCtx = ctxFor(REQUESTER);
const appCtx = ctxFor(APPROVER);
const ALL = ["ledger.read", "ledger.adjust", "ledger.approve"];
/** Tenant finance user: may request/post, never approve. */
const finance = tenantFor(ADV, "ADVERTISER", ["ledger.read", "ledger.adjust"]);
/** Platform staff acting inside the advertiser tenant with every ledger key. */
const platform = tenantFor(ADV, "PLATFORM", ALL);
/** Tenant user who somehow holds ledger.approve but is NOT platform. */
const tenantApprover = tenantFor(ADV, "ADVERTISER", ALL);
const reader = tenantFor(ADV, "ADVERTISER", ["ledger.read"]);

function count(db: TestD1, sql: string, ...params: unknown[]): number {
  return (db.sqlite.prepare(sql).get(...(params as never[])) as { n: number }).n;
}
function rows(db: TestD1, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
}

describe("AdjustmentService", () => {
  let db: TestD1;
  let ledger: LedgerRepository;
  let svc: AdjustmentService;
  let payable: string;
  let platformAdj: string;
  let eurAccount: string;

  const request = (overrides: Partial<Parameters<AdjustmentService["request"]>[2]> = {}, tenant = finance, ctx = reqCtx) =>
    svc.request(
      ctx,
      tenant,
      {
        account_id: payable,
        counter_account_id: platformAdj,
        direction: "CREDIT",
        amount_minor: 2500,
        currency: "USD",
        reason_code: "BONUS",
        reason_note: "Q1 performance bonus",
        reference_type: "TICKET",
        reference_id: "T-42",
        ...overrides,
      },
      META,
    );

  beforeEach(async () => {
    db = createTestD1();
    seed(db);
    ledger = new LedgerRepository(db);
    svc = new AdjustmentService(new AdjustmentRepository(db), ledger, new AuditRepository(db), { now: () => NOW });
    payable = (await ledger.createAccount({ organization_id: ADV, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency: "USD", name: "A/P" })).id;
    platformAdj = (await ledger.createAccount({ organization_id: ADV, code: "PLATFORM_ADJUSTMENT", account_type: "EXPENSE", currency: "USD", name: "Adj" })).id;
    eurAccount = (await ledger.createAccount({ organization_id: ADV, code: "CASH", account_type: "ASSET", currency: "EUR", name: "Cash EUR" })).id;
  });
  afterEach(() => db.close());

  it("manual adjustment is audited and cannot post without approval", async () => {
    // 1. Request: every §59 field is captured.
    const requested = await request();
    expect(requested.status).toBe("REQUESTED");
    expect(requested.reason_code).toBe("BONUS");
    expect(requested.reason_note).toBe("Q1 performance bonus");
    expect(requested.requested_by_user_id).toBe(REQUESTER); // actor
    expect(requested.reference_type).toBe("TICKET"); // reference
    expect(requested.reference_id).toBe("T-42");
    expect(requested.amount_minor).toBe(2500); // amount + currency
    expect(requested.currency).toBe("USD");
    expect(requested.created_at).toBe(NOW.toISOString()); // timestamp
    const before = JSON.parse(requested.before_state) as { account: { balance_minor: number; entry_count: number } };
    expect(before.account.balance_minor).toBe(0); // before_state
    expect(before.account.entry_count).toBe(0);
    expect(requested.after_state).toBeNull();
    expect(requested.approved_by_user_id).toBeNull();
    expect(requested.journal_id).toBeNull();
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.requested' AND target_id = ?", requested.id)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_adjustment_history WHERE adjustment_id = ? AND to_status = 'REQUESTED'", requested.id)).toBe(1);

    // 2. Posting WITHOUT approval is refused — nothing reaches the ledger.
    await expect(svc.post(reqCtx, finance, requested.id, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_NOT_APPROVED" });
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(0);
    expect(rows(db, "SELECT status FROM financial_adjustments WHERE id = ?", requested.id)[0]?.status).toBe("REQUESTED");

    // Forging approval by bypassing the service is also refused by the DB: APPROVED needs approver columns.
    expect(() => db.sqlite.prepare("UPDATE financial_adjustments SET status = 'APPROVED' WHERE id = ?").run(requested.id)).toThrow(/CHECK constraint failed/);
    expect(() => db.sqlite.prepare("UPDATE financial_adjustments SET status = 'POSTED' WHERE id = ?").run(requested.id)).toThrow(/CHECK constraint failed/);

    // 3. Approve: a DIFFERENT user, holding ledger.approve, in a PLATFORM org.
    const approved = await svc.approve(appCtx, platform, requested.id, "Verified against ticket T-42", META);
    expect(approved.status).toBe("APPROVED");
    expect(approved.approved_by_user_id).toBe(APPROVER);
    expect(approved.approved_at).toBe(NOW.toISOString());
    expect(approved.approval_note).toBe("Verified against ticket T-42");
    expect(approved.journal_id).toBeNull();
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0); // approval alone posts nothing
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.approved' AND target_id = ?", requested.id)).toBe(1);

    // 4. Post: balanced journal + status + history + audit in one batch.
    const posted = await svc.post(reqCtx, finance, requested.id, META);
    expect(posted.outcome).toBe("POSTED");
    if (posted.outcome !== "POSTED") throw new Error("unreachable");
    expect(posted.adjustment.status).toBe("POSTED");
    expect(posted.adjustment.journal_id).toBe(posted.journal.id);
    expect(posted.adjustment.posted_at).toBe(NOW.toISOString());
    expect(posted.journal.journal_type).toBe("ADJUSTMENT");
    expect(posted.journal.reference_type).toBe("FINANCIAL_ADJUSTMENT");
    expect(posted.journal.reference_id).toBe(requested.id);
    expect(posted.journal.idempotency_key).toBe(`ADJUSTMENT:${requested.id}`);
    expect(posted.journal.total_minor).toBe(2500);
    const legs = rows(db, "SELECT account_id, direction, amount_minor, currency FROM ledger_entries WHERE journal_id = ? ORDER BY entry_index", posted.journal.id);
    expect(legs).toEqual([
      { account_id: payable, direction: "CREDIT", amount_minor: 2500, currency: "USD" },
      { account_id: platformAdj, direction: "DEBIT", amount_minor: 2500, currency: "USD" },
    ]);
    const after = JSON.parse(posted.adjustment.after_state as string) as { projected: { account_balance_minor: number; counter_account_balance_minor: number } };
    expect(after.projected).toEqual({ account_balance_minor: 2500, counter_account_balance_minor: -2500 });
    expect((await ledger.computeBalance(ADV as never, payable)).balance_minor).toBe(2500);
    expect((await ledger.computeBalance(ADV as never, platformAdj)).balance_minor).toBe(-2500);

    // Audit trail: requested → approved → posted; history is complete and append-only.
    expect(rows(db, "SELECT action FROM audit_logs WHERE target_type = 'financial_adjustment' AND target_id = ? ORDER BY rowid", requested.id).map((r) => r.action)).toEqual([
      "ledger.adjustment.requested",
      "ledger.adjustment.approved",
      "ledger.adjustment.posted",
    ]);
    const history = await svc.history(reader, requested.id);
    expect(history.map((h) => [h.from_status, h.to_status, h.actor_user_id])).toEqual([
      [null, "REQUESTED", REQUESTER],
      ["REQUESTED", "APPROVED", APPROVER],
      ["APPROVED", "POSTED", REQUESTER],
    ]);
    expect(() => db.sqlite.prepare("UPDATE financial_adjustment_history SET to_status = 'REJECTED' WHERE adjustment_id = ?").run(requested.id)).toThrow(
      /FINANCIAL_ADJUSTMENT_HISTORY_APPEND_ONLY/,
    );
    expect(() => db.sqlite.prepare("DELETE FROM financial_adjustment_history WHERE adjustment_id = ?").run(requested.id)).toThrow(/FINANCIAL_ADJUSTMENT_HISTORY_APPEND_ONLY/);
    // The money of the request is frozen.
    expect(() => db.sqlite.prepare("UPDATE financial_adjustments SET amount_minor = 1 WHERE id = ?").run(requested.id)).toThrow(/FINANCIAL_ADJUSTMENT_IMMUTABLE/);
    expect(() => db.sqlite.prepare("DELETE FROM financial_adjustments WHERE id = ?").run(requested.id)).toThrow(/FINANCIAL_ADJUSTMENT_IMMUTABLE/);
  });

  it("self-approval is refused by the service and by the database", async () => {
    const requested = await request({}, platform, appCtx); // APPROVER requested it
    await expect(svc.approve(appCtx, platform, requested.id, null, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_SELF_APPROVAL" });
    expect(rows(db, "SELECT status, approved_by_user_id FROM financial_adjustments WHERE id = ?", requested.id)[0]).toEqual({ status: "REQUESTED", approved_by_user_id: null });
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.approved'")).toBe(0);
    // DB CHECK: approver ≠ requester even if the service is bypassed.
    expect(() =>
      db.sqlite
        .prepare("UPDATE financial_adjustments SET status = 'APPROVED', approved_by_user_id = ?, approved_at = ? WHERE id = ?")
        .run(APPROVER, NOW.toISOString(), requested.id),
    ).toThrow(/CHECK constraint failed/);
    // A different platform user can approve it.
    const approved = await svc.approve(reqCtx, platform, requested.id, null, META);
    expect(approved.status).toBe("APPROVED");
    expect(approved.approved_by_user_id).toBe(REQUESTER);
  });

  it("approval requires ledger.approve AND a PLATFORM org; request/post require ledger.adjust (403, nothing written)", async () => {
    const requested = await request();
    // All authority checks run synchronously, BEFORE any async work (same shape as LedgerService.require).
    const sync403 = (code: string) => expect.objectContaining({ status: 403, code });
    // Tenant user with ledger.approve but not platform → PLATFORM_ONLY.
    expect(() => svc.approve(appCtx, tenantApprover, requested.id, null, META)).toThrow(sync403("PLATFORM_ONLY"));
    expect(() => svc.reject(appCtx, tenantApprover, requested.id, null, META)).toThrow(sync403("PLATFORM_ONLY"));
    // Platform org without ledger.approve → FORBIDDEN.
    const platformNoApprove = tenantFor(ADV, "PLATFORM", ["ledger.read", "ledger.adjust"]);
    expect(() => svc.approve(appCtx, platformNoApprove, requested.id, null, META)).toThrow(sync403("FORBIDDEN"));
    expect(() => svc.reject(appCtx, platformNoApprove, requested.id, null, META)).toThrow(sync403("FORBIDDEN"));
    expect(rows(db, "SELECT status FROM financial_adjustments WHERE id = ?", requested.id)[0]?.status).toBe("REQUESTED");

    // Reader cannot request, post or (without ledger.read) read.
    expect(() => request({}, reader)).toThrow(sync403("FORBIDDEN"));
    expect(() => svc.post(reqCtx, reader, requested.id, META)).toThrow(sync403("FORBIDDEN"));
    expect(() => svc.get(tenantFor(ADV, "ADVERTISER", []), requested.id)).toThrow(sync403("FORBIDDEN"));
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_adjustments")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(1); // only the request
  });

  it("REJECTED is final: cannot be approved, posted or re-rejected", async () => {
    const requested = await request();
    const rejected = await svc.reject(appCtx, platform, requested.id, "Not substantiated", META);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.approved_by_user_id).toBeNull();
    expect(rejected.approval_note).toBe("Not substantiated");
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.rejected' AND target_id = ?", requested.id)).toBe(1);

    await expect(svc.approve(appCtx, platform, requested.id, null, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_NOT_REQUESTED" });
    await expect(svc.reject(appCtx, platform, requested.id, null, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_NOT_REQUESTED" });
    await expect(svc.post(reqCtx, finance, requested.id, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_NOT_APPROVED" });
    // Terminal trigger at the DB level too.
    expect(() =>
      db.sqlite
        .prepare("UPDATE financial_adjustments SET status = 'APPROVED', approved_by_user_id = ?, approved_at = ? WHERE id = ?")
        .run(APPROVER, NOW.toISOString(), requested.id),
    ).toThrow(/FINANCIAL_ADJUSTMENT_FINAL/);
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect((await svc.history(reader, requested.id)).map((h) => h.to_status)).toEqual(["REQUESTED", "REJECTED"]);
  });

  it("posting twice is impossible (service guard, guarded UPDATE, terminal trigger, idempotency key)", async () => {
    const requested = await request();
    await svc.approve(appCtx, platform, requested.id, null, META);
    const first = await svc.post(reqCtx, finance, requested.id, META);
    expect(first.outcome).toBe("POSTED");

    // Service refuses.
    await expect(svc.post(reqCtx, finance, requested.id, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_ALREADY_POSTED" });
    await expect(svc.approve(appCtx, platform, requested.id, null, META)).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_NOT_REQUESTED" });
    // DB refuses any status change off POSTED.
    expect(() => db.sqlite.prepare("UPDATE financial_adjustments SET status = 'APPROVED' WHERE id = ?").run(requested.id)).toThrow(/FINANCIAL_ADJUSTMENT_FINAL/);
    // A second journal with the same idempotency key cannot exist.
    expect(() =>
      db.sqlite
        .prepare(
          `INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, idempotency_key, actor_type, posted_at)
           VALUES ('dup', ?, 'ADJUSTMENT', 'USD', 2500, 'FINANCIAL_ADJUSTMENT', ?, ?, 'TENANT', ?)`,
        )
        .run(ADV, requested.id, `ADJUSTMENT:${requested.id}`, NOW.toISOString()),
    ).toThrow(/UNIQUE constraint failed: journal_entries\.idempotency_key/);

    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.posted'")).toBe(1);
    expect((await ledger.computeBalance(ADV as never, payable)).balance_minor).toBe(2500);
  });

  it("fail-safe: an unverifiable adjustment records a processing error and posts nothing (§131)", async () => {
    // Currency mismatch is refused at request time (400) — never reaches the ledger.
    await expect(request({ counter_account_id: eurAccount })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_CURRENCY_MISMATCH" });
    await expect(request({ currency: "EUR" })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_CURRENCY_MISMATCH" });
    await expect(request({ counter_account_id: payable })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_SAME_ACCOUNT" });
    await expect(request({ amount_minor: 0 })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_INVALID_MONEY" });
    await expect(request({ amount_minor: 12.5 })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_INVALID_MONEY" });
    await expect(request({ reason_note: "   " })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_REASON_NOTE_REQUIRED" });
    await expect(request({ reference_type: "TICKET", reference_id: null })).rejects.toMatchObject({ status: 400, code: "ADJUSTMENT_REFERENCE_INCOMPLETE" });
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_adjustments")).toBe(0);

    // An approved adjustment whose counter account was CLOSED in the meantime cannot build a verified journal.
    const requested = await request();
    await svc.approve(appCtx, platform, requested.id, null, META);
    await ledger.closeAccount(ADV as never, platformAdj, NOW.toISOString());

    const result = await svc.post(reqCtx, finance, requested.id, META);
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome !== "REJECTED") throw new Error("unreachable");
    expect(result.reason_code).toBe("JOURNAL_ACCOUNT_CLOSED");
    expect(result.processing_error.operation).toBe("POST_ADJUSTMENT");
    expect(result.processing_error.reference_type).toBe("FINANCIAL_ADJUSTMENT");
    expect(result.processing_error.reference_id).toBe(requested.id);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors WHERE reference_id = ?", requested.id)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.post_rejected' AND target_id = ?", requested.id)).toBe(1);
    // Nothing posted; the adjustment is still APPROVED (for investigation), no journal_id.
    expect(count(db, "SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ledger_entries")).toBe(0);
    const row = rows(db, "SELECT status, journal_id, after_state FROM financial_adjustments WHERE id = ?", requested.id)[0] as Pick<AdjustmentRow, "status" | "journal_id" | "after_state">;
    expect(row).toEqual({ status: "APPROVED", journal_id: null, after_state: null });
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_adjustment_history WHERE adjustment_id = ? AND to_status = 'POSTED'", requested.id)).toBe(0);
  });

  it("tenant isolation: another org cannot see or act on the adjustment", async () => {
    const requested = await request();
    db.sqlite.exec(`INSERT INTO organizations (id, type, name, slug) VALUES ('org-other', 'ADVERTISER', 'Other', 'other')`);
    const other = tenantFor("org-other", "PLATFORM", ALL);
    expect(await svc.get(other, requested.id)).toBeNull();
    await expect(svc.approve(appCtx, other, requested.id, null, META)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(svc.post(reqCtx, tenantFor("org-other", "ADVERTISER", ALL), requested.id, META)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(rows(db, "SELECT status FROM financial_adjustments WHERE id = ?", requested.id)[0]?.status).toBe("REQUESTED");
  });
});
