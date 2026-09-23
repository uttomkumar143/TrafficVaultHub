import type { ReactNode } from "react";
import { useTenant } from "@/features/organizations/hooks";

interface RequirePermissionProps {
  orgId: string;
  /** Permission key from the PRD §10 catalogue (e.g. `members.manage`). */
  permission: string;
  children: ReactNode;
  /** Rendered instead of `children` when the key is absent (default: nothing). */
  fallback?: ReactNode;
  /** Rendered while the tenant authority is still loading (default: nothing). */
  pending?: ReactNode;
}

/**
 * Permission-gated fragment. Hides (or swaps for `fallback`) UI whose backing
 * endpoint the caller cannot use, based on `GET /organizations/:orgId/me`.
 *
 * This is convenience only — the server answers 403 regardless of what the
 * client renders (PRD §5, §94). Never put security logic here.
 */
export function RequirePermission({ orgId, permission, children, fallback = null, pending = null }: RequirePermissionProps) {
  const tenant = useTenant(orgId);
  if (tenant.isLoading) return <>{pending}</>;
  if (!tenant.tenant || !tenant.can(permission)) return <>{fallback}</>;
  return <>{children}</>;
}
