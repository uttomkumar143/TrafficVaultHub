/**
 * Phase 5 Unit 13c — HTTP tests for the ledger routes (`routes/ledger.ts`)
 * through the REAL app (auth → requireOrg → requirePermission → services → D1).
 *
 * Covers: RBAC per permission (ledger.read / adjust / approve / reserve);
 * tenant isolation 404; §59/§132 self-approval refused; post before approval
 * 409; NO route posts a raw journal / ledger entry; malformed ids 404; money
 * 400 matrix; approval is PLATFORM-only (tenant face has no approve route).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../lib/tenant-scope";
import { buildJournal } from "../modules/ledger/journal";
import { LedgerRepository } from "../modules/ledger/repository";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface Adjustment {
  id: string;
  status: string;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  journal_id: string | null;
}
interface Reserve {
  id: string;
  status: string;
  amount_minor: number;
}

const NOW = "2026-03-01T00:00:00.000Z";
let h: TestHarness;

beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

function count(sql: string, ...args: string[]): number {
  return (h.db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

/** Platform seat: sign up + seat in the PLATFORM org; returns token + platform org id. */
async function platformUser(email: string, role: "SUPER_ADMIN" | "FINANCE_MANAGER" | "ANALYST" | "COMPLIANCE_MANAGER" | "SUPPORT_AGENT") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, role);
  return { token, orgId };
}

/** Affiliate org with CASH / AFFILIATE_PAYABLE / PLATFORM_ADJUSTMENT accounts funded via ONE internal FUNDING journal. */
async function affiliate(email: string, name: string, funded = 20_000) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const ledger = new LedgerRepository(h.db);
  const t = orgId as TenantId;
  const cash = await ledger.createAccount({ organization_id: orgId, code: "CASH", account_type: "ASSET", currency: "USD", name: "Cash" });
  const ap = await ledger.createAccount({ organization_id: orgId, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency: "USD", name: "A/P" });
  const adj = await ledger.createAccount({ organization_id: orgId, code: "PLATFORM_ADJUSTMENT", account_type: "EXPENSE", currency: "USD", name: "Adj" });
  const draft = buildJournal(
    {
      organization_id: orgId,
      journal_type: "FUNDING",
      currency: "USD",
      reference_type: "FUNDING",
      reference_id: `fund-${orgId}`,
      idempotency_key: `FUNDING:fund-${orgId}`,
      legs: [
        { account_id: cash.id, direction: "DEBIT", amount_minor: funded },
        { account_id: ap.id, direction: "CREDIT", amount_minor: funded },
      ],
    },
    await ledger.accountsOf(t),
  );
  const posted = await ledger.postJournal(draft, { actor_type: "INTERNAL", posted_by_user_id: null, request_id: null, posted_at: NOW });
  return { owner, orgId, cashId: cash.id, payableId: ap.id, adjId: adj.id, journalId: posted.journal_id };
}

async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

const L = (orgId: string, path = "") => `/organizations/${orgId}/ledger${path}`;
const P = (platOrgId: string, tenantOrgId: string, path = "") => `/organizations/${platOrgId}/platform/ledger/tenants/${tenantOrgId}${path}`;

const adjustmentBody = (a: Awaited<ReturnType<typeof affiliate>>, extra: Record<string, unknown> = {}) => ({
  account_id: a.payableId,
  counter_account_id: a.adjId,
  direction: "CREDIT",
  amount_minor: 2500,
  currency: "USD",
  reason_code: "BONUS",
  reason_note: "Q1 performance bonus",
  reference_type: "TICKET",
  reference_id: "T-42",
  ...extra,
});

const reserveBody = (extra: Record<string, unknown> = {}) => ({
  reserve_type: "RISK",
  currency: "USD",
  amount_minor: 1000,
  reason_code: "FRAUD_REVIEW",
  ...extra,
});

async function requestAdj(plat: { token: string; orgId: string }, a: Awaited<ReturnType<typeof affiliate>>): Promise<Adjustment> {
  const res = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, "/adjustments"), adjustmentBody(a));
  expect(res.status).toBe(201);
  return (await json<{ adjustment: Adjustment }>(res)).adjustment;
}

