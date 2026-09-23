import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { routes } from "@/routes";
import { __resetSessionStoreForTests, setSessionToken } from "@/lib/session-store";
import {
  errorEnvelope,
  makeOrganization,
  makeSession,
  makeTenantMe,
  makeUser,
  ORG_A_ID,
  ORG_B_ID,
  renderWithProviders,
  stubFetch,
  type FetchHandler,
  type FetchStub,
} from "@/test/utils";
import type { PublicMember } from "@/types/api";

/**
 * Authenticated area (`/app`) — route guard, organization switcher/index,
 * organization creation, overview and members page. Every assertion runs
 * against the stubbed `/api/v1` contract; the fixtures only describe
 * identity/organization shapes (no metrics, no money).
 */

const SESSION_TOKEN = "tvh_s_test";
const ME_ROUTE = { "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }) };

const ORG_B = makeOrganization({
  id: ORG_B_ID,
  type: "ADVERTISER",
  name: "Bravo Ads",
  slug: "bravo-ads",
  membership: {
    id: "44444444-4444-4444-8444-444444444444",
    role: { key: "VIEWER", name: "Viewer", is_owner: false },
    joined_at: "2026-09-23T00:00:00.000Z",
  },
});

const MEMBER_SELF: PublicMember = {
  id: "33333333-3333-4333-8333-333333333333",
  user: { id: makeUser().id, email: "alice@example.com", display_name: "Alice" },
  role: { key: "AFFILIATE_OWNER", name: "Affiliate Owner", is_owner: true },
  status: "ACTIVE",
  joined_at: "2026-09-23T00:00:00.000Z",
  created_at: "2026-09-23T00:00:00.000Z",
};
const MEMBER_BOB: PublicMember = {
  id: "55555555-5555-4555-8555-555555555555",
  user: { id: "66666666-6666-4666-8666-666666666666", email: "bob@example.com", display_name: null },
  role: { key: "AFFILIATE_USER", name: "Affiliate User", is_owner: false },
  status: "ACTIVE",
  joined_at: "2026-09-23T00:00:00.000Z",
  created_at: "2026-09-23T00:00:00.000Z",
};
const ROLES = [
  { key: "AFFILIATE_OWNER", name: "Affiliate Owner", is_owner: true },
  { key: "AFFILIATE_MANAGER", name: "Affiliate Manager", is_owner: false },
  { key: "AFFILIATE_USER", name: "Affiliate User", is_owner: false },
  { key: "VIEWER", name: "Viewer", is_owner: false },
];

function signedIn(extra: Record<string, FetchHandler>): FetchStub {
  setSessionToken(SESSION_TOKEN);
  return stubFetch({ ...ME_ROUTE, ...extra });
}

describe("authenticated area", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
    vi.unstubAllGlobals();
  });

  describe("RequireAuth guard", () => {
    it("redirects a signed-out visitor to /login and remembers where they came from", async () => {
      fetchStub = stubFetch({});
      const { router } = renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/members?tab=x` });

      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      expect(router.state.location.state).toEqual({ from: `/app/${ORG_A_ID}/members?tab=x` });
      // Nothing protected was requested while signed out.
      expect(fetchStub.calls.filter((c) => c.path.startsWith("/api/v1/organizations"))).toHaveLength(0);
    });

    it("shows a pending state while the session is being verified, then renders the shell", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      setSessionToken(SESSION_TOKEN);
      fetchStub = stubFetch({
        "GET /api/v1/auth/me": async () => {
          await gate;
          return { json: { user: makeUser(), session: makeSession() } };
        },
        "GET /api/v1/organizations": () => ({ json: { organizations: [] } }),
      });
      renderWithProviders(routes, { initialPath: "/app" });

      expect(screen.getByRole("status")).toHaveTextContent("Checking your session…");
      expect(screen.queryByRole("banner")).not.toBeInTheDocument();
      release();

      expect(await screen.findByRole("banner")).toBeInTheDocument();
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    it("sends the bearer token on every /app request and bounces to /login when the server answers 401", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ status: 401, json: errorEnvelope("UNAUTHENTICATED") }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/app" });

      await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
      const orgCall = fetchStub.calls.find((c) => c.path === "/api/v1/organizations");
      expect(orgCall?.headers.get("authorization")).toBe(`Bearer ${SESSION_TOKEN}`);
    });
  });

  describe("/app index + organization switcher", () => {
    it("shows the empty state with a create link when the user has no organizations", async () => {
      fetchStub = signedIn({ "GET /api/v1/organizations": () => ({ json: { organizations: [] } }) });
      renderWithProviders(routes, { initialPath: "/app" });

      expect(await screen.findByText("You are not a member of any organization yet.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Create organization" })).toHaveAttribute("href", "/app/organizations/new");
      const switcher = screen.getByRole("combobox", { name: "Organization" });
      expect(within(switcher).getByRole("option", { name: "No organizations yet" })).toBeInTheDocument();
    });

    it("redirects straight to the only organization", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [makeOrganization()] } }),
        [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () => ({ json: makeTenantMe() }),
        [`GET /api/v1/organizations/${ORG_A_ID}`]: () => ({ json: { organization: makeOrganization() } }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/app" });

      await waitFor(() => expect(router.state.location.pathname).toBe(`/app/${ORG_A_ID}`));
      expect(await screen.findByRole("heading", { level: 1, name: "Acme Affiliates" })).toBeInTheDocument();
    });

    it("lists several organizations and the switcher navigates between them", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [makeOrganization(), ORG_B] } }),
        [`GET /api/v1/organizations/${ORG_B_ID}/me`]: () =>
          ({
            json: makeTenantMe({
              organization: { id: ORG_B_ID, type: "ADVERTISER", name: "Bravo Ads" },
              role: { key: "VIEWER", is_owner: false },
              permissions: ["organizations.read"],
            }),
          }),
        [`GET /api/v1/organizations/${ORG_B_ID}`]: () => ({ json: { organization: ORG_B } }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/app" });
      const user = userEvent.setup();

      expect(await screen.findByRole("heading", { level: 1, name: "Your organizations" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Acme Affiliates" })).toHaveAttribute("href", `/app/${ORG_A_ID}`);
      expect(screen.getByRole("link", { name: "Bravo Ads" })).toHaveAttribute("href", `/app/${ORG_B_ID}`);

      await user.selectOptions(screen.getByRole("combobox", { name: "Organization" }), ORG_B_ID);
      await waitFor(() => expect(router.state.location.pathname).toBe(`/app/${ORG_B_ID}`));
      expect(await screen.findByRole("heading", { level: 1, name: "Bravo Ads" })).toBeInTheDocument();
      expect(screen.getByText("VIEWER")).toBeInTheDocument();
      // No members.read → the "Manage members" action is hidden (server would 403 anyway).
      expect(screen.queryByRole("link", { name: "Manage members" })).not.toBeInTheDocument();
    });
  });

  describe("/app/organizations/new", () => {
    it("validates client-side, then posts the exact create body and lands on the new organization", async () => {
      const created = makeOrganization({ id: ORG_B_ID, type: "ADVERTISER", name: "Bravo Ads", slug: "bravo-ads" });
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [] } }),
        "POST /api/v1/organizations": ({ body }) => {
          expect(body).toEqual({ type: "ADVERTISER", name: "Bravo Ads" });
          return { status: 201, json: { organization: created } };
        },
        [`GET /api/v1/organizations/${ORG_B_ID}/me`]: () =>
          ({ json: makeTenantMe({ organization: { id: ORG_B_ID, type: "ADVERTISER", name: "Bravo Ads" } }) }),
        [`GET /api/v1/organizations/${ORG_B_ID}`]: () => ({ json: { organization: created } }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/app/organizations/new" });
      const user = userEvent.setup();

      const submit = await screen.findByRole("button", { name: "Create organization" });
      await user.click(submit);
      expect(await screen.findByText("Name must be at least 2 characters")).toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.method === "POST")).toHaveLength(0);

      await user.selectOptions(screen.getByLabelText("Type"), "ADVERTISER");
      await user.type(screen.getByLabelText("Name"), "Bravo Ads");
      await user.click(submit);

      await waitFor(() => expect(router.state.location.pathname).toBe(`/app/${ORG_B_ID}`));
      expect(await screen.findByRole("heading", { level: 1, name: "Bravo Ads" })).toBeInTheDocument();
    });

    it("surfaces a server conflict without navigating", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [] } }),
        "POST /api/v1/organizations": () => ({ status: 409, json: errorEnvelope("SLUG_ALREADY_EXISTS", "Slug already in use") }),
      });
      const { router } = renderWithProviders(routes, { initialPath: "/app/organizations/new" });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Name"), "Acme Affiliates");
      await user.type(screen.getByLabelText("Slug (optional)"), "acme-affiliates");
      await user.click(screen.getByRole("button", { name: "Create organization" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Slug already in use");
      expect(router.state.location.pathname).toBe("/app/organizations/new");
      const post = fetchStub.calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ type: "AFFILIATE", name: "Acme Affiliates", slug: "acme-affiliates" });
    });
  });

  describe("/app/:orgId (overview)", () => {
    it("renders the not-a-member state when the server answers 404 (no enumeration)", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [makeOrganization()] } }),
        [`GET /api/v1/organizations/${ORG_B_ID}/me`]: () => ({ status: 404, json: errorEnvelope("ORGANIZATION_NOT_FOUND") }),
        [`GET /api/v1/organizations/${ORG_B_ID}`]: () => ({ status: 404, json: errorEnvelope("ORGANIZATION_NOT_FOUND") }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_B_ID}` });

      expect(await screen.findByRole("heading", { level: 1, name: "Organization not found" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to your organizations" })).toHaveAttribute("href", "/app");
    });

    it("shows role, permissions and the members action for a member with members.read", async () => {
      fetchStub = signedIn({
        "GET /api/v1/organizations": () => ({ json: { organizations: [makeOrganization()] } }),
        [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () => ({ json: makeTenantMe() }),
        [`GET /api/v1/organizations/${ORG_A_ID}`]: () => ({ json: { organization: makeOrganization() } }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}` });

      expect(await screen.findByRole("heading", { level: 1, name: "Acme Affiliates" })).toBeInTheDocument();
      expect(screen.getByText("AFFILIATE_OWNER")).toBeInTheDocument();
      expect(screen.getByText("acme-affiliates")).toBeInTheDocument();
      expect(screen.getByText("members.manage")).toBeInTheDocument();
      expect(await screen.findByRole("link", { name: "Manage members" })).toHaveAttribute("href", `/app/${ORG_A_ID}/members`);
    });
  });

  describe("/app/:orgId/members", () => {
    function membersRoutes(tenantPermissions: string[], members: PublicMember[]) {
      return {
        "GET /api/v1/organizations": () => ({ json: { organizations: [makeOrganization()] } }),
        [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () => ({ json: makeTenantMe({ permissions: tenantPermissions }) }),
        [`GET /api/v1/organizations/${ORG_A_ID}/members`]: () => ({ json: { members } }),
        [`GET /api/v1/organizations/${ORG_A_ID}/roles`]: () => ({ json: { roles: ROLES } }),
      };
    }

    it("read-only member sees the list but no add/role/remove controls", async () => {
      fetchStub = signedIn(membersRoutes(["members.read", "organizations.read"], [MEMBER_SELF, MEMBER_BOB]));
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/members` });

      const table = await screen.findByRole("table", { name: "Organization members" });
      expect(within(table).getByText("bob@example.com")).toBeInTheDocument();
      expect(within(table).getByText("(you)")).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: /add member/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: /Role for/ })).not.toBeInTheDocument();
      // The roles catalogue is only fetched when management is possible.
      expect(fetchStub.calls.some((c) => c.path.endsWith("/roles"))).toBe(false);
    });

    it("manager can add a member (exact body), change a role and remove — never for their own seat", async () => {
      const list: PublicMember[] = [MEMBER_SELF, MEMBER_BOB];
      fetchStub = signedIn({
        ...membersRoutes(["members.read", "members.manage", "organizations.read"], list),
        [`GET /api/v1/organizations/${ORG_A_ID}/members`]: () => ({ json: { members: [...list] } }),
        [`POST /api/v1/organizations/${ORG_A_ID}/members`]: ({ body }) => {
          expect(body).toEqual({ email: "carol@example.com", role: "VIEWER" });
          const member: PublicMember = {
            ...MEMBER_BOB,
            id: "77777777-7777-4777-8777-777777777777",
            user: { id: "88888888-8888-4888-8888-888888888888", email: "carol@example.com", display_name: null },
            role: { key: "VIEWER", name: "Viewer", is_owner: false },
          };
          list.push(member);
          return { status: 201, json: { member } };
        },
        [`PATCH /api/v1/organizations/${ORG_A_ID}/members/${MEMBER_BOB.id}`]: ({ body }) => {
          expect(body).toEqual({ role: "AFFILIATE_MANAGER" });
          list[1] = { ...MEMBER_BOB, role: { key: "AFFILIATE_MANAGER", name: "Affiliate Manager", is_owner: false } };
          return { json: { member: list[1] } };
        },
        [`DELETE /api/v1/organizations/${ORG_A_ID}/members/${MEMBER_BOB.id}`]: () => {
          list.splice(1, 1);
          return { status: 204 };
        },
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/members` });
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);

      await screen.findByRole("table", { name: "Organization members" });
      // Own seat: no role select, no remove button.
      expect(screen.queryByRole("combobox", { name: "Role for alice@example.com" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove alice@example.com" })).not.toBeInTheDocument();

      // Add
      await user.type(screen.getByLabelText("Email"), "carol@example.com");
      await user.selectOptions(screen.getByLabelText("Role"), "VIEWER");
      await user.click(screen.getByRole("button", { name: "Add member" }));
      expect(await screen.findByText("carol@example.com")).toBeInTheDocument();

      // Change role
      await user.selectOptions(screen.getByRole("combobox", { name: "Role for bob@example.com" }), "AFFILIATE_MANAGER");
      await waitFor(() =>
        expect(fetchStub.calls.some((c) => c.method === "PATCH" && c.path.endsWith(MEMBER_BOB.id))).toBe(true),
      );

      // Remove
      await user.click(screen.getByRole("button", { name: "Remove bob@example.com" }));
      await waitFor(() => expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument());
      expect(fetchStub.calls.some((c) => c.method === "DELETE" && c.path.endsWith(MEMBER_BOB.id))).toBe(true);
    });

    it("surfaces the server's LAST_OWNER refusal instead of pretending success", async () => {
      fetchStub = signedIn({
        ...membersRoutes(["members.read", "members.manage", "organizations.read"], [MEMBER_SELF, MEMBER_BOB]),
        [`DELETE /api/v1/organizations/${ORG_A_ID}/members/${MEMBER_BOB.id}`]: () =>
          ({ status: 409, json: errorEnvelope("LAST_OWNER", "Cannot remove the last owner") }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/members` });
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);

      await user.click(await screen.findByRole("button", { name: "Remove bob@example.com" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Cannot remove the last owner");
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });
  });
});
