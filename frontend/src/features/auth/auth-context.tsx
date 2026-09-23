/**
 * Authentication context (Phase 1 Unit 7).
 *
 * The server is the only authority on who is signed in (PRD §5): this context
 * simply mirrors `GET /api/v1/auth/me` through TanStack Query, keyed on the
 * presence of a session token. When the token disappears (explicit logout or a
 * `401` observed by `apiRequest`) the query is disabled and every cached
 * server-state entry is dropped so no tenant data outlives the session.
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/lib/api";
import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
  subscribeSessionToken,
} from "@/lib/session-store";
import type { LoginResponse, PublicUser, SessionInfo } from "@/types/api";
import * as authApi from "@/features/auth/api";

export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: PublicUser | null;
  session: SessionInfo | null;
  /** Last error from `GET /auth/me` other than 401 (e.g. network). */
  error: unknown;
  login: (input: authApi.LoginInput) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  /** Re-run `GET /auth/me` (e.g. after email verification). */
  refresh: () => Promise<void>;
  isLoggingIn: boolean;
  isLoggingOut: boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => getSessionToken());

  // Keep local token state in sync with the store (login/logout/401).
  useEffect(() => subscribeSessionToken(setToken), []);

  const meQuery = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: ({ signal }) => authApi.fetchMe(signal),
    enabled: token !== null,
    retry: (failureCount, err) => !(isApiError(err) && err.status === 401) && failureCount < 1,
    staleTime: 60_000,
  });

  // When a session ENDS (token present → absent), purge everything cached
  // under it so no tenant data outlives the session. Public queries issued
  // while already signed out (e.g. health) are left alone.
  const previousToken = useRef<string | null>(token);
  useEffect(() => {
    if (previousToken.current !== null && token === null) {
      queryClient.removeQueries();
    }
    previousToken.current = token;
  }, [token, queryClient]);

  const loginMutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      // Seed the `me` cache from the login response so the UI flips at once,
      // then persist the token (this also notifies subscribers).
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, { user: data.user, session: data.session });
      setSessionToken(data.token);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      try {
        await authApi.logout();
      } catch (err) {
        // A 401 means the server already considers us signed out — fine.
        if (!(isApiError(err) && err.status === 401)) throw err;
      }
    },
    onSettled: () => {
      clearSessionToken();
    },
  });

  const login = useCallback(
    (input: authApi.LoginInput) => loginMutation.mutateAsync(input),
    [loginMutation],
  );
  const logout = useCallback(() => logoutMutation.mutateAsync(), [logoutMutation]);
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    let status: AuthStatus;
    if (token === null) status = "unauthenticated";
    else if (meQuery.isSuccess) status = "authenticated";
    else if (meQuery.isError) {
      // A 401 already cleared the token via apiRequest; anything else is a
      // transient failure — report it but do not pretend to know the user.
      status = isApiError(meQuery.error) && meQuery.error.status === 401 ? "unauthenticated" : "loading";
    } else status = "loading";

    const isNonAuthError = meQuery.isError && !(isApiError(meQuery.error) && meQuery.error.status === 401);

    return {
      status,
      user: status === "authenticated" ? meQuery.data?.user ?? null : null,
      session: status === "authenticated" ? meQuery.data?.session ?? null : null,
      error: isNonAuthError ? meQuery.error : null,
      login,
      logout,
      refresh,
      isLoggingIn: loginMutation.isPending,
      isLoggingOut: logoutMutation.isPending,
    };
  }, [token, meQuery.isSuccess, meQuery.isError, meQuery.error, meQuery.data, login, logout, refresh, loginMutation.isPending, logoutMutation.isPending]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
