import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTenant } from "@/features/organizations/hooks";
import { useApplyToOffer, useMarketplaceOffer } from "@/features/offers/hooks";
import {
  ACCESS_MODE_LABELS,
  AccessGrantStatusBadge,
  AccessModeBadge,
  DetailItem,
  OfferStatusBadge,
  PAYOUT_TYPE_LABELS,
  TARGETING_DIMENSION_LABELS,
} from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import { isApiError } from "@/lib/api";
import { formatBps, formatMinor, formatSeconds } from "@/lib/money";
import type { MarketplaceOffer } from "@/types/api";

/**
 * `/app/:orgId/marketplace/:offerId` — one marketplace offer
 * (`GET /organizations/:orgId/marketplace/:offerId`, `offers.read`) and the
 * affiliate's access action (`POST …/apply`).
 *
 * What the affiliate may do is decided by the SERVER and arrives as
 * `can_join` / `can_apply` / `my_access` on the projection (PRD §29, §92):
 *   • can_join  → the offer is LIVE and PUBLIC, or the affiliate holds an
 *                 APPROVED grant. The destination URL is revealed.
 *   • can_apply → APPLICATION_REQUIRED / PRIVATE with no grant, or a
 *                 REJECTED / REVOKED one — an "Apply" button is shown.
 *   • otherwise → no action control at all (INVITE_ONLY / AFFILIATE_SPECIFIC,
 *                 or a pending application); only the grant status, if any.
 * The page never renders advertiser payout, network margin or budget — the
 * server has already stripped them from the projection.
 */
export function MarketplaceOfferPage() {
  const { orgId = "", offerId = "" } = useParams<{ orgId: string; offerId: string }>();
  const tenant = useTenant(orgId);
  const offer = useMarketplaceOffer(orgId, offerId);
  const apply = useApplyToOffer(orgId, offerId);
  const [actionError, setActionError] = useState<string | null>(null);

  if (tenant.isNotMember) return <NotAMember />;
  if (tenant.isLoading || offer.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading offer…
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
  if (offer.isError) {
    const notFound = isApiError(offer.error) && offer.error.status === 404;
    return (
      <section id="marketplace-offer-not-found-section" className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold">{notFound ? "Offer not available" : "Could not load offer"}</h1>
        <p className="text-muted-foreground">
          {notFound ? "This offer does not exist or is not visible to your organization." : errorMessage(offer.error)}
        </p>
        <Link to={`/app/${orgId}/marketplace`} className="underline underline-offset-4">
          Back to marketplace
        </Link>
      </section>
    );
  }

  const o = offer.data;
  const onApply = async () => {
    setActionError(null);
    try {
      await apply.mutateAsync();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <section id="marketplace-offer-section" className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to={`/app/${orgId}/marketplace`} className="text-muted-foreground underline-offset-4 hover:underline">
          ← Marketplace
        </Link>
      </nav>

      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {o.advertiser.name}
          {o.vertical ? ` · ${o.vertical}` : ""}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{o.name}</h1>
        <div className="flex flex-wrap gap-1.5">
          <OfferStatusBadge status={o.status} />
          <AccessModeBadge mode={o.access_mode} />
          {o.my_access ? <AccessGrantStatusBadge status={o.my_access.status} /> : null}
        </div>
        {o.description ? <p className="text-sm text-muted-foreground whitespace-pre-wrap">{o.description}</p> : null}
      </header>

      <AccessPanel offer={o} busy={apply.isPending} error={actionError} onApply={onApply} />

      <section aria-labelledby="marketplace-offer-terms" className="space-y-3">
        <h2 id="marketplace-offer-terms" className="text-sm font-medium">
          Your terms
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 rounded-lg border p-4 text-sm">
          <DetailItem label="Commission">
            <span className="font-medium">{formatMinor(o.version.affiliate_commission_minor, o.version.currency)}</span>
          </DetailItem>
          <DetailItem label="Payout type">{PAYOUT_TYPE_LABELS[o.version.payout_type] ?? o.version.payout_type}</DetailItem>
          {o.version.revshare_percent_bps !== null ? (
            <DetailItem label="Revenue share">{formatBps(o.version.revshare_percent_bps)}</DetailItem>
          ) : null}
          <DetailItem label="Conversion event">{o.version.conversion_event}</DetailItem>
          <DetailItem label="Attribution window">{formatSeconds(o.version.attribution_window_seconds)}</DetailItem>
          <DetailItem label="Daily cap">{o.version.daily_conversion_cap ?? "—"}</DetailItem>
          <DetailItem label="Total cap">{o.version.total_conversion_cap ?? "—"}</DetailItem>
          <DetailItem label="Terms version">v{o.version.version_number}</DetailItem>
        </dl>
      </section>

      <section aria-labelledby="marketplace-offer-targeting" className="space-y-3">
        <h2 id="marketplace-offer-targeting" className="text-sm font-medium">
          Targeting
        </h2>
        {!o.targeting || o.targeting.length === 0 ? (
          <p className="text-sm text-muted-foreground">No targeting restrictions.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {o.targeting.map((t) => (
              <li key={`${t.dimension}=${t.value}`} className="rounded-full border px-2 py-0.5 text-xs">
                {TARGETING_DIMENSION_LABELS[t.dimension] ?? t.dimension}: {t.value}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface AccessPanelProps {
  offer: MarketplaceOffer;
  busy: boolean;
  error: string | null;
  onApply: () => void;
}

function AccessPanel({ offer, busy, error, onApply }: AccessPanelProps) {
  const grant = offer.my_access?.status ?? null;

  let body: ReactNode;
  if (offer.can_join) {
    body = (
      <>
        <p className="text-sm">
          <span className="font-medium">You have access to this offer.</span>{" "}
          {offer.access_mode === "PUBLIC" ? "It is public — no application needed." : "Your access has been approved."}
        </p>
        {offer.destination_url ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Destination:</span>{" "}
            <span className="font-mono break-all" data-testid="marketplace-destination-url">
              {offer.destination_url}
            </span>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">Tracking links for this offer are generated in a later phase.</p>
      </>
    );
  } else if (offer.can_apply) {
    body = (
      <>
        <p className="text-sm">
          {grant === "REJECTED"
            ? "Your previous application was not approved. You may apply again."
            : grant === "REVOKED"
              ? "Your access was revoked. You may apply again."
              : "This offer requires the advertiser's approval before you can promote it."}
        </p>
        <Button size="sm" disabled={busy} onClick={onApply}>
          {busy ? "Applying…" : "Apply for access"}
        </Button>
      </>
    );
  } else if (grant === "REQUESTED") {
    body = <p className="text-sm">Your application is pending the advertiser's decision.</p>;
  } else if (grant === "INVITED") {
    body = <p className="text-sm">You have been invited to this offer. Access becomes active once the advertiser approves it.</p>;
  } else if (grant === "APPROVED") {
    // Approved but not LIVE (paused / cap reached / …) — nothing to do right now.
    body = <p className="text-sm">Your access is approved; the offer is currently {offer.status.toLowerCase().replace(/_/g, " ")}.</p>;
  } else {
    body = <p className="text-sm text-muted-foreground">{ACCESS_MODE_LABELS[offer.access_mode]}. Access is granted by the advertiser.</p>;
  }

  return (
    <section aria-labelledby="marketplace-offer-access" className="space-y-3 rounded-lg border bg-card p-4">
      <h2 id="marketplace-offer-access" className="text-sm font-medium">
        Access
      </h2>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {body}
    </section>
  );
}
