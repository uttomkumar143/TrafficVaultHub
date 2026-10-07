import { useState } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTenant } from "@/features/organizations/hooks";
import {
  useAffiliateDashboardLinks,
  useAffiliateDashboardOffers,
  useAffiliateOverview,
} from "@/features/affiliate-dashboard/hooks";
import type {
  AffiliateDashboardLink,
  AffiliateDashboardOffer,
  AffiliateOverview,
  MoneyByCurrency,
} from "@/features/affiliate-dashboard/api";
import { formatDateTime } from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import { isApiError } from "@/lib/api";
import { formatBps, formatMinor } from "@/lib/money";

const PAGE_SIZE = 25;
const AFFILIATE_ORG_TYPES = ["AFFILIATE"];

/**
 * `/app/:orgId/dashboard` — the affiliate's own performance dashboard
 * (`GET /organizations/:orgId/affiliate/dashboard/{overview,offers,links}`).
 *
 * Authority is the server's: `tracking.read` for overview + links,
 * `offers.read` for offers; non-AFFILIATE organizations get a 404. This page
 * mirrors that gating client-side only to avoid a request that would be
 * refused, and renders whatever the server refuses as an explicit message —
 * never an empty table. Every money value is integer minor units + currency
 * formatted via `lib/money.ts`; metrics the server reports as
 * `{ available: false }` are rendered as "Not available", never guessed.
 */
export function AffiliateDashboardPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const tenant = useTenant(orgId);

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

  const orgType = tenant.tenant?.organization.type;
  if (!orgType || !AFFILIATE_ORG_TYPES.includes(orgType)) {
    return (
      <section id="affiliate-dashboard-section" className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Affiliate dashboard</h1>
        <Alert>
          <AlertDescription>The affiliate dashboard is only available to affiliate organizations.</AlertDescription>
        </Alert>
        <Button asChild variant="outline" size="sm">
          <Link to={`/app/${orgId}`}>Back to overview</Link>
        </Button>
      </section>
    );
  }

  const canTracking = tenant.can("tracking.read");
  const canOffers = tenant.can("offers.read");

  if (!canTracking && !canOffers) {
    return (
      <section id="affiliate-dashboard-section" className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Affiliate dashboard</h1>
        <Alert>
          <AlertDescription>You do not have permission to view the affiliate dashboard in this organization.</AlertDescription>
        </Alert>
        <Button asChild variant="outline" size="sm">
          <Link to={`/app/${orgId}`}>Back to overview</Link>
        </Button>
      </section>
    );
  }

  return (
    <section id="affiliate-dashboard-section" className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Affiliate dashboard</h1>
        <p className="text-sm text-muted-foreground">{tenant.tenant?.organization.name}</p>
      </header>

      {canTracking ? (
        <OverviewSection orgId={orgId} />
      ) : (
        <PermissionNotice section="Overview" permission="tracking.read" />
      )}
      {canOffers ? <OffersSection orgId={orgId} /> : <PermissionNotice section="Offers" permission="offers.read" />}
      {canTracking ? <LinksSection orgId={orgId} /> : <PermissionNotice section="Tracking links" permission="tracking.read" />}
    </section>
  );
}

function PermissionNotice({ section, permission }: { section: string; permission: string }) {
  return (
    <section aria-label={section} className="space-y-2">
      <h2 className="text-lg font-semibold">{section}</h2>
      <p className="text-sm text-muted-foreground">
        Requires the <code>{permission}</code> permission.
      </p>
    </section>
  );
}

