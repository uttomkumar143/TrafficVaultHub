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
import { CONFIDENTIAL_MARKERS, OFFER_ID, OFFER_ID_2, makeGrant, makeMarketplaceOffer } from "@/test/offer-fixtures";
import type { MarketplaceOffer } from "@/types/api";

/**
 * Affiliate marketplace (`/app/:orgId/marketplace`, `/app/:orgId/marketplace/:offerId`).
 *
 * Two invariants dominate: (1) every filter is forwarded to the SERVER as a
 * query parameter (the browser never filters a wider result set down — PRD
 * §29); (2) confidential advertiser economics never reach the DOM. The second
 * is asserted with a deliberately poisoned stub that adds advertiser_payout /
 * network_margin / budget fields the real server would never send — the page
 * must still render none of them.
 */

const SESSION_TOKEN = "tvh_s_test";
const AFFILIATE_ORG = makeOrganization({ id: ORG_A_ID, type: "AFFILIATE", name: "Acme Affiliates" });
const MARKETPLACE_PATH = `/api/v1/organizations/${ORG_A_ID}/marketplace`;

function affiliateRoutes(permissions: string[] = ["organizations.read", "members.read", "offers.read"]): Record<string, FetchHandler> {
  return {
    "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
    "GET /api/v1/organizations": () => ({ json: { organizations: [AFFILIATE_ORG] } }),
    [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () =>
      ({ json: makeTenantMe({ organization: { id: ORG_A_ID, type: "AFFILIATE", name: "Acme Affiliates" }, permissions }) }),
  };
}

function signedIn(extra: Record<string, FetchHandler>): FetchStub {
  setSessionToken(SESSION_TOKEN);
  return stubFetch(extra);
}

function queryOf(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

/** A "malicious"/buggy server response carrying confidential keys the projection must not have. */
function poisoned(offer: MarketplaceOffer): Record<string, unknown> {
  return {
    ...offer,
    advertiser_payout_minor: 999_999,
    network_margin_minor: 888_888,
    budget_minor: 777_777,
    version: { ...offer.version, advertiser_payout_minor: 999_999, network_margin_minor: 888_888, budget_minor: 777_777 },
  };
}

function expectNoConfidentialData() {
  const html = document.body.innerHTML;
  for (const marker of CONFIDENTIAL_MARKERS) expect(html).not.toMatch(marker);
  expect(html).not.toMatch(/999,999|9,999\.99|888,888|8,888\.88|777,777|7,777\.77/);
}

describe("affiliate marketplace", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
    vi.unstubAllGlobals();
  });

  describe("/app/:orgId/marketplace", () => {
    it("renders confidential-safe cards only — even when the stub leaks advertiser economics", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: () => ({
          json: {
            items: [
              poisoned(makeMarketplaceOffer()),
              poisoned(
                makeMarketplaceOffer({
                  id: OFFER_ID_2,
                  name: "Streaming REVSHARE",
                  access_mode: "APPLICATION_REQUIRED",
                  can_join: false,
                  can_apply: true,
                  version: { ...makeMarketplaceOffer().version, payout_type: "REVSHARE", revshare_percent_bps: 2550, affiliate_commission_minor: 0 },
                }),
              ),
            ],
            next_cursor: null,
          },
        }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace` });

      const list = await screen.findByRole("list", { name: "Marketplace offers" });
      const cards = within(list).getAllByTestId("marketplace-offer-card");
      expect(cards).toHaveLength(2);

      // Affiliate-facing figures ARE shown …
      expect(within(cards[0]!).getByText("USD 30.00")).toBeInTheDocument();
      expect(within(cards[0]!).getByText("Bravo Ads · Retail")).toBeInTheDocument();
      expect(within(cards[0]!).getByText("You can join this offer.")).toBeInTheDocument();
      expect(within(cards[0]!).getByRole("link", { name: "Spring Shoes CPA" })).toHaveAttribute("href", `/app/${ORG_A_ID}/marketplace/${OFFER_ID}`);
      expect(within(cards[1]!).getByText("25.50% revshare")).toBeInTheDocument();
      expect(within(cards[1]!).getByText("Application required.")).toBeInTheDocument();

      // … confidential ones never are (PRD §29).
      expectNoConfidentialData();

      // Initial search: no filters, only the page size.
      const search = fetchStub.calls.find((c) => c.path.startsWith(MARKETPLACE_PATH));
      expect([...queryOf(search!.path).keys()].sort()).toEqual(["limit"]);
    });

    it("applies and combines all eight filters server-side, converting the commission floor to integer minor units", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: ({ path }) => {
          const q = queryOf(path);
          if (!q.has("vertical")) return { json: { items: [makeMarketplaceOffer()], next_cursor: null } };
          return { json: { items: [makeMarketplaceOffer({ id: OFFER_ID_2, name: "Filtered Hit" })], next_cursor: null } };
        },
      });
      const { router } = renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace` });
      const user = userEvent.setup();

      await screen.findByRole("link", { name: "Spring Shoes CPA" });
      const form = screen.getByRole("form", { name: "Marketplace filters" });
      await user.type(within(form).getByLabelText("Vertical"), "Retail");
      await user.type(within(form).getByLabelText("Country"), "us");
      await user.selectOptions(within(form).getByLabelText("Payout type"), "CPA");
      await user.type(within(form).getByLabelText("Minimum commission"), "25.50");
      await user.type(within(form).getByLabelText("Device"), "mobile");
      await user.type(within(form).getByLabelText("Traffic source"), "search");
      await user.selectOptions(within(form).getByLabelText("Access mode"), "PUBLIC");
      await user.selectOptions(within(form).getByLabelText("Status"), "LIVE");
      await user.click(within(form).getByRole("button", { name: "Apply filters" }));

      expect(await screen.findByRole("link", { name: "Filtered Hit" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Spring Shoes CPA" })).not.toBeInTheDocument();

      // URL is the source of truth (shareable) …
      const urlParams = new URLSearchParams(router.state.location.search);
      expect(urlParams.get("min_commission_minor")).toBe("2550");
      expect(urlParams.get("vertical")).toBe("Retail");

      // … and every filter reached the server, AND-combined, upper-cased where the server expects codes.
      const filtered = fetchStub.calls.filter((c) => c.path.startsWith(MARKETPLACE_PATH) && queryOf(c.path).has("vertical")).at(-1)!;
      const q = queryOf(filtered.path);
      expect(Object.fromEntries(q.entries())).toEqual({
        vertical: "Retail",
        country: "US",
        payout_type: "CPA",
        min_commission_minor: "2550",
        device: "MOBILE",
        traffic_source: "SEARCH",
        access_mode: "PUBLIC",
        status: "LIVE",
        limit: "24",
      });
      // The floor is an integer, never a float, on the wire.
      expect(q.get("min_commission_minor")).toMatch(/^\d+$/);
    });

    it("rejects a malformed commission floor client-side and never sends it", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: () => ({ json: { items: [makeMarketplaceOffer()], next_cursor: null } }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace` });
      const user = userEvent.setup();

      await screen.findByRole("link", { name: "Spring Shoes CPA" });
      await user.type(screen.getByLabelText("Minimum commission"), "25.505");
      await user.click(screen.getByRole("button", { name: "Apply filters" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount like 25 or 25.50");
      expect(fetchStub.calls.some((c) => queryOf(c.path).has("min_commission_minor"))).toBe(false);
    });

    it("hydrates the filter form from the URL and 'Clear' drops every filter", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: () => ({ json: { items: [], next_cursor: null } }),
      });
      const { router } = renderWithProviders(routes, {
        initialPath: `/app/${ORG_A_ID}/marketplace?country=US&min_commission_minor=2550&status=PAUSED&status_bogus=1`,
      });
      const user = userEvent.setup();

      expect(await screen.findByText("No offers match these filters.")).toBeInTheDocument();
      expect(screen.getByLabelText("Country")).toHaveValue("US");
      expect(screen.getByLabelText("Minimum commission")).toHaveValue("25.50");
      expect(screen.getByLabelText("Status")).toHaveValue("PAUSED");

      const first = fetchStub.calls.find((c) => c.path.startsWith(MARKETPLACE_PATH))!;
      expect(Object.fromEntries(queryOf(first.path).entries())).toEqual({ country: "US", min_commission_minor: "2550", status: "PAUSED", limit: "24" });

      await user.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(router.state.location.search).toBe(""));
      await waitFor(() => {
        const last = fetchStub.calls.filter((c) => c.path.startsWith(MARKETPLACE_PATH)).at(-1)!;
        expect([...queryOf(last.path).keys()]).toEqual(["limit"]);
      });
    });

    it("walks next_cursor with 'Load more'", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: ({ path }) => {
          const cursor = queryOf(path).get("cursor");
          if (cursor === null) return { json: { items: [makeMarketplaceOffer()], next_cursor: "mk-2" } };
          return { json: { items: [makeMarketplaceOffer({ id: OFFER_ID_2, name: "Second Page" })], next_cursor: null } };
        },
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace` });
      const user = userEvent.setup();

      await screen.findByRole("link", { name: "Spring Shoes CPA" });
      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(await screen.findByRole("link", { name: "Second Page" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Spring Shoes CPA" })).toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.path.startsWith(MARKETPLACE_PATH)).map((c) => queryOf(c.path).get("cursor"))).toEqual([null, "mk-2"]);
    });

    it("surfaces the server's AFFILIATE_ORG_INVALID refusal (advertiser org opened the marketplace)", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${MARKETPLACE_PATH}`]: () =>
          ({ status: 400, json: errorEnvelope("AFFILIATE_ORG_INVALID", "The marketplace is available to affiliate or partner organizations") }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace` });

      expect(await screen.findByRole("alert")).toHaveTextContent("The marketplace is available to affiliate or partner organizations");
    });
  });

  describe("/app/:orgId/marketplace/:offerId", () => {
    const DETAIL_PATH = `${MARKETPLACE_PATH}/${OFFER_ID}`;

    function renderDetail(offer: MarketplaceOffer, extra: Record<string, FetchHandler> = {}) {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${DETAIL_PATH}`]: () => ({ json: { offer: poisoned(offer) } }),
        ...extra,
      });
      return renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace/${OFFER_ID}` });
    }

    function accessPanel() {
      return screen.getByRole("region", { name: "Access" });
    }

    it("PUBLIC + LIVE (can_join): shows access + destination URL and no apply control; no confidential data", async () => {
      renderDetail(makeMarketplaceOffer({ destination_url: "https://advertiser.example/landing", targeting: [{ dimension: "COUNTRY", value: "US" }] }));

      expect(await screen.findByRole("heading", { level: 1, name: "Spring Shoes CPA" })).toBeInTheDocument();
      const panel = accessPanel();
      expect(within(panel).getByText("You have access to this offer.")).toBeInTheDocument();
      expect(within(panel).getByText("It is public — no application needed.")).toBeInTheDocument();
      expect(within(panel).getByTestId("marketplace-destination-url")).toHaveTextContent("https://advertiser.example/landing");
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();

      // Affiliate terms shown; targeting shown; confidential fields absent.
      expect(screen.getByText("USD 30.00")).toBeInTheDocument();
      expect(screen.getByText("Country: US")).toBeInTheDocument();
      expectNoConfidentialData();
    });

    it("APPROVED grant + LIVE (can_join): 'approved' copy and destination", async () => {
      renderDetail(
        makeMarketplaceOffer({
          access_mode: "PRIVATE",
          my_access: { status: "APPROVED" },
          can_join: true,
          can_apply: false,
          destination_url: "https://advertiser.example/private",
        }),
      );
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText("Your access has been approved.")).toBeInTheDocument();
      expect(within(panel).getByTestId("marketplace-destination-url")).toHaveTextContent("https://advertiser.example/private");
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    });

    it("APPLICATION_REQUIRED with no grant (can_apply): Apply posts to /apply and the panel flips to pending", async () => {
      let applied = false;
      renderDetail(makeMarketplaceOffer({ access_mode: "APPLICATION_REQUIRED", can_join: false, can_apply: true }), {
        [`GET ${DETAIL_PATH}`]: () =>
          ({
            json: {
              offer: poisoned(
                applied
                  ? makeMarketplaceOffer({ access_mode: "APPLICATION_REQUIRED", can_join: false, can_apply: false, my_access: { status: "REQUESTED" } })
                  : makeMarketplaceOffer({ access_mode: "APPLICATION_REQUIRED", can_join: false, can_apply: true }),
              ),
            },
          }),
        [`POST ${DETAIL_PATH}/apply`]: ({ body }) => {
          expect(body).toBeUndefined(); // the affiliate org comes from the path, never the body
          applied = true;
          return { status: 201, json: { grant: makeGrant({ status: "REQUESTED" }) } };
        },
      });
      const user = userEvent.setup();

      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText("This offer requires the advertiser's approval before you can promote it.")).toBeInTheDocument();
      expect(screen.queryByTestId("marketplace-destination-url")).not.toBeInTheDocument();

      await user.click(within(panel).getByRole("button", { name: "Apply for access" }));

      expect(await screen.findByText("Your application is pending the advertiser's decision.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Apply for access" })).not.toBeInTheDocument();
      expect(screen.getByText("Application pending")).toBeInTheDocument();
      const post = fetchStub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe(`${DETAIL_PATH}/apply`);
    });

    it.each([
      ["REJECTED", "Your previous application was not approved. You may apply again."],
      ["REVOKED", "Your access was revoked. You may apply again."],
    ] as const)("%s grant on a PRIVATE offer (can_apply): re-apply copy + Apply button", async (status, copy) => {
      renderDetail(makeMarketplaceOffer({ access_mode: "PRIVATE", my_access: { status }, can_join: false, can_apply: true }));
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText(copy)).toBeInTheDocument();
      expect(within(panel).getByRole("button", { name: "Apply for access" })).toBeInTheDocument();
    });

    it("REQUESTED grant (neither join nor apply): pending copy, no action control", async () => {
      renderDetail(makeMarketplaceOffer({ access_mode: "APPLICATION_REQUIRED", my_access: { status: "REQUESTED" }, can_join: false, can_apply: false }));
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText("Your application is pending the advertiser's decision.")).toBeInTheDocument();
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("marketplace-destination-url")).not.toBeInTheDocument();
    });

    it("INVITED grant: invitation copy, no action control", async () => {
      renderDetail(makeMarketplaceOffer({ access_mode: "INVITE_ONLY", my_access: { status: "INVITED" }, can_join: false, can_apply: false }));
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText(/You have been invited to this offer/)).toBeInTheDocument();
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    });

    it("APPROVED grant but offer PAUSED (can_join=false): explains the status, no destination", async () => {
      renderDetail(makeMarketplaceOffer({ access_mode: "PRIVATE", status: "PAUSED", my_access: { status: "APPROVED" }, can_join: false, can_apply: false }));
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText("Your access is approved; the offer is currently paused.")).toBeInTheDocument();
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("marketplace-destination-url")).not.toBeInTheDocument();
    });

    it.each(["INVITE_ONLY", "AFFILIATE_SPECIFIC"] as const)("%s with no grant: explains access is granted by the advertiser, no control", async (mode) => {
      renderDetail(makeMarketplaceOffer({ access_mode: mode, my_access: null, can_join: false, can_apply: false }));
      const panel = await screen.findByRole("region", { name: "Access" });
      expect(within(panel).getByText(/Access is granted by the advertiser\.$/)).toBeInTheDocument();
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
      expectNoConfidentialData();
    });

    it("surfaces an apply refusal (ACCESS_NOT_APPLICABLE) without changing the panel", async () => {
      renderDetail(makeMarketplaceOffer({ access_mode: "APPLICATION_REQUIRED", can_join: false, can_apply: true }), {
        [`POST ${DETAIL_PATH}/apply`]: () => ({ status: 409, json: errorEnvelope("ACCESS_NOT_APPLICABLE", "This offer does not accept applications") }),
      });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Apply for access" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This offer does not accept applications");
      expect(screen.getByRole("button", { name: "Apply for access" })).toBeInTheDocument();
    });

    it("renders 'Offer not available' on 404 without distinguishing hidden from nonexistent", async () => {
      fetchStub = signedIn({
        ...affiliateRoutes(),
        [`GET ${DETAIL_PATH}`]: () => ({ status: 404, json: errorEnvelope("OFFER_NOT_FOUND") }),
      });
      renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/marketplace/${OFFER_ID}` });

      expect(await screen.findByRole("heading", { level: 1, name: "Offer not available" })).toBeInTheDocument();
      expect(screen.getByText("This offer does not exist or is not visible to your organization.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to marketplace" })).toHaveAttribute("href", `/app/${ORG_A_ID}/marketplace`);
    });
  });
});
