/**
 * PayoutService tests — Phase 5 Unit 12b (PRD §65–§66, §114, §115, §132).
 * Real migrations 0001–0011 via the SQLite-backed TestD1 shim; real ledger + reserves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AuditRepository } from "../audit/repository";
import type { AuthenticatedContext } from "../auth/service";
import { buildJournal } from "../ledger/journal";
import { LedgerRepository } from "../ledger/repository";
import { ReserveRepository, ReserveService } from "../ledger/reserves";
import type { CreatePayoutRequest, CreatePayoutResult, PaymentProvider } from "./provider";
import { PayoutRepository } from "./repository";
import { PayoutService, payoutJournalIdempotencyKey } from "./service";
import { StubPaymentAdapter } from "./stub-adapter";

const AFF = "org-aff-1";
const AFF2 = "org-aff-2";
const ADV = "org-adv-1";
const REQ = "user-req";
const APPR = "user-appr";
const NOW = "2026-03-15T12:00:00.000Z";
const T_AFF = AFF as TenantId;
const META = { ip_address: null, user_agent: null, request_id: "req-1" };
const ALL = ["payouts.read", "payouts.request", "payouts.review", "payouts.approve", "payouts.release"];

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
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
      VALUES ('pm_fail', '${AFF}', 'afp1', 'BANK_TRANSFER', 'stub', 'fail:INSUFFICIENT_FUNDS', 'Bad bank', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z');
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
      VALUES ('pm2', '${AFF2}', 'afp2', 'PAYPAL', 'stub', 'tok2', 'PayPal', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z');
  `);
}

function tenantFor(orgId: string, perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type: "AFFILIATE", name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
const ctxOf = (id: string) => ({ user: { id, email: `${id}@example.com` }, session: {} }) as unknown as AuthenticatedContext;
const reqCtx = ctxOf(REQ);
const apprCtx = ctxOf(APPR);
const aff = tenantFor(AFF, ALL);
const aff2 = tenantFor(AFF2, ALL);

function count(db: TestD1, sql: string, ...args: string[]): number {
  return (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}
const audits = (db: TestD1, action: string) => count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?", action);
const history = (db: TestD1, id: string) => db.sqlite.prepare("SELECT from_status, to_status, reason_code FROM payout_status_history WHERE payout_id = ? ORDER BY created_at, rowid").all(id) as { from_status: string | null; to_status: string; reason_code: string | null }[];
const attempts = (db: TestD1, id: string) => count(db, "SELECT COUNT(*) AS n FROM payout_attempts WHERE payout_id = ?", id);
const journals = (db: TestD1) => count(db, "SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT'");

/** Counting wrapper around any provider (never changes results). */
function counting(inner: PaymentProvider): PaymentProvider & { calls: CreatePayoutRequest[] } {
  const calls: CreatePayoutRequest[] = [];
  return {
    calls,
    name: inner.name,
    createPayout: (req) => {
      calls.push(req);
      return inner.createPayout(req);
    },
    getStatus: (r) => inner.getStatus(r),
    verifyWebhook: (p, s, k) => inner.verifyWebhook(p, s, k),
    cancelPayout: (r) => inner.cancelPayout(r),
  };
}

/** Scripted provider: outcome per NEW idempotency key in order; replays by key like a real provider. */
function scripted(outcomes: CreatePayoutResult["status"][]): PaymentProvider & { calls: number } {
  const seen = new Map<string, CreatePayoutResult>();
  const p = {
    calls: 0,
    name: "scripted",
    async createPayout(req: CreatePayoutRequest): Promise<CreatePayoutResult> {
      p.calls++;
      const prev = seen.get(req.idempotency_key);
      if (prev) return { ...prev, replayed: true };
      const status = outcomes.shift() ?? "PAID";
      const res: CreatePayoutResult = {
        provider: "scripted",
        provider_reference: `ref-${req.idempotency_key}-${p.calls}`,
        status,
        replayed: false,
        ...(status === "FAILED" ? { failure_code: "BANK_REJECTED", failure_reason: "scripted failure" } : {}),
      };
      seen.set(req.idempotency_key, res);
      return res;
    },
    getStatus: async () => {
      throw new Error("unused");
    },
    verifyWebhook: async () => {
      throw new Error("unused");
    },
    cancelPayout: async () => {
      throw new Error("unused");
    },
  };
  return p;
}

