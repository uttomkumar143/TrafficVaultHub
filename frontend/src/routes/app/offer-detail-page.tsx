import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTenant } from "@/features/organizations/hooks";
import {
  useOffer,
  useOfferAccessGrants,
  useOfferHistory,
  useOfferMutations,
  useOfferVersions,
} from "@/features/offers/hooks";
import type { AccessGrantInput } from "@/features/offers/api";
import { DEFAULT_VERSION_FORM, toVersionPayload, versionFormSchema, type VersionFormValues } from "@/features/offers/schemas";
import { VersionDetails, VersionFormFields } from "@/features/offers/version-form-fields";
import {
  ACCESS_MODE_LABELS,
  ACTOR_KIND_LABELS,
  AccessGrantStatusBadge,
  AccessModeBadge,
  GRANT_MANAGED_ACCESS_MODES,
  OFFER_STATUS_LABELS,
  OfferStatusBadge,
  TRANSITION_VERBS,
  formatDateTime,
  isVersionable,
  requiresReason,
  selectClassName,
  textareaClassName,
} from "@/features/offers/presentation";
import { NotAMember } from "@/routes/app/organization-overview-page";
import { errorMessage } from "@/lib/error-message";
import { isApiError } from "@/lib/api";
import { minorToMajorString } from "@/lib/money";
import type { AccessGrant, Offer, OfferStatus, OfferTransition, OfferVersion } from "@/types/api";

/**
 * `/app/:orgId/offers/:offerId` — the advertiser's view of one offer.
 *
 *   • Current version (owner-facing, incl. confidential economics — this page
 *     is only ever mounted for the OWNING organization).
 *   • Lifecycle controls rendered FROM `offer.allowed_transitions` — the
 *     state graph is never hard-coded here; a reason is collected when the
 *     target status demands one (PRD §124) and the server re-checks all of it.
 *   • "New version" form (PRD §24 — versions are immutable, appended only),
 *     shown while the status still accepts versions.
 *   • Immutable version history, newest first.
 *   • Access grant management for non-PUBLIC offers (PRD §92): invite /
 *     approve / reject / revoke — each is one `PUT …/access`.
 *   • Append-only transition history.
 *
 * Every mutation is gated in the UI by `GET /organizations/:orgId/me`
 * permissions for convenience only; the server is the authority (PRD §5, §94).
 */
export function OfferDetailPage() {
  const { orgId = "", offerId = "" } = useParams<{ orgId: string; offerId: string }>();
  const tenant = useTenant(orgId);
  const offer = useOffer(orgId, offerId);
  const versions = useOfferVersions(orgId, offerId);
  const history = useOfferHistory(orgId, offerId);
  const canUpdate = tenant.can("offers.update");
  const canPause = tenant.can("offers.pause");
  const mutations = useOfferMutations(orgId, offerId);
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
      <section id="offer-not-found-section" className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold">{notFound ? "Offer not found" : "Could not load offer"}</h1>
        <p className="text-muted-foreground">
          {notFound ? "This offer does not exist or does not belong to this organization." : errorMessage(offer.error)}
        </p>
        <Link to={`/app/${orgId}/offers`} className="underline underline-offset-4">
          Back to offers
        </Link>
      </section>
    );
  }

  const o = offer.data;
  const run = async (op: Promise<unknown>) => {
    setActionError(null);
    try {
      await op;
      return true;
    } catch (err) {
      setActionError(errorMessage(err));
      return false;
    }
  };
  const busy =
    mutations.transition.isPending || mutations.submit.isPending || mutations.createVersion.isPending || mutations.setAccess.isPending;

  return (
    <section id="offer-detail-section" className="mx-auto max-w-4xl space-y-8">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to={`/app/${orgId}/offers`} className="text-muted-foreground underline-offset-4 hover:underline">
          ← Offers
        </Link>
      </nav>

      <header className="space-y-2">
        {o.vertical ? <p className="text-xs uppercase tracking-wide text-muted-foreground">{o.vertical}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{o.name}</h1>
        <div className="flex flex-wrap gap-1.5">
          <OfferStatusBadge status={o.status} />
          <AccessModeBadge mode={o.access_mode} />
        </div>
        {o.description ? <p className="text-sm text-muted-foreground whitespace-pre-wrap">{o.description}</p> : null}
        <p className="text-xs text-muted-foreground">{ACCESS_MODE_LABELS[o.access_mode]}</p>
        {o.review_notes ? (
          <Alert>
            <AlertDescription>
              <span className="font-medium">Reviewer notes:</span> {o.review_notes}
            </AlertDescription>
          </Alert>
        ) : null}
      </header>

      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <LifecyclePanel
        offer={o}
        canUpdate={canUpdate}
        canPause={canPause}
        busy={busy}
        onTransition={(to, reason) =>
          // DRAFT → SUBMITTED has its own endpoint (adds the "needs a version" check, PRD §22).
          to === "SUBMITTED"
            ? run(mutations.submit.mutateAsync())
            : run(mutations.transition.mutateAsync({ to, ...(reason ? { reason } : {}) }))
        }
      />

      <section aria-labelledby="offer-current-version" className="space-y-3">
        <h2 id="offer-current-version" className="text-sm font-medium">
          Current terms
        </h2>
        {o.current_version ? (
          <div className="rounded-lg border p-4">
            <VersionDetails version={o.current_version} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This offer has no version yet.</p>
        )}
      </section>

      {canUpdate && isVersionable(o.status) ? (
        <NewVersionForm
          current={o.current_version}
          busy={mutations.createVersion.isPending}
          onSubmit={(values) => run(mutations.createVersion.mutateAsync(toVersionPayload(values)))}
        />
      ) : null}

      <VersionHistory versions={versions.data} isPending={versions.isPending} error={versions.isError ? errorMessage(versions.error) : null} />

      {GRANT_MANAGED_ACCESS_MODES.has(o.access_mode) ? (
        <AccessGrantsPanel
          orgId={orgId}
          offerId={offerId}
          canManage={canUpdate}
          busy={mutations.setAccess.isPending}
          onSet={(input) => run(mutations.setAccess.mutateAsync(input))}
        />
      ) : null}

      <TransitionHistory transitions={history.data} isPending={history.isPending} error={history.isError ? errorMessage(history.error) : null} />
    </section>
  );
}

