/**
 * Affiliate dashboard server-state hooks (Phase 7 Unit 1b). TanStack Query
 * wrappers over `features/affiliate-dashboard/api.ts`. Query keys live under
 * `["organizations", orgId, ...]` so the auth context's session-end purge
 * drops them and switching organization never shows another tenant's cache.
 *
 * Nothing here decides authority: the server enforces permission, org type
 * (AFFILIATE-only → 404 otherwise) and tenant boundary on every request.
 */
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/lib/api";
import { useAuth } from "@/features/auth/use-auth";
import * as dashboardApi from "@/features/affiliate-dashboard/api";
import type { PageParams, RangeParams } from "@/features/affiliate-dashboard/api";

export const affiliateDashboardKeys = {
  all: (orgId: string) => ["organizations", orgId, "affiliate-dashboard"] as const,
  overview: (orgId: string, range: RangeParams) => ["organizations", orgId, "affiliate-dashboard", "overview", range] as const,
  offers: (orgId: string, page: PageParams) => ["organizations", orgId, "affiliate-dashboard", "offers", page] as const,
  links: (orgId: string, page: PageParams) => ["organizations", orgId, "affiliate-dashboard", "links", page] as const,
};

/** Never retry a 400/401/403/404 — those are authoritative answers, not hiccups. */
function retryUnlessDefinitive(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

function useEnabled(orgId: string | undefined, extra = true): boolean {
  const auth = useAuth();
  return auth.status === "authenticated" && !!orgId && extra;
}

export function useAffiliateOverview(orgId: string | undefined, range: RangeParams = {}, enabledExtra = true) {
  const enabled = useEnabled(orgId, enabledExtra);
  return useQuery({
    queryKey: affiliateDashboardKeys.overview(orgId ?? "none", range),
    queryFn: ({ signal }) => dashboardApi.getOverview(orgId as string, range, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.overview,
  });
}

export function useAffiliateDashboardOffers(orgId: string | undefined, page: PageParams = {}, enabledExtra = true) {
  const enabled = useEnabled(orgId, enabledExtra);
  return useQuery({
    queryKey: affiliateDashboardKeys.offers(orgId ?? "none", page),
    queryFn: ({ signal }) => dashboardApi.listDashboardOffers(orgId as string, page, signal),
    enabled,
    retry: retryUnlessDefinitive,
  });
}

export function useAffiliateDashboardLinks(orgId: string | undefined, page: PageParams = {}, enabledExtra = true) {
  const enabled = useEnabled(orgId, enabledExtra);
  return useQuery({
    queryKey: affiliateDashboardKeys.links(orgId ?? "none", page),
    queryFn: ({ signal }) => dashboardApi.listDashboardLinks(orgId as string, page, signal),
    enabled,
    retry: retryUnlessDefinitive,
  });
}
