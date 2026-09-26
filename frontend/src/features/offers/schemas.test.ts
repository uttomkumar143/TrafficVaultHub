import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERSION_FORM,
  parseTargetingLines,
  percentToBps,
  toCreatePayload,
  toVersionPayload,
  versionFormSchema,
} from "@/features/offers/schemas";

/**
 * The offer form mirrors `backend/src/routes/offers.ts`: the payload that
 * leaves the browser carries integer `*_minor` fields + `currency` only —
 * never a float, never a combined "price" (PRD §25).
 */
describe("offer schemas", () => {
  const base = {
    ...DEFAULT_VERSION_FORM,
    advertiser_payout: "50.00",
    affiliate_commission: "40",
    network_margin: "10",
    conversion_event: "signup",
    destination_url: "https://track.example/click",
  };

  it("accepts a valid CPA version and emits integer minor units", () => {
    const parsed = versionFormSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    const payload = toVersionPayload(base);
    expect(payload).toMatchObject({
      payout_type: "CPA",
      currency: "USD",
      advertiser_payout_minor: 5000,
      affiliate_commission_minor: 4000,
      network_margin_minor: 1000,
      attribution_window_seconds: 30 * 86_400,
      conversion_event: "signup",
      destination_url: "https://track.example/click",
    });
    for (const v of Object.values(payload)) {
      if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }
    expect(payload).not.toHaveProperty("advertiser_payout");
    expect(payload).not.toHaveProperty("price");
  });

  it("rejects a commission above the payout and sub-minor precision", () => {
    const over = versionFormSchema.safeParse({ ...base, affiliate_commission: "60" });
    expect(over.success).toBe(false);
    expect(JSON.stringify(over.error?.issues)).toContain("Commission cannot exceed");

    const precise = versionFormSchema.safeParse({ ...base, advertiser_payout: "50.005" });
    expect(precise.success).toBe(false);
  });

  it("requires a percentage for REVSHARE and converts it to basis points", () => {
    const missing = versionFormSchema.safeParse({ ...base, payout_type: "REVSHARE", revshare_percent: "" });
    expect(missing.success).toBe(false);
    const ok = { ...base, payout_type: "REVSHARE" as const, revshare_percent: "12.5", advertiser_payout: "0", affiliate_commission: "0", network_margin: "0" };
    expect(versionFormSchema.safeParse(ok).success).toBe(true);
    expect(toVersionPayload(ok).revshare_percent_bps).toBe(1250);
    expect(percentToBps("100")).toBe(10000);
    expect(percentToBps("0.01")).toBe(1);
    expect(versionFormSchema.safeParse({ ...ok, revshare_percent: "150" }).success).toBe(false);
  });

  it("parses DIMENSION=value targeting lines and rejects unknown dimensions", () => {
    expect(parseTargetingLines("COUNTRY=US\n device = MOBILE \n\nCOUNTRY=US")).toEqual({
      rules: [
        { dimension: "COUNTRY", value: "US" },
        { dimension: "DEVICE", value: "MOBILE" },
      ],
      error: null,
    });
    expect(parseTargetingLines("PLANET=MARS").error).toMatch(/Unknown dimension/);
    expect(parseTargetingLines("nonsense").error).toMatch(/DIMENSION=value/);
    expect(versionFormSchema.safeParse({ ...base, targeting_lines: "PLANET=MARS" }).success).toBe(false);
  });

  it("builds the create payload with the version nested and empty optionals omitted", () => {
    const payload = toCreatePayload(
      { name: "Finance CPA", vertical: "", description: "", access_mode: "PUBLIC" },
      { ...base, targeting_lines: "COUNTRY=US" },
    );
    expect(payload).toEqual({
      name: "Finance CPA",
      access_mode: "PUBLIC",
      version: expect.objectContaining({ advertiser_payout_minor: 5000, affiliate_commission_minor: 4000 }),
      targeting: [{ dimension: "COUNTRY", value: "US" }],
    });
    expect(payload).not.toHaveProperty("vertical");
    // No tenant identifiers are ever part of the body (PRD §94).
    expect(JSON.stringify(payload)).not.toMatch(/organization_id|advertiser_id|tenant_id/);
  });
});