describe("ledger HTTP — tenant face reads (ledger.read) and tenant isolation", () => {
  it("owner reads accounts, balance, available and the journal detail; a foreign tenant / malformed id → 404", async () => {
    const a = await affiliate("a1@traffic.example", "Aff One");
    const b = await affiliate("b1@traffic.example", "Aff Two", 500);

    const accounts = await json<{ items: Array<{ id: string }> }>(await h.as(a.owner, "GET", L(a.orgId, "/accounts")));
    expect(accounts.items.map((x) => x.id).sort()).toEqual([a.cashId, a.payableId, a.adjId].sort());

    const bal = await json<{ balance: { balance_minor: number; entry_count: number } }>(await h.as(a.owner, "GET", L(a.orgId, `/accounts/${a.payableId}/balance`)));
    expect(bal.balance).toMatchObject({ balance_minor: 20_000, entry_count: 1 });

    const avail = await json<{ available: { available_minor: number; payable_minor: number; reserved_minor: number } }>(
      await h.as(a.owner, "GET", L(a.orgId, "/available?currency=USD")),
    );
    expect(avail.available).toMatchObject({ available_minor: 20_000, payable_minor: 20_000, reserved_minor: 0 });
    expect((await h.as(a.owner, "GET", L(a.orgId, "/available"))).status).toBe(400);
    expect((await h.as(a.owner, "GET", L(a.orgId, "/available?currency=usd"))).status).toBe(400);

    const j = await json<{ journal: { id: string; total_minor: number }; entries: unknown[] }>(await h.as(a.owner, "GET", L(a.orgId, `/journals/${a.journalId}`)));
    expect(j.journal).toMatchObject({ id: a.journalId, total_minor: 20_000 });
    expect(j.entries).toHaveLength(2);

    // Tenant isolation: B's rows through A's org and A's rows through B's org → 404; B cannot even reach A's org.
    expect((await h.as(a.owner, "GET", L(a.orgId, `/accounts/${b.payableId}/balance`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, `/journals/${b.journalId}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", L(a.orgId, `/journals/${a.journalId}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", L(a.orgId, "/accounts"))).status).toBe(404);

    // Malformed ids → 404, never 400/500.
    expect((await h.as(a.owner, "GET", L(a.orgId, "/accounts/not-a-uuid/balance"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, "/journals/not-a-uuid"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, `/journals/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, `/adjustments/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, "/adjustments/xyz"))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, `/reserves/${RANDOM_ID}`))).status).toBe(404);
    expect((await h.as(a.owner, "GET", L(a.orgId, "/reserves?status=NOPE"))).status).toBe(400);
  });

  it("no route posts a raw journal or ledger entry (404), and the ledger stays untouched", async () => {
    const a = await affiliate("a2@traffic.example", "Aff");
    const plat = await platformUser("fin2@traffic.example", "SUPER_ADMIN");
    const before = count("SELECT COUNT(*) AS n FROM journal_entries") + count("SELECT COUNT(*) AS n FROM ledger_entries");
    const raw = { journal_type: "FUNDING", currency: "USD", legs: [{ account_id: a.cashId, direction: "DEBIT", amount_minor: 1 }] };
    for (const path of ["/journals", `/journals/${a.journalId}`, "/entries", `/journals/${a.journalId}/entries`, `/accounts/${a.payableId}/balance`, "/accounts"]) {
      expect((await h.as(a.owner, "POST", L(a.orgId, path), raw)).status).toBe(404);
      expect((await h.as(plat.token, "POST", L(plat.orgId, path), raw)).status).toBe(404);
      expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, path), raw)).status).toBe(404);
    }
    for (const path of [`/journals/${a.journalId}`, `/accounts/${a.payableId}/balance`]) {
      expect((await h.as(a.owner, "PUT", L(a.orgId, path), raw)).status).toBe(404);
      expect((await h.as(a.owner, "PATCH", L(a.orgId, path), raw)).status).toBe(404);
      expect((await h.as(a.owner, "DELETE", L(a.orgId, path))).status).toBe(404);
    }
    expect(count("SELECT COUNT(*) AS n FROM journal_entries") + count("SELECT COUNT(*) AS n FROM ledger_entries")).toBe(before);
  });
});

