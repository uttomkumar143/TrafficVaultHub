import { describe, expect, it } from "vitest";
import { CHECK_NAMES, validateConversion, type ValidationFacts } from "./validation";

function facts(overrides: Partial<ValidationFacts> = {}): ValidationFacts {
  return {
    advertiser: { organizationId: "adv-1", organizationType: "ADVERTISER", organizationStatus: "ACTIVE" },
    offer: {
      id: "offer-1",
      organizationId: "adv-1",
      status: "LIVE",
      conversionEvents: ["SALE", "LEAD"],
      requiresClick: true,
      requiresSaleAmount: true,
      allowedCurrencies: ["USD", "EUR"],
      minSaleAmountMinor: 100,
    },
    click: { id: "click-1", offerId: "offer-1", affiliateOrganizationId: "aff-1", occurredAt: "2026-09-01T10:00:00.000Z" },
    affiliate: { organizationId: "aff-1", organizationStatus: "ACTIVE", hasOfferAccess: true },
    conversion: {
      conversionEvent: "SALE",
      saleAmountMinor: 2500,
      currency: "USD",
      occurredAt: "2026-09-01T10:30:00.000Z",
      receivedAt: "2026-09-01T10:31:00.000Z",
    },
    attribution: { decision: "ATTRIBUTED", reasonCode: "CLICK_MATCHED_LAST" },
    dedup: { duplicateOfConversionId: null },
    trafficRules: { affiliateRestricted: false, geoAllowed: true, deviceAllowed: true },
    fraud: { score: 12, level: "LOW" },
    ...overrides,
  };
}

