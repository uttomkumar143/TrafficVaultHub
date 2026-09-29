import { describe, expect, it } from "vitest";
import {
  CONVERSION_ACTORS,
  CONVERSION_STATUSES,
  allowedTargets,
  canTransition,
  guardTransition,
  isInternalOnlyTarget,
  isPayoutBlockedBy,
  requiresReason,
  type ConversionStatus,
} from "./state-machine";

describe("conversion state machine (PRD §38)", () => {
  it("walks the happy path RECEIVED → … → PAID with the right actors", () => {
    expect(canTransition("RECEIVED", "VALIDATING", "SYSTEM")).toBe(true);
    expect(canTransition("VALIDATING", "PENDING", "SYSTEM")).toBe(true);
    expect(canTransition("PENDING", "APPROVED", "TENANT")).toBe(true);
    expect(canTransition("PENDING", "APPROVED", "PLATFORM")).toBe(true);
    expect(canTransition("APPROVED", "LEDGER_POSTED", "INTERNAL")).toBe(true);
    expect(canTransition("LEDGER_POSTED", "EARNED", "INTERNAL")).toBe(true);
    expect(canTransition("EARNED", "PAYOUT_ELIGIBLE", "INTERNAL")).toBe(true);
    expect(canTransition("PAYOUT_ELIGIBLE", "PAID", "INTERNAL")).toBe(true);
  });

  it("keeps the money pipeline INTERNAL-only: no TENANT/PLATFORM/SYSTEM actor can reach it", () => {
    const money: ConversionStatus[] = ["LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"];
    for (const to of money) {
      expect(isInternalOnlyTarget(to), to).toBe(true);
      for (const from of CONVERSION_STATUSES) {
        for (const actor of ["TENANT", "PLATFORM", "SYSTEM"] as const) {
          expect(canTransition(from, to, actor), `${from}→${to} by ${actor}`).toBe(false);
        }
      }
    }
    // INTERNAL never performs a business decision.
    for (const to of ["APPROVED", "REJECTED", "FRAUD_REVIEW", "DISPUTED", "REVERSED", "PENDING"] as const) {
      for (const from of CONVERSION_STATUSES) expect(canTransition(from, to, "INTERNAL"), `${from}→${to}`).toBe(false);
    }
  });

  it("routes exceptions: PENDING → REJECTED|FRAUD_REVIEW, FRAUD_REVIEW and DISPUTED resolved by PLATFORM only", () => {
    expect(canTransition("PENDING", "REJECTED", "TENANT")).toBe(true);
    expect(canTransition("PENDING", "FRAUD_REVIEW", "SYSTEM")).toBe(true);
    expect(canTransition("PENDING", "FRAUD_REVIEW", "TENANT")).toBe(false);
    expect(allowedTargets("FRAUD_REVIEW", "PLATFORM").sort()).toEqual(["APPROVED", "REJECTED"]);
    expect(allowedTargets("FRAUD_REVIEW", "TENANT")).toEqual([]);
    expect(canTransition("REJECTED", "DISPUTED", "TENANT")).toBe(true);
    expect(allowedTargets("DISPUTED", "PLATFORM").sort()).toEqual(["APPROVED", "REJECTED"]);
    expect(allowedTargets("DISPUTED", "TENANT")).toEqual([]);
    expect(canTransition("APPROVED", "REVERSED", "TENANT")).toBe(true);
    expect(canTransition("APPROVED", "REVERSED", "PLATFORM")).toBe(true);
    // Reversal happens once: PAID and REVERSED are terminal.
    for (const from of ["PAID", "REVERSED"] as const) {
      for (const actor of CONVERSION_ACTORS) expect(allowedTargets(from, actor)).toEqual([]);
    }
    // A conversion never goes backwards or skips validation.
    expect(canTransition("APPROVED", "PENDING", "PLATFORM")).toBe(false);
    expect(canTransition("RECEIVED", "APPROVED", "PLATFORM")).toBe(false);
    expect(canTransition("REJECTED", "APPROVED", "PLATFORM")).toBe(false);
  });

  it("requires a reason for restrictive targets (PRD §124)", () => {
    for (const s of ["REJECTED", "FRAUD_REVIEW", "DISPUTED", "REVERSED"] as const) expect(requiresReason(s)).toBe(true);
    for (const s of ["APPROVED", "PENDING", "PAID"] as const) expect(requiresReason(s)).toBe(false);
  });

  it("guards: active CONVERSION_HOLD blocks → APPROVED; PAYOUT_HOLD / COMPLIANCE_BLOCK / open fraud review block → PAYOUT_ELIGIBLE", () => {
    expect(guardTransition("APPROVED", { activeHoldTypes: ["CONVERSION_HOLD"], fraudReviewOpen: false })).toEqual({
      ok: false,
      code: "CONVERSION_ON_HOLD",
      message: expect.any(String),
    });
    expect(guardTransition("APPROVED", { activeHoldTypes: ["PAYOUT_HOLD", "COMPLIANCE_BLOCK"], fraudReviewOpen: true })).toEqual({
      ok: true,
    });
    expect(guardTransition("PAYOUT_ELIGIBLE", { activeHoldTypes: ["PAYOUT_HOLD"], fraudReviewOpen: false }).ok).toBe(false);
    expect(guardTransition("PAYOUT_ELIGIBLE", { activeHoldTypes: ["COMPLIANCE_BLOCK"], fraudReviewOpen: false })).toMatchObject({
      code: "COMPLIANCE_BLOCKED",
    });
    expect(guardTransition("PAYOUT_ELIGIBLE", { activeHoldTypes: [], fraudReviewOpen: true })).toMatchObject({ code: "FRAUD_REVIEW_OPEN" });
    expect(guardTransition("PAYOUT_ELIGIBLE", { activeHoldTypes: ["CONVERSION_HOLD"], fraudReviewOpen: false })).toEqual({ ok: true });
    expect(guardTransition("PAYOUT_ELIGIBLE", { activeHoldTypes: [], fraudReviewOpen: false })).toEqual({ ok: true });
    // Holds never affect other edges.
    expect(guardTransition("REJECTED", { activeHoldTypes: ["CONVERSION_HOLD", "PAYOUT_HOLD"], fraudReviewOpen: true })).toEqual({
      ok: true,
    });
    expect(isPayoutBlockedBy({ activeHoldTypes: ["PAYOUT_HOLD"], fraudReviewOpen: false })).toBe(true);
    expect(isPayoutBlockedBy({ activeHoldTypes: [], fraudReviewOpen: false })).toBe(false);
  });
});
