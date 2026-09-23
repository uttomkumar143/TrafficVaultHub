import { Link, Navigate } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useOrganizations } from "@/features/organizations/hooks";
import { errorMessage } from "@/lib/error-message";

/**
 * `/app` — entry point after sign-in. With exactly one organization the user is
 * taken straight to it; otherwise the list is shown (or an empty state that
 * leads to organization creation).
 */
export function AppIndexPage() {
  const orgs = useOrganizations();

  if (orgs.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your organizations…
      </p>
    );
  }
  if (orgs.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>{errorMessage(orgs.error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void orgs.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const list = orgs.data;
  if (list.length === 1) return <Navigate to={`/app/${list[0].id}`} replace />;

  return (
    <section id="organizations-section" className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your organizations</h1>
        <Button asChild size="sm">
          <Link to="/app/organizations/new">Create organization</Link>
        </Button>
      </header>

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center space-y-2">
          <p className="font-medium">You are not a member of any organization yet.</p>
          <p className="text-sm text-muted-foreground">
            Create an advertiser or affiliate organization to get started, or ask an owner to add you.
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <Link to={`/app/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                  {o.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {o.type} · {o.membership.role.name}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link to={`/app/${o.id}`}>Open</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