describe("conversion validation pipeline (PRD §38–§40)", () => {
  it("passes a clean conversion through all eleven checks in order", () => {
    const r = validateConversion(facts());
    expect(r.outcome).toBe("PASS");
    expect(r.reasonCode).toBe("VALIDATION_PASSED");
    expect(r.checks.map((c) => c.check)).toEqual([...CHECK_NAMES]);
    expect(r.checks.every((c) => c.status === "PASS")).toBe(true);
  });

  it("stops at the first hard failure and reports later checks as SKIPPED (cheap → expensive)", () => {
    const r = validateConversion(facts({ offer: null }));
    expect(r.outcome).toBe("REJECT");
    expect(r.reasonCode).toBe("OFFER_NOT_FOUND");
    expect(r.checks[0]).toMatchObject({ check: "ADVERTISER_IDENTITY", status: "PASS" });
    expect(r.checks[1]).toMatchObject({ check: "OFFER", status: "FAIL", code: "OFFER_NOT_FOUND" });
    expect(r.checks.slice(2).every((c) => c.status === "SKIPPED")).toBe(true);
  });

  it("rejects on identity / ownership / liveness / access facts", () => {
    expect(validateConversion(facts({ advertiser: null })).reasonCode).toBe("ADVERTISER_NOT_FOUND");
    expect(
      validateConversion(facts({ advertiser: { organizationId: "x", organizationType: "AFFILIATE", organizationStatus: "ACTIVE" } }))
        .reasonCode,
    ).toBe("ORGANIZATION_NOT_ADVERTISER");
    expect(
      validateConversion(
        facts({ advertiser: { organizationId: "adv-1", organizationType: "ADVERTISER", organizationStatus: "SUSPENDED" } }),
      ).reasonCode,
    ).toBe("ADVERTISER_INACTIVE");
    expect(validateConversion(facts({ offer: { ...facts().offer!, organizationId: "adv-2" } })).reasonCode).toBe("OFFER_NOT_OWNED");
    expect(validateConversion(facts({ offer: { ...facts().offer!, status: "DRAFT" } })).reasonCode).toBe("OFFER_NOT_LIVE");
    expect(validateConversion(facts({ click: null })).reasonCode).toBe("CLICK_REQUIRED");
    expect(validateConversion(facts({ click: { ...facts().click!, offerId: "offer-9" } })).reasonCode).toBe("CLICK_OFFER_MISMATCH");
    expect(validateConversion(facts({ affiliate: null })).reasonCode).toBe("AFFILIATE_NOT_FOUND");
    expect(validateConversion(facts({ affiliate: { ...facts().affiliate!, hasOfferAccess: false } })).reasonCode).toBe(
      "AFFILIATE_NO_OFFER_ACCESS",
    );
    expect(validateConversion(facts({ affiliate: { ...facts().affiliate!, organizationId: "aff-2" } })).reasonCode).toBe(
      "AFFILIATE_CLICK_MISMATCH",
    );
    // No click and offer does not require one → optional path passes.
    const noClick = validateConversion(facts({ click: null, affiliate: null, offer: { ...facts().offer!, requiresClick: false } }));
    expect(noClick.outcome).toBe("PASS");
  });

  it("rejects on event, timestamp, attribution and dedup facts", () => {
    expect(validateConversion(facts({ conversion: { ...facts().conversion, conversionEvent: "INSTALL" } })).reasonCode).toBe(
      "EVENT_NOT_CONFIGURED",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, occurredAt: "2026-09-01T11:00:00.000Z" } })).reasonCode).toBe(
      "OCCURRED_IN_FUTURE",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, occurredAt: "2026-01-01T00:00:00.000Z" } })).reasonCode).toBe(
      "OCCURRED_TOO_OLD",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, occurredAt: "2026-09-01T09:59:00.000Z" } })).reasonCode).toBe(
      "CONVERSION_BEFORE_CLICK",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, occurredAt: "not-a-date" } })).reasonCode).toBe(
      "TIMESTAMP_INVALID",
    );
    expect(validateConversion(facts({ attribution: null })).reasonCode).toBe("ATTRIBUTION_MISSING");
    expect(validateConversion(facts({ attribution: { decision: "REJECTED", reasonCode: "NO_CLICK_IN_WINDOW" } })).reasonCode).toBe(
      "NO_CLICK_IN_WINDOW",
    );
    const dup = validateConversion(facts({ dedup: { duplicateOfConversionId: "conv-0" } }));
    expect(dup).toMatchObject({ outcome: "REJECT", reasonCode: "DUPLICATE_CONVERSION" });
    expect(dup.checks.find((c) => c.check === "DEDUP")).toMatchObject({ detail: "conv-0" });
  });

  it("rejects on traffic rules and offer-specific money requirements (integer minor units only)", () => {
    expect(
      validateConversion(facts({ trafficRules: { affiliateRestricted: false, geoAllowed: false, deviceAllowed: true } })).reasonCode,
    ).toBe("GEO_NOT_ALLOWED");
    expect(
      validateConversion(facts({ trafficRules: { affiliateRestricted: false, geoAllowed: null, deviceAllowed: false } })).reasonCode,
    ).toBe("DEVICE_NOT_ALLOWED");
    expect(validateConversion(facts({ conversion: { ...facts().conversion, saleAmountMinor: null, currency: null } })).reasonCode).toBe(
      "SALE_AMOUNT_REQUIRED",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, saleAmountMinor: 12.5 } })).reasonCode).toBe(
      "SALE_AMOUNT_NOT_INTEGER",
    );
    expect(validateConversion(facts({ conversion: { ...facts().conversion, currency: "GBP" } })).reasonCode).toBe("CURRENCY_NOT_ALLOWED");
    expect(validateConversion(facts({ conversion: { ...facts().conversion, saleAmountMinor: 50 } })).reasonCode).toBe(
      "SALE_AMOUNT_BELOW_MINIMUM",
    );
  });

  it("HOLDs (never rejects) on soft signals and keeps running so the reviewer sees everything", () => {
    const r = validateConversion(
      facts({
        affiliate: { ...facts().affiliate!, organizationStatus: "RESTRICTED" },
        attribution: { decision: "HELD", reasonCode: "WINDOW_EDGE" },
        fraud: { score: 91, level: "CRITICAL" },
      }),
    );
    expect(r.outcome).toBe("HOLD");
    expect(r.reasonCode).toBe("AFFILIATE_RESTRICTED"); // first HOLD in pipeline order
    expect(r.checks.filter((c) => c.status === "HOLD").map((c) => c.code)).toEqual([
      "AFFILIATE_RESTRICTED",
      "WINDOW_EDGE",
      "FRAUD_CRITICAL",
    ]);
    expect(r.checks.some((c) => c.status === "SKIPPED")).toBe(false);
    // A score alone never rejects: HIGH → HOLD, MEDIUM → PASS.
    expect(validateConversion(facts({ fraud: { score: 70, level: "HIGH" } }))).toMatchObject({ outcome: "HOLD", reasonCode: "FRAUD_HIGH" });
    expect(validateConversion(facts({ fraud: { score: 40, level: "MEDIUM" } })).outcome).toBe("PASS");
    expect(validateConversion(facts({ fraud: null })).checks.find((c) => c.check === "FRAUD_SIGNALS")).toMatchObject({
      code: "NOT_SCORED",
    });
    expect(validateConversion(facts({ trafficRules: { affiliateRestricted: true, geoAllowed: true, deviceAllowed: true } }))).toMatchObject(
      {
        outcome: "HOLD",
        reasonCode: "AFFILIATE_TRAFFIC_RESTRICTED",
      },
    );
    // A hard failure after a hold still wins: REJECT.
    expect(
      validateConversion(facts({ fraud: { score: 91, level: "CRITICAL" }, conversion: { ...facts().conversion, currency: "GBP" } })),
    ).toMatchObject({ outcome: "REJECT", reasonCode: "CURRENCY_NOT_ALLOWED" });
  });
});
