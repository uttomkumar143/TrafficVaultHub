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
  renderWithProviders,
  stubFetch,
  type FetchHandler,
  type FetchStub,
} from "@/test/utils";
import {
  ADVERTISER_MANAGER_PERMISSIONS,
  OFFER_ID,
  OFFER_ID_2,
  makeOffer,
  makeOfferSummary,
  makeTransition,
  makeVersion,
} from "@/test/offer-fixtures";

/**
 * Advertiser offer list (`/app/:orgId/offers`) and create form
 * (`/app/:orgId/offers/new`). Every assertion runs against the stubbed
 * `/api/v1` contract from `backend/src/routes/offers.ts`; money crosses the
 * wire as integer minor units + currency only (PRD §25) and the body never
 * carries an organization / advertiser id (PRD §94).
 */

const SESSION_TOKEN = "tvh_s_test";
const ADVERTISER_ORG = makeOrganization({ id: ORG_A_ID, type: "ADVERTISER", name: "Bravo Ads", slug: "bravo-ads" });
const OFFERS_PATH = `/api/v1/organizations/${ORG_A_ID}/offers`;

function advertiserRoutes(permissions: string[] = ADVERTISER_MANAGER_PERMISSIONS): Record<string, FetchHandler> {
  return {
    "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
    "GET /api/v1/organizations": () => ({ json: { organizations: [ADVERTISER_ORG] } }),
    [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () =>
      ({
        json: makeTenantMe({
          organization: { id: ORG_A_ID, type: "ADVERTISER", name: "Bravo Ads" },
          role: { key: "ADVERTISER_MANAGER", is_owner: false },
          permissions,
        }),
      }),
  };
}

function signedIn(extra: Record<string, FetchHandler>): FetchStub {
  setSessionToken(SESSION_TOKEN);
  return stubFetch(extra);
}

function queryOf(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

describe("advertiser offers", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
    vi.unstubAllGlobals();
  });

  describe("/app/:orgId/offers", () => {
    it("lists the organization's offers with status + access badges and links to each detail", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`GET ${OFFERS_PATH}`]: () => ({
          json: {
            items: [
              makeOfferSummary(),
              makeOfferSummary({ id: OFFER_ID_2, name: "Winter Boots CPL", status: "LIVE", access_mode: "APPLICATION_REQUIRED", vertical: null }),
            ],
            next_cursor: null,
          },
        }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers` });

      const table = await screen.findByRole("table", { name: "Your offers" });
      expect(within(table).getByRole("link", { name: "Spring Shoes CPA" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers/${OFFER_ID}`);
      expect(within(table).getByRole("link", { name: "Winter Boots CPL" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers/${OFFER_ID_2}`);
      expect(within(table).getByText("Draft")).toBeInTheDocument();
      expect(within(table).getByText("Live")).toBeInTheDocument();
      expect(within(table).getByText("Application required")).toBeInTheDocument();
      expect(within(table).getByText("Retail")).toBeInTheDocument();

      // The list request is the tenant-scoped path; nothing else identifies the org.
      const listCall = fetchStub.calls.find((c) => c.path.startsWith(OFFERS_PATH));
      expect(listCall?.headers.get("authorization")).toBe(`Bearer ${SESSION_TOKEN}`);
      expect(queryOf(listCall!.path).get("limit")).toBe("25");
      expect(queryOf(listCall!.path).has("organization_id")).toBe(false);

      expect(screen.getByRole("link", { name: "Create offer" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers/new`);
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("walks next_cursor with 'Load more' and keeps earlier rows", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`GET ${OFFERS_PATH}`]: ({ path }) => {
          const cursor = queryOf(path).get("cursor");
          if (cursor === null) return { json: { items: [makeOfferSummary()], next_cursor: "cursor-page-2" } };
          expect(cursor).toBe("cursor-page-2");
          return { json: { items: [makeOfferSummary({ id: OFFER_ID_2, name: "Winter Boots CPL" })], next_cursor: null } };
        },
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers` });
      const user = userEvent.setup();

      await screen.findByRole("link", { name: "Spring Shoes CPA" });
      expect(screen.queryByRole("link", { name: "Winter Boots CPL" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Load more" }));

      expect(await screen.findByRole("link", { name: "Winter Boots CPL" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Spring Shoes CPA" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      const listCalls = fetchStub.calls.filter((c) => c.path.startsWith(OFFERS_PATH));
      expect(listCalls.map((c) => queryOf(c.path).get("cursor"))).toEqual([null, "cursor-page-2"]);
    });

    it("hides 'Create offer' without offers.create and shows the empty state", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(["organizations.read", "offers.read"]),
        [`GET ${OFFERS_PATH}`]: () => ({ json: { items: [], next_cursor: null } }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers` });

      expect(await screen.findByText("No offers yet.")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Create offer" })).not.toBeInTheDocument();
    });

    it("surfaces the server's refusal instead of an empty list", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`GET ${OFFERS_PATH}`]: () => ({ status: 403, json: errorEnvelope("FORBIDDEN", "Missing permission offers.read") }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers` });

      expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to do that.");
      expect(screen.queryByText("No offers yet.")).not.toBeInTheDocument();
    });
  });

  describe("/app/:orgId/offers/new", () => {
    /** Detail-page routes the app fetches right after a successful create. */
    function detailRoutes(created: ReturnType<typeof makeOffer>): Record<string, FetchHandler> {
      return {
        [`GET ${OFFERS_PATH}/${created.id}`]: () => ({ json: { offer: created } }),
        [`GET ${OFFERS_PATH}/${created.id}/versions`]: () => ({ json: { versions: [created.current_version] } }),
        [`GET ${OFFERS_PATH}/${created.id}/history`]: () => ({ json: { transitions: [makeTransition()] } }),
      };
    }

    it("posts integer minor units + currency only (no ids, no floats) and lands on the new offer", async () => {
      const created = makeOffer({
        name: "Spring Shoes CPA",
        vertical: "Retail",
        current_version: makeVersion({ advertiser_payout_minor: 4029, affiliate_commission_minor: 3000, network_margin_minor: 1029, budget_minor: null, daily_conversion_cap: null, destination_url: null, targeting: [] }),
      });
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`POST ${OFFERS_PATH}`]: ({ body }) => {
          expect(body).toEqual({
            name: "Spring Shoes CPA",
            vertical: "Retail",
            access_mode: "APPLICATION_REQUIRED",
            version: {
              payout_type: "CPA",
              currency: "USD",
              advertiser_payout_minor: 4029,
              affiliate_commission_minor: 3000,
              conversion_event: "purchase",
              daily_conversion_cap: null,
              total_conversion_cap: null,
              attribution_window_seconds: 30 * 86_400,
              destination_url: null,
            },
            targeting: [{ dimension: "COUNTRY", value: "US" }],
          });
          return { status: 201, json: { offer: created } };
        },
        ...detailRoutes(created),
      });
      const { router } = renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers/new` });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Name"), "Spring Shoes CPA");
      await user.type(screen.getByLabelText("Vertical (optional)"), "Retail");
      await user.selectOptions(screen.getByLabelText("Access mode"), "APPLICATION_REQUIRED");
      // "40.29" is the classic float trap (40.29 * 100 = 4028.9999…); it must arrive as 4029.
      await user.type(screen.getByLabelText("Advertiser payout (USD)"), "40.29");
      await user.type(screen.getByLabelText("Affiliate commission (USD)"), "30");
      await user.type(screen.getByLabelText("Conversion event"), "purchase");
      await user.type(screen.getByLabelText("Targeting rules (optional)"), "COUNTRY=US");
      await user.click(screen.getByRole("button", { name: "Create offer" }));

      await waitFor(() => expect(router.state.location.pathname).toBe(`/app/${ORG_A_ID}/offers/${created.id}`));
      expect(await screen.findByRole("heading", { level: 1, name: "Spring Shoes CPA" })).toBeInTheDocument();

      const post = fetchStub.calls.find((c) => c.method === "POST");
      const raw = JSON.stringify(post?.body);
      expect(raw).not.toMatch(/organization_id|advertiser_id|advertiser_profile_id|tenant_id/);
      expect(raw).not.toMatch(/\d+\.\d+/); // no decimal money anywhere in the payload
    });

    it("blocks submission client-side when commission exceeds payout or the name is too short", async () => {
      fetchStub = signedIn(advertiserRoutes());
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers/new` });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Name"), "S");
      await user.type(screen.getByLabelText("Advertiser payout (USD)"), "10");
      await user.type(screen.getByLabelText("Affiliate commission (USD)"), "12");
      await user.type(screen.getByLabelText("Conversion event"), "purchase");
      await user.click(screen.getByRole("button", { name: "Create offer" }));

      expect(await screen.findByText("Name must be at least 2 characters")).toBeInTheDocument();
      expect(screen.getByText("Commission cannot exceed the advertiser payout")).toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("rejects a payout with more precision than the currency allows", async () => {
      fetchStub = signedIn(advertiserRoutes());
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers/new` });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Name"), "Spring Shoes CPA");
      await user.type(screen.getByLabelText("Advertiser payout (USD)"), "40.005");
      await user.type(screen.getByLabelText("Affiliate commission (USD)"), "30");
      await user.type(screen.getByLabelText("Conversion event"), "purchase");
      await user.click(screen.getByRole("button", { name: "Create offer" }));

      expect(await screen.findByText("Enter an amount with at most the USD minor-unit precision")).toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("surfaces a server refusal (ADVERTISER_PROFILE_REQUIRED) and stays on the form", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`POST ${OFFERS_PATH}`]: () =>
          ({ status: 400, json: errorEnvelope("ADVERTISER_PROFILE_REQUIRED", "Create an advertiser profile before creating offers") }),
      });
      const { router } = renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers/new` });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Name"), "Spring Shoes CPA");
      await user.type(screen.getByLabelText("Advertiser payout (USD)"), "40");
      await user.type(screen.getByLabelText("Affiliate commission (USD)"), "30");
      await user.type(screen.getByLabelText("Conversion event"), "purchase");
      await user.click(screen.getByRole("button", { name: "Create offer" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Create an advertiser profile before creating offers");
      expect(router.state.location.pathname).toBe(`/app/${ORG_A_ID}/offers/new`);
    });

    it("shows the forbidden state without offers.create (server would 403 anyway)", async () => {
      fetchStub = signedIn(advertiserRoutes(["organizations.read", "offers.read"]));
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/offers/new` });

      expect(await screen.findByText("You do not have permission to create offers in this organization.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create offer" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to offers" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers`);
    });
  });
});