/** Server refusals rendered as explicit messages (403 / 404 distinguished). */
function RefusalOrError({ error }: { error: unknown }) {
  if (isApiError(error) && error.status === 404) {
    return (
      <Alert>
        <AlertDescription>The affiliate dashboard is not available for this organization.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

// ---- overview ---------------------------------------------------------------

function OverviewSection({ orgId }: { orgId: string }) {
  const overview = useAffiliateOverview(orgId);

  return (
    <section id="affiliate-overview" aria-labelledby="affiliate-overview-heading" className="space-y-3">
      <h2 id="affiliate-overview-heading" className="text-lg font-semibold">
        Overview
      </h2>
      {overview.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading overview…
        </p>
      ) : overview.isError ? (
        <RefusalOrError error={overview.error} />
      ) : (
        <OverviewCards overview={overview.data} />
      )}
    </section>
  );
}

function OverviewCards({ overview }: { overview: AffiliateOverview }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        <time dateTime={overview.range.from}>{formatDateTime(overview.range.from)}</time>
        {" – "}
        <time dateTime={overview.range.to}>{formatDateTime(overview.range.to)}</time>
      </p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Clicks" value={String(overview.clicks.total)} />
        <Metric label="Conversions" value={String(overview.conversions.total)} />
        <Metric
          label="EPC"
          value={overview.epc.available ? formatMinor(overview.epc.value_minor, overview.epc.currency) : "Not available"}
        />
        <Metric
          label="Conversion rate"
          value={overview.conversion_rate.available ? formatBps(overview.conversion_rate.bps) : "Not available"}
        />
      </dl>

      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-lg border p-4 space-y-2">
          <h3 className="text-sm font-medium">Conversions by status</h3>
          {Object.keys(overview.conversions.by_lifecycle_status).length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversions in this range.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {Object.entries(overview.conversions.by_lifecycle_status).map(([status, count]) => (
                <li key={status} className="flex justify-between">
                  <span>{humanize(status)}</span>
                  <span className="tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="rounded-lg border p-4 space-y-2">
          <h3 className="text-sm font-medium">Earnings</h3>
          {overview.earnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earnings in this range.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {overview.earnings.map((e) => (
                <li key={e.currency} className="flex justify-between">
                  <span>
                    {e.currency} <span className="text-muted-foreground">({e.count})</span>
                  </span>
                  <span className="tabular-nums">{formatMinor(e.total_minor, e.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <article className="rounded-lg border p-4 space-y-2">
        <h3 className="text-sm font-medium">Payouts</h3>
        <dl className="grid gap-3 sm:grid-cols-3 text-sm">
          <MoneyList label="Pending" items={overview.payouts.pending} />
          <MoneyList label="Approved" items={overview.payouts.approved} />
          <MoneyList label="Paid" items={overview.payouts.paid} />
        </dl>
      </article>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function MoneyList({ label, items }: { label: string; items: MoneyByCurrency[] }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd>
        {items.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="space-y-0.5">
            {items.map((m) => (
              <li key={m.currency} className="tabular-nums">
                {formatMinor(m.total_minor, m.currency)} <span className="text-muted-foreground">({m.count})</span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

// ---- offers -----------------------------------------------------------------

function OffersSection({ orgId }: { orgId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<AffiliateDashboardOffer[]>([]);
  const offers = useAffiliateDashboardOffers(orgId, { limit: PAGE_SIZE, cursor });
  const rows = offers.data ? dedupe([...accumulated, ...offers.data.items]) : accumulated;

  return (
    <section id="affiliate-offers" aria-labelledby="affiliate-offers-heading" className="space-y-3">
      <h2 id="affiliate-offers-heading" className="text-lg font-semibold">
        Offers
      </h2>
      {offers.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading offers…
        </p>
      ) : offers.isError ? (
        <RefusalOrError error={offers.error} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No offers available yet.</p>
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
                Commission
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="px-3 py-2">
                  <Link to={`/app/${orgId}/marketplace/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                    {o.name}
                  </Link>
                  {o.vertical ? <p className="text-xs text-muted-foreground">{o.vertical}</p> : null}
                </td>
                <td className="px-3 py-2">{humanize(o.status)}</td>
                <td className="px-3 py-2">{o.access_status ? humanize(o.access_status) : humanize(o.access_mode)}</td>
                <td className="px-3 py-2 tabular-nums">{commissionLabel(o)}</td>
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
          {offers.isFetching ? "Loading…" : "Load more offers"}
        </Button>
      ) : null}
    </section>
  );
}

function commissionLabel(o: AffiliateDashboardOffer): string {
  const e = o.economics;
  if (!e) return "—";
  if (e.payout_type === "REVSHARE" && e.revshare_percent_bps !== null) return `${formatBps(e.revshare_percent_bps)} revshare`;
  if (e.affiliate_commission_minor !== null && e.currency) {
    return `${formatMinor(e.affiliate_commission_minor, e.currency)}${e.payout_type ? ` ${e.payout_type}` : ""}`;
  }
  return "—";
}

// ---- links ------------------------------------------------------------------

function LinksSection({ orgId }: { orgId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<AffiliateDashboardLink[]>([]);
  const links = useAffiliateDashboardLinks(orgId, { limit: PAGE_SIZE, cursor });
  const rows = links.data ? dedupe([...accumulated, ...links.data.items]) : accumulated;

  return (
    <section id="affiliate-links" aria-labelledby="affiliate-links-heading" className="space-y-3">
      <h2 id="affiliate-links-heading" className="text-lg font-semibold">
        Tracking links
      </h2>
      {links.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading tracking links…
        </p>
      ) : links.isError ? (
        <RefusalOrError error={links.error} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tracking links yet.</p>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <caption className="sr-only">Your tracking links</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Link
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Offer
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Clicks
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="px-3 py-2">
                  <span className="font-medium">{l.name ?? l.code}</span>
                  <p className="text-xs text-muted-foreground font-mono">{l.tracking_path}</p>
                </td>
                <td className="px-3 py-2">{l.offer_name ?? "—"}</td>
                <td className="px-3 py-2">{humanize(l.status)}</td>
                <td className="px-3 py-2 tabular-nums">{l.click_count}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  <time dateTime={l.created_at}>{formatDateTime(l.created_at)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {links.data?.next_cursor ? (
        <Button
          variant="outline"
          size="sm"
          disabled={links.isFetching}
          onClick={() => {
            setAccumulated(rows);
            setCursor(links.data?.next_cursor ?? null);
          }}
        >
          {links.isFetching ? "Loading…" : "Load more links"}
        </Button>
      ) : null}
    </section>
  );
}

// ---- helpers ----------------------------------------------------------------

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(item.id, item);
  return [...seen.values()];
}

/** `APPLICATION_REQUIRED` → `Application required`. */
function humanize(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
