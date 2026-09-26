/**
 * Offer / marketplace fixtures for the Phase 2 route tests. Shapes mirror the
 * backend's response types (`backend/src/modules/offers/service.ts`); money is
 * integer minor units + currency only (PRD §25). The marketplace fixture is
 * the confidential-safe projection: it never carries advertiser payout,
 * network margin or budget — exactly like the real server response.
 */
import { FIXED_TIME, ORG_A_ID } from "@/test/utils";
import type { AccessGrant, MarketplaceOffer, Offer, OfferStatus, OfferSummary, OfferTransition, OfferVersion } from "@/types/api";

export const OFFER_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
export const OFFER_ID_2 = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
export const VERSION_ID = "2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d";
export const ADVERTISER_PROFILE_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c";
export const AFFILIATE_ORG_ID = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
export const AFFILIATE_ORG_ID_2 = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

/** Advertiser tenant permissions granted to an offer manager. */
export const ADVERTISER_MANAGER_PERMISSIONS = [
  "organizations.read",
  "members.read",
  "offers.read",
  "offers.create",
  "offers.update",
  "offers.pause",
];

export function makeVersion(overrides: Partial<OfferVersion> = {}): OfferVersion {
  return {
    id: VERSION_ID,
    offer_id: OFFER_ID,
    version_number: 1,
    payout_type: "CPA",
    currency: "USD",
    advertiser_payout_minor: 4000,
    affiliate_commission_minor: 3000,
    network_margin_minor: 1000,
    revshare_percent_bps: null,
    daily_conversion_cap: 100,
    total_conversion_cap: null,
    budget_minor: 500000,
    attribution_window_seconds: 30 * 86_400,
    conversion_event: "purchase",
    destination_url: "https://advertiser.example/landing",
    targeting_starts_at: null,
    targeting_ends_at: null,
    change_summary: null,
    created_by_user_id: "11111111-1111-4111-8111-111111111111",
    created_at: FIXED_TIME,
    targeting: [{ dimension: "COUNTRY", value: "US" }],
    ...overrides,
  };
}

export function makeOfferSummary(overrides: Partial<OfferSummary> = {}): OfferSummary {
  return {
    id: OFFER_ID,
    organization_id: ORG_A_ID,
    advertiser_profile_id: ADVERTISER_PROFILE_ID,
    status: "DRAFT",
    access_mode: "PUBLIC",
    name: "Spring Shoes CPA",
    vertical: "Retail",
    description: null,
    current_version_id: VERSION_ID,
    review_notes: null,
    submitted_at: null,
    approved_at: null,
    activated_at: null,
    archived_at: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    allowed_transitions: ["SUBMITTED", "ARCHIVED"],
    ...overrides,
  };
}

export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  const { current_version, ...summary } = overrides;
  return {
    ...makeOfferSummary(summary),
    current_version: current_version === undefined ? makeVersion() : current_version,
  };
}

export function makeTransition(overrides: Partial<OfferTransition> = {}): OfferTransition {
  return {
    id: "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f",
    from_status: null,
    to_status: "DRAFT",
    actor_kind: "TENANT",
    actor_user_id: "11111111-1111-4111-8111-111111111111",
    reason: null,
    created_at: FIXED_TIME,
    ...overrides,
  };
}

export function makeGrant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    id: "7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e",
    offer_id: OFFER_ID,
    affiliate_organization_id: AFFILIATE_ORG_ID,
    status: "REQUESTED",
    reason: null,
    requested_at: FIXED_TIME,
    decided_at: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    ...overrides,
  };
}

/** Confidential-safe projection — no advertiser payout / margin / budget keys at all. */
export function makeMarketplaceOffer(overrides: Partial<MarketplaceOffer> = {}): MarketplaceOffer {
  return {
    id: OFFER_ID,
    name: "Spring Shoes CPA",
    vertical: "Retail",
    description: "Promote the spring collection.",
    access_mode: "PUBLIC",
    status: "LIVE" as OfferStatus,
    advertiser: { name: "Bravo Ads", slug: "bravo-ads", type: "ADVERTISER" },
    version: {
      version_number: 1,
      payout_type: "CPA",
      currency: "USD",
      affiliate_commission_minor: 3000,
      revshare_percent_bps: null,
      daily_conversion_cap: 100,
      total_conversion_cap: null,
      attribution_window_seconds: 30 * 86_400,
      conversion_event: "purchase",
    },
    my_access: null,
    can_join: true,
    can_apply: false,
    ...overrides,
  };
}

/** Strings that must never appear in affiliate-facing DOM (PRD §29). */
export const CONFIDENTIAL_MARKERS = ["advertiser_payout", "network_margin", "budget", "Advertiser payout", "Network margin", "Budget"];
