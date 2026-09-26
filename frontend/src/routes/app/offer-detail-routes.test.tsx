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
  AFFILIATE_ORG_ID,
  AFFILIATE_ORG_ID_2,
  OFFER_ID,
  makeGrant,
  makeOffer,
  makeTransition,
  makeVersion,
} from "@/test/offer-fixtures";
import type { Offer, OfferStatus } from "@/types/api";

/**
 * Advertiser offer detail (`/app/:orgId/offers/:offerId`). This page is the
 * OWNER's view, so confidential economics are expected here. What these tests
 * pin down is the contract with `backend/src/routes/offers.ts`:
 *
 *   • lifecycle buttons are rendered FROM `offer.allowed_transitions` (never a
 *     hard-coded graph) and filtered by the backend's per-target permission
 *     split (PAUSED / resume→LIVE need offers.pause, everything else
 *     offers.update); DRAFT→SUBMITTED goes through POST …/submit; targets in
 *     REASON_REQUIRED_STATUSES (PRD §124) collect a mandatory reason;
 *   • "New version" appends an immutable version (POST …/versions) with
 *     integer minor units + currency, pre-filled from the current version
 *     without any float; hidden once ARCHIVED (nothing is versionable there);
 *   • access grants are one `PUT …/access` per action; the panel exists only
 *     for grant-managed access modes (never PUBLIC);
 *   • version + transition history are read-only and newest-first;
 *   • 404 → "Offer not found" with no enumeration; 403 surfaced.
 */

const SESSION_TOKEN = "tvh_s_test";
const ADVERTISER_ORG = makeOrganization({ id: ORG_A_ID, type: "ADVERTISER", name: "Bravo Ads", slug: "bravo-ads" });
const OFFERS_PATH = `/api/v1/organizations/${ORG_A_ID}/offers`;
const OFFER_PATH = `${OFFERS_PATH}/${OFFER_ID}`;
const DETAIL_ROUTE = `/app/${ORG_A_ID}/offers/${OFFER_ID}`;

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

/**
 * A mutable "server" for one offer: GETs read the current state, so a mutation
 * handler can swap `state.offer` and the page's refetch observes the change.
 */
interface OfferServer {
  offer: Offer;
  versions: ReturnType<typeof makeVersion>[];
  transitions: ReturnType<typeof makeTransition>[];
  grants: ReturnType<typeof makeGrant>[];
}

function offerServer(offer: Offer, extra: Partial<Omit<OfferServer, "offer">> = {}): OfferServer {
  return {
    offer,
    versions: extra.versions ?? (offer.current_version ? [offer.current_version] : []),
    transitions: extra.transitions ?? [makeTransition()],
    grants: extra.grants ?? [],
  };
}

function offerRoutes(state: OfferServer): Record<string, FetchHandler> {
  return {
    [`GET ${OFFER_PATH}`]: () => ({ json: { offer: state.offer } }),
    [`GET ${OFFER_PATH}/versions`]: () => ({ json: { versions: state.versions } }),
    [`GET ${OFFER_PATH}/history`]: () => ({ json: { transitions: state.transitions } }),
    [`GET ${OFFER_PATH}/access`]: () => ({ json: { grants: state.grants } }),
  };
}

function signedIn(extra: Record<string, FetchHandler>): FetchStub {
  setSessionToken(SESSION_TOKEN);
  return stubFetch(extra);
}

function callsTo(stub: FetchStub, method: string, path: string) {
  return stub.calls.filter((c) => c.method === method && c.path === path);
}

async function renderDetail() {
  const utils = renderWithProviders(routes, { initialPath: DETAIL_ROUTE });
  await screen.findByRole("heading", { level: 1, name: "Spring Shoes CPA" });
  return utils;
}

function lifecycleButtons(): string[] {
  const group = screen.queryByRole("group", { name: "Lifecycle actions" });
  return group ? within(group).getAllByRole("button").map((b) => b.textContent ?? "") : [];
}

