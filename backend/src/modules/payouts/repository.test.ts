/**
 * PayoutRepository — Phase 5 Unit 11 tests (PRD §65, §66, §114, §132).
 * Runs over the real migrations 0001–0011 via the SQLite-backed TestD1 shim.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { isPayoutBlockedBy } from "../conversions/state-machine";
import { PayoutRepository, isStateConflict, wholeDaysBetween } from "./repository";

const AFF = "org-aff-1";
const AFF2 = "org-aff-2";
const ADV = "org-adv-1";
const REQ = "user-req";
const APPR = "user-appr";
const NOW = "2026-03-15T12:00:00.000Z";
const T_AFF = AFF as TenantId;
const T_AFF2 = AFF2 as TenantId;

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${REQ}', 'req@example.com'), ('${APPR}', 'appr@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF2}', 'AFFILIATE', 'Aff2', 'aff2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('afp1', '${AFF}', 'ACTIVE', 'Aff');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('afp2', '${AFF2}', 'ACTIVE', 'Aff2');
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
      VALUES ('pm1', '${AFF}', 'afp1', 'BANK_TRANSFER', 'stub', 'tok1', 'Bank', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z');
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status)
      VALUES ('pm1_eur', '${AFF}', 'afp1', 'WISE', 'stub', 'tok1e', 'Wise EUR', 'EUR', 'PENDING_VERIFICATION');
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
      VALUES ('pm2', '${AFF2}', 'afp2', 'PAYPAL', 'stub', 'tok2', 'PayPal', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('offer-1', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('ver-1', 'offer-1', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
  `);
}

function conversion(db: TestD1, id: string, lifecycle: string, affiliate: string | null, earnedAt: string | null): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, occurred_at)
       VALUES (?, ?, 'offer-1', 'ver-1', ?, ?, 'signup', 'PENDING', ?, 10000, 'USD', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, ADV, affiliate, `ext-${id}`, lifecycle);
  if (earnedAt) {
    db.sqlite
      .prepare(
        `INSERT INTO conversion_status_history (id, organization_id, conversion_id, from_status, to_status, actor_type, reason_code, created_at)
         VALUES (?, ?, ?, 'LEDGER_POSTED', 'EARNED', 'SYSTEM', 'LEDGER_POSTED', ?)`,
      )
      .run(`h-${id}`, ADV, id, earnedAt);
  }
}

function count(db: TestD1, sql: string): number {
  return (db.sqlite.prepare(sql).get() as { n: number }).n;
}

describe("PayoutRepository", () => {
  let db: TestD1;
  let repo: PayoutRepository;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new PayoutRepository(db);
  });
  afterEach(() => db.close());

  const basePayout = { id: "po1", payout_method_id: "pm1", amount_minor: 10_000, currency: "USD", idempotency_key: "idem-1", requested_by_user_id: REQ, requested_actor_type: "TENANT" as const };

  it("insert + history round-trip, idempotency-key lookup, tenant isolation", async () => {
    expect(
      await repo.batch([
        repo.insertStatement(T_AFF, { ...basePayout, fee_minor: 250, period_start: "2026-02-01", period_end: "2026-02-28", eligibility_snapshot: '{"ok":true}', request_id: "req-1" }, NOW),
        repo.historyStatement(T_AFF, { id: "psh1", payout_id: "po1", from_status: null, to_status: "REQUESTED", actor_type: "TENANT", actor_user_id: REQ, reason_code: "REQUESTED" }, NOW),
      ]),
    ).toBe(true);

    const row = await repo.findById(T_AFF, "po1");
    expect(row).toMatchObject({
      id: "po1",
      organization_id: AFF,
      payout_method_id: "pm1",
      amount_minor: 10_000,
      currency: "USD",
      fee_minor: 250,
      status: "REQUESTED",
      idempotency_key: "idem-1",
      provider: null,
      provider_reference: null,
      period_start: "2026-02-01",
      period_end: "2026-02-28",
      eligibility_snapshot: '{"ok":true}',
      requested_by_user_id: REQ,
      requested_actor_type: "TENANT",
      approved_at: null,
      journal_id: null,
      request_id: "req-1",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(Number.isInteger(row!.amount_minor)).toBe(true);
    expect((await repo.findByIdempotencyKey(T_AFF, "idem-1"))?.id).toBe("po1");
    expect(await repo.listByStatus(T_AFF, "REQUESTED")).toHaveLength(1);
    expect(await repo.listStatusHistory(T_AFF, "po1")).toMatchObject([{ id: "psh1", from_status: null, to_status: "REQUESTED", actor_type: "TENANT", reason_code: "REQUESTED", created_at: NOW }]);

    // Tenant isolation: another affiliate sees nothing.
    expect(await repo.findById(T_AFF2, "po1")).toBeNull();
    expect(await repo.findByIdempotencyKey(T_AFF2, "idem-1")).toBeNull();
    expect(await repo.listByStatus(T_AFF2, "REQUESTED")).toEqual([]);
    expect(await repo.listStatusHistory(T_AFF2, "po1")).toEqual([]);
    expect(await repo.findPayoutMethod(T_AFF2, "pm1")).toBeNull();
    // A stale-status update scoped to the wrong tenant touches nothing (WHERE organization_id = ?).
    expect(await repo.batch([repo.statusStatement(T_AFF2, "po1", "REQUESTED", "CANCELLED", NOW, { cancelled_at: NOW })])).toBe(true);
    expect((await repo.findById(T_AFF, "po1"))?.status).toBe("REQUESTED");
  });

  it("guarded status update: happy path advances; stale expected status rolls the WHOLE batch back", async () => {
    await repo.batch([repo.insertStatement(T_AFF, basePayout, NOW)]);
    const later = "2026-03-15T12:05:00.000Z";

    expect(
      await repo.batch([
        repo.statusStatement(T_AFF, "po1", "REQUESTED", "ELIGIBILITY_CHECK", later),
        repo.historyStatement(T_AFF, { id: "psh2", payout_id: "po1", from_status: "REQUESTED", to_status: "ELIGIBILITY_CHECK", actor_type: "SYSTEM" }, later),
      ]),
    ).toBe(true);
    expect(await repo.findById(T_AFF, "po1")).toMatchObject({ status: "ELIGIBILITY_CHECK", updated_at: later });

    // Stale: caller still believes REQUESTED → sentinel → rejected → history row NOT written either.
    const before = count(db, "SELECT COUNT(*) AS n FROM payout_status_history");
    expect(
      await repo.batch([
        repo.statusStatement(T_AFF, "po1", "REQUESTED", "CANCELLED", later, { cancelled_at: later, cancel_reason: "stale" }),
        repo.historyStatement(T_AFF, { id: "psh3", payout_id: "po1", from_status: "REQUESTED", to_status: "CANCELLED", actor_type: "TENANT" }, later),
      ]),
    ).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM payout_status_history")).toBe(before);
    expect(await repo.findById(T_AFF, "po1")).toMatchObject({ status: "ELIGIBILITY_CHECK", cancelled_at: null, cancel_reason: null });

    // Order-independent: history first, then the stale guard — still nothing persists.
    expect(
      await repo.batch([
        repo.historyStatement(T_AFF, { id: "psh4", payout_id: "po1", from_status: "REQUESTED", to_status: "CANCELLED", actor_type: "TENANT" }, later),
        repo.statusStatement(T_AFF, "po1", "REQUESTED", "CANCELLED", later, { cancelled_at: later }),
      ]),
    ).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM payout_status_history WHERE id = 'psh4'")).toBe(0);

    // Full legal path through the guarded builder, including §132 approver + extras.
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "ELIGIBILITY_CHECK", "UNDER_REVIEW", later)])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "UNDER_REVIEW", "APPROVED", later, { approved_by_user_id: APPR, approved_at: later, approval_note: "ok" })])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "APPROVED", "PROCESSING", later, { provider: "stub", provider_reference: "ref-1" })])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "PROCESSING", "FAILED", later, { failure_code: "BANK_REJECTED", failure_reason: "closed" })])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "FAILED", "PROCESSING", later)])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "PROCESSING", "PAID", later, { paid_at: later })])).toBe(true);
    expect(await repo.findById(T_AFF, "po1")).toMatchObject({ status: "PAID", approved_by_user_id: APPR, provider_reference: "ref-1", paid_at: later });
    // Final: even a correct expectedFrom cannot move it (trg_payouts_terminal) → mapped to false, nothing changes.
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "PAID", "PROCESSING", later)])).toBe(false);
    expect((await repo.findById(T_AFF, "po1"))?.status).toBe("PAID");
  });

  it("0011 CHECK / trigger violations surface as failures (not swallowed)", async () => {
    // Illegal transition via a correct expectedFrom: REQUESTED → PAID (trigger) → mapped to false, row untouched.
    await repo.batch([repo.insertStatement(T_AFF, basePayout, NOW)]);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "REQUESTED", "PAID", NOW, { paid_at: NOW })])).toBe(false);
    expect((await repo.findById(T_AFF, "po1"))?.status).toBe("REQUESTED");

    // Row CHECK: FAILED without failure_code → CHECK violation is NOT a state conflict → thrown, row untouched.
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "REQUESTED", "ELIGIBILITY_CHECK", NOW)])).toBe(true);
    await expect(repo.batch([repo.statusStatement(T_AFF, "po1", "ELIGIBILITY_CHECK", "FAILED", NOW)])).rejects.toThrow(/CHECK constraint failed/);
    expect((await repo.findById(T_AFF, "po1"))?.status).toBe("ELIGIBILITY_CHECK");

    // Non-conflict errors are re-thrown, never mapped to false:
    // method / org mismatch (trg_payouts_method_guard)
    await expect(repo.batch([repo.insertStatement(T_AFF, { ...basePayout, id: "po2", idempotency_key: "idem-2", payout_method_id: "pm2" }, NOW)])).rejects.toThrow(/PAYOUT_METHOD_ORG_MISMATCH/);
    // currency mismatch with the method
    await expect(repo.batch([repo.insertStatement(T_AFF, { ...basePayout, id: "po2", idempotency_key: "idem-2", currency: "EUR" }, NOW)])).rejects.toThrow(/PAYOUT_METHOD_CURRENCY_MISMATCH/);
    // duplicate idempotency key (UNIQUE) → second payout provably impossible
    await expect(repo.batch([repo.insertStatement(T_AFF, { ...basePayout, id: "po2" }, NOW)])).rejects.toThrow(/UNIQUE/);
    // §132 approver == requester (row CHECK) → thrown, nothing written
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "ELIGIBILITY_CHECK", "UNDER_REVIEW", NOW)])).toBe(true);
    await expect(repo.batch([repo.statusStatement(T_AFF, "po1", "UNDER_REVIEW", "APPROVED", NOW, { approved_by_user_id: REQ, approved_at: NOW })])).rejects.toThrow(/CHECK constraint failed/);
    expect(await repo.findById(T_AFF, "po1")).toMatchObject({ status: "UNDER_REVIEW", approved_by_user_id: null });
    // provider_reference immutable once set (0011 trigger) → thrown
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "UNDER_REVIEW", "APPROVED", NOW, { approved_by_user_id: APPR, approved_at: NOW })])).toBe(true);
    expect(await repo.batch([repo.statusStatement(T_AFF, "po1", "APPROVED", "PROCESSING", NOW, { provider: "stub", provider_reference: "ref-A" })])).toBe(true);
    await expect(repo.batch([repo.statusStatement(T_AFF, "po1", "PROCESSING", "FAILED", NOW, { failure_code: "X", provider_reference: "ref-B" })])).rejects.toThrow(/PAYOUT_PROVIDER_REFERENCE_IMMUTABLE/);
    // payouts cannot be deleted
    expect(() => db.sqlite.exec(`DELETE FROM payouts WHERE id = 'po1'`)).toThrow(/PAYOUT_IMMUTABLE/);

    // Builders refuse non-integer / bad money before any SQL.
    expect(() => repo.insertStatement(T_AFF, { ...basePayout, amount_minor: 100.5 }, NOW)).toThrow(AppError);
    expect(() => repo.insertStatement(T_AFF, { ...basePayout, amount_minor: Number.NaN }, NOW)).toThrow(/INVALID_MONEY|integer/);
    expect(() => repo.insertStatement(T_AFF, { ...basePayout, currency: "usd" }, NOW)).toThrow(AppError);
    expect(() => repo.insertStatement(T_AFF, { ...basePayout, fee_minor: 1.5 }, NOW)).toThrow(AppError);
    // DB CHECKs on money: amount 0 and fee ≥ amount
    await expect(repo.batch([repo.insertStatement(T_AFF, { ...basePayout, id: "po3", idempotency_key: "idem-3", amount_minor: 0 }, NOW)])).rejects.toThrow(/CHECK/);
    await expect(repo.batch([repo.insertStatement(T_AFF, { ...basePayout, id: "po3", idempotency_key: "idem-3", fee_minor: 10_000 }, NOW)])).rejects.toThrow(/CHECK/);
    expect(await repo.findById(T_AFF, "po3")).toBeNull();
    expect(isStateConflict(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isStateConflict(new Error("CHECK constraint failed: amount_minor > 0"))).toBe(false);
    expect(isStateConflict(new Error("CHECK constraint failed: status IN ('REQUESTED','PAID')"))).toBe(true);
    expect(isStateConflict(new Error("PAYOUT_ILLEGAL_TRANSITION"))).toBe(true);
  });

  it("payout_status_history is INSERT-only: UPDATE and DELETE are rejected by 0011 triggers", async () => {
    await repo.batch([
      repo.insertStatement(T_AFF, basePayout, NOW),
      repo.historyStatement(T_AFF, { id: "psh1", payout_id: "po1", from_status: null, to_status: "REQUESTED", actor_type: "TENANT", actor_user_id: REQ }, NOW),
    ]);
    expect(() => db.sqlite.exec(`UPDATE payout_status_history SET note = 'x' WHERE id = 'psh1'`)).toThrow(/PAYOUT_STATUS_HISTORY_APPEND_ONLY/);
    expect(() => db.sqlite.exec(`DELETE FROM payout_status_history WHERE id = 'psh1'`)).toThrow(/PAYOUT_STATUS_HISTORY_APPEND_ONLY/);
    expect(await repo.listStatusHistory(T_AFF, "po1")).toHaveLength(1);
    // history CHECKs: bad reason_code / unknown status → thrown (not a state conflict)
    await expect(repo.batch([repo.historyStatement(T_AFF, { id: "psh2", payout_id: "po1", from_status: "REQUESTED", to_status: "CANCELLED", actor_type: "TENANT", reason_code: "lower case" }, NOW)])).rejects.toThrow(/CHECK/);
    await expect(repo.batch([repo.historyStatement(T_AFF, { id: "psh2", payout_id: "nope", from_status: null, to_status: "REQUESTED", actor_type: "TENANT" }, NOW)])).rejects.toThrow(/FOREIGN KEY/);
    expect(count(db, "SELECT COUNT(*) AS n FROM payout_status_history")).toBe(1);
  });

  it("payout_attempts are INSERT-only, money-locked to the payout, numbered, and tenant-scoped", async () => {
    await repo.batch([repo.insertStatement(T_AFF, basePayout, NOW)]);
    expect(await repo.nextAttemptNumber(T_AFF, "po1")).toBe(1);
    const base = { payout_id: "po1", provider: "stub", provider_idempotency_key: "po1:1", amount_minor: 10_000, currency: "USD", actor_type: "SYSTEM" as const };
    expect(await repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa1", attempt_number: 1, outcome: "SUBMITTED", request_hash: "a".repeat(64) }, NOW)])).toBe(true);
    expect(await repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa2", attempt_number: 2, provider_idempotency_key: "po1:2", outcome: "FAILED", error_code: "TIMEOUT_UPSTREAM", error_message: "no reply" }, NOW)])).toBe(true);
    expect(await repo.nextAttemptNumber(T_AFF, "po1")).toBe(3);
    expect(await repo.listAttempts(T_AFF, "po1")).toMatchObject([
      { id: "pa1", attempt_number: 1, outcome: "SUBMITTED", amount_minor: 10_000, currency: "USD", organization_id: AFF },
      { id: "pa2", attempt_number: 2, outcome: "FAILED", error_code: "TIMEOUT_UPSTREAM" },
    ]);
    expect(await repo.listAttempts(T_AFF2, "po1")).toEqual([]);
    expect(await repo.nextAttemptNumber(T_AFF2, "po1")).toBe(1);

    // append-only
    expect(() => db.sqlite.exec(`UPDATE payout_attempts SET outcome = 'SUCCEEDED' WHERE id = 'pa1'`)).toThrow(/PAYOUT_ATTEMPTS_APPEND_ONLY/);
    expect(() => db.sqlite.exec(`DELETE FROM payout_attempts WHERE id = 'pa1'`)).toThrow(/PAYOUT_ATTEMPTS_APPEND_ONLY/);
    // trigger: money must equal the payout's; org must match; duplicate attempt_number refused
    await expect(repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 3, provider_idempotency_key: "po1:3", amount_minor: 9_999, outcome: "SUBMITTED" }, NOW)])).rejects.toThrow(/PAYOUT_ATTEMPT_MONEY_MISMATCH/);
    await expect(repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 3, provider_idempotency_key: "po1:3", currency: "EUR", outcome: "SUBMITTED" }, NOW)])).rejects.toThrow(/PAYOUT_ATTEMPT_MONEY_MISMATCH/);
    await expect(repo.batch([repo.attemptStatement(T_AFF2, { ...base, id: "pa3", attempt_number: 3, provider_idempotency_key: "po1:3", outcome: "SUBMITTED" }, NOW)])).rejects.toThrow(/PAYOUT_ATTEMPT_ORG_MISMATCH/);
    await expect(repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 2, provider_idempotency_key: "po1:x", outcome: "SUBMITTED" }, NOW)])).rejects.toThrow(/UNIQUE/);
    await expect(repo.batch([repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 3, provider_idempotency_key: "po1:3", outcome: "FAILED" }, NOW)])).rejects.toThrow(/CHECK/); // FAILED needs error_code
    expect(() => repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 0, outcome: "SUBMITTED" }, NOW)).toThrow(AppError);
    expect(() => repo.attemptStatement(T_AFF, { ...base, id: "pa3", attempt_number: 3, amount_minor: 1e20, outcome: "SUBMITTED" }, NOW)).toThrow(AppError);
    expect(count(db, "SELECT COUNT(*) AS n FROM payout_attempts")).toBe(2);
  });

  it("helper reads: payout method, organization status, open fraud / compliance case statuses", async () => {
    expect(await repo.findPayoutMethod(T_AFF, "pm1")).toMatchObject({ id: "pm1", organization_id: AFF, status: "VERIFIED", currency: "USD" });
    expect(await repo.findPayoutMethod(T_AFF, "pm1_eur")).toMatchObject({ status: "PENDING_VERIFICATION", currency: "EUR" });
    expect(await repo.findPayoutMethod(T_AFF, "pm2")).toBeNull();

    expect(await repo.organizationStatus(T_AFF)).toEqual({ id: AFF, status: "ACTIVE" });
    db.sqlite.exec(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = '${AFF}'`);
    expect(await repo.organizationStatus(T_AFF)).toEqual({ id: AFF, status: "SUSPENDED" });
    expect(await repo.organizationStatus("missing" as TenantId)).toBeNull();

    expect(await repo.openFraudCaseStatuses(T_AFF)).toEqual([]);
    expect(await repo.openComplianceCaseStatuses(T_AFF)).toEqual([]);
    db.sqlite.exec(`
      INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code, created_at)
        VALUES ('fc1', '${ADV}', '${AFF}', 'OPEN', 'HIGH', 'VELOCITY', '2026-03-01T00:00:00.000Z'),
               ('fc2', '${ADV}', '${AFF}', 'UNDER_REVIEW', 'HIGH', 'VELOCITY', '2026-03-02T00:00:00.000Z'),
               ('fc3', '${ADV}', '${AFF}', 'DISMISSED', 'LOW', 'VELOCITY', '2026-03-03T00:00:00.000Z'),
               ('fc4', '${ADV}', '${AFF2}', 'OPEN', 'HIGH', 'VELOCITY', '2026-03-04T00:00:00.000Z'),
               ('fc5', '${ADV}', NULL, 'OPEN', 'HIGH', 'VELOCITY', '2026-03-05T00:00:00.000Z');
      INSERT INTO compliance_cases (id, organization_id, subject_type, subject_id, affiliate_organization_id, status, severity, reason_code, created_at)
        VALUES ('cc1', '${ADV}', 'AFFILIATE', 'afp1', '${AFF}', 'OPEN', 'BLOCKING', 'KYC', '2026-03-01T00:00:00.000Z'),
               ('cc2', '${ADV}', 'AFFILIATE', 'afp1', '${AFF}', 'ESCALATED', 'BLOCKING', 'KYC', '2026-03-02T00:00:00.000Z'),
               ('cc3', '${ADV}', 'AFFILIATE', 'afp1', '${AFF}', 'RESOLVED', 'INFO', 'KYC', '2026-03-03T00:00:00.000Z'),
               ('cc4', '${ADV}', 'AFFILIATE', 'afp2', '${AFF2}', 'OPEN', 'BLOCKING', 'KYC', '2026-03-04T00:00:00.000Z');
    `);
    expect(await repo.openFraudCaseStatuses(T_AFF)).toEqual(["OPEN", "UNDER_REVIEW"]);
    expect(await repo.openComplianceCaseStatuses(T_AFF)).toEqual(["OPEN", "ESCALATED"]);
    expect(await repo.openFraudCaseStatuses(T_AFF2)).toEqual(["OPEN"]);
    expect(await repo.openComplianceCaseStatuses(T_AFF2)).toEqual(["OPEN"]);
    expect(await repo.openDisputeCount(T_AFF)).toBe(0); // documented gap: no disputes table yet
  });

  it("helper reads: affiliate-wide hold facts and newest EARNED age in whole days", async () => {
    conversion(db, "c1", "EARNED", AFF, "2026-03-01T00:00:00.000Z");
    conversion(db, "c2", "PAYOUT_ELIGIBLE", AFF, "2026-03-10T11:59:59.000Z"); // newest payable → 5 days (floored)
    conversion(db, "c3", "EARNED", AFF, "2026-03-14T00:00:00.000Z");
    db.sqlite.exec(`UPDATE conversions SET lifecycle_status = 'PAID' WHERE id = 'c3'`); // already paid → excluded
    conversion(db, "c4", "EARNED", AFF2, "2026-03-15T00:00:00.000Z"); // other affiliate → excluded
    conversion(db, "c5", "APPROVED", AFF, null); // not earned yet → excluded

    expect(await repo.newestEarnedAgeDays(T_AFF, NOW)).toBe(5);
    expect(await repo.newestEarnedAgeDays(T_AFF, "2026-03-10T12:00:00.000Z")).toBe(0);
    expect(await repo.newestEarnedAgeDays(T_AFF2, NOW)).toBe(0);
    expect(await repo.newestEarnedAgeDays("org-none" as TenantId, NOW)).toBeNull();
    expect(wholeDaysBetween("2026-03-01T00:00:00.000Z", "2026-03-02T23:59:59.000Z")).toBe(1);
    expect(wholeDaysBetween("2026-03-05T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toBe(0);
    expect(() => wholeDaysBetween("garbage", NOW)).toThrow(AppError);

    expect(await repo.affiliateHoldFacts(T_AFF)).toEqual({ activeHoldTypes: [], fraudReviewOpen: false });
    db.sqlite.exec(`
      INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type)
        VALUES ('h1', '${ADV}', 'c1', NULL, 'CONVERSION_HOLD', 'ACTIVE', 'R', 'MANUAL'),
               ('h2', '${ADV}', NULL, '${AFF}', 'PAYOUT_HOLD', 'ACTIVE', 'R', 'FRAUD_CASE'),
               ('h4', '${ADV}', NULL, '${AFF2}', 'COMPLIANCE_BLOCK', 'ACTIVE', 'R', 'COMPLIANCE_CASE');
      INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type, released_at)
        VALUES ('h3', '${ADV}', NULL, '${AFF}', 'COMPLIANCE_BLOCK', 'RELEASED', 'R', 'COMPLIANCE_CASE', '2026-03-10T00:00:00.000Z');
    `);
    const facts = await repo.affiliateHoldFacts(T_AFF);
    expect([...facts.activeHoldTypes].sort()).toEqual(["CONVERSION_HOLD", "PAYOUT_HOLD"]);
    expect(facts.fraudReviewOpen).toBe(false);
    expect(isPayoutBlockedBy(facts)).toBe(true);
    expect(await repo.affiliateHoldFacts(T_AFF2)).toMatchObject({ activeHoldTypes: ["COMPLIANCE_BLOCK"] });
    db.sqlite.exec(`UPDATE conversion_holds SET status = 'RELEASED', released_at = '${NOW}' WHERE id = 'h2'`);
    expect((await repo.affiliateHoldFacts(T_AFF)).activeHoldTypes).toEqual(["CONVERSION_HOLD"]);
    expect(isPayoutBlockedBy(await repo.affiliateHoldFacts(T_AFF))).toBe(false); // CONVERSION_HOLD alone never blocks payout

    db.sqlite.exec(`INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code) VALUES ('fc1', '${ADV}', '${AFF}', 'APPEALED', 'HIGH', 'VELOCITY')`);
    const all = await repo.eligibilityFacts(T_AFF, "pm1", NOW);
    expect(all).toEqual({
      organization: { id: AFF, status: "ACTIVE" },
      payout_method: expect.objectContaining({ id: "pm1", status: "VERIFIED", currency: "USD" }),
      compliance_case_statuses: [],
      fraud_case_statuses: ["APPEALED"],
      active_hold_types: ["CONVERSION_HOLD"],
      newest_earned_age_days: 5,
      open_dispute_count: 0,
    });
    expect((await repo.eligibilityFacts(T_AFF, "pm2", NOW)).payout_method).toBeNull();
  });
});
