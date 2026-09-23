import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "@/features/auth/use-auth";
import { errorMessage } from "@/lib/error-message";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Route guard: renders children only for an authenticated user.
 *
 * - `loading`          → neutral pending state (never flashes protected UI).
 * - `unauthenticated`  → redirect to `/login` with `state.from` so the login
 *                        page can return here afterwards.
 * - transient `/auth/me` failure (network) → honest error, no guessing.
 *
 * UI-only gating (PRD §5): the server enforces authentication on every call.
 */
export function RequireAuth({ children }: { children?: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "unauthenticated") {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  if (auth.status === "loading") {
    if (auth.error) {
      return (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(auth.error)}</AlertDescription>
        </Alert>
      );
    }
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        Checking your session…
      </p>
    );
  }

  return children ? <>{children}</> : <Outlet />;
}
