import { QueryClient } from "@tanstack/react-query";

/**
 * Shared TanStack Query client.
 * Server state is the source of truth (PRD §4, §5); the client only caches it.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
