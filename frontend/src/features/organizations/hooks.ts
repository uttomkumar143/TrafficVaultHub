/**
 * Organization server-state hooks (Phase 1 Unit 7 step 4).
 *
 * All hooks are TanStack Query wrappers over `features/organizations/api.ts`.
 * `useTenant(orgId)` mirrors `GET /organizations/:orgId/me` and exposes
 * `can(key)` for hiding/disabling UI — it is NEVER an authority: the server
 * re-checks every permission on every request (PRD §5, §94).
 *
 * Query keys are namespaced under `["organizations", ...]` so the auth
 * context's session-end purge (`queryClient.removeQueries()`) drops them too.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/api";
import { useAuth } from "@/features/auth/use-auth";
import * as orgApi from "@/features/organizations/api";
import type { PublicMember, TenantMeResponse } from "@/types/api";

export const organizationKeys = {
  all: ["organizations"] as const,
  list: () => ["organizations", "list"] as const,
  detail: (orgId: string) => ["organizations", orgId] as const,
  me: (orgId: string) => ["organizations", orgId, "me"] as const,
  roles: (orgId: string) => ["organizations", orgId, "roles"] as const,
  members: (orgId: string) => ["organizations", orgId, "members"] as const,
};

/** Never retry a 401/403/404 — those are authoritative answers, not hiccups. */
function retryUnlessDefinitive(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && (err.status === 401 || err.status === 403 || err.status === 404)) return false;
  return failureCount < 1;
}

export function useOrganizations() {
  const auth = useAuth();
  return useQuery({
    queryKey: organizationKeys.list(),
    queryFn: ({ signal }) => orgApi.listOrganizations(signal),
    enabled: auth.status === "authenticated",
    retry: retryUnlessDefinitive,
    select: (data) => data.organizations,
    staleTime: 30_000,
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: orgApi.createOrganization,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.list() });
    },
  });
}

export interface TenantState {
  /** `undefined` while loading or when the query is disabled/errored. */
  tenant: TenantMeResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** True when the server answered 404 (not a member / unknown org — no enumeration). */
  isNotMember: boolean;
  /** UI-gating helper only. */
  can: (permission: string) => boolean;
  isOwner: boolean;
  refetch: () => Promise<unknown>;
}

export function useTenant(orgId: string | undefined): TenantState {
  const auth = useAuth();
  const query = useQuery({
    queryKey: organizationKeys.me(orgId ?? "none"),
    queryFn: ({ signal }) => orgApi.getTenantMe(orgId as string, signal),
    enabled: auth.status === "authenticated" && !!orgId,
    retry: retryUnlessDefinitive,
    staleTime: 30_000,
  });

  const permissions = useMemo(() => new Set(query.data?.permissions ?? []), [query.data]);
  const can = useCallback((permission: string) => permissions.has(permission), [permissions]);
  const isNotMember = query.isError && isApiError(query.error) && query.error.status === 404;

  return {
    tenant: query.data,
    isLoading: query.isPending && query.fetchStatus !== "idle",
    isError: query.isError,
    error: query.error,
    isNotMember,
    can,
    isOwner: query.data?.role.is_owner ?? false,
    refetch: query.refetch,
  };
}

export function useOrganization(orgId: string | undefined) {
  const auth = useAuth();
  return useQuery({
    queryKey: organizationKeys.detail(orgId ?? "none"),
    queryFn: ({ signal }) => orgApi.getOrganization(orgId as string, signal),
    enabled: auth.status === "authenticated" && !!orgId,
    retry: retryUnlessDefinitive,
    select: (data) => data.organization,
  });
}

export function useRoles(orgId: string | undefined, enabled = true) {
  const auth = useAuth();
  return useQuery({
    queryKey: organizationKeys.roles(orgId ?? "none"),
    queryFn: ({ signal }) => orgApi.listRoles(orgId as string, signal),
    enabled: auth.status === "authenticated" && !!orgId && enabled,
    retry: retryUnlessDefinitive,
    select: (data) => data.roles,
    staleTime: 5 * 60_000,
  });
}

export function useMembers(orgId: string | undefined) {
  const auth = useAuth();
  return useQuery({
    queryKey: organizationKeys.members(orgId ?? "none"),
    queryFn: ({ signal }) => orgApi.listMembers(orgId as string, signal),
    enabled: auth.status === "authenticated" && !!orgId,
    retry: retryUnlessDefinitive,
    select: (data) => data.members,
  });
}

/** Add / change role / remove — each invalidates the member list on success. */
export function useMemberMutations(orgId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: organizationKeys.members(orgId) });

  const add = useMutation({
    mutationFn: (input: orgApi.AddMemberInput) => orgApi.addMember(orgId, input),
    onSuccess: invalidate,
  });
  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: string }) => orgApi.changeMemberRole(orgId, input.memberId, input.role),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (member: Pick<PublicMember, "id">) => orgApi.removeMember(orgId, member.id),
    onSuccess: invalidate,
  });

  return { add, changeRole, remove };
}
