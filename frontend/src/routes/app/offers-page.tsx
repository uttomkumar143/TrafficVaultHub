import { useState } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RequirePermission } from "@/components/auth/require-permission";
import { useTenant } from "@/features/organizations/hooks";
import { useOffers } from "@/features/offers/hooks";
import { AccessModeBadge, OfferStatusBadge, formatDateTime } from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import type { OfferSummary } from "@/types/api";

const PAGE_SIZE = 25;

/**
 * `/app/:orgId/offers` — the advertiser's own offers in every lifecycle status
 * (`GET /organizations/:orgId/offers`, `offers.read`). "Create offer" is shown
 * only with `offers.create`; the server re-checks both (PRD §5, §94).
 * Cursor-paginated per PRD §127 — a "Load more" button walks `next_cursor`.
 */
export function OffersPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const tenant = useTenant(orgId);
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<OfferSummary[]>([]);
  const offers = useOffers(orgId, { limit: PAGE_SIZE, cursor });

  if (tenant.isNotMember) return <NotAMember />;
  if (tenant.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (tenant.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{errorMessage(tenant.error)}</AlertDescription>
      </Alert>
    );
  }

  // The current page + every earlier page the user loaded. Query invalidation
  // refetches the current cursor; earlier pages are kept as loaded.
  const rows: OfferSummary[] = offers.data ? dedupe([...accumulated, ...offers.data.items]) : accumulated;

  return (
    <section id="offers-section" className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Offers</h1>
          <p className="text-sm text-muted-foreground">{tenant.tenant?.organization.name}</p>
        </div>
        <RequirePermission orgId={orgId} permission="offers.create">
          <Button asChild size="sm">
            <Link to={`/app/${orgId}/offers/new`}>Create offer</Link>
          </Button>
        </RequirePermission>
      </header>

      {offers.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading offers…
        </p>
      ) : offers.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(offers.error)}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No offers yet.</p>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <caption className="sr-only">Your offers</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Offer
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Access
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="px-3 py-2">
                  <Link to={`/app/${orgId}/offers/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                    {o.name}
                  </Link>
                  {o.vertical ? <p className="text-xs text-muted-foreground">{o.vertical}</p> : null}
                </td>
                <td className="px-3 py-2">
                  <OfferStatusBadge status={o.status} />
                </td>
                <td className="px-3 py-2">
                  <AccessModeBadge mode={o.access_mode} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  <time dateTime={o.updated_at}>{formatDateTime(o.updated_at)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {offers.data?.next_cursor ? (
        <Button
          variant="outline"
          size="sm"
          disabled={offers.isFetching}
          onClick={() => {
            setAccumulated(rows);
            setCursor(offers.data?.next_cursor ?? null);
          }}
        >
          {offers.isFetching ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}

function dedupe(items: OfferSummary[]): OfferSummary[] {
  const seen = new Map<string, OfferSummary>();
  for (const item of items) seen.set(item.id, item);
  return [...seen.values()];
}
