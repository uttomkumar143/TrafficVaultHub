import { Outlet, Link } from "react-router";

/**
 * Minimal reusable application shell: header, main content outlet, footer.
 * Navigation is intentionally sparse in Phase 0.
 */
export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header
        id="app-header"
        className="border-b px-6 py-4 flex items-center justify-between"
      >
        <Link to="/" className="font-semibold tracking-tight">
          TrafficVaultHub
        </Link>
        <nav aria-label="Primary" className="text-sm text-muted-foreground">
          <span>Phase 0 — Bootstrap</span>
        </nav>
      </header>

      <main id="app-main" className="flex-1 px-6 py-10">
        <Outlet />
      </main>

      <footer
        id="app-footer"
        className="border-t px-6 py-4 text-xs text-muted-foreground"
      >
        TrafficVaultHub — performance marketing platform. Foundation build; no
        production data.
      </footer>
    </div>
  );
}
