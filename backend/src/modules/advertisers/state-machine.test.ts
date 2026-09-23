/**
 * Phase 2 Unit 1 — advertiser lifecycle state machine (PRD §16, §124, §132).
 * Pure-function tests: which actor may drive which edge, terminal state,
 * reason requirements, submission completeness.
 */
import { describe, expect, it } from "vitest";
import {
  ADVERTISER_STATUSES,
  allowedTargets,
  canTransition,
  isAdvertiserStatus,
  missingSubmissionFields,
  requiresReason,
  SUBMITTABLE_STATUSES,
  TERMINAL_STATUS,
  type AdvertiserStatus,
} from "./state-machine";

describe("advertiser state machine", () => {
  it("enumerates exactly the PRD §16 statuses", () => {
    expect([...ADVERTISER_STATUSES].sort()).toEqual(
      [
        "REGISTERED",
        "EMAIL_VERIFIED",
        "BUSINESS_REVIEW",
        "COMPLIANCE_REVIEW",
        "BILLING_SETUP",
        "APPROVED",
        "ACTIVE",
        "MORE_INFORMATION_REQUIRED",
        "RESTRICTED",
        "SUSPENDED",
        "TERMINATED",
      ].sort(),
    );
    expect(isAdvertiserStatus("ACTIVE")).toBe(true);
    expect(isAdvertiserStatus("DELETED")).toBe(false);
  });

  it("walks the happy path with the correct actor at every step", () => {
    expect(canTransition("REGISTERED", "EMAIL_VERIFIED", "SYSTEM")).toBe(true);
    expect(canTransition("EMAIL_VERIFIED", "BUSINESS_REVIEW", "TENANT")).toBe(true);
    expect(canTransition("BUSINESS_REVIEW", "COMPLIANCE_REVIEW", "PLATFORM")).toBe(true);
    expect(canTransition("COMPLIANCE_REVIEW", "BILLING_SETUP", "PLATFORM")).toBe(true);
    expect(canTransition("BILLING_SETUP", "APPROVED", "PLATFORM")).toBe(true);
    expect(canTransition("APPROVED", "ACTIVE", "PLATFORM")).toBe(true);
  });

  it("never lets the tenant approve or activate itself (PRD §132)", () => {
    const platformOnly: Array<[AdvertiserStatus, AdvertiserStatus]> = [
      ["BUSINESS_REVIEW", "COMPLIANCE_REVIEW"],
      ["COMPLIANCE_REVIEW", "BILLING_SETUP"],
      ["BILLING_SETUP", "APPROVED"],
      ["APPROVED", "ACTIVE"],
      ["SUSPENDED", "ACTIVE"],
      ["RESTRICTED", "ACTIVE"],
    ];
    for (const [from, to] of platformOnly) {
      expect(canTransition(from, to, "TENANT"), `${from} → ${to} by TENANT`).toBe(false);
      expect(canTransition(from, to, "SYSTEM"), `${from} → ${to} by SYSTEM`).toBe(false);
    }
    // The tenant's only powers: submit and re-submit.
    for (const s of ADVERTISER_STATUSES) {
      const targets = allowedTargets(s, "TENANT");
      if (SUBMITTABLE_STATUSES.includes(s)) expect(targets).toEqual(["BUSINESS_REVIEW"]);
      else expect(targets).toEqual([]);
    }
  });

  it("does not let the platform skip the tenant's submission", () => {
    expect(canTransition("EMAIL_VERIFIED", "BUSINESS_REVIEW", "PLATFORM")).toBe(false);
    expect(canTransition("REGISTERED", "BUSINESS_REVIEW", "PLATFORM")).toBe(false);
    expect(canTransition("REGISTERED", "ACTIVE", "PLATFORM")).toBe(false);
  });

  it("TERMINATED is terminal for every actor", () => {
    for (const to of ADVERTISER_STATUSES) {
      expect(canTransition(TERMINAL_STATUS, to, "PLATFORM")).toBe(false);
      expect(canTransition(TERMINAL_STATUS, to, "TENANT")).toBe(false);
      expect(canTransition(TERMINAL_STATUS, to, "SYSTEM")).toBe(false);
    }
  });

  it("rejects self-transitions", () => {
    for (const s of ADVERTISER_STATUSES) {
      expect(canTransition(s, s, "PLATFORM")).toBe(false);
    }
  });

  it("requires a reason only for restrictive targets (PRD §124)", () => {
    expect(requiresReason("MORE_INFORMATION_REQUIRED")).toBe(true);
    expect(requiresReason("RESTRICTED")).toBe(true);
    expect(requiresReason("SUSPENDED")).toBe(true);
    expect(requiresReason("TERMINATED")).toBe(true);
    expect(requiresReason("ACTIVE")).toBe(false);
    expect(requiresReason("APPROVED")).toBe(false);
    expect(requiresReason("COMPLIANCE_REVIEW")).toBe(false);
  });

  it("reports the exact onboarding fields still missing before submission", () => {
    expect(missingSubmissionFields({})).toEqual([
      "company_name",
      "website_url",
      "business_category",
      "legal_name",
      "country_code",
      "contact_name",
      "contact_email",
    ]);
    expect(
      missingSubmissionFields({
        company_name: "Acme",
        website_url: "https://acme.example",
        business_category: "ECOMMERCE",
        legal_name: "  ",
        country_code: "US",
        contact_name: "Ann",
        contact_email: null,
      }),
    ).toEqual(["legal_name", "contact_email"]);
  });
});
