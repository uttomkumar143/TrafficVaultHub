import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
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
import type { AffiliateDashboardLink, AffiliateDashboardOffer, AffiliateOverview } from "@/features/affiliate-dashboard/api";

/**
 * Affiliate dashboard (`/app/:orgId/dashboard`) — Phase 7 Unit 1b. Every
 * assertion runs against the stubbed `/api/v1` contract from
 * `backend/src/routes/affiliate-dashboard.ts`. Money is integer minor units +
 * currency (PRD §25); `{available:false}` metrics render "Not available";
 * nothing identifying the tenant is ever sent in a query (PRD §94).
 */

const SESSION_TOKEN = "tvh_s_test";
const AFFILIATE_ORG = makeOrganization({ id: ORG_A_ID, type: "AFFILIATE", name: "Alpha Traffic", slug: "alpha-traffic" });
const BASE = `/api/v1/organizations/${ORG_A_ID}/affiliate/dashboard`;
const OVERVIEW_PATH = `${BASE}/overview`;
const OFFERS_PATH = `${BASE}/offers`;
const LINKS_PATH = `${BASE}/links`;
const AFFILIATE_PERMISSIONS = ["organizations.read", "offers.read", "tracking.read"];
const OFFER_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const OFFER_ID_2 = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";

function makeOverview(overrides: Partial<AffiliateOverview> = {}): AffiliateOverview {
  return {
    range: { from: "2026-09-07T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z" },
    clicks: { total: 1234 },
    conversions: { total: 7, by_lifecycle_status: { APPROVED: 5, PENDING: 2 } },
    earnings: [{ currency: "USD", total_minor: 4029, count: 5, by_lifecycle_status: { APPROVED: { total_minor: 4029, count: 5 } } }],
    payouts: {
      pending: [{ currency: "USD", total_minor: 1500, count: 1 }],
      approved: [],
      paid: [{ currency: "JPY", total_minor: 123456, count: 2 }],
    },
    epc: { available: false },
    conversion_rate: { available: false },
    ...overrides,
  };
}

