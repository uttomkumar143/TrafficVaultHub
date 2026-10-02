/**
 * Phase 5 Unit 13b — HTTP tests for the PLATFORM payout face
 * (`platformPayoutRoutes` under /organizations/:platformOrgId/platform)
 * through the REAL app (auth → requireOrg → requirePermission →
 * PayoutService platform entry points → D1), with the payment provider
 * injected through the `createApp` seam (`paymentProvider`).
 *
 * Covers: non-platform faces cannot call platform routes; payouts.approve /
 * payouts.release RBAC; §132 approver ≠ requester; ineligible payouts never
 * reach PAID; duplicate process = one payout / attempt / journal; PAID posts
 * exactly ONE PAYOUT journal; provider FAILED → FAILED → retry (§114);
 * history actor_type PLATFORM + audit row on the AFFILIATE org; 404s.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../lib/tenant-scope";
import { buildJournal } from "../modules/ledger/journal";
import { LedgerRepository } from "../modules/ledger/repository";
import type { CreatePayoutRequest, CreatePayoutResult, PaymentProvider } from "../modules/payouts/provider";
import { PASSWORD, RANDOM_ID, ROLE_IDS, TestHarness, json } from "./fixtures";

interface Payout {
  id: string;
  organization_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  failure_code: string | null;
  provider_reference: string | null;
}

/** Scripted provider: per-key replay like a real adapter; outcomes consumed in order, then PAID. */
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
        provider_reference: `ref-${req.idempotency_key}`,
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

let h: TestHarness;
let provider: ReturnType<typeof scripted>;
beforeEach(() => {
  provider = scripted([]);
  h = new TestHarness({ paymentProvider: provider });
});
afterEach(() => h.close());

const COMPLETE_AFFILIATE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

const NOW = "2026-03-15T12:00:00.000Z";

async function platform(email = "fin@network.example", role: keyof typeof ROLE_IDS = "SUPER_ADMIN") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, role);
  return { token, orgId };
}

/** A second platform seat (same platform org) with `role`. */
async function platformSeat(email: string, role: keyof typeof ROLE_IDS): Promise<string> {
  const token = await h.user(email);
  await h.platformOrg(email, role);
  return token;
}

/** Affiliate org with profile, a VERIFIED USD payout method and `funded` minor units of AFFILIATE_PAYABLE. */
async function affiliate(email: string, name: string, funded = 20_000) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  const methodId = crypto.randomUUID();
  h.db.sqlite
    .prepare(
      `INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
       VALUES (?, ?, ?, 'BANK_TRANSFER', 'stub', ?, 'Bank', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z')`,
    )
    .run(methodId, orgId, created.profile.id, `tok-${methodId}`);

  const ledger = new LedgerRepository(h.db);
  const t = orgId as TenantId;
  const cash = await ledger.createAccount({ organization_id: orgId, code: "CASH", account_type: "ASSET", currency: "USD", name: "Cash" });
  const ap = await ledger.createAccount({ organization_id: orgId, code: "AFFILIATE_PAYABLE", account_type: "LIABILITY", currency: "USD", name: "A/P" });
  await ledger.createAccount({ organization_id: orgId, code: "PAYOUT_CLEARING", account_type: "LIABILITY", currency: "USD", name: "Clearing" });
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
  await ledger.postJournal(draft, { actor_type: "INTERNAL", posted_by_user_id: null, request_id: null, posted_at: NOW });
  return { owner, orgId, profileId: created.profile.id, methodId, payableId: ap.id, ledger };
}

async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

