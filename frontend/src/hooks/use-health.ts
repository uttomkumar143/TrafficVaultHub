import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "@/lib/api";

/** Query hook for the backend liveness probe. */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
  });
}
