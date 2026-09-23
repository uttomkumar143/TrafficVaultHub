import { Link, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RequirePermission } from "@/components/auth/require-permission";
import { useOrganization, useTenant } from "@/features/organizations/hooks";
import { errorMessage } from "@/lib/error-message";

/**
 * `/app/:orgId` — organization overview. Shows the organization record
 * (`GET /organizations/:orgId`, `organizations.read`) and the caller's own
 * role/permissions (`GET /organizations/:orgId/me`). Dashboards with real
 * metrics arrive in Phase 7; nothing here fabricates numbers.
 */
export function OrganizationOverviewPage() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  const tenant = useTenant(orgId);
  const org = useOrganization(orgId);

  if (tenant.isNotMember) return <NotAMember />;
  if (tenant.isLoading || (org.isPending && org.fetchStatus !== "idle")) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading organization…
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
  if (!tenant.tenant) return null;

  const t = tenant.tenant;

  return (
    <section id="organization-overview-section" className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.organization.type}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t.organization.name}</h1>
        <p className="text-sm text-muted-foreground">
          Your role: <span className="font-medium text-foreground">{t.role.key}</span>
          {t.role.is_owner ? " (owner)" : null}
        </p>
      </header>

      {org.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(org.error)}</AlertDescription>
        </Alert>
      ) : org.data ? (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 rounded-lg border p-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Slug</dt>
            <dd className="font-mono">{org.data.slug}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{org.data.status}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              <time dateTime={org.data.created_at}>{new Date(org.data.created_at).toLocaleString()}</time>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Member since</dt>
            <dd>
              {t.membership.joined_at ? (
                <time dateTime={t.membership.joined_at}>{new Date(t.membership.joined_at).toLocaleString()}</time>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <RequirePermission orgId={orgId} permission="members.read">
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/${orgId}/members`}>Manage members</Link>
          </Button>
        </RequirePermission>
      </div>

      <section aria-labelledby="permissions-heading" className="space-y-2">
        <h2 id="permissions-heading" className="text-sm font-medium">
          Your permissions in this organization
        </h2>
        {t.permissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No permissions granted.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {t.permissions.map((p) => (
              <li key={p} className="rounded-full border px-2.5 py-0.5 font-mono text-xs">
                {p}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Operational and financial dashboards are not yet available — they are delivered with later phases and will
        only ever show backend-computed figures.
      </p>
    </section>
  );
}

export function NotAMember() {
  return (
    <section id="organization-not-found-section" className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Organization not found</h1>
      <p className="text-muted-foreground">
        This organization does not exist or you are not a member of it.
      </p>
      <Link to="/app" className="underline underline-offset-4">
        Back to your organizations
      </Link>
    </section>
  );
}