describe("ledger HTTP — RBAC matrix", () => {
  it("tenant roles: only AFFILIATE_OWNER holds ledger.read; no tenant seat can request/post adjustments or place reserves (403, nothing written)", async () => {
    const a = await affiliate("a3@traffic.example", "Aff");
    const user = await member(a.owner, a.orgId, "user3@traffic.example", "AFFILIATE_USER");
    const viewer = await member(a.owner, a.orgId, "viewer3@traffic.example", "VIEWER");

    // ledger.read: AFFILIATE_OWNER yes; AFFILIATE_USER / VIEWER no (0004 grants).
    expect((await h.as(a.owner, "GET", L(a.orgId, "/accounts"))).status).toBe(200);
    expect((await h.as(a.owner, "GET", L(a.orgId, "/reserves"))).status).toBe(200);
    for (const token of [user, viewer]) {
      expect((await h.as(token, "GET", L(a.orgId, "/accounts"))).status).toBe(403);
      expect((await h.as(token, "GET", L(a.orgId, `/accounts/${a.payableId}/balance`))).status).toBe(403);
      expect((await h.as(token, "GET", L(a.orgId, `/journals/${a.journalId}`))).status).toBe(403);
    }
    for (const token of [a.owner, user, viewer]) {
      const req = await h.as(token, "POST", L(a.orgId, "/adjustments"), adjustmentBody(a));
      expect(req.status).toBe(403);
      expect(await h.errorCode(req)).toBe("FORBIDDEN");
      expect((await h.as(token, "POST", L(a.orgId, `/adjustments/${RANDOM_ID}/post`), {})).status).toBe(403);
      expect((await h.as(token, "POST", L(a.orgId, "/reserves"), reserveBody())).status).toBe(403);
      expect((await h.as(token, "POST", L(a.orgId, `/reserves/${RANDOM_ID}/release`), {})).status).toBe(403);
      // approve / reject do not exist on the tenant face at all.
      expect((await h.as(token, "POST", L(a.orgId, `/adjustments/${RANDOM_ID}/approve`), {})).status).toBe(404);
      expect((await h.as(token, "POST", L(a.orgId, `/adjustments/${RANDOM_ID}/reject`), {})).status).toBe(404);
      // The platform face is unreachable for a tenant seat (no membership in a PLATFORM org → 404).
      expect((await h.as(token, "POST", P(a.orgId, a.orgId, "/adjustments"), adjustmentBody(a))).status).toBe(403);
    }
    expect(count("SELECT COUNT(*) AS n FROM financial_adjustments")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM reserves")).toBe(0);
  });

  it("platform face: ANALYST (ledger.read only) 403 on every write; FINANCE_MANAGER has adjust/approve/reserve; non-member of the platform org 404", async () => {
    const a = await affiliate("a4@traffic.example", "Aff");
    const fin = await platformUser("fin4@traffic.example", "FINANCE_MANAGER");
    const analyst = await platformUser("an4@traffic.example", "ANALYST");
    const adj = await requestAdj(fin, a);

    expect((await h.as(analyst.token, "GET", P(fin.orgId, a.orgId, `/adjustments/${adj.id}`))).status).toBe(200);
    expect((await h.as(analyst.token, "GET", P(fin.orgId, a.orgId, "/available?currency=USD"))).status).toBe(200);
    for (const [path, body] of [
      ["/adjustments", adjustmentBody(a)],
      [`/adjustments/${adj.id}/approve`, {}],
      [`/adjustments/${adj.id}/reject`, {}],
      [`/adjustments/${adj.id}/post`, {}],
      ["/reserves", reserveBody()],
      [`/reserves/${RANDOM_ID}/release`, {}],
    ] as const) {
      const res = await h.as(analyst.token, "POST", P(fin.orgId, a.orgId, path), body);
      expect(res.status).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
    // Finance manager with ledger.reserve places and releases a reserve on the affiliate's ledger.
    const placed = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/reserves"), reserveBody());
    expect(placed.status).toBe(201);
    const r = (await json<{ reserve: Reserve; available_after: { reserved_minor: number } }>(placed));
    expect(r.available_after.reserved_minor).toBe(1000);
    const released = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, `/reserves/${r.reserve.id}/release`), { reason: "cleared" });
    expect(released.status).toBe(200);
    expect((await json<{ reserve: Reserve }>(released)).reserve.status).toBe("RELEASED");
    expect((await h.as(fin.token, "POST", P(fin.orgId, a.orgId, `/reserves/${r.reserve.id}/release`), {})).status).toBe(409);
    // The tenant sees its reserve read-only.
    expect((await json<{ items: Reserve[] }>(await h.as(a.owner, "GET", L(a.orgId, "/reserves?status=RELEASED")))).items).toHaveLength(1);

    // A user who is not a member of the platform org → 404 (no org enumeration).
    expect((await h.as(a.owner, "GET", P(fin.orgId, a.orgId, `/adjustments/${adj.id}`))).status).toBe(404);
    // Malformed target tenant / adjustment id → 404.
    expect((await h.as(fin.token, "GET", P(fin.orgId, "not-a-uuid", `/adjustments/${adj.id}`))).status).toBe(404);
    expect((await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/adjustments/not-a-uuid/approve"), {})).status).toBe(404);
    expect((await h.as(fin.token, "POST", P(fin.orgId, RANDOM_ID, `/adjustments/${adj.id}/approve`), {})).status).toBe(404);
  });
});

describe("ledger HTTP — adjustment lifecycle (§59 / §132)", () => {
  it("request → self-approval 409 → other platform user approves → post = ONE journal; post before approval / double post 409; tenant reads it", async () => {
    const a = await affiliate("a5@traffic.example", "Aff");
    const requester = await platformUser("req5@traffic.example", "FINANCE_MANAGER");
    const approver = await platformUser("appr5@traffic.example", "SUPER_ADMIN");
    const adj = await requestAdj(requester, a);
    expect(adj.status).toBe("REQUESTED");

    // Post before approval → 409, no journal.
    const early = await h.as(requester.token, "POST", P(requester.orgId, a.orgId, `/adjustments/${adj.id}/post`), {});
    expect(early.status).toBe(409);
    expect(await h.errorCode(early)).toBe("ADJUSTMENT_NOT_APPROVED");

    // §132: the requester cannot approve their own adjustment.
    const self = await h.as(requester.token, "POST", P(requester.orgId, a.orgId, `/adjustments/${adj.id}/approve`), { note: "me" });
    expect(self.status).toBe(409);
    expect(await h.errorCode(self)).toBe("ADJUSTMENT_SELF_APPROVAL");
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ledger.adjustment.approved'")).toBe(0);

    // Body validation on approve: unknown field → 400.
    expect((await h.as(approver.token, "POST", P(approver.orgId, a.orgId, `/adjustments/${adj.id}/approve`), { status: "POSTED" })).status).toBe(400);

    const ok = await h.as(approver.token, "POST", P(approver.orgId, a.orgId, `/adjustments/${adj.id}/approve`), { note: "verified T-42" });
    expect(ok.status).toBe(200);
    const approved = (await json<{ adjustment: Adjustment }>(ok)).adjustment;
    expect(approved.status).toBe("APPROVED");
    expect(approved.approved_by_user_id).not.toBe(approved.requested_by_user_id);
    // Approving / rejecting again → 409 (not REQUESTED).
    expect((await h.as(approver.token, "POST", P(approver.orgId, a.orgId, `/adjustments/${adj.id}/approve`), {})).status).toBe(409);
    expect((await h.as(approver.token, "POST", P(approver.orgId, a.orgId, `/adjustments/${adj.id}/reject`), {})).status).toBe(409);

    const journalsBefore = count("SELECT COUNT(*) AS n FROM journal_entries");
    const posted = await h.as(requester.token, "POST", P(requester.orgId, a.orgId, `/adjustments/${adj.id}/post`), {});
    expect(posted.status).toBe(200);
    const result = await json<{ outcome: string; adjustment: Adjustment; journal: { id: string; total_minor: number } }>(posted);
    expect(result.outcome).toBe("POSTED");
    expect(result.adjustment.status).toBe("POSTED");
    expect(result.journal.total_minor).toBe(2500);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries")).toBe(journalsBefore + 1);
    expect(count("SELECT COUNT(*) AS n FROM ledger_entries WHERE journal_id = ?", result.journal.id)).toBe(2);

    const again = await h.as(requester.token, "POST", P(requester.orgId, a.orgId, `/adjustments/${adj.id}/post`), {});
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("ADJUSTMENT_ALREADY_POSTED");
    expect(count("SELECT COUNT(*) AS n FROM journal_entries")).toBe(journalsBefore + 1);

    // Tenant reads the adjustment, its history and the resulting balance / journal.
    const detail = await json<{ adjustment: Adjustment; history: Array<{ to_status: string; actor_type: string }> }>(
      await h.as(a.owner, "GET", L(a.orgId, `/adjustments/${adj.id}`)),
    );
    expect(detail.adjustment.journal_id).toBe(result.journal.id);
    expect(detail.history.map((x) => x.to_status)).toEqual(["REQUESTED", "APPROVED", "POSTED"]);
    expect(new Set(detail.history.map((x) => x.actor_type))).toEqual(new Set(["PLATFORM"]));
    const bal = await json<{ balance: { balance_minor: number } }>(await h.as(a.owner, "GET", L(a.orgId, `/accounts/${a.payableId}/balance`)));
    expect(bal.balance.balance_minor).toBe(22_500);
    expect((await h.as(a.owner, "GET", L(a.orgId, `/journals/${result.journal.id}`))).status).toBe(200);
    // Another tenant cannot see it.
    const b = await affiliate("b5@traffic.example", "Other", 100);
    expect((await h.as(b.owner, "GET", L(b.orgId, `/adjustments/${adj.id}`))).status).toBe(404);
    expect((await h.as(b.owner, "GET", L(b.orgId, `/journals/${result.journal.id}`))).status).toBe(404);
  });

  it("reject path and account tenancy: counter account of another tenant → 404 at request time", async () => {
    const a = await affiliate("a6@traffic.example", "Aff");
    const b = await affiliate("b6@traffic.example", "Other", 100);
    const fin = await platformUser("fin6@traffic.example", "FINANCE_MANAGER");
    const admin = await platformUser("adm6@traffic.example", "SUPER_ADMIN");
    const adj = await requestAdj(fin, a);
    const rejected = await h.as(admin.token, "POST", P(admin.orgId, a.orgId, `/adjustments/${adj.id}/reject`), { note: "no ticket" });
    expect(rejected.status).toBe(200);
    expect((await json<{ adjustment: Adjustment }>(rejected)).adjustment.status).toBe("REJECTED");
    expect((await h.as(fin.token, "POST", P(fin.orgId, a.orgId, `/adjustments/${adj.id}/post`), {})).status).toBe(409);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'ADJUSTMENT'")).toBe(0);

    const cross = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/adjustments"), adjustmentBody(a, { counter_account_id: b.adjId }));
    expect(cross.status).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM financial_adjustments")).toBe(1);
  });
});

describe("ledger HTTP — money / body validation 400 matrix", () => {
  it("floats, zero, negatives, unsafe integers, bad currency, unknown enum, extra fields → 400 and nothing written", async () => {
    const a = await affiliate("a7@traffic.example", "Aff");
    const fin = await platformUser("fin7@traffic.example", "FINANCE_MANAGER");
    const bad: Array<Record<string, unknown>> = [
      { amount_minor: 12.5 },
      { amount_minor: 0 },
      { amount_minor: -100 },
      { amount_minor: Number.MAX_SAFE_INTEGER + 2 },
      { amount_minor: "2500" },
      { currency: "usd" },
      { currency: "USDT" },
      { direction: "UP" },
      { reason_code: "WHATEVER" },
      { reason_note: "" },
      { reference_type: "INVOICE" },
      { status: "APPROVED" },
      { journal_id: RANDOM_ID },
    ];
    for (const extra of bad) {
      const res = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/adjustments"), adjustmentBody(a, extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    }
    const badReserve: Array<Record<string, unknown>> = [
      { amount_minor: 1.5 },
      { amount_minor: 0 },
      { amount_minor: -1 },
      { currency: "eur" },
      { reserve_type: "MYSTERY" },
      { reason_code: "lower case" },
      { reference_type: "INVOICE" },
      { status: "RELEASED" },
    ];
    for (const extra of badReserve) {
      const res = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/reserves"), reserveBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    // Currency mismatch between body and accounts is the service's job → 400 too, still nothing written.
    expect((await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/adjustments"), adjustmentBody(a, { currency: "EUR" }))).status).toBe(400);
    expect(count("SELECT COUNT(*) AS n FROM financial_adjustments")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM reserves")).toBe(0);
    // Coverage: reserve larger than available with require_coverage → 409, none placed.
    const over = await h.as(fin.token, "POST", P(fin.orgId, a.orgId, "/reserves"), reserveBody({ amount_minor: 50_000, require_coverage: true }));
    expect(over.status).toBe(409);
    expect(await h.errorCode(over)).toBe("RESERVE_EXCEEDS_AVAILABLE");
    expect(count("SELECT COUNT(*) AS n FROM reserves")).toBe(0);
  });
});
