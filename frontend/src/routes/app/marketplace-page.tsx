import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTenant } from "@/features/organizations/hooks";
import { useMarketplace } from "@/features/offers/hooks";
import type { MarketplaceFilter } from "@/features/offers/api";
import {
  ACCESS_MODE_SHORT_LABELS,
  AccessGrantStatusBadge,
  AccessModeBadge,
  OFFER_STATUS_LABELS,
  OfferStatusBadge,
  PAYOUT_TYPE_LABELS,
  selectClassName,
} from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import { formatBps, formatMinor, formatSeconds, minorToMajorString, parseMajorToMinor } from "@/lib/money";
import {
  ACCESS_MODES,
  MARKETPLACE_STATUSES,
  PAYOUT_TYPES,
  type AccessMode,
  type MarketplaceOffer,
  type MarketplaceStatus,
  type PayoutType,
} from "@/types/api";

const PAGE_SIZE = 24;

/** Filter keys ↔ query-string params (same names the server reads). */
const FILTER_KEYS = ["vertical", "country", "payout_type", "min_commission_minor", "device", "traffic_source", "access_mode", "status"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

function readFilter(params: URLSearchParams): MarketplaceFilter {
  const filter: MarketplaceFilter = {};
  const get = (k: FilterKey) => params.get(k)?.trim() || "";
  if (get("vertical")) filter.vertical = get("vertical");
  if (get("country")) filter.country = get("country").toUpperCase();
  if ((PAYOUT_TYPES as readonly string[]).includes(get("payout_type"))) filter.payout_type = get("payout_type") as PayoutType;
  if (/^\d{1,15}$/.test(get("min_commission_minor"))) filter.min_commission_minor = Number(get("min_commission_minor"));
  if (get("device")) filter.device = get("device").toUpperCase();
  if (get("traffic_source")) filter.traffic_source = get("traffic_source").toUpperCase();
  if ((ACCESS_MODES as readonly string[]).includes(get("access_mode"))) filter.access_mode = get("access_mode") as AccessMode;
  if ((MARKETPLACE_STATUSES as readonly string[]).includes(get("status"))) filter.status = get("status") as MarketplaceStatus;
  return filter;
}

/**
 * `/app/:orgId/marketplace` — affiliate/partner marketplace search
 * (`GET /organizations/:orgId/marketplace`, `offers.read`). Every filter is
 * mirrored in the URL so a search is shareable/bookmarkable and is applied
 * SERVER-SIDE (AND-combined; filters can only narrow, never widen, what the
 * affiliate may see — PRD §29). The cards render only the confidential-safe
 * projection the server returns: affiliate commission, never advertiser
 * payout, margin or budget.
 */
export function MarketplacePage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tenant = useTenant(orgId);
  const filter = readFilter(searchParams);
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<MarketplaceOffer[]>([]);
  const [filterKey, setFilterKey] = useState(searchParams.toString());
  const results = useMarketplace(orgId, filter, { limit: PAGE_SIZE, cursor });

  // Reset pagination whenever the filter set changes.
  if (filterKey !== searchParams.toString()) {
    setFilterKey(searchParams.toString());
    setCursor(null);
    setAccumulated([]);
  }

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

  const rows: MarketplaceOffer[] = results.data ? dedupe([...accumulated, ...results.data.items]) : accumulated;

  const applyFilter = (next: Record<FilterKey, string>) => {
    const params = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const value = next[key].trim();
      if (value) params.set(key, value);
    }
    setSearchParams(params);
  };

  return (
    <section id="marketplace-section" className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
        <p className="text-sm text-muted-foreground">
          Offers available to {tenant.tenant?.organization.name}. Commission figures are what your organization earns.
        </p>
      </header>

      <MarketplaceFilterForm key={filterKey} initial={searchParams} onApply={applyFilter} onClear={() => setSearchParams(new URLSearchParams())} />

      {results.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Searching…
        </p>
      ) : results.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(results.error)}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No offers match these filters.</p>
      ) : (
        <ul aria-label="Marketplace offers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((offer) => (
            <li key={offer.id}>
              <MarketplaceOfferCard orgId={orgId} offer={offer} />
            </li>
          ))}
        </ul>
      )}

      {results.data?.next_cursor ? (
        <Button
          variant="outline"
          size="sm"
          disabled={results.isFetching}
          onClick={() => {
            setAccumulated(rows);
            setCursor(results.data?.next_cursor ?? null);
          }}
        >
          {results.isFetching ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}

interface FilterFormProps {
  initial: URLSearchParams;
  onApply: (values: Record<FilterKey, string>) => void;
  onClear: () => void;
}

/**
 * Uncontrolled filter form; the URL is the source of truth. The payout floor
 * is typed in MAJOR units and converted to integer minor units (string math)
 * before it reaches the query string — the server rejects floats.
 */
function MarketplaceFilterForm({ initial, onApply, onClear }: FilterFormProps) {
  const [floorError, setFloorError] = useState<string | null>(null);
  const initialFloorMinor = initial.get("min_commission_minor") ?? "";
  const initialFloorMajor = /^\d{1,15}$/.test(initialFloorMinor) ? minorToMajorString(Number(initialFloorMinor), "USD") : "";

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (k: string) => String(data.get(k) ?? "").trim();
    const floorMajor = text("min_commission");
    let floorMinor = "";
    if (floorMajor) {
      const minor = parseMajorToMinor(floorMajor, "USD");
      if (minor === null) {
        setFloorError("Enter an amount like 25 or 25.50");
        return;
      }
      floorMinor = String(minor);
    }
    setFloorError(null);
    onApply({
      vertical: text("vertical"),
      country: text("country"),
      payout_type: text("payout_type"),
      min_commission_minor: floorMinor,
      device: text("device"),
      traffic_source: text("traffic_source"),
      access_mode: text("access_mode"),
      status: text("status"),
    });
  };

  return (
    <form id="marketplace-filter-form" aria-label="Marketplace filters" onSubmit={submit} className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="mf-vertical">Vertical</Label>
          <Input id="mf-vertical" name="vertical" defaultValue={initial.get("vertical") ?? ""} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-country">Country</Label>
          <Input id="mf-country" name="country" placeholder="US" maxLength={2} defaultValue={initial.get("country") ?? ""} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-payout-type">Payout type</Label>
          <select id="mf-payout-type" name="payout_type" className={selectClassName} defaultValue={initial.get("payout_type") ?? ""}>
            <option value="">Any</option>
            {PAYOUT_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAYOUT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-min-commission">Minimum commission</Label>
          <Input
            id="mf-min-commission"
            name="min_commission"
            inputMode="decimal"
            placeholder="25.00"
            defaultValue={initialFloorMajor}
            aria-invalid={floorError ? true : undefined}
            aria-describedby={floorError ? "mf-min-commission-error" : undefined}
            autoComplete="off"
          />
          {floorError ? (
            <p id="mf-min-commission-error" role="alert" className="text-xs text-destructive">
              {floorError}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-device">Device</Label>
          <Input id="mf-device" name="device" placeholder="MOBILE" defaultValue={initial.get("device") ?? ""} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-traffic-source">Traffic source</Label>
          <Input id="mf-traffic-source" name="traffic_source" placeholder="SEARCH" defaultValue={initial.get("traffic_source") ?? ""} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-access-mode">Access mode</Label>
          <select id="mf-access-mode" name="access_mode" className={selectClassName} defaultValue={initial.get("access_mode") ?? ""}>
            <option value="">Any</option>
            {ACCESS_MODES.map((m) => (
              <option key={m} value={m}>
                {ACCESS_MODE_SHORT_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mf-status">Status</Label>
          <select id="mf-status" name="status" className={selectClassName} defaultValue={initial.get("status") ?? ""}>
            <option value="">Any visible</option>
            {MARKETPLACE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {OFFER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </form>
  );
}

/** Confidential-safe card: only fields present on `MarketplaceOffer`. */
function MarketplaceOfferCard({ orgId, offer }: { orgId: string; offer: MarketplaceOffer }) {
  const v = offer.version;
  return (
    <article className="h-full rounded-lg border bg-card p-4 flex flex-col gap-3" data-testid="marketplace-offer-card">
      <header className="space-y-1">
        <h2 className="font-medium leading-tight">
          <Link to={`/app/${orgId}/marketplace/${offer.id}`} className="underline-offset-4 hover:underline">
            {offer.name}
          </Link>
        </h2>
        <p className="text-xs text-muted-foreground">
          {offer.advertiser.name}
          {offer.vertical ? ` · ${offer.vertical}` : ""}
        </p>
      </header>
      <div className="flex flex-wrap gap-1.5">
        <OfferStatusBadge status={offer.status} />
        <AccessModeBadge mode={offer.access_mode} />
        {offer.my_access ? <AccessGrantStatusBadge status={offer.my_access.status} /> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Commission</dt>
        <dd className="font-medium">
          {v.payout_type === "REVSHARE" && v.revshare_percent_bps !== null
            ? `${formatBps(v.revshare_percent_bps)} revshare`
            : formatMinor(v.affiliate_commission_minor, v.currency)}
        </dd>
        <dt className="text-muted-foreground">Payout type</dt>
        <dd>{v.payout_type}</dd>
        <dt className="text-muted-foreground">Attribution</dt>
        <dd>{formatSeconds(v.attribution_window_seconds)}</dd>
        <dt className="text-muted-foreground">Event</dt>
        <dd className="truncate">{v.conversion_event}</dd>
      </dl>
      <p className="mt-auto text-xs text-muted-foreground">
        {offer.can_join ? "You can join this offer." : offer.can_apply ? "Application required." : "Access is by invitation."}
      </p>
    </article>
  );
}

function dedupe(items: MarketplaceOffer[]): MarketplaceOffer[] {
  const seen = new Map<string, MarketplaceOffer>();
  for (const item of items) seen.set(item.id, item);
  return [...seen.values()];
}
