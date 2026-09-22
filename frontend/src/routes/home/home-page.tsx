import { useHealth } from "@/hooks/use-health";
import { Button } from "@/components/ui/button";

/**
 * Placeholder home route.
 * Displays static explanatory text and the live backend health probe result.
 * Intentionally contains NO business metrics (PRD §3).
 */
export function HomePage() {
  const health = useHealth();

  return (
    <section id="home-section" className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">TrafficVaultHub</h1>
        <p className="text-muted-foreground">
          Performance marketing / CPA affiliate network platform. This is the
          Phase 0 foundation: the application shell, routing, server-state
          provider and API client are in place. Business features are not yet
          implemented.
        </p>
      </div>

      <div id="backend-status" className="rounded-lg border p-4 space-y-2">
        <h2 className="text-sm font-medium">Backend connectivity</h2>
        <p className="text-sm text-muted-foreground">
          {health.isPending && "Checking /api/v1/health…"}
          {health.isError && "Backend unreachable. Start the Worker with `npm run dev` in backend/."}
          {health.isSuccess && `Backend responded: status = ${health.data.status}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
        >
          Re-check
        </Button>
      </div>
    </section>
  );
}
