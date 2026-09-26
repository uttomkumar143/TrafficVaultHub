/**
 * Offer + marketplace server-state hooks (Phase 2 Unit 7). TanStack Query
 * wrappers over `features/offers/api.ts`. Query keys live under
 * `["organizations", orgId, ...]` so the auth context's session-end purge
 * drops them and so switching organization never shows another tenant's
 * cached data.
 *
 * Nothing here decides authority: the server enforces every permission,
 * access mode and tenant boundary on every request (PRD §5, §94, §116).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/api";
import { useAuth } from "@/features/auth/use-auth";
import * as offerApi from "@/features/offers/api";
import type { MarketplaceFilter, PageParams } from "@/features/offers/api";

export const offerKeys = {
  all: (orgId: string) => ["organizations", orgId, "offers"] as const,
  list: (orgId: string, page: PageParams) => ["organizations", orgId, "offers", "list", page] as const,
  detail: (orgId: string, offerId: string) => ["organizations", orgId, "offers", offerId] as const,
  versions: (orgId: string, offerId: string) => ["organizations", orgId, "offers", offerId, "versions"] as const,
  history: (orgId: string, offerId: string) => ["organizations", orgId, "offers", offerId, "history"] as const,
  access: (orgId: string, offerId: string) => ["organizations", orgId, "offers", offerId, "access"] as const,
  marketplaceAll: (orgId: string) => ["organizations", orgId, "marketplace"] as const,
  marketplace: (orgId: string, filter: MarketplaceFilter, page: PageParams) =>
    ["organizations", orgId, "marketplace", "search", filter, page] as const,
  marketplaceDetail: (orgId: string, offerId: string) => ["organizations", orgId, "marketplace", offerId] as const,
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

// ---- advertiser / owner ------------------------------------------------------

export function useOffers(orgId: string | undefined, page: PageParams = {}) {
  const enabled = useEnabled(orgId);
  return useQuery({
    queryKey: offerKeys.list(orgId ?? "none", page),
    queryFn: ({ signal }) => offerApi.listOffers(orgId as string, page, signal),
    enabled,
    retry: retryUnlessDefinitive,
  });
}

export function useOffer(orgId: string | undefined, offerId: string | undefined) {
  const enabled = useEnabled(orgId, !!offerId);
  return useQuery({
    queryKey: offerKeys.detail(orgId ?? "none", offerId ?? "none"),
    queryFn: ({ signal }) => offerApi.getOffer(orgId as string, offerId as string, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.offer,
  });
}

export function useOfferVersions(orgId: string | undefined, offerId: string | undefined) {
  const enabled = useEnabled(orgId, !!offerId);
  return useQuery({
    queryKey: offerKeys.versions(orgId ?? "none", offerId ?? "none"),
    queryFn: ({ signal }) => offerApi.listVersions(orgId as string, offerId as string, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.versions,
  });
}

export function useOfferHistory(orgId: string | undefined, offerId: string | undefined) {
  const enabled = useEnabled(orgId, !!offerId);
  return useQuery({
    queryKey: offerKeys.history(orgId ?? "none", offerId ?? "none"),
    queryFn: ({ signal }) => offerApi.listHistory(orgId as string, offerId as string, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.transitions,
  });
}

export function useOfferAccessGrants(orgId: string | undefined, offerId: string | undefined) {
  const enabled = useEnabled(orgId, !!offerId);
  return useQuery({
    queryKey: offerKeys.access(orgId ?? "none", offerId ?? "none"),
    queryFn: ({ signal }) => offerApi.listAccessGrants(orgId as string, offerId as string, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.grants,
  });
}

export function useCreateOffer(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: offerApi.CreateOfferInput) => offerApi.createOffer(orgId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: offerKeys.all(orgId) });
    },
  });
}

/** Every offer mutation invalidates the offer's detail/versions/history/access + the list. */
export function useOfferMutations(orgId: string, offerId: string) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: offerKeys.all(orgId) });
  };

  const update = useMutation({
    mutationFn: (input: offerApi.UpdateOfferInput) => offerApi.updateOffer(orgId, offerId, input),
    onSuccess: invalidate,
  });
  const submit = useMutation({
    mutationFn: () => offerApi.submitOffer(orgId, offerId),
    onSuccess: invalidate,
  });
  const transition = useMutation({
    mutationFn: (input: offerApi.TransitionInput) => offerApi.transitionOffer(orgId, offerId, input),
    onSuccess: invalidate,
  });
  const createVersion = useMutation({
    mutationFn: (input: offerApi.OfferVersionInput & { targeting?: offerApi.CreateOfferInput["targeting"] }) =>
      offerApi.createVersion(orgId, offerId, input),
    onSuccess: invalidate,
  });
  const setAccess = useMutation({
    mutationFn: (input: offerApi.AccessGrantInput) => offerApi.setAccessGrant(orgId, offerId, input),
    onSuccess: invalidate,
  });

  return { update, submit, transition, createVersion, setAccess };
}

// ---- affiliate marketplace ---------------------------------------------------

export function useMarketplace(orgId: string | undefined, filter: MarketplaceFilter, page: PageParams = {}) {
  const enabled = useEnabled(orgId);
  return useQuery({
    queryKey: offerKeys.marketplace(orgId ?? "none", filter, page),
    queryFn: ({ signal }) => offerApi.searchMarketplace(orgId as string, filter, page, signal),
    enabled,
    retry: retryUnlessDefinitive,
    placeholderData: (previous) => previous,
  });
}

export function useMarketplaceOffer(orgId: string | undefined, offerId: string | undefined) {
  const enabled = useEnabled(orgId, !!offerId);
  return useQuery({
    queryKey: offerKeys.marketplaceDetail(orgId ?? "none", offerId ?? "none"),
    queryFn: ({ signal }) => offerApi.getMarketplaceOffer(orgId as string, offerId as string, signal),
    enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.offer,
  });
}

export function useApplyToOffer(orgId: string, offerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => offerApi.applyToOffer(orgId, offerId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: offerKeys.marketplaceAll(orgId) });
    },
  });
}
