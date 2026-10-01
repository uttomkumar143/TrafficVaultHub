/**
 * Phase 5 Unit 10a — payout state machine. Pure, plus ONE parity test that
 * drives every (from, to) edge through the real 0011 trigger on the TestD1 shim.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../test/d1-sqlite";
import {
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  allPayoutEdges,
  canTransitionPayout,
  checkPayoutTransition,
  isFinalPayoutStatus,
  isPayoutStatus,
  nextPayoutStatuses,
  type PayoutStatus,
} from "./state-machine";

describe("payouts/state-machine (pure)", () => {
  it("defines the §65 edges exactly: REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW → APPROVED → PROCESSING → PAID, FAILED recoverable, CANCELLED", () => {
    expect(PAYOUT_TRANSITIONS).toEqual({
      REQUESTED: ["ELIGIBILITY_CHECK", "CANCELLED"],
      ELIGIBILITY_CHECK: ["UNDER_REVIEW", "FAILED", "CANCELLED"],
      UNDER_REVIEW: ["APPROVED", "CANCELLED"],
      APPROVED: ["PROCESSING", "CANCELLED"],
      PROCESSING: ["PAID", "FAILED"],
      FAILED: ["PROCESSING", "CANCELLED"],
      PAID: [],
      CANCELLED: [],
    });
    expect(PAYOUT_STATUSES).toHaveLength(8);
    expect(isPayoutStatus("PAID")).toBe(true);
    expect(isPayoutStatus("DONE")).toBe(false);
    expect(nextPayoutStatuses("FAILED")).toEqual(["PROCESSING", "CANCELLED"]);
  });

  it("happy path is legal end to end; PAID and CANCELLED are final; self-transitions are refused", () => {
    const path: PayoutStatus[] = ["REQUESTED", "ELIGIBILITY_CHECK", "UNDER_REVIEW", "APPROVED", "PROCESSING", "PAID"];
    for (let i = 0; i < path.length - 1; i++) expect(canTransitionPayout(path[i]!, path[i + 1]!)).toBe(true);
    for (const s of PAYOUT_STATUSES) {
      expect(canTransitionPayout(s, s)).toBe(false);
      expect(canTransitionPayout("PAID", s)).toBe(false);
      expect(canTransitionPayout("CANCELLED", s)).toBe(false);
    }
    expect(isFinalPayoutStatus("PAID")).toBe(true);
    expect(isFinalPayoutStatus("CANCELLED")).toBe(true);
    expect(isFinalPayoutStatus("FAILED")).toBe(false);
    // Skips and backwards moves are illegal.
    expect(canTransitionPayout("REQUESTED", "APPROVED")).toBe(false);
    expect(canTransitionPayout("REQUESTED", "PAID")).toBe(false);
    expect(canTransitionPayout("APPROVED", "UNDER_REVIEW")).toBe(false);
    expect(canTransitionPayout("PROCESSING", "CANCELLED")).toBe(false); // must go via FAILED
    expect(canTransitionPayout("FAILED", "PAID")).toBe(false); // must go via PROCESSING
    expect(allPayoutEdges()).toHaveLength(8 * 7);
    expect(allPayoutEdges().filter((e) => e.legal)).toHaveLength(13);
  });

  it("checkPayoutTransition mirrors the 0011 row CHECKs: FAILED needs a failure_code, APPROVED needs an approver who is not the requester", () => {
    expect(checkPayoutTransition("PAID", "FAILED")).toEqual({ ok: false, error: { code: "PAYOUT_FINAL", message: expect.any(String) } });
    expect(checkPayoutTransition("REQUESTED", "PAID")).toMatchObject({ ok: false, error: { code: "PAYOUT_ILLEGAL_TRANSITION" } });

    expect(checkPayoutTransition("PROCESSING", "FAILED")).toMatchObject({ ok: false, error: { code: "PAYOUT_FAILURE_CODE_REQUIRED" } });
    expect(checkPayoutTransition("PROCESSING", "FAILED", { failure_code: "bad-code" })).toMatchObject({ ok: false, error: { code: "PAYOUT_FAILURE_CODE_REQUIRED" } });
    expect(checkPayoutTransition("PROCESSING", "FAILED", { failure_code: "BANK_REJECTED" })).toEqual({ ok: true });
    expect(checkPayoutTransition("ELIGIBILITY_CHECK", "FAILED", { failure_code: "NOT_ELIGIBLE" })).toEqual({ ok: true });

    expect(checkPayoutTransition("UNDER_REVIEW", "APPROVED")).toMatchObject({ ok: false, error: { code: "PAYOUT_APPROVER_REQUIRED" } });
    expect(checkPayoutTransition("UNDER_REVIEW", "APPROVED", { approved_by_user_id: "u1", requested_by_user_id: "u1" })).toMatchObject({ ok: false, error: { code: "PAYOUT_APPROVER_IS_REQUESTER" } });
    expect(checkPayoutTransition("UNDER_REVIEW", "APPROVED", { approved_by_user_id: "u2", requested_by_user_id: "u1" })).toEqual({ ok: true });
    expect(checkPayoutTransition("UNDER_REVIEW", "APPROVED", { approved_by_user_id: "u2", requested_by_user_id: null })).toEqual({ ok: true }); // SYSTEM-requested

    // Other edges carry no extra facts.
    expect(checkPayoutTransition("REQUESTED", "ELIGIBILITY_CHECK")).toEqual({ ok: true });
    expect(checkPayoutTransition("FAILED", "PROCESSING")).toEqual({ ok: true });
    expect(checkPayoutTransition("APPROVED", "CANCELLED")).toEqual({ ok: true });
  });
});

describe("payouts/state-machine ↔ 0011 trg_payouts_legal_transition parity (TestD1)", () => {
  const db = createTestD1();
  afterAll(() => db.close());

  const ORG = "org_aff_sm";
  const REQ = "user_req_sm";
  const APPR = "user_appr_sm";
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${REQ}', 'req@example.com'), ('${APPR}', 'appr@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ORG}', 'AFFILIATE', 'Aff SM', 'aff-sm');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('afp_sm', '${ORG}', 'ACTIVE', 'Aff SM');
    INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at)
      VALUES ('pm_sm', '${ORG}', 'afp_sm', 'BANK_TRANSFER', 'stub', 'tok_sm', 'Bank', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z');
  `);

  /** Column values that satisfy every 0011 row CHECK for a given status (so only the transition trigger decides). */
  function rowFor(status: PayoutStatus): { status: string; approved_by_user_id: string | null; approved_at: string | null; paid_at: string | null; cancelled_at: string | null; failure_code: string | null } {
    const approved = ["APPROVED", "PROCESSING", "PAID"].includes(status);
    return {
      status,
      approved_by_user_id: approved ? APPR : null,
      approved_at: approved ? "2026-01-02T00:00:00.000Z" : null,
      paid_at: status === "PAID" ? "2026-01-03T00:00:00.000Z" : null,
      cancelled_at: status === "CANCELLED" ? "2026-01-03T00:00:00.000Z" : null,
      failure_code: status === "FAILED" ? "STUB_FAILED" : null,
    };
  }

  let n = 0;
  function insertAt(status: PayoutStatus): string {
    const id = `po_sm_${++n}`;
    const r = rowFor(status);
    db.sqlite
      .prepare(
        `INSERT INTO payouts (id, organization_id, payout_method_id, amount_minor, currency, status, idempotency_key, requested_by_user_id, requested_actor_type,
                              approved_by_user_id, approved_at, paid_at, cancelled_at, failure_code)
         VALUES (?, ?, ?, 1000, 'USD', ?, ?, ?, 'TENANT', ?, ?, ?, ?, ?)`,
      )
      .run(id, ORG, "pm_sm", r.status, `idem_${id}`, REQ, r.approved_by_user_id, r.approved_at, r.paid_at, r.cancelled_at, r.failure_code);
    return id;
  }

  function tryMove(id: string, to: PayoutStatus): { ok: true } | { ok: false; message: string } {
    const r = rowFor(to);
    try {
      db.sqlite
        .prepare(`UPDATE payouts SET status = ?, approved_by_user_id = ?, approved_at = ?, paid_at = ?, cancelled_at = ?, failure_code = ? WHERE id = ?`)
        .run(r.status, r.approved_by_user_id, r.approved_at, r.paid_at, r.cancelled_at, r.failure_code, id);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  it("every one of the 56 (from, to) pairs agrees with the database trigger", () => {
    const mismatches: string[] = [];
    for (const edge of allPayoutEdges()) {
      const id = insertAt(edge.from);
      const db_result = tryMove(id, edge.to);
      if (db_result.ok !== edge.legal) {
        mismatches.push(`${edge.from} → ${edge.to}: ts=${edge.legal ? "legal" : "illegal"} db=${db_result.ok ? "accepted" : db_result.message}`);
      }
      if (!db_result.ok) {
        // From a final state BOTH trg_payouts_terminal (PAYOUT_FINAL) and trg_payouts_legal_transition
        // (PAYOUT_ILLEGAL_TRANSITION) reject; SQLite reports whichever fires first. Either name is correct.
        const accepted = isFinalPayoutStatus(edge.from) ? /PAYOUT_FINAL|PAYOUT_ILLEGAL_TRANSITION/ : /PAYOUT_ILLEGAL_TRANSITION/;
        expect(db_result.message, `${edge.from} → ${edge.to}`).toMatch(accepted);
        const pure = checkPayoutTransition(edge.from, edge.to, { failure_code: "X", approved_by_user_id: APPR, requested_by_user_id: REQ });
        expect(pure.ok).toBe(false);
        if (!pure.ok) expect(pure.error.code).toBe(isFinalPayoutStatus(edge.from) ? "PAYOUT_FINAL" : "PAYOUT_ILLEGAL_TRANSITION");
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("row CHECKs the pure guard mirrors are enforced by the DB too (FAILED without failure_code; approver == requester)", () => {
    const id = insertAt("PROCESSING");
    expect(() => db.sqlite.prepare(`UPDATE payouts SET status = 'FAILED' WHERE id = ?`).run(id)).toThrow(/CHECK/);
    const id2 = insertAt("UNDER_REVIEW");
    expect(() =>
      db.sqlite.prepare(`UPDATE payouts SET status = 'APPROVED', approved_by_user_id = ?, approved_at = '2026-01-02T00:00:00.000Z' WHERE id = ?`).run(REQ, id2),
    ).toThrow(/CHECK/);
    expect(() =>
      db.sqlite.prepare(`UPDATE payouts SET status = 'APPROVED', approved_by_user_id = ?, approved_at = '2026-01-02T00:00:00.000Z' WHERE id = ?`).run(APPR, id2),
    ).not.toThrow();
  });
});
