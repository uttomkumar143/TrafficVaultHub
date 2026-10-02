/**
 * Phase 5 Unit 13a — HTTP tests for the affiliate payout face
 * (`routes/payouts.ts` under /organizations/:orgId/payouts) through the REAL
 * app (auth → requireOrg → requirePermission → PayoutService → D1).
 *
 * Covers: 403 without permission (+ VIEWER), tenant isolation 404, idempotency
 * replay (same payout, no second row), money errors 400, foreign payout
 * method 404, no route can set status / post ledger entries, cancel only on
 * allowed edges (409 otherwise), status filter validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface Payout {
  id: string;
  organization_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string;
  cancel_reason: string | null;
  requested_actor_type: string;
}

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
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

async function affiliate(email: string, name: string) {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  const profileId = created.profile.id;
  const methodId = crypto.randomUUID();
  h.db.sqlite
    .prepare(
      `INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
       VALUES (?, ?, ?, 'BANK_TRANSFER', 'stub', ?, 'Bank', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z')`,
    )
    .run(methodId, orgId, profileId, `tok-${methodId}`);
  return { owner, orgId, profileId, methodId };
}

/** Seat `email` in `orgId` with `role`, return its token. */
async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

/** Grant an extra permission to a platform-defined role for this test DB (payouts.review lives on finance roles only). */
function grant(roleKey: string, permissionKey: string): void {
  h.db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p WHERE r.organization_id IS NULL AND r.key = ? AND p.key = ?`,
    )
    .run(roleKey, permissionKey);
}

function count(sql: string, ...args: string[]): number {
  return (h.db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

const body = (methodId: string, key = "idem-1", amount = 10_000, currency = "USD") => ({
  payout_method_id: methodId,
  amount_minor: amount,
  currency,
  idempotency_key: key,
});

describe("payout routes — affiliate face", () => {
  it("AFFILIATE_OWNER (payouts.request) requests a payout: 201 REQUESTED actor TENANT; replay of the same key → 200 SAME payout, one row", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const first = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId));
    expect(first.status).toBe(201);
    const p = (await json<{ payout: Payout }>(first)).payout;
    expect(p.status).toBe("REQUESTED");
    expect(p.organization_id).toBe(a.orgId);
    expect(p.amount_minor).toBe(10_000);
    expect(p.currency).toBe("USD");
    expect(p.requested_actor_type).toBe("TENANT");

    // Replay: same key, even with a different amount → the original row, nothing new written.
    const replay = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId, "idem-1", 99_999));
    expect(replay.status).toBe(200);
    const r = (await json<{ payout: Payout }>(replay)).payout;
    expect(r.id).toBe(p.id);
    expect(r.amount_minor).toBe(10_000);
    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM payout_status_history")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payout.requested'")).toBe(1);

    // Detail and list are readable by the owner.
    const detail = await json<{ payout: Payout; history: unknown[]; attempts: unknown[] }>(
      await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts/${p.id}`),
    );
    expect(detail.payout.id).toBe(p.id);
    expect(detail.history).toHaveLength(1);
    expect(detail.attempts).toHaveLength(0);
    const list = await json<{ items: Payout[]; next_cursor: string | null }>(await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts?status=REQUESTED`));
    expect(list.items.map((i) => i.id)).toEqual([p.id]);
    const none = await json<{ items: Payout[] }>(await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts?status=PAID`));
    expect(none.items).toHaveLength(0);
  });

  it("RBAC: AFFILIATE_USER / VIEWER (no payouts.read) 403 everywhere; payouts.read alone can read but not request; nothing written", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const viewer = await member(a.owner, a.orgId, "viewer@traffic.example", "VIEWER");
    const user = await member(a.owner, a.orgId, "user@traffic.example", "AFFILIATE_USER");
    const p = (await json<{ payout: Payout }>(await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId)))).payout;

    for (const token of [viewer, user]) {
      expect((await h.as(token, "GET", `/organizations/${a.orgId}/payouts`)).status).toBe(403);
      expect((await h.as(token, "GET", `/organizations/${a.orgId}/payouts/${p.id}`)).status).toBe(403);
      expect((await h.as(token, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId, "idem-v"))).status).toBe(403);
      expect((await h.as(token, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, {})).status).toBe(403);
    }
    // A read-only seat (AFFILIATE_USER + payouts.read in this test DB): reads 200, request / cancel 403.
    grant("AFFILIATE_USER", "payouts.read");
    const reader = await member(a.owner, a.orgId, "reader@traffic.example", "AFFILIATE_USER");
    expect((await h.as(reader, "GET", `/organizations/${a.orgId}/payouts`)).status).toBe(200);
    expect((await h.as(reader, "GET", `/organizations/${a.orgId}/payouts/${p.id}`)).status).toBe(200);
    const req = await h.as(reader, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId, "idem-m"));
    expect(req.status).toBe(403);
    expect(await h.errorCode(req)).toBe("FORBIDDEN");
    expect((await h.as(reader, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, {})).status).toBe(403);
    // The owner itself holds payouts.request but not payouts.review → cancel is 403 too (finance decides).
    expect((await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, {})).status).toBe(403);

    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM payout_status_history")).toBe(1);
    // Unauthenticated → 401.
    expect((await h.api("GET", `/organizations/${a.orgId}/payouts`)).status).toBe(401);
  });

  it("tenant isolation: another affiliate's payout and payout method are 404 (list empty); malformed id 404; bad status filter 400", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const b = await affiliate("other@clicks.example", "Clicks Ltd");
    const p = (await json<{ payout: Payout }>(await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId)))).payout;

    // B reads its own org: A's payout is invisible.
    const bList = await json<{ items: Payout[] }>(await h.as(b.owner, "GET", `/organizations/${b.orgId}/payouts`));
    expect(bList.items).toHaveLength(0);
    expect((await h.as(b.owner, "GET", `/organizations/${b.orgId}/payouts/${p.id}`)).status).toBe(404);
    expect((await h.as(b.owner, "POST", `/organizations/${b.orgId}/payouts/${p.id}/cancel`, {})).status).toBe(403); // no payouts.review; gate first
    // B is not a member of A's org at all → requireOrg 403/404 (never 200).
    expect((await h.as(b.owner, "GET", `/organizations/${a.orgId}/payouts/${p.id}`)).status).not.toBe(200);
    // A's payout method used from B's org → 404 PAYOUT_METHOD_NOT_FOUND, no row.
    const foreign = await h.as(b.owner, "POST", `/organizations/${b.orgId}/payouts`, body(a.methodId, "idem-b"));
    expect(foreign.status).toBe(404);
    expect(await h.errorCode(foreign)).toBe("PAYOUT_METHOD_NOT_FOUND");
    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    // A's idempotency key reused by B: 0011 keys are UNIQUE network-wide → 409, never A's payout replayed to B, no row.
    const clash = await h.as(b.owner, "POST", `/organizations/${b.orgId}/payouts`, body(b.methodId, "idem-1"));
    expect(clash.status).toBe(409);
    expect(await h.errorCode(clash)).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(1);
    const bOwn = await h.as(b.owner, "POST", `/organizations/${b.orgId}/payouts`, body(b.methodId, "idem-b-own"));
    expect(bOwn.status).toBe(201);
    expect((await json<{ payout: Payout }>(bOwn)).payout.id).not.toBe(p.id);

    expect((await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts/not-a-uuid`)).status).toBe(404);
    expect((await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts/${RANDOM_ID}`)).status).toBe(404);
    const bad = await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts?status=WHATEVER`);
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
  });

  it("money validation 400: float / zero / negative / unsafe amount, lowercase or 4-letter currency, method currency mismatch, missing key; nothing written", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const cases: Array<Record<string, unknown>> = [
      { ...body(a.methodId), amount_minor: 10.5 },
      { ...body(a.methodId), amount_minor: 0 },
      { ...body(a.methodId), amount_minor: -5 },
      { ...body(a.methodId), amount_minor: Number.MAX_SAFE_INTEGER + 2 },
      { ...body(a.methodId), amount_minor: "10000" },
      { ...body(a.methodId), currency: "usd" },
      { ...body(a.methodId), currency: "USDT" },
      { ...body(a.methodId), idempotency_key: "" },
      { ...body(a.methodId), status: "PAID" }, // unknown field — strict schema
      { payout_method_id: a.methodId, amount_minor: 100, currency: "USD" }, // missing key
    ];
    for (const c of cases) {
      const res = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, c);
      expect(res.status, JSON.stringify(c)).toBe(400);
    }
    // Valid shape but the method is USD → EUR request refused by the service.
    const mismatch = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId, "idem-eur", 100, "EUR"));
    expect(mismatch.status).toBe(400);
    expect(await h.errorCode(mismatch)).toBe("CURRENCY_MISMATCH_METHOD");
    expect(count("SELECT COUNT(*) AS n FROM payouts")).toBe(0);
  });

  it("no route can set status or post ledger entries: status/approve/process paths 404 here, status in body ignored, ledger tables untouched", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    const p = (await json<{ payout: Payout }>(await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId)))).payout;
    for (const path of ["eligibility", "approve", "process", "status", "transition"]) {
      const res = await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts/${p.id}/${path}`, { to: "PAID", status: "PAID" });
      expect(res.status, path).toBe(404);
    }
    expect((await h.as(a.owner, "PATCH", `/organizations/${a.orgId}/payouts/${p.id}`, { status: "PAID" })).status).toBe(404);
    expect((await h.as(a.owner, "PUT", `/organizations/${a.orgId}/payouts/${p.id}`, { status: "PAID" })).status).toBe(404);
    expect((await h.as(a.owner, "DELETE", `/organizations/${a.orgId}/payouts/${p.id}`)).status).toBe(404);
    expect((await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts/${p.id}/journal`, { legs: [] })).status).toBe(404);

    const detail = await json<{ payout: Payout }>(await h.as(a.owner, "GET", `/organizations/${a.orgId}/payouts/${p.id}`));
    expect(detail.payout.status).toBe("REQUESTED");
    expect(count("SELECT COUNT(*) AS n FROM journal_entries")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM ledger_entries")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM payout_attempts")).toBe(0);
  });

  it("cancel (payouts.review): REQUESTED → CANCELLED with reason + history + audit; CANCELLED again 409; PAID 409; reason too long 400", async () => {
    const a = await affiliate("aff@traffic.example", "Traffic Co");
    // AFFILIATE_MANAGER gets payouts.review in this test DB so the gate is exercised through a real role.
    grant("AFFILIATE_MANAGER", "payouts.review");
    const reviewer = await member(a.owner, a.orgId, "mgr@traffic.example", "AFFILIATE_MANAGER");
    const p = (await json<{ payout: Payout }>(await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId)))).payout;

    expect((await h.as(reviewer, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, { reason: "x".repeat(2001) })).status).toBe(400);

    const cancelled = await h.as(reviewer, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, { reason: "changed my mind" });
    expect(cancelled.status).toBe(200);
    const c = (await json<{ payout: Payout }>(cancelled)).payout;
    expect(c.status).toBe("CANCELLED");
    expect(c.cancel_reason).toBe("changed my mind");
    expect(count("SELECT COUNT(*) AS n FROM payout_status_history WHERE payout_id = ? AND to_status = 'CANCELLED'", p.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payout.cancelled' AND target_id = ?", p.id)).toBe(1);

    // Final state: cancel again → 409 INVALID_PAYOUT_TRANSITION.
    const again = await h.as(reviewer, "POST", `/organizations/${a.orgId}/payouts/${p.id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("INVALID_PAYOUT_TRANSITION");

    // A PAID payout (final) cannot be cancelled either — seeded directly through the legal chain.
    const paid = (await json<{ payout: Payout }>(await h.as(a.owner, "POST", `/organizations/${a.orgId}/payouts`, body(a.methodId, "idem-paid")))).payout;
    const approverId = (h.db.sqlite.prepare("SELECT id FROM users WHERE lower(email) = 'mgr@traffic.example'").get() as { id: string }).id;
    for (const [from, to] of [
      ["REQUESTED", "ELIGIBILITY_CHECK"],
      ["ELIGIBILITY_CHECK", "UNDER_REVIEW"],
      ["UNDER_REVIEW", "APPROVED"],
      ["APPROVED", "PROCESSING"],
      ["PROCESSING", "PAID"],
    ]) {
      const extra =
        to === "APPROVED"
          ? `, approved_by_user_id = '${approverId}', approved_at = '2026-03-15T00:00:00.000Z'`
          : to === "PAID"
            ? ", paid_at = '2026-03-15T00:00:00.000Z'"
            : "";
      h.db.sqlite.prepare(`UPDATE payouts SET status = ?${extra} WHERE id = ? AND status = ?`).run(to as string, paid.id, from as string);
    }
    expect((h.db.sqlite.prepare("SELECT status FROM payouts WHERE id = ?").get(paid.id) as { status: string }).status).toBe("PAID");
    const paidCancel = await h.as(reviewer, "POST", `/organizations/${a.orgId}/payouts/${paid.id}/cancel`, {});
    expect(paidCancel.status).toBe(409);
    expect(count("SELECT COUNT(*) AS n FROM payouts WHERE status = 'PAID'")).toBe(1);
    // Unknown / foreign id → 404.
    expect((await h.as(reviewer, "POST", `/organizations/${a.orgId}/payouts/${RANDOM_ID}/cancel`, {})).status).toBe(404);
  });
});
