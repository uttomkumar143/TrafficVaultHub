/**
 * Offers + marketplace API bindings — one function per endpoint in
 * `backend/src/routes/offers.ts`. Thin wrappers over `apiRequest`. The acting
 * organization is ALWAYS the path parameter; no `organization_id`,
 * `advertiser_id` or `affiliate_id` is ever sent in a body or query (PRD §94
 * — the server derives them from the session + path and ignores anything
 * else). Money goes over the wire as integer minor units + currency only.
 */
import { apiRequest } from "@/lib/api";
import type {
  AccessGrant,
  AccessGrantStatus,
  AccessMode,
  MarketplaceOffer,
  MarketplaceStatus,
  Offer,
  OfferStatus,
  OfferSummary,
  OfferTransition,
  OfferVersion,
  Page,
  PayoutType,
  Targeting,
} from "@/types/api";

const org = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}`;
const offers = (orgId: string) => `${org(orgId)}/offers`;
const offer = (orgId: string, offerId: string) => `${offers(orgId)}/${encodeURIComponent(offerId)}`;
const marketplace = (orgId: string) => `${org(orgId)}/marketplace`;

/** Query-string builder that drops empty values (server treats absent = no filter). */
function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as Array<[string, unknown]>) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

// ---- advertiser / owner ------------------------------------------------------

export interface OfferVersionInput {
  payout_type: PayoutType;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor?: number;
  revshare_percent_bps?: number | null;
  daily_conversion_cap?: number | null;
  total_conversion_cap?: number | null;
  budget_minor?: number | null;
  attribution_window_seconds?: number;
  conversion_event: string;
  destination_url?: string | null;
  targeting_starts_at?: string | null;
  targeting_ends_at?: string | null;
  change_summary?: string | null;
}

export interface CreateOfferInput {
  name: string;
  vertical?: string | null;
  description?: string | null;
  access_mode?: AccessMode;
  version: OfferVersionInput;
  targeting?: Targeting[];
}

export interface UpdateOfferInput {
  name?: string;
  vertical?: string | null;
  description?: string | null;
  access_mode?: AccessMode;
}

export interface TransitionInput {
  to: OfferStatus;
  reason?: string | null;
}

export interface AccessGrantInput {
  affiliate_organization_id: string;
  status: Extract<AccessGrantStatus, "INVITED" | "APPROVED" | "REJECTED" | "REVOKED">;
  reason?: string | null;
}

export interface PageParams {
  limit?: number;
  cursor?: string | null;
}

export function listOffers(orgId: string, page: PageParams = {}, signal?: AbortSignal): Promise<Page<OfferSummary>> {
  return apiRequest<Page<OfferSummary>>(`${offers(orgId)}${qs(page)}`, { signal });
}

export function createOffer(orgId: string, input: CreateOfferInput): Promise<{ offer: Offer }> {
  return apiRequest<{ offer: Offer }>(offers(orgId), { method: "POST", body: input });
}

export function getOffer(orgId: string, offerId: string, signal?: AbortSignal): Promise<{ offer: Offer }> {
  return apiRequest<{ offer: Offer }>(offer(orgId, offerId), { signal });
}

export function updateOffer(orgId: string, offerId: string, input: UpdateOfferInput): Promise<{ offer: Offer }> {
  return apiRequest<{ offer: Offer }>(offer(orgId, offerId), { method: "PATCH", body: input });
}

export function submitOffer(orgId: string, offerId: string): Promise<{ offer: Offer }> {
  return apiRequest<{ offer: Offer }>(`${offer(orgId, offerId)}/submit`, { method: "POST" });
}

export function transitionOffer(orgId: string, offerId: string, input: TransitionInput): Promise<{ offer: Offer }> {
  return apiRequest<{ offer: Offer }>(`${offer(orgId, offerId)}/transition`, { method: "POST", body: input });
}

export function listVersions(orgId: string, offerId: string, signal?: AbortSignal): Promise<{ versions: OfferVersion[] }> {
  return apiRequest<{ versions: OfferVersion[] }>(`${offer(orgId, offerId)}/versions`, { signal });
}

export function createVersion(
  orgId: string,
  offerId: string,
  input: OfferVersionInput & { targeting?: Targeting[] },
): Promise<{ version: OfferVersion }> {
  return apiRequest<{ version: OfferVersion }>(`${offer(orgId, offerId)}/versions`, { method: "POST", body: input });
}

export function listHistory(orgId: string, offerId: string, signal?: AbortSignal): Promise<{ transitions: OfferTransition[] }> {
  return apiRequest<{ transitions: OfferTransition[] }>(`${offer(orgId, offerId)}/history`, { signal });
}

export function listAccessGrants(orgId: string, offerId: string, signal?: AbortSignal): Promise<{ grants: AccessGrant[] }> {
  return apiRequest<{ grants: AccessGrant[] }>(`${offer(orgId, offerId)}/access`, { signal });
}

export function setAccessGrant(orgId: string, offerId: string, input: AccessGrantInput): Promise<{ grant: AccessGrant }> {
  return apiRequest<{ grant: AccessGrant }>(`${offer(orgId, offerId)}/access`, { method: "PUT", body: input });
}

// ---- affiliate marketplace ---------------------------------------------------

/** Every field optional; the server validates enum values and rejects a float payout floor. */
export interface MarketplaceFilter {
  vertical?: string;
  country?: string;
  payout_type?: PayoutType | "";
  /** Integer minor units of the AFFILIATE commission floor. */
  min_commission_minor?: number;
  device?: string;
  traffic_source?: string;
  access_mode?: AccessMode | "";
  status?: MarketplaceStatus | "";
}

export function searchMarketplace(
  orgId: string,
  filter: MarketplaceFilter = {},
  page: PageParams = {},
  signal?: AbortSignal,
): Promise<Page<MarketplaceOffer>> {
  return apiRequest<Page<MarketplaceOffer>>(`${marketplace(orgId)}${qs({ ...filter, ...page })}`, { signal });
}

export function getMarketplaceOffer(orgId: string, offerId: string, signal?: AbortSignal): Promise<{ offer: MarketplaceOffer }> {
  return apiRequest<{ offer: MarketplaceOffer }>(`${marketplace(orgId)}/${encodeURIComponent(offerId)}`, { signal });
}

export function applyToOffer(orgId: string, offerId: string): Promise<{ grant: AccessGrant }> {
  return apiRequest<{ grant: AccessGrant }>(`${marketplace(orgId)}/${encodeURIComponent(offerId)}/apply`, { method: "POST" });
}