// ---- lifecycle -------------------------------------------------------------

interface LifecyclePanelProps {
  offer: Offer;
  canUpdate: boolean;
  canPause: boolean;
  busy: boolean;
  onTransition: (to: OfferStatus, reason: string | null) => Promise<boolean>;
}

/** Mirror of the backend's per-target permission split (`requiredPermissionFor`, TENANT actor). */
function permissionForTarget(from: OfferStatus, to: OfferStatus): "offers.pause" | "offers.update" {
  if (to === "PAUSED") return "offers.pause";
  if (to === "LIVE" && from !== "APPROVED") return "offers.pause";
  return "offers.update";
}

function LifecyclePanel({ offer, canUpdate, canPause, busy, onTransition }: LifecyclePanelProps) {
  const [pending, setPending] = useState<OfferStatus | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const targets = offer.allowed_transitions.filter((to) => {
    const needed = permissionForTarget(offer.status, to);
    return needed === "offers.pause" ? canPause : canUpdate;
  });

  const start = (to: OfferStatus) => {
    setReasonError(null);
    if (requiresReason(to)) {
      setPending(to);
      setReason("");
      return;
    }
    void onTransition(to, null);
  };

  const confirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pending) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError(`A reason is required to ${TRANSITION_VERBS[pending].toLowerCase()}.`);
      return;
    }
    const ok = await onTransition(pending, trimmed);
    if (ok) {
      setPending(null);
      setReason("");
    }
  };

  return (
    <section aria-labelledby="offer-lifecycle" className="space-y-3 rounded-lg border bg-card p-4">
      <h2 id="offer-lifecycle" className="text-sm font-medium">
        Lifecycle
      </h2>
      <p className="text-sm">
        Current status: <span className="font-medium">{OFFER_STATUS_LABELS[offer.status]}</span>
      </p>
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {offer.allowed_transitions.length === 0
            ? offer.status === "ARCHIVED"
              ? "This offer is archived; no further changes are possible."
              : "No lifecycle action is available to your organization right now."
            : "You do not have permission to change this offer's status."}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Lifecycle actions">
          {targets.map((to) => (
            <Button
              key={to}
              size="sm"
              variant={to === "ARCHIVED" || to === "COMPLIANCE_HOLD" || to === "TRACKING_ISSUE" ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => start(to)}
            >
              {TRANSITION_VERBS[to]}
            </Button>
          ))}
        </div>
      )}

      {pending ? (
        <form id="transition-reason-form" onSubmit={confirm} noValidate className="space-y-3 rounded-md border bg-background p-3">
          <p className="text-sm">
            <span className="font-medium">{TRANSITION_VERBS[pending]}</span> — a reason is required and is recorded in the audit log.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="transition-reason">Reason</Label>
            <textarea
              id="transition-reason"
              className={textareaClassName}
              rows={2}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
            />
            {reasonError ? (
              <p role="alert" className="text-xs text-destructive">
                {reasonError}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Applying…" : `Confirm: ${TRANSITION_VERBS[pending]}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ---- versions --------------------------------------------------------------

interface NewVersionFormProps {
  current: OfferVersion | null;
  busy: boolean;
  onSubmit: (values: VersionFormValues) => Promise<boolean>;
}

/** Pre-fills from the current version (major-unit strings, no floats) so a tweak is a small edit. */
function prefill(current: OfferVersion | null): VersionFormValues {
  if (!current) return DEFAULT_VERSION_FORM;
  const cur = current.currency;
  return {
    payout_type: current.payout_type,
    currency: cur,
    advertiser_payout: minorToMajorString(current.advertiser_payout_minor, cur),
    affiliate_commission: minorToMajorString(current.affiliate_commission_minor, cur),
    network_margin: minorToMajorString(current.network_margin_minor, cur),
    revshare_percent: current.revshare_percent_bps === null ? "" : bpsToPercentString(current.revshare_percent_bps),
    daily_conversion_cap: current.daily_conversion_cap === null ? "" : String(current.daily_conversion_cap),
    total_conversion_cap: current.total_conversion_cap === null ? "" : String(current.total_conversion_cap),
    budget: current.budget_minor === null ? "" : minorToMajorString(current.budget_minor, cur),
    attribution_window_days:
      current.attribution_window_seconds % 86_400 === 0 ? String(current.attribution_window_seconds / 86_400) : "",
    conversion_event: current.conversion_event,
    destination_url: current.destination_url ?? "",
    change_summary: "",
    targeting_lines: current.targeting.map((t) => `${t.dimension}=${t.value}`).join("\n"),
  };
}

/** `2500` → `"25"`, `1250` → `"12.5"` — string math only. */
function bpsToPercentString(bps: number): string {
  const padded = String(bps).padStart(3, "0");
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function NewVersionForm({ current, busy, onSubmit }: NewVersionFormProps) {
  const [open, setOpen] = useState(false);
  const form = useForm<VersionFormValues>({ resolver: zodResolver(versionFormSchema), defaultValues: prefill(current) });

  if (!open) {
    return (
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            form.reset(prefill(current));
            setOpen(true);
          }}
        >
          Create new version
        </Button>
      </div>
    );
  }

  const submit = form.handleSubmit(async (values) => {
    const ok = await onSubmit(values);
    if (ok) {
      setOpen(false);
      form.reset(prefill(current));
    }
  });

  return (
    <form id="new-version-form" aria-labelledby="new-version-heading" onSubmit={submit} noValidate className="space-y-6 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h2 id="new-version-heading" className="text-sm font-medium">
          New version
        </h2>
        <p className="text-xs text-muted-foreground">
          Versions are immutable. Saving creates version {current ? current.version_number + 1 : 1} and makes it current; earlier versions stay in
          the history.
        </p>
      </div>
      <VersionFormFields form={form} disabled={busy} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save new version"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function VersionHistory({ versions, isPending, error }: { versions: OfferVersion[] | undefined; isPending: boolean; error: string | null }) {
  const ordered = versions ? [...versions].sort((a, b) => b.version_number - a.version_number) : [];
  return (
    <section aria-labelledby="offer-version-history" className="space-y-3">
      <h2 id="offer-version-history" className="text-sm font-medium">
        Version history
      </h2>
      {isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading versions…
        </p>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No versions.</p>
      ) : (
        <ol aria-label="Offer versions" className="divide-y rounded-lg border text-sm">
          {ordered.map((v) => (
            <li key={v.id} className="px-3 py-2">
              <details>
                <summary className="cursor-pointer flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">v{v.version_number}</span>
                  <span className="text-muted-foreground">{v.change_summary ?? (v.version_number === 1 ? "Initial version" : "No summary")}</span>
                  <time className="ml-auto text-xs text-muted-foreground" dateTime={v.created_at}>
                    {formatDateTime(v.created_at)}
                  </time>
                </summary>
                <div className="pt-3">
                  <VersionDetails version={v} />
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---- access grants -----------------------------------------------------------

interface AccessGrantsPanelProps {
  orgId: string;
  offerId: string;
  canManage: boolean;
  busy: boolean;
  onSet: (input: AccessGrantInput) => Promise<boolean>;
}

function AccessGrantsPanel({ orgId, offerId, canManage, busy, onSet }: AccessGrantsPanelProps) {
  const grants = useOfferAccessGrants(orgId, offerId);
  const [inviteId, setInviteId] = useState("");
  const [inviteStatus, setInviteStatus] = useState<"INVITED" | "APPROVED">("INVITED");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const id = inviteId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setInviteError("Enter the affiliate organization's id (UUID).");
      return;
    }
    setInviteError(null);
    const ok = await onSet({ affiliate_organization_id: id, status: inviteStatus });
    if (ok) setInviteId("");
  };

  return (
    <section aria-labelledby="offer-access-grants" className="space-y-3">
      <h2 id="offer-access-grants" className="text-sm font-medium">
        Affiliate access
      </h2>
      {grants.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading access grants…
        </p>
      ) : grants.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(grants.error)}</AlertDescription>
        </Alert>
      ) : grants.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No affiliates have access or pending applications.</p>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <caption className="sr-only">Affiliate access grants</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Affiliate organization
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Updated
              </th>
              {canManage ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {grants.data.map((g) => (
              <GrantRow key={g.id} grant={g} canManage={canManage} busy={busy} onSet={onSet} />
            ))}
          </tbody>
        </table>
      )}

      {canManage ? (
        <form id="invite-affiliate-form" aria-label="Invite affiliate" onSubmit={invite} noValidate className="space-y-3 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">Invite or approve an affiliate</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="invite-affiliate-id">Affiliate organization id</Label>
              <Input
                id="invite-affiliate-id"
                value={inviteId}
                onChange={(e) => setInviteId(e.target.value)}
                placeholder="00000000-0000-4000-8000-000000000000"
                autoComplete="off"
                aria-invalid={inviteError ? true : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-affiliate-status">Grant</Label>
              <select
                id="invite-affiliate-status"
                className={selectClassName}
                value={inviteStatus}
                onChange={(e) => setInviteStatus(e.target.value as "INVITED" | "APPROVED")}
              >
                <option value="INVITED">Invite</option>
                <option value="APPROVED">Approve directly</option>
              </select>
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Send"}
            </Button>
          </div>
          {inviteError ? (
            <p role="alert" className="text-xs text-destructive">
              {inviteError}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function GrantRow({
  grant,
  canManage,
  busy,
  onSet,
}: {
  grant: AccessGrant;
  canManage: boolean;
  busy: boolean;
  onSet: (input: AccessGrantInput) => Promise<boolean>;
}) {
  const set = (status: AccessGrantInput["status"]) => {
    let reason: string | null = null;
    if (status === "REJECTED" || status === "REVOKED") {
      reason = window.prompt(`Reason for ${status === "REJECTED" ? "rejecting" : "revoking"} this affiliate's access (optional):`, "");
      if (reason === null) return; // cancelled
    }
    void onSet({ affiliate_organization_id: grant.affiliate_organization_id, status, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
  };
  const shortId = grant.affiliate_organization_id;
  return (
    <tr className="border-t">
      <td className="px-3 py-2 font-mono text-xs break-all">{shortId}</td>
      <td className="px-3 py-2">
        <AccessGrantStatusBadge status={grant.status} />
        {grant.reason ? <p className="text-xs text-muted-foreground mt-1">{grant.reason}</p> : null}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        <time dateTime={grant.updated_at}>{formatDateTime(grant.updated_at)}</time>
      </td>
      {canManage ? (
        <td className="px-3 py-2">
          <div className="flex flex-wrap justify-end gap-1.5">
            {grant.status === "REQUESTED" || grant.status === "INVITED" || grant.status === "REJECTED" || grant.status === "REVOKED" ? (
              <Button size="sm" variant="outline" disabled={busy} aria-label={`Approve ${shortId}`} onClick={() => set("APPROVED")}>
                Approve
              </Button>
            ) : null}
            {grant.status === "REQUESTED" || grant.status === "INVITED" ? (
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Reject ${shortId}`} onClick={() => set("REJECTED")}>
                Reject
              </Button>
            ) : null}
            {grant.status === "APPROVED" ? (
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Revoke ${shortId}`} onClick={() => set("REVOKED")}>
                Revoke
              </Button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

// ---- transition history --------------------------------------------------------

function TransitionHistory({
  transitions,
  isPending,
  error,
}: {
  transitions: OfferTransition[] | undefined;
  isPending: boolean;
  error: string | null;
}) {
  const ordered = transitions ? [...transitions].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)) : [];
  return (
    <section aria-labelledby="offer-transition-history" className="space-y-3">
      <h2 id="offer-transition-history" className="text-sm font-medium">
        Lifecycle history
      </h2>
      {isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No lifecycle changes recorded.</p>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <caption className="sr-only">Offer lifecycle history</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                When
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Change
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                By
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Reason
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                  <time dateTime={t.created_at}>{formatDateTime(t.created_at)}</time>
                </td>
                <td className="px-3 py-2">
                  {t.from_status ? `${OFFER_STATUS_LABELS[t.from_status]} → ` : ""}
                  <span className="font-medium">{OFFER_STATUS_LABELS[t.to_status]}</span>
                </td>
                <td className="px-3 py-2">{ACTOR_KIND_LABELS[t.actor_kind]}</td>
                <td className="px-3 py-2 text-muted-foreground">{t.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
