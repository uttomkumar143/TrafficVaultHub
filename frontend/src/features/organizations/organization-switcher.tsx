import { useNavigate } from "react-router";
import { useOrganizations } from "@/features/organizations/hooks";

const NEW_ORG_VALUE = "__new__";

/**
 * Native `<select>` organization switcher (accessible, no extra dependency).
 * Lists the organizations returned by `GET /organizations` — i.e. only those
 * the server says the user belongs to — and navigates to `/app/:orgId`.
 */
export function OrganizationSwitcher({ currentOrgId }: { currentOrgId?: string }) {
  const navigate = useNavigate();
  const orgs = useOrganizations();

  if (orgs.isPending) {
    return (
      <span className="text-xs text-muted-foreground" role="status">
        Loading organizations…
      </span>
    );
  }
  if (orgs.isError) {
    return (
      <span className="text-xs text-destructive" role="alert">
        Organizations unavailable
      </span>
    );
  }

  const list = orgs.data;
  const knownCurrent = currentOrgId && list.some((o) => o.id === currentOrgId) ? currentOrgId : "";

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Organization</span>
      <select
        id="organization-switcher"
        aria-label="Organization"
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={knownCurrent}
        onChange={(e) => {
          const value = e.target.value;
          if (value === NEW_ORG_VALUE) navigate("/app/organizations/new");
          else if (value) navigate(`/app/${value}`);
        }}
      >
        <option value="" disabled>
          {list.length === 0 ? "No organizations yet" : "Select organization"}
        </option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} · {o.type}
          </option>
        ))}
        <option value={NEW_ORG_VALUE}>+ Create organization</option>
      </select>
    </label>
  );
}
