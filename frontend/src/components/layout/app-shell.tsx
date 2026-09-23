import { Outlet, Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/use-auth";

/**
 * Public application shell: header with auth-aware navigation, main content
 * outlet, footer. Authenticated product areas live under `/app` with their own
 * shell.
 */
export function AppShell() {
  const auth = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header id="app-header" className="border-b px-6 py-4 flex items-center justify-between">
        <Link to="/" className="font-semibold tracking-tight">
          TrafficVaultHub
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-3 text-sm">
          {auth.status === "authenticated" ? (
            <>
              <span className="text-muted-foreground hidden sm:inline">{auth.user?.email}</span>
              <Button asChild size="sm" variant="outline">
                <Link to="/app">Open app</Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={auth.isLoggingOut}
                onClick={() => void auth.logout().then(() => navigate("/login", { replace: true }))}
              >
                Sign out
              </Button>
            </>
          ) : (
            <>
              <Link to="/login" className="underline-offset-4 hover:underline">
                Sign in
              </Link>
              <Button asChild size="sm">
                <Link to="/signup">Create account</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main id="app-main" className="flex-1 px-6 py-10">
        <Outlet />
      </main>

      <footer id="app-footer" className="border-t px-6 py-4 text-xs text-muted-foreground">
        TrafficVaultHub — performance marketing platform. Foundation build; no production data.
      </footer>
    </div>
  );
}