describe("advertiser offer detail — /app/:orgId/offers/:offerId", () => {
  let fetchStub: FetchStub;

  beforeEach(() => {
    __resetSessionStoreForTests();
  });
  afterEach(() => {
    __resetSessionStoreForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- rendering ---------------------------------------------------------------

  describe("rendering", () => {
    it("shows the offer header, current terms (owner-only economics), versions and history", async () => {
      const state = offerServer(
        makeOffer({
          status: "LIVE",
          access_mode: "PUBLIC",
          description: "Promote the spring collection.",
          review_notes: "Approved with standard terms.",
          allowed_transitions: ["PAUSED"],
        }),
        {
          transitions: [
            makeTransition({ id: "t1", from_status: null, to_status: "DRAFT", created_at: "2026-09-01T00:00:00.000Z" }),
            makeTransition({ id: "t2", from_status: "DRAFT", to_status: "SUBMITTED", created_at: "2026-09-02T00:00:00.000Z" }),
            makeTransition({
              id: "t3",
              from_status: "UNDER_REVIEW",
              to_status: "APPROVED",
              actor_kind: "PLATFORM",
              reason: "Looks good",
              created_at: "2026-09-03T00:00:00.000Z",
            }),
          ],
        },
      );
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();

      expect(screen.getByText("Retail")).toBeInTheDocument();
      expect(screen.getByText("Promote the spring collection.")).toBeInTheDocument();
      expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Live");
      expect(screen.getByText("Public")).toBeInTheDocument();
      expect(screen.getByText("Approved with standard terms.")).toBeInTheDocument();

      // Owner view: the confidential economics ARE rendered here (and only here).
      const currentSection = screen.getByRole("heading", { name: "Current terms" }).closest("section")!;
      const current = within(currentSection).getByTestId("version-details-1");
      expect(within(current).getByText("Advertiser payout").nextElementSibling).toHaveTextContent("USD 40.00");
      expect(within(current).getByText("Affiliate commission").nextElementSibling).toHaveTextContent("USD 30.00");
      expect(within(current).getByText("Network margin").nextElementSibling).toHaveTextContent("USD 10.00");
      expect(within(current).getByText("Budget").nextElementSibling).toHaveTextContent("USD 5,000.00");
      expect(within(current).getByText("Attribution window").nextElementSibling).toHaveTextContent("30 days");
      expect(within(current).getByText("Country: US")).toBeInTheDocument();

      // Transition history newest-first, with actor kind and reason.
      const history = screen.getByRole("table", { name: "Offer lifecycle history" });
      const rows = within(history).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent("Under review → Approved");
      expect(rows[0]).toHaveTextContent("Platform");
      expect(rows[0]).toHaveTextContent("Looks good");
      expect(rows[2]).toHaveTextContent("Draft");
      expect(rows[2]).toHaveTextContent("Advertiser");
      expect(rows[2]).toHaveTextContent("—");

      // All reads are tenant-scoped GETs under the org path with the bearer token; nothing identifies the org otherwise.
      for (const path of [OFFER_PATH, `${OFFER_PATH}/versions`, `${OFFER_PATH}/history`]) {
        const call = fetchStub.calls.find((c) => c.method === "GET" && c.path === path);
        expect(call, path).toBeDefined();
        expect(call?.headers.get("authorization")).toBe(`Bearer ${SESSION_TOKEN}`);
      }
      // PUBLIC offer: no grants panel, so no access request at all.
      expect(callsTo(fetchStub, "GET", `${OFFER_PATH}/access`)).toHaveLength(0);
      expect(screen.queryByRole("heading", { name: "Affiliate access" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "← Offers" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers`);
    });

    it("lists version history newest-first with each version expandable to its full terms", async () => {
      const v1 = makeVersion({ id: "v-1", version_number: 1, created_at: "2026-09-01T00:00:00.000Z" });
      const v2 = makeVersion({
        id: "v-2",
        version_number: 2,
        advertiser_payout_minor: 4500,
        affiliate_commission_minor: 3200,
        network_margin_minor: 1300,
        change_summary: "Raised commission",
        created_at: "2026-09-05T00:00:00.000Z",
      });
      const state = offerServer(makeOffer({ status: "LIVE", current_version_id: "v-2", current_version: v2, allowed_transitions: ["PAUSED"] }), {
        versions: [v1, v2],
      });
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();

      const list = screen.getByRole("list", { name: "Offer versions" });
      // Direct children only — each version's targeting chips are nested <li>s of their own.
      const items = Array.from(list.querySelectorAll<HTMLLIElement>(":scope > li"));
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent("v2");
      expect(items[0]).toHaveTextContent("Raised commission");
      expect(items[1]).toHaveTextContent("v1");
      expect(items[1]).toHaveTextContent("Initial version");
      // Each history entry carries the immutable snapshot of its own terms.
      expect(within(items[1]!).getByTestId("version-details-1")).toHaveTextContent("USD 40.00");
      expect(within(items[0]!).getByTestId("version-details-2")).toHaveTextContent("USD 45.00");
    });

    it("renders 'Offer not found' on 404 without leaking whether the offer exists elsewhere", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`GET ${OFFER_PATH}`]: () => ({ status: 404, json: errorEnvelope("OFFER_NOT_FOUND", "Offer not found") }),
        [`GET ${OFFER_PATH}/versions`]: () => ({ status: 404, json: errorEnvelope("OFFER_NOT_FOUND", "Offer not found") }),
        [`GET ${OFFER_PATH}/history`]: () => ({ status: 404, json: errorEnvelope("OFFER_NOT_FOUND", "Offer not found") }),
      });
      renderWithProviders(routes, { initialPath: DETAIL_ROUTE });

      expect(await screen.findByRole("heading", { level: 1, name: "Offer not found" })).toBeInTheDocument();
      expect(screen.getByText("This offer does not exist or does not belong to this organization.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to offers" })).toHaveAttribute("href", `/app/${ORG_A_ID}/offers`);
      expect(screen.queryByRole("heading", { name: "Lifecycle" })).not.toBeInTheDocument();
    });

    it("surfaces a 403 from the server instead of a blank page", async () => {
      fetchStub = signedIn({
        ...advertiserRoutes(),
        [`GET ${OFFER_PATH}`]: () => ({ status: 403, json: errorEnvelope("FORBIDDEN", "Missing permission offers.read") }),
      });
      renderWithProviders(routes, { initialPath: DETAIL_ROUTE });

      expect(await screen.findByRole("heading", { level: 1, name: "Could not load offer" })).toBeInTheDocument();
      expect(screen.getByText("You do not have permission to do that.")).toBeInTheDocument();
    });

    it("shows the not-a-member state when the tenant lookup 404s", async () => {
      fetchStub = signedIn({
        "GET /api/v1/auth/me": () => ({ json: { user: makeUser(), session: makeSession() } }),
        "GET /api/v1/organizations": () => ({ json: { organizations: [] } }),
        [`GET /api/v1/organizations/${ORG_A_ID}/me`]: () => ({ status: 404, json: errorEnvelope("ORGANIZATION_NOT_FOUND", "Organization not found") }),
      });
      renderWithProviders(routes, { initialPath: DETAIL_ROUTE });

      expect(await screen.findByRole("heading", { level: 1, name: "Organization not found" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Lifecycle" })).not.toBeInTheDocument();
    });
  });

  // ---- lifecycle -----------------------------------------------------------------

  describe("lifecycle", () => {
    it("renders buttons FROM allowed_transitions only — statuses the server did not offer never appear", async () => {
      // A LIVE offer: the server (TENANT actor) offers just PAUSED; SYSTEM/PLATFORM-only
      // edges (CAP_REACHED, COMPLIANCE_HOLD, …) are not in the list and must not be rendered.
      const state = offerServer(makeOffer({ status: "LIVE", allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();

      expect(screen.getByText("Current status:")).toHaveTextContent("Live");
      expect(lifecycleButtons()).toEqual(["Pause"]);
      for (const verb of ["Go live", "Archive", "Submit for review", "Place on compliance hold", "Mark cap reached", "Approve"]) {
        expect(screen.queryByRole("button", { name: verb })).not.toBeInTheDocument();
      }
    });

    it("routes DRAFT → SUBMITTED through POST …/submit (no body) and re-renders the server's new state", async () => {
      const state = offerServer(makeOffer({ status: "DRAFT", allowed_transitions: ["SUBMITTED", "ARCHIVED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/submit`]: () => {
          state.offer = { ...state.offer, status: "SUBMITTED", submitted_at: "2026-09-26T00:00:00.000Z", allowed_transitions: ["DRAFT"] };
          state.transitions = [...state.transitions, makeTransition({ id: "t-submit", from_status: "DRAFT", to_status: "SUBMITTED", created_at: "2026-09-26T00:00:00.000Z" })];
          return { json: { offer: state.offer } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      expect(lifecycleButtons()).toEqual(["Submit for review", "Archive"]);
      await user.click(screen.getByRole("button", { name: "Submit for review" }));

      await waitFor(() => expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Submitted"));
      const submit = callsTo(fetchStub, "POST", `${OFFER_PATH}/submit`);
      expect(submit).toHaveLength(1);
      expect(submit[0]!.body).toBeUndefined();
      expect(callsTo(fetchStub, "POST", `${OFFER_PATH}/transition`)).toHaveLength(0);
      // The offered actions now follow the NEW server state (withdraw only).
      expect(lifecycleButtons()).toEqual(["Send back to draft"]);
      const history = screen.getByRole("table", { name: "Offer lifecycle history" });
      expect(within(history).getAllByRole("row")[1]).toHaveTextContent("Draft → Submitted");
    });

    it("surfaces OFFER_INCOMPLETE from /submit and leaves the offer in DRAFT", async () => {
      const state = offerServer(makeOffer({ status: "DRAFT", current_version: null, current_version_id: null, allowed_transitions: ["SUBMITTED", "ARCHIVED"] }), {
        versions: [],
      });
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/submit`]: () =>
          ({ status: 400, json: errorEnvelope("OFFER_INCOMPLETE", "An offer needs at least one version before submission") }),
      });
      await renderDetail();
      const user = userEvent.setup();

      expect(screen.getByText("This offer has no version yet.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Submit for review" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("An offer needs at least one version before submission");
      expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Draft");
    });

    it("non-reason transitions POST …/transition with exactly { to } — e.g. Pause, then Go live", async () => {
      const state = offerServer(makeOffer({ status: "LIVE", allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/transition`]: ({ body }) => {
          const { to } = body as { to: OfferStatus };
          state.offer = { ...state.offer, status: to, allowed_transitions: to === "PAUSED" ? ["LIVE", "ARCHIVED"] : ["PAUSED"] };
          return { json: { offer: state.offer } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Pause" }));
      await waitFor(() => expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Paused"));
      expect(lifecycleButtons()).toEqual(["Go live", "Archive"]);

      await user.click(screen.getByRole("button", { name: "Go live" }));
      await waitFor(() => expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Live"));

      const posts = callsTo(fetchStub, "POST", `${OFFER_PATH}/transition`);
      expect(posts.map((c) => c.body)).toEqual([{ to: "PAUSED" }, { to: "LIVE" }]);
      // No reason form was ever shown for these targets.
      expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    });

    it("Archive demands a reason (PRD §124): empty reason is blocked client-side, then POSTs { to, reason }", async () => {
      const state = offerServer(makeOffer({ status: "PAUSED", allowed_transitions: ["LIVE", "ARCHIVED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/transition`]: ({ body }) => {
          expect(body).toEqual({ to: "ARCHIVED", reason: "Campaign ended" });
          state.offer = { ...state.offer, status: "ARCHIVED", archived_at: "2026-09-26T00:00:00.000Z", allowed_transitions: [] };
          return { json: { offer: state.offer } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Archive" }));
      // Nothing is sent until a reason is confirmed.
      expect(callsTo(fetchStub, "POST", `${OFFER_PATH}/transition`)).toHaveLength(0);
      const reason = screen.getByLabelText("Reason");
      await user.click(screen.getByRole("button", { name: "Confirm: Archive" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("A reason is required to archive.");
      expect(callsTo(fetchStub, "POST", `${OFFER_PATH}/transition`)).toHaveLength(0);

      await user.type(reason, "  Campaign ended  ");
      await user.click(screen.getByRole("button", { name: "Confirm: Archive" }));

      await waitFor(() => expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Archived"));
      expect(callsTo(fetchStub, "POST", `${OFFER_PATH}/transition`)).toHaveLength(1);
      expect(screen.getByText("This offer is archived; no further changes are possible.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
      // Terminal: no versioning and no lifecycle controls remain.
      expect(screen.queryByRole("button", { name: "Create new version" })).not.toBeInTheDocument();
      expect(lifecycleButtons()).toEqual([]);
    });

    it("Cancel on the reason form sends nothing", async () => {
      const state = offerServer(makeOffer({ status: "DRAFT", allowed_transitions: ["SUBMITTED", "ARCHIVED"] }));
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Archive" }));
      await user.type(screen.getByLabelText("Reason"), "changed my mind");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
      expect(fetchStub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      expect(screen.getByTestId("offer-status-badge")).toHaveTextContent("Draft");
    });

    it("splits targets by permission like the backend: PAUSED / resume→LIVE need offers.pause, the rest offers.update", async () => {
      // offers.update WITHOUT offers.pause on a PAUSED offer: 'Go live' (resume) is hidden, 'Archive' stays.
      const paused = offerServer(makeOffer({ status: "PAUSED", allowed_transitions: ["LIVE", "ARCHIVED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(["organizations.read", "offers.read", "offers.update"]),
        ...offerRoutes(paused),
      });
      const first = await renderDetail();
      expect(lifecycleButtons()).toEqual(["Archive"]);
      first.unmount();
      vi.unstubAllGlobals();
      __resetSessionStoreForTests();

      // offers.pause WITHOUT offers.update on a LIVE offer: 'Pause' shown; on APPROVED, 'Go live' (first launch) is
      // offers.update and so hidden, 'Archive' hidden too — the page explains why.
      const live = offerServer(makeOffer({ status: "LIVE", allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(["organizations.read", "offers.read", "offers.pause"]),
        ...offerRoutes(live),
      });
      const second = await renderDetail();
      expect(lifecycleButtons()).toEqual(["Pause"]);
      second.unmount();
      vi.unstubAllGlobals();
      __resetSessionStoreForTests();

      const approved = offerServer(makeOffer({ status: "APPROVED", allowed_transitions: ["LIVE", "ARCHIVED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(["organizations.read", "offers.read", "offers.pause"]),
        ...offerRoutes(approved),
      });
      await renderDetail();
      expect(lifecycleButtons()).toEqual([]);
      expect(screen.getByText("You do not have permission to change this offer's status.")).toBeInTheDocument();
    });

    it("read-only member (offers.read only) sees status + history but no controls at all", async () => {
      const state = offerServer(makeOffer({ status: "LIVE", access_mode: "PRIVATE", allowed_transitions: ["PAUSED"] }), {
        grants: [makeGrant({ status: "APPROVED" })],
      });
      fetchStub = signedIn({ ...advertiserRoutes(["organizations.read", "offers.read"]), ...offerRoutes(state) });
      await renderDetail();

      expect(lifecycleButtons()).toEqual([]);
      expect(screen.getByText("You do not have permission to change this offer's status.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create new version" })).not.toBeInTheDocument();
      // Grants are still listed (read) but neither the invite form nor per-row actions render.
      const grants = await screen.findByRole("table", { name: "Affiliate access grants" });
      expect(within(grants).getByText(AFFILIATE_ORG_ID)).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Invite affiliate" })).not.toBeInTheDocument();
      expect(within(grants).queryByRole("button")).not.toBeInTheDocument();
    });

    it("surfaces INVALID_TRANSITION (409) from the server when its state moved underneath the page", async () => {
      const state = offerServer(makeOffer({ status: "LIVE", allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/transition`]: () => ({ status: 409, json: errorEnvelope("INVALID_TRANSITION", "Cannot move offer from ARCHIVED to PAUSED") }),
      });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Cannot move offer from ARCHIVED to PAUSED");
    });
  });

  // ---- versions --------------------------------------------------------------------

  describe("new version (immutable append, PRD §24–§25)", () => {
    it("pre-fills from the current version as exact major-unit strings (no floats) and POSTs integer minor units", async () => {
      const current = makeVersion({
        advertiser_payout_minor: 4029, // the 40.29 float trap
        affiliate_commission_minor: 3001,
        network_margin_minor: 1028,
        budget_minor: 123456,
        daily_conversion_cap: 100,
        total_conversion_cap: 5000,
        destination_url: "https://advertiser.example/landing",
        targeting: [
          { dimension: "COUNTRY", value: "US" },
          { dimension: "DEVICE", value: "MOBILE" },
        ],
      });
      const state = offerServer(makeOffer({ status: "LIVE", current_version: current, allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/versions`]: ({ body }) => {
          expect(body).toEqual({
            payout_type: "CPA",
            currency: "USD",
            advertiser_payout_minor: 4029,
            affiliate_commission_minor: 3500,
            network_margin_minor: 1028,
            budget_minor: 123456,
            daily_conversion_cap: 100,
            total_conversion_cap: 5000,
            attribution_window_seconds: 30 * 86_400,
            conversion_event: "purchase",
            destination_url: "https://advertiser.example/landing",
            change_summary: "Raised commission to 35",
            targeting: [
              { dimension: "COUNTRY", value: "US" },
              { dimension: "DEVICE", value: "MOBILE" },
            ],
          });
          const v2 = makeVersion({
            id: "v-2",
            version_number: 2,
            advertiser_payout_minor: 4029,
            affiliate_commission_minor: 3500,
            network_margin_minor: 1028,
            budget_minor: 123456,
            total_conversion_cap: 5000,
            change_summary: "Raised commission to 35",
            created_at: "2026-09-26T00:00:00.000Z",
          });
          state.versions = [...state.versions, v2];
          state.offer = { ...state.offer, current_version: v2, current_version_id: v2.id };
          return { status: 201, json: { version: v2 } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Create new version" }));
      const form = screen.getByRole("form", { name: "New version" });
      expect(form).toHaveTextContent("Saving creates version 2 and makes it current");

      // Pre-fill is exact string math from minor units — 4029 → "40.29", never "40.28999…".
      expect(within(form).getByLabelText("Advertiser payout (USD)")).toHaveValue("40.29");
      expect(within(form).getByLabelText("Affiliate commission (USD)")).toHaveValue("30.01");
      expect(within(form).getByLabelText("Network margin (USD, optional)")).toHaveValue("10.28");
      expect(within(form).getByLabelText("Budget (USD, optional)")).toHaveValue("1234.56");
      expect(within(form).getByLabelText("Daily conversion cap (optional)")).toHaveValue("100");
      expect(within(form).getByLabelText("Total conversion cap (optional)")).toHaveValue("5000");
      expect(within(form).getByLabelText("Attribution window (days)")).toHaveValue("30");
      expect(within(form).getByLabelText("Conversion event")).toHaveValue("purchase");
      expect(within(form).getByLabelText("Destination URL (optional)")).toHaveValue("https://advertiser.example/landing");
      expect(within(form).getByLabelText("Targeting rules (optional)")).toHaveValue("COUNTRY=US\nDEVICE=MOBILE");
      expect(within(form).getByLabelText("Change summary (optional)")).toHaveValue("");

      const commission = within(form).getByLabelText("Affiliate commission (USD)");
      await user.clear(commission);
      await user.type(commission, "35");
      await user.type(within(form).getByLabelText("Change summary (optional)"), "Raised commission to 35");
      await user.click(within(form).getByRole("button", { name: "Save new version" }));

      // Form closes; the new version is current and joins the history at the top; v1 is untouched.
      await waitFor(() => expect(screen.queryByRole("form", { name: "New version" })).not.toBeInTheDocument());
      const currentSection = screen.getByRole("heading", { name: "Current terms" }).closest("section")!;
      await waitFor(() => expect(within(currentSection).getByTestId("version-details-2")).toBeInTheDocument());
      expect(within(currentSection).getByText("Affiliate commission").nextElementSibling).toHaveTextContent("USD 35.00");
      const list = screen.getByRole("list", { name: "Offer versions" });
      const items = Array.from(list.querySelectorAll<HTMLLIElement>(":scope > li"));
      expect(items.map((li) => li.querySelector("summary")?.textContent)).toEqual([
        expect.stringContaining("v2"),
        expect.stringContaining("v1"),
      ]);
      expect(within(items[1]!).getByTestId("version-details-1")).toHaveTextContent("USD 30.01");

      const post = callsTo(fetchStub, "POST", `${OFFER_PATH}/versions`);
      expect(post).toHaveLength(1);
      const raw = JSON.stringify(post[0]!.body);
      expect(raw).not.toMatch(/organization_id|advertiser_id|advertiser_profile_id|offer_id|tenant_id/);
      expect(raw).not.toMatch(/\d+\.\d+/); // no decimal money anywhere on the wire
      // Versions are never edited in place: no PUT/PATCH against a version resource.
      expect(fetchStub.calls.filter((c) => (c.method === "PUT" || c.method === "PATCH") && c.path.includes("/versions"))).toHaveLength(0);
    });

    it("blocks a new version client-side when commission exceeds payout and sends nothing", async () => {
      const state = offerServer(makeOffer({ status: "DRAFT", allowed_transitions: ["SUBMITTED", "ARCHIVED"] }));
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Create new version" }));
      const form = screen.getByRole("form", { name: "New version" });
      const commission = within(form).getByLabelText("Affiliate commission (USD)");
      await user.clear(commission);
      await user.type(commission, "45");
      await user.click(within(form).getByRole("button", { name: "Save new version" }));

      expect(await screen.findByText("Commission cannot exceed the advertiser payout")).toBeInTheDocument();
      expect(callsTo(fetchStub, "POST", `${OFFER_PATH}/versions`)).toHaveLength(0);
      expect(screen.getByRole("form", { name: "New version" })).toBeInTheDocument();
    });

    it("surfaces a server refusal (INVALID_TRANSITION 409) and keeps the form open", async () => {
      const state = offerServer(makeOffer({ status: "LIVE", allowed_transitions: ["PAUSED"] }));
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`POST ${OFFER_PATH}/versions`]: () =>
          ({ status: 409, json: errorEnvelope("INVALID_TRANSITION", "A new version cannot be created while the offer is ARCHIVED") }),
      });
      await renderDetail();
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Create new version" }));
      await user.click(within(screen.getByRole("form", { name: "New version" })).getByRole("button", { name: "Save new version" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("A new version cannot be created while the offer is ARCHIVED");
      expect(screen.getByRole("form", { name: "New version" })).toBeInTheDocument();
      // Current terms unchanged — still v1.
      const currentSection = screen.getByRole("heading", { name: "Current terms" }).closest("section")!;
      expect(within(currentSection).getByTestId("version-details-1")).toBeInTheDocument();
      expect(screen.queryByTestId("version-details-2")).not.toBeInTheDocument();
    });

    it("hides 'Create new version' for an ARCHIVED offer (nothing is versionable there)", async () => {
      const state = offerServer(makeOffer({ status: "ARCHIVED", archived_at: "2026-09-20T00:00:00.000Z", allowed_transitions: [] }));
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(state) });
      await renderDetail();

      expect(screen.queryByRole("button", { name: "Create new version" })).not.toBeInTheDocument();
      expect(screen.getByText("This offer is archived; no further changes are possible.")).toBeInTheDocument();
      // History remains readable.
      expect(screen.getByRole("list", { name: "Offer versions" })).toBeInTheDocument();
    });
  });

  // ---- access grants -----------------------------------------------------------------

  describe("affiliate access grants (PRD §92)", () => {
    function grantsFor(mode: Offer["access_mode"]) {
      return offerServer(makeOffer({ status: "LIVE", access_mode: mode, allowed_transitions: ["PAUSED"] }), {
        grants: [
          makeGrant({ id: "g-req", affiliate_organization_id: AFFILIATE_ORG_ID, status: "REQUESTED" }),
          makeGrant({ id: "g-appr", affiliate_organization_id: AFFILIATE_ORG_ID_2, status: "APPROVED", decided_at: "2026-09-10T00:00:00.000Z" }),
        ],
      });
    }

    it("mounts the panel only for grant-managed modes; PUBLIC never even requests /access", async () => {
      for (const mode of ["APPLICATION_REQUIRED", "PRIVATE", "INVITE_ONLY", "AFFILIATE_SPECIFIC"] as const) {
        fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(grantsFor(mode)) });
        const utils = await renderDetail();
        expect(await screen.findByRole("table", { name: "Affiliate access grants" }), mode).toBeInTheDocument();
        expect(callsTo(fetchStub, "GET", `${OFFER_PATH}/access`).length, mode).toBeGreaterThan(0);
        utils.unmount();
        vi.unstubAllGlobals();
        __resetSessionStoreForTests();
      }

      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(grantsFor("PUBLIC")) });
      await renderDetail();
      expect(screen.queryByRole("heading", { name: "Affiliate access" })).not.toBeInTheDocument();
      expect(callsTo(fetchStub, "GET", `${OFFER_PATH}/access`)).toHaveLength(0);
    });

    it("lists grants with status badges and only the actions valid for each status", async () => {
      fetchStub = signedIn({ ...advertiserRoutes(), ...offerRoutes(grantsFor("APPLICATION_REQUIRED")) });
      await renderDetail();

      const table = await screen.findByRole("table", { name: "Affiliate access grants" });
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);

      const requested = rows[0]!;
      expect(requested).toHaveTextContent(AFFILIATE_ORG_ID);
      expect(within(requested).getByTestId("access-grant-status-badge")).toHaveTextContent("Application pending");
      expect(within(requested).getByRole("button", { name: `Approve ${AFFILIATE_ORG_ID}` })).toBeInTheDocument();
      expect(within(requested).getByRole("button", { name: `Reject ${AFFILIATE_ORG_ID}` })).toBeInTheDocument();
      expect(within(requested).queryByRole("button", { name: `Revoke ${AFFILIATE_ORG_ID}` })).not.toBeInTheDocument();

      const approved = rows[1]!;
      expect(within(approved).getByTestId("access-grant-status-badge")).toHaveTextContent("Approved");
      expect(within(approved).getByRole("button", { name: `Revoke ${AFFILIATE_ORG_ID_2}` })).toBeInTheDocument();
      expect(within(approved).queryByRole("button", { name: `Approve ${AFFILIATE_ORG_ID_2}` })).not.toBeInTheDocument();
      expect(within(approved).queryByRole("button", { name: `Reject ${AFFILIATE_ORG_ID_2}` })).not.toBeInTheDocument();
    });

    it("Approve PUTs { affiliate_organization_id, status: 'APPROVED' } (no reason) and the row updates", async () => {
      const state = grantsFor("PRIVATE");
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`PUT ${OFFER_PATH}/access`]: ({ body }) => {
          expect(body).toEqual({ affiliate_organization_id: AFFILIATE_ORG_ID, status: "APPROVED" });
          state.grants = state.grants.map((g) => (g.affiliate_organization_id === AFFILIATE_ORG_ID ? { ...g, status: "APPROVED" as const, decided_at: "2026-09-26T00:00:00.000Z" } : g));
          return { json: { grant: state.grants[0] } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      await screen.findByRole("table", { name: "Affiliate access grants" });
      await user.click(screen.getByRole("button", { name: `Approve ${AFFILIATE_ORG_ID}` }));

      await waitFor(() => expect(screen.getByRole("button", { name: `Revoke ${AFFILIATE_ORG_ID}` })).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: `Approve ${AFFILIATE_ORG_ID}` })).not.toBeInTheDocument();
      expect(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`)).toHaveLength(1);
      // Grants are keyed by the affiliate org id — never by our own org id in the body.
      expect(JSON.stringify(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`)[0]!.body)).not.toContain(ORG_A_ID);
    });

    it("Reject / Revoke ask for an optional reason via prompt; a trimmed reason is sent, cancel sends nothing", async () => {
      const state = grantsFor("APPLICATION_REQUIRED");
      const prompt = vi.spyOn(window, "prompt");
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`PUT ${OFFER_PATH}/access`]: ({ body }) => {
          const input = body as { affiliate_organization_id: string; status: "REJECTED" | "REVOKED"; reason?: string };
          state.grants = state.grants.map((g) =>
            g.affiliate_organization_id === input.affiliate_organization_id ? { ...g, status: input.status, reason: input.reason ?? null } : g,
          );
          return { json: { grant: state.grants.find((g) => g.affiliate_organization_id === input.affiliate_organization_id) } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();
      await screen.findByRole("table", { name: "Affiliate access grants" });

      // 1. Cancelled prompt → nothing sent.
      prompt.mockReturnValueOnce(null);
      await user.click(screen.getByRole("button", { name: `Reject ${AFFILIATE_ORG_ID}` }));
      expect(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`)).toHaveLength(0);

      // 2. Reject with a reason (whitespace trimmed).
      prompt.mockReturnValueOnce("  Traffic quality concerns  ");
      await user.click(screen.getByRole("button", { name: `Reject ${AFFILIATE_ORG_ID}` }));
      await waitFor(() => expect(screen.getByText("Traffic quality concerns")).toBeInTheDocument());

      // 3. Revoke with an empty reason → no `reason` key at all.
      prompt.mockReturnValueOnce("");
      await user.click(screen.getByRole("button", { name: `Revoke ${AFFILIATE_ORG_ID_2}` }));
      await waitFor(() => expect(screen.getAllByTestId("access-grant-status-badge").map((b) => b.textContent)).toEqual(["Rejected", "Revoked"]));

      expect(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`).map((c) => c.body)).toEqual([
        { affiliate_organization_id: AFFILIATE_ORG_ID, status: "REJECTED", reason: "Traffic quality concerns" },
        { affiliate_organization_id: AFFILIATE_ORG_ID_2, status: "REVOKED" },
      ]);
      // A rejected grant can be approved later (re-application path), a revoked one too.
      expect(screen.getByRole("button", { name: `Approve ${AFFILIATE_ORG_ID}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Approve ${AFFILIATE_ORG_ID_2}` })).toBeInTheDocument();
    });

    it("invite form validates the UUID client-side, then PUTs INVITED or APPROVED by affiliate org id", async () => {
      const state = offerServer(makeOffer({ status: "LIVE", access_mode: "INVITE_ONLY", allowed_transitions: ["PAUSED"] }), { grants: [] });
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`PUT ${OFFER_PATH}/access`]: ({ body }) => {
          const input = body as { affiliate_organization_id: string; status: "INVITED" | "APPROVED" };
          const grant = makeGrant({ id: `g-${state.grants.length + 1}`, affiliate_organization_id: input.affiliate_organization_id, status: input.status });
          state.grants = [...state.grants, grant];
          return { status: 201, json: { grant } };
        },
      });
      await renderDetail();
      const user = userEvent.setup();

      expect(await screen.findByText("No affiliates have access or pending applications.")).toBeInTheDocument();
      const form = screen.getByRole("form", { name: "Invite affiliate" });
      const idInput = within(form).getByLabelText("Affiliate organization id");

      await user.type(idInput, "not-a-uuid");
      await user.click(within(form).getByRole("button", { name: "Send" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Enter the affiliate organization's id (UUID).");
      expect(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`)).toHaveLength(0);

      await user.clear(idInput);
      await user.type(idInput, AFFILIATE_ORG_ID);
      await user.click(within(form).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(screen.getByRole("table", { name: "Affiliate access grants" })).toHaveTextContent(AFFILIATE_ORG_ID));
      expect(screen.getAllByTestId("access-grant-status-badge").map((b) => b.textContent)).toEqual(["Invited"]);
      expect(idInput).toHaveValue(""); // cleared after success

      await user.type(idInput, AFFILIATE_ORG_ID_2);
      await user.selectOptions(within(form).getByLabelText("Grant"), "APPROVED");
      await user.click(within(form).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(screen.getAllByTestId("access-grant-status-badge").map((b) => b.textContent)).toEqual(["Invited", "Approved"]));

      expect(callsTo(fetchStub, "PUT", `${OFFER_PATH}/access`).map((c) => c.body)).toEqual([
        { affiliate_organization_id: AFFILIATE_ORG_ID, status: "INVITED" },
        { affiliate_organization_id: AFFILIATE_ORG_ID_2, status: "APPROVED" },
      ]);
    });

    it("surfaces the server's grant refusal (e.g. AFFILIATE_ORG_NOT_FOUND) without altering the list", async () => {
      const state = grantsFor("PRIVATE");
      fetchStub = signedIn({
        ...advertiserRoutes(),
        ...offerRoutes(state),
        [`PUT ${OFFER_PATH}/access`]: () => ({ status: 404, json: errorEnvelope("AFFILIATE_ORG_NOT_FOUND", "Affiliate organization not found") }),
      });
      await renderDetail();
      const user = userEvent.setup();

      const form = await screen.findByRole("form", { name: "Invite affiliate" });
      await user.type(within(form).getByLabelText("Affiliate organization id"), "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c");
      await user.click(within(form).getByRole("button", { name: "Send" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Affiliate organization not found");
      expect(screen.getAllByTestId("access-grant-status-badge")).toHaveLength(2);
    });
  });
});