function count(sql: string, ...args: string[]): number {
  return (h.db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

const requestBody = (methodId: string, key = "idem-1", amount = 10_000) => ({
  payout_method_id: methodId,
  amount_minor: amount,
  currency: "USD",
  idempotency_key: key,
});

/** Affiliate requests a payout (tenant face). */
async function requestPayout(a: { owner: string; orgId: string; methodId: string }, key = "idem-1", amount = 10_000): Promise<Payout> {
  const res = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, requestBody(a.methodId, key, amount));
  expect(res.status).toBe(201);
  return (await json<{ payout: Payout }>(res)).payout;
}

const P = (platOrg: string, affOrg: string, payoutId: string, action = "") => `/organizations/${platOrg}/platform/affiliates/${affOrg}/payouts/${payoutId}${action}`;

/** REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW via the platform eligibility route. */
async function toUnderReview(plat: { token: string; orgId: string }, affOrg: string, payoutId: string): Promise<void> {
  const res = await h.as(plat.token, "POST", P(plat.orgId, affOrg, payoutId, "/eligibility"), {});
  expect(res.status).toBe(200);
  const run = await json<{ payout: Payout; result: { eligible: boolean } }>(res);
  expect(run.result.eligible).toBe(true);
  expect(run.payout.status).toBe("UNDER_REVIEW");
}

function statusOf(payoutId: string): string {
  return (h.db.sqlite.prepare("SELECT status FROM payouts WHERE id = ?").get(payoutId) as { status: string }).status;
}

describe("payout routes — platform face", () => {
  it("affiliate / advertiser / platform VIEWER-like seats cannot call platform payout routes; affiliate face cannot approve/process", async () => {
    const plat = await platform();
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const p = await requestPayout(a);
    const advOwner = await h.user("adv@acme.example");
    const advOrg = await h.org(advOwner, "ADVERTISER", "Acme Ads");
    const viewer = await member(a.owner, a.orgId, "viewer@traffic.example", "VIEWER");

    // Non-members of the platform org → 404 (org not visible), on read and write.
    for (const token of [a.owner, advOwner, viewer]) {
      expect((await h.as(token, "GET", `/organizations/${plat.orgId}/platform/payouts`)).status).toBe(404);
      expect((await h.as(token, "GET", P(plat.orgId, a.orgId, p.id))).status).toBe(404);
      expect((await h.as(token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), {})).status).toBe(404);
      expect((await h.as(token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {})).status).toBe(404);
    }
    // An affiliate/advertiser org is not a platform org: its own members get 403/404 on the platform prefix.
    expect([403, 404]).toContain((await h.as(a.owner, "GET", `/organizations/${a.orgId}/platform/payouts`)).status);
    expect([403, 404]).toContain((await h.as(advOwner, "GET", `/organizations/${advOrg}/platform/payouts`)).status);
    expect([403, 404]).toContain((await h.as(a.owner, "POST", P(a.orgId, a.orgId, p.id, "/approve"), {})).status);

    // The affiliate face has no approve/process routes.
    expect((await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts/${p.id}/approve`, {})).status).toBe(404);
    expect((await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts/${p.id}/process`, {})).status).toBe(404);
    expect(statusOf(p.id)).toBe("REQUESTED");
    expect(count("SELECT COUNT(*) AS n FROM payout_status_history")).toBe(1);
  });

  it("RBAC on the platform org: payouts.approve approves, ANALYST (payouts.read only) reads but cannot review/approve/process; COMPLIANCE_MANAGER 403 on approve", async () => {
    const plat = await platform(); // SUPER_ADMIN: all payouts.*
    const analyst = await platformSeat("analyst@network.example", "ANALYST");
    const compliance = await platformSeat("comp@network.example", "COMPLIANCE_MANAGER");
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const p = await requestPayout(a);

    // Work queue (payouts.review): SUPER_ADMIN 200 and sees the row; ANALYST 403.
    const queue = await h.as(plat.token, "GET", `/organizations/${plat.orgId}/platform/payouts?status=REQUESTED`);
    expect(queue.status).toBe(200);
    expect((await json<{ items: Payout[] }>(queue)).items.map((i) => i.id)).toEqual([p.id]);
    expect((await h.as(analyst, "GET", `/organizations/${plat.orgId}/platform/payouts`)).status).toBe(403);

    // payouts.read: ANALYST can read list + detail of the affiliate's payouts.
    const list = await h.as(analyst, "GET", `/organizations/${plat.orgId}/platform/affiliates/${a.orgId}/payouts`);
    expect(list.status).toBe(200);
    expect((await json<{ items: Payout[] }>(list)).items).toHaveLength(1);
    expect((await h.as(analyst, "GET", P(plat.orgId, a.orgId, p.id))).status).toBe(200);
    expect((await h.as(analyst, "POST", P(plat.orgId, a.orgId, p.id, "/eligibility"), {})).status).toBe(403);
    expect((await h.as(analyst, "POST", P(plat.orgId, a.orgId, p.id, "/cancel"), {})).status).toBe(403);

    await toUnderReview(plat, a.orgId, p.id);
    for (const token of [analyst, compliance]) {
      const res = await h.as(token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), {});
      expect(res.status).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
      expect((await h.as(token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {})).status).toBe(403);
    }
    expect(statusOf(p.id)).toBe("UNDER_REVIEW");

    const ok = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), { note: "looks fine" });
    expect(ok.status).toBe(200);
    expect((await json<{ payout: Payout }>(ok)).payout.status).toBe("APPROVED");
    expect(count("SELECT COUNT(*) AS n FROM payouts WHERE status = 'PAID'")).toBe(0);
  });

  it("§132 approver == requester is refused (same user owns the affiliate and sits as platform SUPER_ADMIN); another approver succeeds", async () => {
    // One user, two seats: affiliate owner AND platform SUPER_ADMIN.
    const a = await affiliate("both@traffic.example", "Traffic Co");
    const platOrg = await h.platformOrg("both@traffic.example", "SUPER_ADMIN");
    const plat = { token: a.owner, orgId: platOrg };
    const p = await requestPayout(a);
    await toUnderReview(plat, a.orgId, p.id);

    const self = await h.as(plat.token, "POST", P(platOrg, a.orgId, p.id, "/approve"), {});
    expect(self.status).toBe(403);
    expect(statusOf(p.id)).toBe("UNDER_REVIEW");
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payout.approved'")).toBe(0);

    const other = await platformSeat("fin2@network.example", "FINANCE_MANAGER");
    const ok = await h.as(other, "POST", P(platOrg, a.orgId, p.id, "/approve"), {});
    expect(ok.status).toBe(200);
    expect(statusOf(p.id)).toBe("APPROVED");
  });

  it("ineligible payouts (PAYOUT_HOLD / COMPLIANCE_BLOCK / open fraud case / non-ACTIVE org / amount > payable) go FAILED and never reach PAID", async () => {
    const plat = await platform();
    const a = await affiliate("aff@traffic.example", "Traffic Co", 20_000);
    const advOwner = await h.user("adv@acme.example");
    const advOrg = await h.org(advOwner, "ADVERTISER", "Acme Ads");

    const run = async (key: string, seed: () => void, amount = 10_000): Promise<string[]> => {
      const p = await requestPayout(a, key, amount);
      seed();
      const res = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/eligibility"), {});
      expect(res.status).toBe(200);
      const out = await json<{ payout: Payout; result: { eligible: boolean; reasons: { code: string }[] } }>(res);
      expect(out.result.eligible).toBe(false);
      expect(out.payout.status).toBe("FAILED");
      expect(statusOf(p.id)).toBe("FAILED");
      // Approve / process on a FAILED eligibility payout (never approved) are refused edges (409), nothing paid.
      expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), {})).status).toBe(409);
      expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {})).status).toBe(409);
      return out.result.reasons.map((r) => r.code);
    };
    const hold = (id: string, type: string, source: string) =>
      h.db.sqlite.exec(`INSERT INTO conversion_holds (id, organization_id, conversion_id, affiliate_organization_id, hold_type, status, reason_code, source_type)
        VALUES ('${id}', '${advOrg}', NULL, '${a.orgId}', '${type}', 'ACTIVE', 'R', '${source}')`);
    const release = (id: string) => h.db.sqlite.exec(`UPDATE conversion_holds SET status = 'RELEASED', released_at = '${NOW}' WHERE id = '${id}'`);

    expect(await run("k-hold", () => hold("h-pay", "PAYOUT_HOLD", "FRAUD_CASE"))).toEqual(["PAYOUT_ON_HOLD"]);
    release("h-pay");
    expect(await run("k-block", () => hold("h-blk", "COMPLIANCE_BLOCK", "COMPLIANCE_CASE"))).toEqual(["COMPLIANCE_BLOCKED"]);
    release("h-blk");
    expect(
      await run("k-fraud", () =>
        h.db.sqlite.exec(
          `INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code) VALUES ('fc1', '${advOrg}', '${a.orgId}', 'OPEN', 'HIGH', 'VELOCITY')`,
        ),
      ),
    ).toEqual(["FRAUD_CASE_OPEN"]);
    h.db.sqlite.exec("UPDATE fraud_cases SET status = 'DISMISSED' WHERE id = 'fc1'");
    expect(await run("k-org", () => h.db.sqlite.exec(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = '${a.orgId}'`))).toEqual(["ORG_NOT_ACTIVE"]);
    h.db.sqlite.exec(`UPDATE organizations SET status = 'ACTIVE' WHERE id = '${a.orgId}'`);
    expect(await run("k-amount", () => undefined, 30_000)).toEqual(["AMOUNT_EXCEEDS_PAYABLE"]);

    expect(count("SELECT COUNT(*) AS n FROM payouts WHERE status = 'PAID'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM payout_attempts")).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await a.ledger.computeBalance(a.orgId as TenantId, a.payableId)).balance_minor).toBe(20_000);
  });

  it("process → PAID: exactly ONE PAYOUT journal; duplicate process → 409 with one payout / attempt / journal; history actor PLATFORM; audit on the AFFILIATE org", async () => {
    const plat = await platform();
    const a = await affiliate("aff@traffic.example", "Traffic Co", 20_000);
    const p = await requestPayout(a);
    await toUnderReview(plat, a.orgId, p.id);
    expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), {})).status).toBe(200);

    const first = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {});
    expect(first.status).toBe(200);
    const r = await json<{ outcome: string; payout: Payout; attempt: { attempt_number: number } }>(first);
    expect(r.outcome).toBe("PAID");
    expect(r.payout.status).toBe("PAID");
    expect(r.payout.provider_reference).toBe("ref-idem-1");
    expect(r.attempt.attempt_number).toBe(1);

    // Duplicate process on a final payout: refused edge, nothing new written.
    const dup = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {});
    expect(dup.status).toBe(409);
    expect(provider.calls).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM payout_attempts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT' AND organization_id = ?", a.orgId)).toBe(1);
    expect((await a.ledger.computeBalance(a.orgId as TenantId, a.payableId)).balance_minor).toBe(10_000);

    // History: request row TENANT, every platform step PLATFORM, the PAID confirmation PROVIDER
    // (sorted multiset — rows written in one batch share created_at).
    const hist = h.db.sqlite.prepare("SELECT to_status, actor_type FROM payout_status_history WHERE payout_id = ?").all(p.id) as {
      to_status: string;
      actor_type: string;
    }[];
    const sorted = hist.map((x) => `${x.to_status}:${x.actor_type}`).sort();
    expect(sorted).toEqual(["APPROVED:PLATFORM", "ELIGIBILITY_CHECK:PLATFORM", "PAID:PROVIDER", "PROCESSING:PLATFORM", "REQUESTED:TENANT", "UNDER_REVIEW:PLATFORM"]);

    // Audit rows live on the AFFILIATE org and name the platform actor org.
    const audits = h.db.sqlite
      .prepare("SELECT action, organization_id, metadata FROM audit_logs WHERE target_id = ? AND action IN ('payout.approved','payout.paid')")
      .all(p.id) as { action: string; organization_id: string; metadata: string }[];
    expect(audits.map((x) => x.action).sort()).toEqual(["payout.approved", "payout.paid"]);
    for (const row of audits) {
      expect(row.organization_id).toBe(a.orgId);
      const md = JSON.parse(row.metadata) as { actor_organization_id: string; actor_type: string };
      expect(md.actor_organization_id).toBe(plat.orgId);
      expect(md.actor_type).toBe("PLATFORM");
    }
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND target_id = ?", plat.orgId, p.id)).toBe(0);

    // Platform detail shows the attempt; the affiliate sees PAID on its own face.
    const detail = await json<{ payout: Payout; attempts: unknown[] }>(await h.as(plat.token, "GET", P(plat.orgId, a.orgId, p.id)));
    expect(detail.attempts).toHaveLength(1);
    expect((await json<{ payout: Payout }>(await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts/${p.id}`))).payout.status).toBe("PAID");
  });

  it("§114 failed provider → FAILED (no ledger effect) → retry replays the same key → FAILED again; recovering provider → PAID with one journal", async () => {
    const plat = await platform();
    const a = await affiliate("aff@traffic.example", "Traffic Co", 20_000);
    const p = await requestPayout(a);
    await toUnderReview(plat, a.orgId, p.id);
    expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/approve"), {})).status).toBe(200);

    // Script: first provider call fails.
    provider.createPayout = (() => {
      const inner = scripted(["FAILED"]);
      return async (req: CreatePayoutRequest) => {
        provider.calls++;
        return inner.createPayout(req);
      };
    })();

    const r1 = await json<{ outcome: string; payout: Payout; attempt: { attempt_number: number; outcome: string } }>(
      await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {}),
    );
    expect(r1.outcome).toBe("FAILED");
    expect(r1.payout.status).toBe("FAILED");
    expect(r1.payout.failure_code).toBe("BANK_REJECTED");
    expect(r1.attempt.attempt_number).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT'")).toBe(0);
    expect((await a.ledger.computeBalance(a.orgId as TenantId, a.payableId)).balance_minor).toBe(20_000);

    // Retry: same payout idempotency key → the provider replays the failed reference → FAILED, attempt #2.
    const r2 = await json<{ outcome: string; attempt: { attempt_number: number } }>(await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {}));
    expect(r2.outcome).toBe("FAILED");
    expect(r2.attempt.attempt_number).toBe(2);
    expect(provider.calls).toBe(2);
    const reasons = (h.db.sqlite.prepare("SELECT reason_code FROM payout_status_history WHERE payout_id = ? AND to_status = 'PROCESSING'").all(p.id) as { reason_code: string | null }[])
      .map((x) => x.reason_code)
      .sort();
    expect(reasons).toContain("RETRY");

    // Recovery: provider now accepts, returning the frozen provider_reference (0011 freezes it once set).
    provider.createPayout = async () => ({ provider: "scripted", provider_reference: "ref-idem-1", status: "PAID", replayed: true });
    const r3 = await json<{ outcome: string; payout: Payout; attempt: { attempt_number: number } }>(
      await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {}),
    );
    expect(r3.outcome).toBe("PAID");
    expect(r3.payout.status).toBe("PAID");
    expect(r3.payout.failure_code).toBeNull();
    expect(r3.attempt.attempt_number).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM payout_attempts WHERE payout_id = ?", p.id)).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM journal_entries WHERE journal_type = 'PAYOUT'")).toBe(1);
    expect((await a.ledger.computeBalance(a.orgId as TenantId, a.payableId)).balance_minor).toBe(10_000);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payout.failed' AND organization_id = ?", a.orgId)).toBe(2);
  });

  it("tenant isolation / 404s: random or malformed payout id, wrong affiliate org, payout of another affiliate; platform cancel works with reason", async () => {
    const plat = await platform();
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const b = await affiliate("aff2@other.example", "Other Co");
    const p = await requestPayout(a);

    expect((await h.as(plat.token, "GET", P(plat.orgId, a.orgId, RANDOM_ID))).status).toBe(404);
    expect((await h.as(plat.token, "GET", P(plat.orgId, a.orgId, "not-a-uuid"))).status).toBe(404);
    expect((await h.as(plat.token, "GET", P(plat.orgId, "not-an-org", p.id))).status).toBe(404);
    // Payout belongs to A, addressed through B's prefix → 404, and nothing changes.
    expect((await h.as(plat.token, "GET", P(plat.orgId, b.orgId, p.id))).status).toBe(404);
    expect((await h.as(plat.token, "POST", P(plat.orgId, b.orgId, p.id, "/eligibility"), {})).status).toBe(404);
    expect((await h.as(plat.token, "POST", P(plat.orgId, b.orgId, p.id, "/cancel"), {})).status).toBe(404);
    expect((await h.as(plat.token, "POST", P(plat.orgId, RANDOM_ID, p.id, "/approve"), {})).status).toBe(404);
    expect(statusOf(p.id)).toBe("REQUESTED");
    expect(count("SELECT COUNT(*) AS n FROM payout_status_history")).toBe(1);

    const cancel = await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/cancel"), { reason: "duplicate request" });
    expect(cancel.status).toBe(200);
    expect((await json<{ payout: Payout }>(cancel)).payout.status).toBe("CANCELLED");
    const last = h.db.sqlite.prepare("SELECT actor_type FROM payout_status_history WHERE payout_id = ? AND to_status = 'CANCELLED'").get(p.id) as { actor_type: string };
    expect(last.actor_type).toBe("PLATFORM");
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payout.cancelled' AND organization_id = ?", a.orgId)).toBe(1);
    // Cancelled is final: approve / process / cancel again → 409.
    expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/cancel"), {})).status).toBe(409);
    expect((await h.as(plat.token, "POST", P(plat.orgId, a.orgId, p.id, "/process"), {})).status).toBe(409);
  });
});
