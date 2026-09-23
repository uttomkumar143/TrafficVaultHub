import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/use-auth";
import { OrganizationSwitcher } from "@/features/organizations/organization-switcher";
import { cn } from "@/lib/utils";

/**
 * Authenticated product shell mounted under `/app` (inside `<RequireAuth>`).
 * Header: brand, organization switcher, signed-in email, sign out.
 * Sidebar: sections for the current organization (only when one is selected).
 *
 * Only the identity/organization sections exist in Phase 1; the role-specific
 * dashboards of PRD §86–90 are added by Phase 7 and must never show
 * fabricated numbers before their backends exist.
 */
export function AuthenticatedShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();

  const sections = orgId
    ? [
        { to: `/app/${orgId}`, label: "Overview", end: true },
        { to: `/app/${orgId}/members`, label: "Members", end: false },
      ]
    : [];

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