describe("PayoutService", () => {
  let db: TestD1;
  let repo: PayoutRepository;
  let ledger: LedgerRepository;
  let reserves: ReserveService;
  let clock: string;
  let payable: string;

  async function fund(amount: number, currency = "USD", withClearing = true): Promise<void> {
    const cash = await ledger.createAccount({ organization_id: AFF, code: "CASH", account_type: "ASSET", currency, name: "Cash" });
    const ap = await ledger.createAccount({ organization_id: AFF, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency, name: "A/P" });
    payable = ap.id;
    if (withClearing) await ledger.createAccount({ organization_id: AFF, code: "PAYOUT_CLEARING", account_type: "LIABILITY", currency, name: "Clearing" });
    const draft = buildJournal(
      {
        organization_id: AFF,
        journal_type: "FUNDING",
        currency,
        reference_type: "FUNDING",
        reference_id: "fund-1",
        idempotency_key: "FUNDING:fund-1",
        legs: [
          { account_id: cash.id, direction: "DEBIT", amount_minor: amount },
          { account_id: ap.id, direction: "CREDIT", amount_minor: amount },
        ],
      },
      await ledger.accountsOf(T_AFF),
    );
    await ledger.postJournal(draft, { actor_type: "INTERNAL", posted_by_user_id: null, request_id: null, posted_at: NOW });
  }

  function service(provider: PaymentProvider): PayoutService {
    return new PayoutService(repo, ledger, reserves, provider, db, { now: () => new Date(clock) });
  }

  async function toUnderReview(svc: PayoutService, key = "idem-1", method = "pm1", amount = 10_000) {
    const p = await svc.request(reqCtx, aff, { payout_method_id: method, amount_minor: amount, currency: "USD", idempotency_key: key }, META);
    const e = await svc.runEligibility(reqCtx, aff, p.id, META);
    expect(e.outcome).toBe("ELIGIBLE");
    return e.payout;
  }

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new PayoutRepository(db);
    ledger = new LedgerRepository(db);
    reserves = new ReserveService(new ReserveRepository(db), ledger, new AuditRepository(db), { now: () => new Date(NOW) });
    clock = NOW;
  });
  afterEach(() => db.close());

  it("happy path REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW → APPROVED → PROCESSING → PAID with history, audit and ONE ledger journal", async () => {
    await fund(20_000);
    const provider = counting(new StubPaymentAdapter());
    const svc = service(provider);

    const p = await svc.request(reqCtx, aff, { payout_method_id: "pm1", amount_minor: 10_000, currency: "USD", idempotency_key: "idem-1" }, META);
    expect(p.status).toBe("REQUESTED");
    expect(p.requested_by_user_id).toBe(REQ);
    expect(audits(db, "payout.requested")).toBe(1);

    const e = await svc.runEligibility(reqCtx, aff, p.id, META);
    expect(e.outcome).toBe("ELIGIBLE");
    expect(e.payout.status).toBe("UNDER_REVIEW"); // never auto-approved
    expect(JSON.parse(e.payout.eligibility_snapshot as string).eligible).toBe(true);

    const a = await svc.approve(apprCtx, aff, p.id, "ok", META);
    expect(a.status).toBe("APPROVED");
    expect(a.approved_by_user_id).toBe(APPR);
    expect(a.approved_at).toBe(NOW);

    const r = await svc.process(apprCtx, aff, p.id, META);
    expect(r.outcome).toBe("PAID");
    expect(r.payout.status).toBe("PAID");
    expect(r.payout.paid_at).toBe(NOW);
    expect(r.payout.provider).toBe("stub");
    expect(r.payout.provider_reference).toBeTruthy();
    expect(r.attempt.outcome).toBe("SUCCEEDED");
    expect(r.attempt.attempt_number).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.idempotency_key).toBe("idem-1");

    // Ledger: exactly one PAYOUT journal, linked, balance reduced; payable 20000 → 10000.
    expect(journals(db)).toBe(1);
    const j = await ledger.findJournalByIdempotencyKey(T_AFF, payoutJournalIdempotencyKey(p.id));
    expect(j?.id).toBe(r.payout.journal_id);
    expect(j?.total_minor).toBe(10_000);
    expect((await ledger.computeBalance(T_AFF, payable)).balance_minor).toBe(10_000);
    expect((await reserves.computeAvailable(T_AFF, "USD")).payable_minor).toBe(10_000);

    expect(history(db, p.id).map((h) => h.to_status)).toEqual(["REQUESTED", "ELIGIBILITY_CHECK", "UNDER_REVIEW", "APPROVED", "PROCESSING", "PAID"]);
    for (const action of ["payout.eligible", "payout.approved", "payout.paid"]) expect(audits(db, action)).toBe(1);

    const detail = await svc.getPayout(aff, p.id);
    expect(detail.history).toHaveLength(6);
    expect(detail.attempts).toHaveLength(1);

    // PAID is final: no further edges.
    await expect(svc.cancel(apprCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
    await expect(svc.process(apprCtx, aff, p.id, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
  });

  it("§114 duplicate payout → no duplicate payout: same idempotency key returns the same row; re-processing never calls the provider or posts twice", async () => {
    await fund(20_000);
    const provider = counting(new StubPaymentAdapter());
    const svc = service(provider);
    const input = { payout_method_id: "pm1", amount_minor: 10_000, currency: "USD", idempotency_key: "idem-dup" };
    const p1 = await svc.request(reqCtx, aff, input, META);
    const p2 = await svc.request(reqCtx, aff, input, META);
    const p3 = await svc.request(reqCtx, aff, { ...input, amount_minor: 99_999 }, META); // same key, different amount → still the original
    expect(p2.id).toBe(p1.id);
    expect(p3.id).toBe(p1.id);
    expect(p3.amount_minor).toBe(10_000);
    expect(count(db, "SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    expect(audits(db, "payout.requested")).toBe(1);

    await svc.runEligibility(reqCtx, aff, p1.id, META);
    await svc.approve(apprCtx, aff, p1.id, null, META);
    await svc.process(apprCtx, aff, p1.id, META);
    await expect(svc.process(apprCtx, aff, p1.id, META)).rejects.toMatchObject({ code: "INVALID_PAYOUT_TRANSITION" });
    expect(provider.calls).toHaveLength(1);
    expect(attempts(db, p1.id)).toBe(1);
    expect(journals(db)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM payouts")).toBe(1);
  });

  it("ineligible payouts are rejected to FAILED with stable reasons in history/audit and nothing is paid", async () => {
    await fund(5_000);
    const provider = counting(new StubPaymentAdapter());
    const svc = service(provider);

    const run = async (key: string, prep: () => void, amount = 1_000) => {
      prep();
      const p = await svc.request(reqCtx, aff, { payout_method_id: "pm1", amount_minor: amount, currency: "USD", idempotency_key: key }, META);
      const e = await svc.runEligibility(reqCtx, aff, p.id, META);
      expect(e.outcome).toBe("REJECTED");
      expect(e.payout.status).toBe("FAILED");
      expect(e.payout.failure_code).toBe("INELIGIBLE");
      const codes = e.result.eligible ? [] : e.result.reasons.map((r) => r.code);
      expect(history(db, p.id).at(-1)).toMatchObject({ from_status: "ELIGIBILITY_CHECK", to_status: "FAILED", reason_code: "INELIGIBLE" });
      expect(JSON.parse(e.payout.eligibility_snapshot as string).reasons.map((r: { code: string }) => r.code)).toEqual(codes);
      return { payout: e.payout, codes };
    };

    const hold = await run("k-hold", () =>
      db.sqlite.exec(`INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type)
        VALUES ('h-pay', '${ADV}', NULL, '${AFF}', 'PAYOUT_HOLD', 'ACTIVE', 'R', 'FRAUD_CASE')`),
    );
    expect(hold.codes).toEqual(["PAYOUT_ON_HOLD"]);
    db.sqlite.exec("UPDATE conversion_holds SET status = 'RELEASED', released_at = '2026-03-15T00:00:00.000Z' WHERE id = 'h-pay'");

    const block = await run("k-block", () =>
      db.sqlite.exec(`INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type)
        VALUES ('h-blk', '${ADV}', NULL, '${AFF}', 'COMPLIANCE_BLOCK', 'ACTIVE', 'R', 'COMPLIANCE_CASE')`),
    );
    expect(block.codes).toEqual(["COMPLIANCE_BLOCKED"]);
    db.sqlite.exec("UPDATE conversion_holds SET status = 'RELEASED', released_at = '2026-03-15T00:00:00.000Z' WHERE id = 'h-blk'");

    const fraud = await run("k-fraud", () =>
      db.sqlite.exec(`INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code) VALUES ('fc1', '${ADV}', '${AFF}', 'OPEN', 'HIGH', 'VELOCITY')`),
    );
    expect(fraud.codes).toEqual(["FRAUD_CASE_OPEN"]);
    db.sqlite.exec("UPDATE fraud_cases SET status = 'DISMISSED' WHERE id = 'fc1'");

    const org = await run("k-org", () => db.sqlite.exec(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = '${AFF}'`));
    expect(org.codes).toEqual(["ORG_NOT_ACTIVE"]);
    db.sqlite.exec(`UPDATE organizations SET status = 'ACTIVE' WHERE id = '${AFF}'`);

    const over = await run("k-over", () => undefined, 6_000);
    expect(over.codes).toEqual(["AMOUNT_EXCEEDS_PAYABLE"]);

    expect(audits(db, "payout.ineligible")).toBe(5);
    expect(audits(db, "payout.eligible")).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(attempts(db, over.payout.id)).toBe(0);
    expect(journals(db)).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM payouts WHERE status = 'PAID'")).toBe(0);

    // A FAILED eligibility payout cannot be approved or processed; it can be cancelled.
    await expect(svc.approve(apprCtx, aff, over.payout.id, null, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
    const c = await svc.cancel(apprCtx, aff, over.payout.id, "not payable", META);
    expect(c.status).toBe("CANCELLED");
    expect(c.cancel_reason).toBe("not payable");
  });

  it("§132 approver == requester is refused (403) and nothing is written", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const p = await toUnderReview(svc);
    await expect(svc.approve(reqCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 403, code: "APPROVER_IS_REQUESTER" });
    expect((await repo.findById(T_AFF, p.id))?.status).toBe("UNDER_REVIEW");
    expect(audits(db, "payout.approved")).toBe(0);
    expect(history(db, p.id)).toHaveLength(3);
  });

  it("a hold placed after review blocks approve (eligibility re-checked at approval time)", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const p = await toUnderReview(svc);
    db.sqlite.exec(`INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type)
      VALUES ('h-late', '${ADV}', NULL, '${AFF}', 'PAYOUT_HOLD', 'ACTIVE', 'R', 'FRAUD_CASE')`);
    await expect(svc.approve(apprCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 409, code: "PAYOUT_NOT_ELIGIBLE" });
    expect((await repo.findById(T_AFF, p.id))?.status).toBe("UNDER_REVIEW");
    expect(audits(db, "payout.approved")).toBe(0);
  });

  it("§114 failed payout → recoverable: provider FAILED → FAILED (no ledger effect), retry → PROCESSING → PAID", async () => {
    await fund(20_000);
    const provider = scripted(["FAILED"]);
    const svc = service(provider);
    const p = await toUnderReview(svc);
    await svc.approve(apprCtx, aff, p.id, null, META);

    const r1 = await svc.process(apprCtx, aff, p.id, META);
    expect(r1.outcome).toBe("FAILED");
    expect(r1.payout.status).toBe("FAILED");
    expect(r1.payout.failure_code).toBe("BANK_REJECTED");
    expect(r1.payout.provider_reference).toBe("ref-idem-1-1");
    expect(r1.attempt.outcome).toBe("REJECTED");
    expect(journals(db)).toBe(0);
    expect((await ledger.computeBalance(T_AFF, payable)).balance_minor).toBe(20_000);
    expect(audits(db, "payout.failed")).toBe(1);

    // Retry with the SAME idempotency key: the provider replays the same (failed) reference → FAILED again, attempt #2.
    const r2 = await svc.process(apprCtx, aff, p.id, META);
    expect(r2.outcome).toBe("FAILED");
    expect(r2.attempt.attempt_number).toBe(2);
    expect(provider.calls).toBe(2);
    expect(history(db, p.id).slice(-4).map((h) => h.to_status)).toEqual(["PROCESSING", "FAILED", "PROCESSING", "FAILED"]);
    expect(history(db, p.id).at(-2)?.reason_code).toBe("RETRY");

    // Recovery: a provider that now accepts (new key namespace) → PAID; frozen provider_reference is respected via a fresh provider name.
    const fresh = scripted(["PAID"]);
    const svc2 = service(fresh);
    // provider_reference is frozen once set (0011): the recovering adapter must return the same reference.
    fresh.createPayout = async () => ({ provider: "scripted", provider_reference: "ref-idem-1-1", status: "PAID", replayed: true });
    const r3 = await svc2.process(apprCtx, aff, p.id, META);
    expect(r3.outcome).toBe("PAID");
    expect(r3.payout.status).toBe("PAID");
    expect(r3.attempt.attempt_number).toBe(3);
    expect(attempts(db, p.id)).toBe(3);
    expect(journals(db)).toBe(1);
    expect((await ledger.computeBalance(T_AFF, payable)).balance_minor).toBe(10_000);
    expect(r3.payout.failure_code).toBeNull();
  });

  it("provider PENDING keeps PROCESSING; a later process() completes it (PAID) with one journal", async () => {
    await fund(20_000);
    const provider = scripted(["PENDING"]);
    const svc = service(provider);
    const p = await toUnderReview(svc);
    await svc.approve(apprCtx, aff, p.id, null, META);
    const r1 = await svc.process(apprCtx, aff, p.id, META);
    expect(r1.outcome).toBe("PENDING");
    expect(r1.payout.status).toBe("PROCESSING");
    expect(r1.attempt.outcome).toBe("ACCEPTED");
    expect(journals(db)).toBe(0);
    // Provider now reports PAID for the same reference.
    provider.createPayout = async () => ({ provider: "scripted", provider_reference: r1.payout.provider_reference as string, status: "PAID", replayed: true });
    const r2 = await svc.process(apprCtx, aff, p.id, META);
    expect(r2.outcome).toBe("PAID");
    expect(attempts(db, p.id)).toBe(2);
    expect(journals(db)).toBe(1);
  });

  it("provider PAID but ledger refuses (no PAYOUT_CLEARING account) → attempt + processing error recorded, payout stays PROCESSING, 500; fixed → PAID", async () => {
    await fund(20_000, "USD", false);
    const svc = service(new StubPaymentAdapter());
    const p = await toUnderReview(svc);
    await svc.approve(apprCtx, aff, p.id, null, META);
    await expect(svc.process(apprCtx, aff, p.id, META)).rejects.toMatchObject({ status: 500, code: "PAYOUT_LEDGER_POSTING_FAILED" });
    const row = await repo.findById(T_AFF, p.id);
    expect(row?.status).toBe("PROCESSING");
    expect(row?.provider_reference).toBeTruthy();
    expect(attempts(db, p.id)).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM financial_processing_errors WHERE operation = 'POST_PAYOUT' AND reference_id = ?", p.id)).toBe(1);
    expect(journals(db)).toBe(0);
    expect(audits(db, "payout.ledger_posting_failed")).toBe(1);

    await ledger.createAccount({ organization_id: AFF, code: "PAYOUT_CLEARING", account_type: "LIABILITY", currency: "USD", name: "Clearing" });
    const r = await svc.process(apprCtx, aff, p.id, META);
    expect(r.outcome).toBe("PAID");
    expect(r.attempt.attempt_number).toBe(2);
    expect(journals(db)).toBe(1);
    expect((await ledger.computeBalance(T_AFF, payable)).balance_minor).toBe(10_000);
  });

  it("stale status → 409 PAYOUT_STATE_CONFLICT and the whole batch rolls back (no history, no audit)", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const p = await toUnderReview(svc);
    const before = { h: history(db, p.id).length, a: count(db, "SELECT COUNT(*) AS n FROM audit_logs") };
    // Another worker cancelled it between our read and our write.
    db.sqlite.exec(`UPDATE payouts SET status = 'CANCELLED', cancelled_at = '${NOW}' WHERE id = '${p.id}'`);
    vi.spyOn(repo, "findById").mockResolvedValueOnce({ ...p, status: "UNDER_REVIEW" });
    await expect(svc.approve(apprCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 409, code: "PAYOUT_STATE_CONFLICT" });
    expect(history(db, p.id).length).toBe(before.h);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(before.a);
    expect((await repo.findById(T_AFF, p.id))?.status).toBe("CANCELLED");
    expect((await repo.findById(T_AFF, p.id))?.approved_by_user_id).toBeNull();
  });

  it("invalid edges → 409 INVALID_PAYOUT_TRANSITION; money errors → 400; unknown method → 404", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const p = await svc.request(reqCtx, aff, { payout_method_id: "pm1", amount_minor: 10_000, currency: "USD", idempotency_key: "idem-1" }, META);
    await expect(svc.approve(apprCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
    await expect(svc.process(apprCtx, aff, p.id, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
    const base = { payout_method_id: "pm1", currency: "USD", idempotency_key: "idem-x" };
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 10.5 }, META)).rejects.toMatchObject({ status: 400, code: "INVALID_AMOUNT" });
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 0 }, META)).rejects.toMatchObject({ status: 400, code: "INVALID_AMOUNT" });
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 100, currency: "usd" }, META)).rejects.toMatchObject({ status: 400, code: "INVALID_CURRENCY" });
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 100, currency: "EUR" }, META)).rejects.toMatchObject({ status: 400, code: "CURRENCY_MISMATCH_METHOD" });
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 100, payout_method_id: "nope" }, META)).rejects.toMatchObject({ status: 404, code: "PAYOUT_METHOD_NOT_FOUND" });
    await expect(svc.request(reqCtx, aff, { ...base, amount_minor: 100, idempotency_key: "" }, META)).rejects.toMatchObject({ status: 400, code: "INVALID_IDEMPOTENCY_KEY" });
    expect(count(db, "SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    // cancel from REQUESTED is a legal edge
    expect((await svc.cancel(reqCtx, aff, p.id, null, META)).status).toBe("CANCELLED");
    await expect(svc.cancel(reqCtx, aff, p.id, null, META)).rejects.toMatchObject({ status: 409, code: "INVALID_PAYOUT_TRANSITION" });
  });

  it("tenant isolation: another affiliate cannot read, approve, process or cancel the payout, and its own list is empty", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const p = await toUnderReview(svc);
    await expect(svc.getPayout(aff2, p.id)).rejects.toMatchObject({ status: 404, code: "PAYOUT_NOT_FOUND" });
    await expect(svc.approve(apprCtx, aff2, p.id, null, META)).rejects.toMatchObject({ status: 404 });
    await expect(svc.process(apprCtx, aff2, p.id, META)).rejects.toMatchObject({ status: 404 });
    await expect(svc.cancel(apprCtx, aff2, p.id, null, META)).rejects.toMatchObject({ status: 404 });
    await expect(svc.runEligibility(apprCtx, aff2, p.id, META)).rejects.toMatchObject({ status: 404 });
    expect((await svc.list(aff2, { limit: 10, cursor: null })).items).toEqual([]);
    // AFF2 cannot request against AFF's method either.
    await expect(svc.request(reqCtx, aff2, { payout_method_id: "pm1", amount_minor: 100, currency: "USD", idempotency_key: "k2" }, META)).rejects.toMatchObject({ status: 404, code: "PAYOUT_METHOD_NOT_FOUND" });
    expect((await repo.findById(T_AFF, p.id))?.status).toBe("UNDER_REVIEW");
  });

  it("permission matrix: read / request / review / approve / release each gate their step with 403 FORBIDDEN before any I/O", async () => {
    await fund(20_000);
    const svc = service(new StubPaymentAdapter());
    const none = tenantFor(AFF, []);
    const reader = tenantFor(AFF, ["payouts.read"]);
    const requester = tenantFor(AFF, ["payouts.read", "payouts.request"]);
    const reviewer = tenantFor(AFF, ["payouts.read", "payouts.review"]);
    const approver = tenantFor(AFF, ["payouts.read", "payouts.review", "payouts.approve"]);
    const input = { payout_method_id: "pm1", amount_minor: 10_000, currency: "USD", idempotency_key: "idem-1" };
    await expect(svc.request(reqCtx, none, input, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(svc.list(none, { limit: 5, cursor: null })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(svc.request(reqCtx, reader, input, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" }); // payouts.read alone cannot request
    const p = await svc.request(reqCtx, requester, input, META);
    await expect(svc.getPayout(none, p.id)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(svc.runEligibility(reqCtx, reader, p.id, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(svc.cancel(reqCtx, reader, p.id, null, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await svc.runEligibility(reqCtx, reviewer, p.id, META);
    await expect(svc.approve(apprCtx, reviewer, p.id, null, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await svc.approve(apprCtx, approver, p.id, null, META);
    await expect(svc.process(apprCtx, approver, p.id, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const r = await svc.process(apprCtx, aff, p.id, META);
    expect(r.outcome).toBe("PAID");
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(4); // requested, eligible, approved, paid
  });

  it("list pages by (created_at, id) DESC with an opaque cursor and optional status filter", async () => {
    await fund(100_000);
    const svc = service(new StubPaymentAdapter());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock = `2026-03-15T12:0${i}:00.000Z`;
      ids.push((await svc.request(reqCtx, aff, { payout_method_id: "pm1", amount_minor: 1_000 * (i + 1), currency: "USD", idempotency_key: `k-${i}` }, META)).id);
    }
    await svc.cancel(reqCtx, aff, ids[0] as string, null, META);
    const page1 = await svc.list(aff, { limit: 2, cursor: null });
    expect(page1.items.map((p) => p.id)).toEqual([ids[4], ids[3]]);
    expect(page1.next_cursor).not.toBeNull();
    const { decodeCursor } = await import("../../lib/pagination");
    const page2 = await svc.list(aff, { limit: 2, cursor: decodeCursor(page1.next_cursor as string) });
    expect(page2.items.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    const page3 = await svc.list(aff, { limit: 2, cursor: decodeCursor(page2.next_cursor as string) });
    expect(page3.items.map((p) => p.id)).toEqual([ids[0]]);
    expect(page3.next_cursor).toBeNull();
    const cancelled = await svc.list(aff, { limit: 10, cursor: null }, { status: "CANCELLED" });
    expect(cancelled.items.map((p) => p.id)).toEqual([ids[0]]);
    expect((await svc.list(aff, { limit: 10, cursor: null }, { status: "REQUESTED" })).items).toHaveLength(4);
  });
});