function makeDashboardOffer(overrides: Partial<AffiliateDashboardOffer> = {}): AffiliateDashboardOffer {
  return {
    id: OFFER_ID,
    name: "Spring Shoes CPA",
    vertical: "Retail",
    description: null,
    access_mode: "APPLICATION_REQUIRED",
    status: "LIVE",
    access_status: "APPROVED",
    economics: { payout_type: "CPA", currency: "USD", affiliate_commission_minor: 3000, revshare_percent_bps: null, conversion_event: "purchase" },
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeLink(overrides: Partial<AffiliateDashboardLink> = {}): AffiliateDashboardLink {
  return {
    id: "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b",
    offer_id: OFFER_ID,
    offer_name: "Spring Shoes CPA",
    traffic_source_id: null,
    code: "abc123",
    tracking_path: "/c/abc123",
    name: "Spring newsletter",
    creative_id: null,
    status: "ACTIVE",
    click_count: 42,
    created_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function affiliateRoutes(permissions: string[] = AFFILIATE_PERMISSIONS, type: "AFFILIATE" | "ADVERTISER" = "AFFILIATE"): Record<string, FetchHandler> {
  return {
    "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
    "GET /api/v1/organizations": () => ({ json: { organizations: [{ ...AFFILIATE_ORG, type }] } }),
    [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () =>
      ({
        json: makeTenantMe({
          organization: { id: ORG_A_ID, type, name: "Alpha Traffic" },
          role: { key: "AFFILIATE_MANAGER", is_owner: false },
          permissions,
        }),
      }),
  };
}

function dataRoutes(): Record<string, FetchHandler> {
  return {
    [`GET ${OVERVIEW_PATH}`]: () => ({ json: { overview: makeOverview() } }),
    [`GET ${OFFERS_PATH}`]: () => ({ json: { items: [makeDashboardOffer()], next_cursor: null } }),
    [`GET ${LINKS_PATH}`]: () => ({ json: { items: [makeLink()], next_cursor: null } }),
  };
}

function signedIn(extra: Record<string, FetchHandler>): FetchStub {
  setSessionToken(SESSION_TOKEN);
  return stubFetch(extra);
}

function queryOf(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}

describe("affiliate dashboard /app/:orgId/dashboard", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
    vi.unstubAllGlobals();
  });

  it("renders overview, offers and links from the three tenant-scoped endpoints", async () => {
    fetchStub = signedIn({ ...affiliateRoutes(), ...dataRoutes() });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    expect(await screen.findByRole("heading", { level: 1, name: "Affiliate dashboard" })).toBeInTheDocument();

    // Overview — counts + per-currency money formatted from minor units.
    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(await within(overview).findByText("1234")).toBeInTheDocument();
    expect(within(overview).getByText("USD 40.29")).toBeInTheDocument();
    expect(within(overview).getByText("USD 15.00")).toBeInTheDocument();
    expect(within(overview).getByText("JPY 123,456")).toBeInTheDocument();
    // "Approved"/"Pending" also label payout buckets — scope to the conversions list.
    const byStatus = within(overview).getByText("Conversions by status").closest("article") as HTMLElement;
    expect(within(byStatus).getByText("Approved")).toBeInTheDocument();
    expect(within(byStatus).getByText("5")).toBeInTheDocument();
    expect(within(byStatus).getByText("Pending")).toBeInTheDocument();
    expect(within(byStatus).getByText("2")).toBeInTheDocument();

    // Offers table — commission shown from affiliate economics only.
    const offersTable = await screen.findByRole("table", { name: "Your offers" });
    expect(within(offersTable).getByRole("link", { name: "Spring Shoes CPA" })).toHaveAttribute("href", `/app/${ORG_A_ID}/marketplace/${OFFER_ID}`);
    expect(within(offersTable).getByText("USD 30.00 CPA")).toBeInTheDocument();
    expect(within(offersTable).getByText("Live")).toBeInTheDocument();

    // Links table.
    const linksTable = await screen.findByRole("table", { name: "Your tracking links" });
    expect(within(linksTable).getByText("Spring newsletter")).toBeInTheDocument();
    expect(within(linksTable).getByText("/c/abc123")).toBeInTheDocument();
    expect(within(linksTable).getByText("42")).toBeInTheDocument();

    // Every dashboard request is tenant-scoped by PATH only, bearer-authenticated, and
    // never carries a tenant identifier in the query string.
    const dashboardCalls = fetchStub.calls.filter((c) => c.path.startsWith(BASE));
    expect(dashboardCalls.map((c) => c.path.split("?")[0]).sort()).toEqual([LINKS_PATH, OFFERS_PATH, OVERVIEW_PATH].sort());
    for (const call of dashboardCalls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${SESSION_TOKEN}`);
      expect(queryOf(call.path).has("organization_id")).toBe(false);
      expect(queryOf(call.path).has("affiliate_id")).toBe(false);
    }
    expect(queryOf(dashboardCalls.find((c) => c.path.startsWith(OFFERS_PATH))!.path).get("limit")).toBe("25");

    // Nav entry is present for an AFFILIATE org with the permission.
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", `/app/${ORG_A_ID}/dashboard`);
  });

  it("renders 'Not available' for {available:false} metrics and never fabricates a number", async () => {
    fetchStub = signedIn({ ...affiliateRoutes(), ...dataRoutes() });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    const overview = await screen.findByRole("region", { name: "Overview" });
    const notAvailable = await within(overview).findAllByText("Not available");
    expect(notAvailable).toHaveLength(2); // EPC + Conversion rate
    expect(within(overview).getByText("EPC")).toBeInTheDocument();
    expect(within(overview).getByText("Conversion rate")).toBeInTheDocument();
  });

  it("never leaks advertiser-side economics into the DOM", async () => {
    fetchStub = signedIn({
      ...affiliateRoutes(),
      ...dataRoutes(),
      // A hostile/buggy server payload with extra fields — the page must not render them.
      [`GET ${OFFERS_PATH}`]: () =>
        ({
          json: {
            items: [{ ...makeDashboardOffer(), advertiser_payout_minor: 9999, network_margin_minor: 777, organization_id: "leak" }],
            next_cursor: null,
          },
        }),
    });
    const { container } = renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    await screen.findByRole("table", { name: "Your offers" });
    const html = container.innerHTML;
    expect(html).not.toMatch(/9999|99\.99|777|7\.77|network_margin|advertiser_payout|leak/);
  });

  it("shows the empty states when the affiliate has no data", async () => {
    fetchStub = signedIn({
      ...affiliateRoutes(),
      [`GET ${OVERVIEW_PATH}`]: () =>
        ({
          json: {
            overview: makeOverview({
              clicks: { total: 0 },
              conversions: { total: 0, by_lifecycle_status: {} },
              earnings: [],
              payouts: { pending: [], approved: [], paid: [] },
            }),
          },
        }),
      [`GET ${OFFERS_PATH}`]: () => ({ json: { items: [], next_cursor: null } }),
      [`GET ${LINKS_PATH}`]: () => ({ json: { items: [], next_cursor: null } }),
    });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    expect(await screen.findByText("No offers available yet.")).toBeInTheDocument();
    expect(await screen.findByText("No tracking links yet.")).toBeInTheDocument();
    expect(screen.getByText("No conversions in this range.")).toBeInTheDocument();
    expect(screen.getByText("No earnings in this range.")).toBeInTheDocument();
    expect(screen.getAllByText("None")).toHaveLength(3);
  });

  it("walks next_cursor with 'Load more offers' and keeps earlier rows", async () => {
    fetchStub = signedIn({
      ...affiliateRoutes(),
      ...dataRoutes(),
      [`GET ${OFFERS_PATH}`]: ({ path }) => {
        const cursor = queryOf(path).get("cursor");
        if (cursor === null) return { json: { items: [makeDashboardOffer()], next_cursor: "cursor-page-2" } };
        expect(cursor).toBe("cursor-page-2");
        return { json: { items: [makeDashboardOffer({ id: OFFER_ID_2, name: "Winter Boots CPL" })], next_cursor: null } };
      },
    });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });
    const user = userEvent.setup();

    await screen.findByRole("link", { name: "Spring Shoes CPA" });
    expect(screen.queryByRole("link", { name: "Winter Boots CPL" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more offers" }));

    expect(await screen.findByRole("link", { name: "Winter Boots CPL" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Spring Shoes CPA" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more offers" })).not.toBeInTheDocument();
    const offerCalls = fetchStub.calls.filter((c) => c.path.startsWith(OFFERS_PATH));
    expect(offerCalls.map((c) => queryOf(c.path).get("cursor"))).toEqual([null, "cursor-page-2"]);
  });

  it("surfaces a server 403 as an alert instead of an empty list", async () => {
    fetchStub = signedIn({
      ...affiliateRoutes(),
      ...dataRoutes(),
      [`GET ${LINKS_PATH}`]: () => ({ status: 403, json: errorEnvelope("FORBIDDEN", "Missing permission tracking.read") }),
    });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    const links = await screen.findByRole("region", { name: "Tracking links" });
    expect(await within(links).findByRole("alert")).toHaveTextContent("You do not have permission to do that.");
    expect(within(links).queryByText("No tracking links yet.")).not.toBeInTheDocument();
  });

  it("surfaces a server 404 (non-affiliate tenant) as an explicit message", async () => {
    fetchStub = signedIn({
      ...affiliateRoutes(),
      ...dataRoutes(),
      [`GET ${OVERVIEW_PATH}`]: () => ({ status: 404, json: errorEnvelope("NOT_FOUND", "Not found") }),
    });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(await within(overview).findByText("The affiliate dashboard is not available for this organization.")).toBeInTheDocument();
  });

  it("gates each section by permission and does not request what the server would refuse", async () => {
    fetchStub = signedIn({ ...affiliateRoutes(["organizations.read", "offers.read"]), ...dataRoutes() });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    await screen.findByRole("table", { name: "Your offers" });
    expect(screen.getAllByText("tracking.read")).toHaveLength(2); // Overview + Tracking links notices
    expect(screen.queryByRole("table", { name: "Your tracking links" })).not.toBeInTheDocument();
    expect(fetchStub.calls.some((c) => c.path.startsWith(OVERVIEW_PATH))).toBe(false);
    expect(fetchStub.calls.some((c) => c.path.startsWith(LINKS_PATH))).toBe(false);
    expect(fetchStub.calls.some((c) => c.path.startsWith(OFFERS_PATH))).toBe(true);
  });

  it("shows the forbidden state without any dashboard permission", async () => {
    fetchStub = signedIn({ ...affiliateRoutes(["organizations.read"]), ...dataRoutes() });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    expect(await screen.findByText("You do not have permission to view the affiliate dashboard in this organization.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to overview" })).toHaveAttribute("href", `/app/${ORG_A_ID}`);
    expect(fetchStub.calls.some((c) => c.path.startsWith(BASE))).toBe(false);
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("refuses to render for a non-AFFILIATE organization and hides the nav entry", async () => {
    fetchStub = signedIn({ ...affiliateRoutes(AFFILIATE_PERMISSIONS, "ADVERTISER"), ...dataRoutes() });
    renderWithProviders(routes, { initialPath: `/app/${ORG_A_ID}/dashboard` });

    expect(await screen.findByText("The affiliate dashboard is only available to affiliate organizations.")).toBeInTheDocument();
    expect(fetchStub.calls.some((c) => c.path.startsWith(BASE))).toBe(false);
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });
});
