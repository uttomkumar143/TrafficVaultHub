/**
 * Phase 2 Unit 2 — affiliate lifecycle state machine (PRD §19, §21, §124, §132).
 * Pure-function tests: which actor may drive which edge, the APPEAL edge,
 * terminal state, reason requirements, submission completeness.
 */
import { describe, expect, it } from "vitest";
import {
  AFFILIATE_STATUSES,
  APPEALABLE_STATUSES,
  allowedTargets,
  canTransition,
  isAffiliateStatus,
  missingSubmissionFields,
  requiresReason,
  SUBMITTABLE_STATUSES,
  TERMINAL_STATUS,
  TRAFFIC_SOURCE_TYPES,
  type AffiliateStatus,
} from "./state-machine";

describe("affiliate state machine", () => {
  it("enumerates exactly the PRD §19 statuses", () => {
    expect([...AFFILIATE_STATUSES].sort()).toEqual(
      [
        "APPLIED",
        "EMAIL_VERIFIED",
        "UNDER_REVIEW",
        "APPROVED",
        "ACTIVE",
        "MORE_INFORMATION_REQUIRED",
        "RESTRICTED",
        "SUSPENDED",
        "APPEAL",
        "TERMINATED",
      ].sort(),
    );
    expect(isAffiliateStatus("APPEAL")).toBe(true);
    expect(isAffiliateStatus("BUSINESS_REVIEW")).toBe(false);
  });

  it("walks the happy path with the correct actor at every step", () => {
    expect(canTransition("APPLIED", "EMAIL_VERIFIED", "SYSTEM")).toBe(true);
    expect(canTransition("EMAIL_VERIFIED", "UNDER_REVIEW", "TENANT")).toBe(true);
    expect(canTransition("UNDER_REVIEW", "APPROVED", "PLATFORM")).toBe(true);
    expect(canTransition("APPROVED", "ACTIVE", "PLATFORM")).toBe(true);
  });

  it("never lets the tenant approve or activate itself (PRD §132)", () => {
    const platformOnly: Array<[AffiliateStatus, AffiliateStatus]> = [
      ["UNDER_REVIEW", "APPROVED"],
      ["APPROVED", "ACTIVE"],
      ["SUSPENDED", "ACTIVE"],
      ["RESTRICTED", "ACTIVE"],
      ["APPEAL", "ACTIVE"],
    ];
    for (const [from, to] of platformOnly) {
      expect(canTransition(from, to, "TENANT"), `${from} → ${to} by TENANT`).toBe(false);
      expect(canTransition(from, to, "SYSTEM"), `${from} → ${to} by SYSTEM`).toBe(false);
    }
    // The tenant's only powers: submit / re-submit, and appeal.
    for (const s of AFFILIATE_STATUSES) {
      const targets = allowedTargets(s, "TENANT");
      if (SUBMITTABLE_STATUSES.includes(s)) expect(targets).toEqual(["UNDER_REVIEW"]);
      else if (APPEALABLE_STATUSES.includes(s)) expect(targets).toEqual(["APPEAL"]);
      else expect(targets).toEqual([]);
    }
  });

  it("APPEAL: only the tenant may lodge it, only the platform may resolve it", () => {
    expect(canTransition("RESTRICTED", "APPEAL", "TENANT")).toBe(true);
    expect(canTransition("SUSPENDED", "APPEAL", "TENANT")).toBe(true);
    expect(canTransition("RESTRICTED", "APPEAL", "PLATFORM")).toBe(false);
    expect(canTransition("ACTIVE", "APPEAL", "TENANT")).toBe(false);
    expect(canTransition("TERMINATED", "APPEAL", "TENANT")).toBe(false);
    expect(allowedTargets("APPEAL", "PLATFORM").sort()).toEqual(["ACTIVE", "RESTRICTED", "SUSPENDED", "TERMINATED"]);
    expect(allowedTargets("APPEAL", "TENANT")).toEqual([]);
  });

  it("does not let the platform skip the tenant's submission", () => {
    expect(canTransition("EMAIL_VERIFIED", "UNDER_REVIEW", "PLATFORM")).toBe(false);
    expect(canTransition("APPLIED", "UNDER_REVIEW", "PLATFORM")).toBe(false);
    expect(canTransition("APPLIED", "ACTIVE", "PLATFORM")).toBe(false);
    expect(canTransition("EMAIL_VERIFIED", "APPROVED", "PLATFORM")).toBe(false);
  });

  it("TERMINATED is terminal for every actor", () => {
    for (const to of AFFILIATE_STATUSES) {
      expect(canTransition(TERMINAL_STATUS, to, "PLATFORM")).toBe(false);
      expect(canTransition(TERMINAL_STATUS, to, "TENANT")).toBe(false);
      expect(canTransition(TERMINAL_STATUS, to, "SYSTEM")).toBe(false);
    }
  });

  it("rejects self-transitions", () => {
    for (const s of AFFILIATE_STATUSES) {
      expect(canTransition(s, s, "PLATFORM")).toBe(false);
      expect(canTransition(s, s, "TENANT")).toBe(false);
    }
  });

  it("requires a reason only for restrictive targets (PRD §124)", () => {
    expect(requiresReason("MORE_INFORMATION_REQUIRED")).toBe(true);
    expect(requiresReason("RESTRICTED")).toBe(true);
    expect(requiresReason("SUSPENDED")).toBe(true);
    expect(requiresReason("TERMINATED")).toBe(true);
    expect(requiresReason("ACTIVE")).toBe(false);
    expect(requiresReason("APPROVED")).toBe(false);
    expect(requiresReason("APPEAL")).toBe(false);
    expect(requiresReason("UNDER_REVIEW")).toBe(false);
  });

  it("reports the exact application fields still missing before submission (website OR app)", () => {
    expect(missingSubmissionFields({})).toEqual([
      "display_name",
      "promotional_methods",
      "country_code",
      "contact_name",
      "contact_email",
      "website_url_or_app_url",
    ]);
    expect(
      missingSubmissionFields({
        display_name: "Traffic Co",
        promotional_methods: "SEO blog",
        country_code: "US",
        contact_name: "Tia",
        contact_email: "  ",
        website_url: null,
        app_url: "https://apps.example/traffic",
      }),
    ).toEqual(["contact_email"]);
    expect(TRAFFIC_SOURCE_TYPES).toHaveLength(10);
  });
});
