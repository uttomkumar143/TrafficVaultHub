import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/use-auth";
import { OrganizationSwitcher } from "@/features/organizations/organization-switcher";
import { useTenant } from "@/features/organizations/hooks";
import { cn } from "@/lib/utils";
import type { OrganizationType } from "@/types/api";

/**
 * Mirrors `OFFER_ORG_TYPES` / `AFFILIATE_ORG_TYPES` in
 * backend/src/modules/offers/service.ts. UI-gating only — the server rejects
 * ORG_TYPE_NOT_ADVERTISER / AFFILIATE_ORG_INVALID regardless of what is shown.
 */
const OFFER_OWNER_ORG_TYPES: readonly OrganizationType[] = ["ADVERTISER", "AGENCY"];
const MARKETPLACE_ORG_TYPES: readonly OrganizationType[] = ["AFFILIATE", "PARTNER"];

interface NavSection {
  to: string;
  label: string;
  end: boolean;
}

/**
 * Authenticated product shell mounted under `/app` (inside `<RequireAuth>`).
 * Header: brand, organization switcher, signed-in email, sign out.
 * Sidebar: sections for the current organization (only when one is selected).
 *
 * Phase 1 provides the identity/organization sections. Phase 2 adds
 * "Offers" (ADVERTISER/AGENCY) or "Marketplace" (AFFILIATE/PARTNER), both
 * gated on `offers.read` from `GET /organizations/:orgId/me`. The role-specific
 * dashboards of PRD §86–90 are added by Phase 7 and must never show
 * fabricated numbers before their backends exist.
 */
export function AuthenticatedShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();
  const tenant = useTenant(orgId);

  const sections: NavSection[] = [];
  if (orgId) {
    sections.push({ to: `/app/${orgId}`, label: "Overview", end: true });
    sections.push({ to: `/app/${orgId}/members`, label: "Members", end: false });

    const orgType = tenant.tenant?.organization.type;
    if (orgType && tenant.can("offers.read")) {
      if (OFFER_OWNER_ORG_TYPES.includes(orgType)) {
        sections.push({ to: `/app/${orgId}/offers`, label: "Offers", end: false });
      } else if (MARKETPLACE_ORG_TYPES.includes(orgType)) {
        sections.push({ to: `/app/${orgId}/marketplace`, label: "Marketplace", end: false });
      }
    }
    // Phase 7 — affiliate dashboard (AFFILIATE org type only; server 404s otherwise).
    if (orgType === "AFFILIATE" && (tenant.can("tracking.read") || tenant.can("offers.read"))) {
      sections.push({ to: `/app/${orgId}/dashboard`, label: "Dashboard", end: false });
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header id="app-header" className="border-b px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-4">
          <Link to="/app" className="font-semibold tracking-tight">
            TrafficVaultHub
          </Link>
          <OrganizationSwitcher currentOrgId={orgId} />
        </div>
        <nav aria-label="Account" className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground hidden sm:inline">{auth.user?.email}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={auth.isLoggingOut}
            onClick={() => void auth.logout().then(() => navigate("/login", { replace: true }))}
          >
            Sign out
          </Button>
        </nav>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        {sections.length > 0 ? (
          <aside id="app-sidebar" className="border-b md:border-b-0 md:border-r md:w-56 px-4 py-4">
            <nav aria-label="Organization sections" className="flex md:flex-col gap-1 text-sm">
              {sections.map((s) => (
                <NavLink
                  key={s.to}
                  to={s.to}
                  end={s.end}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-3 py-2 hover:bg-muted",
                      isActive ? "bg-muted font-medium" : "text-muted-foreground",
                    )
                  }
                >
                  {s.label}
                </NavLink>
              ))}
            </nav>
          </aside>
        ) : null}

        <main id="app-main" className="flex-1 px-4 sm:px-6 py-8">
          <Outlet />
        </main>
      </div>

      <footer id="app-footer" className="border-t px-6 py-4 text-xs text-muted-foreground">
        TrafficVaultHub — all figures originate from the backend; no demo data in production.
      </footer>
    </div>
  );
}
