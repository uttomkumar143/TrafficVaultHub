/**
 * Affiliate dashboard API bindings (Phase 7 Unit 1b) — one function per
 * endpoint in `backend/src/routes/affiliate-dashboard.ts`. Thin wrappers over
 * `apiRequest`. The acting organization is ALWAYS the path parameter; nothing
 * identifying the tenant is ever sent in a query (PRD §94). Money arrives as
 * integer minor units + currency only (PRD §25) and is never recomputed here.
 *
 * Metrics the backend cannot yet compute arrive as `{ available: false }` and
 * are rendered as "Not available" — never substituted with a number.
 */
import { apiRequest } from "@/lib/api";
import type { Page } from "@/types/api";

const dashboard = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}/affiliate/dashboard`;

/** Query-string builder that drops empty values (server treats absent = default). */
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

// ---- wire types (mirror backend/src/modules/affiliate-dashboard/service.ts) ----

export interface MoneyByCurrency {
  currency: string;
  total_minor: number;
  count: number;
}

export interface EarningsByCurrency extends MoneyByCurrency {
  by_lifecycle_status: Record<string, { total_minor: number; count: number }>;
}

/** A metric the server declares it cannot compute yet. */
export interface UnavailableMetric {
  available: false;
}

export interface DashboardRange {
  from: string;
  to: string;
}

export interface AffiliateOverview {
  range: DashboardRange;
  clicks: { total: number };
  conversions: { total: number; by_lifecycle_status: Record<string, number> };
  earnings: EarningsByCurrency[];
  payouts: {
    pending: MoneyByCurrency[];
    approved: MoneyByCurrency[];
    paid: MoneyByCurrency[];
  };
  epc: UnavailableMetric | { available: true; value_minor: number; currency: string };
  conversion_rate: UnavailableMetric | { available: true; bps: number };
}

export interface AffiliateDashboardOffer {
  id: string;
  name: string;
  vertical: string | null;
  description: string | null;
  access_mode: string;
  status: string;
  access_status: string | null;
  economics: {
    payout_type: string | null;
    currency: string | null;
    affiliate_commission_minor: number | null;
    revshare_percent_bps: number | null;
    conversion_event: string | null;
  } | null;
  created_at: string;
}

export interface AffiliateDashboardLink {
  id: string;
  offer_id: string;
  offer_name: string | null;
  traffic_source_id: string | null;
  code: string;
  tracking_path: string;
  name: string | null;
  creative_id: string | null;
  status: string;
  click_count: number;
  created_at: string;
}

export interface RangeParams {
  /** ISO 8601 timestamp; server defaults to 30 days back. */
  from?: string;
  /** ISO 8601 timestamp; server defaults to now. */
  to?: string;
}

export interface PageParams {
  limit?: number;
  cursor?: string | null;
}

// ---- fetchers ------------------------------------------------------------------

export function getOverview(orgId: string, range: RangeParams = {}, signal?: AbortSignal): Promise<{ overview: AffiliateOverview }> {
  return apiRequest<{ overview: AffiliateOverview }>(`${dashboard(orgId)}/overview${qs(range)}`, { signal });
}

export function listDashboardOffers(orgId: string, page: PageParams = {}, signal?: AbortSignal): Promise<Page<AffiliateDashboardOffer>> {
  return apiRequest<Page<AffiliateDashboardOffer>>(`${dashboard(orgId)}/offers${qs(page)}`, { signal });
}

export function listDashboardLinks(orgId: string, page: PageParams = {}, signal?: AbortSignal): Promise<Page<AffiliateDashboardLink>> {
  return apiRequest<Page<AffiliateDashboardLink>>(`${dashboard(orgId)}/links${qs(page)}`, { signal });
}
