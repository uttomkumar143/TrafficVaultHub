/**
 * Phase 2 Unit 9 — Offers, versioning, economics, access & marketplace
 * (PRD §22–§30, §92, §94, §116, §124). HTTP → requireAuth → requireOrg →
 * requirePermission → OfferService → OfferRepository → D1 shim on the real
 * migrations 0001–0007.
 *
 * Covers the Unit 9 definition of done:
 *   - offer version history is immutable and queryable;
 *   - access rules correctly block/allow per mode, enforced server-side;
 *   - confidential advertiser economics are never exposed through the
 *     affiliate-facing marketplace, and one tenant's offers/grants never leak
 *     into another's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface Version {
  id: string;
  version_number: number;
  payout_type: string;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor: number;
  revshare_percent_bps: number | null;
  conversion_event: string;
  destination_url: string | null;
  targeting: Array<{ dimension: string; value: string }>;
}
interface Offer {
  id: string;
  organization_id: string;
  status: string;
  access_mode: string;
  name: string;
  current_version_id: string | null;
  current_version: Version | null;
  allowed_transitions: string[];
}
interface Grant {
  id: string;
  offer_id: string;
  affiliate_organization_id: string;
  status: string;
}

// A valid fixed-payout (CPA) version. Money is integer minor units + currency.
const V1 = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click",
};

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

/** Advertiser owner + ADVERTISER org + a minimal advertiser profile. */
async function advertiser(email = "adv@acme.example", name = "Acme Ads") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: name })).status).toBe(201);
  return { owner, orgId };
}

/** Affiliate owner + AFFILIATE org (self-service orgs are ACTIVE). */
async function affiliate(email = "aff@traffic.example", name = "Traffic Co") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  return { owner, orgId };
}

async function platform(email = "rev@network.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  return { token, orgId };
}

/** Drive a freshly-created offer all the way to LIVE and return its id. */
async function toLive(
  owner: string,
  advOrg: string,
  plat: { token: string; orgId: string },
  body: Record<string, unknown>,
): Promise<Offer> {
  const created = await json<{ offer: Offer }>(await h.as(owner, "POST", `/organizations/${advOrg}/offers`, body));
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) =>
    h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  // Launch is the tenant's call (APPROVED → LIVE, offers.update).
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}
interface MktVersion {
  version_number: number;
  payout_type: string;
  currency: string;
  affiliate_commission_minor: number;
  revshare_percent_bps: number | null;
  conversion_event: string;
}
interface MktOffer {
  id: string;
  name: string;
  access_mode: string;
  status: string;
  advertiser: { name: string; slug: string; type: string };
  version: MktVersion;
  destination_url?: string | null;
  targeting?: Array<{ dimension: string; value: string }>;
  my_access: { status: string } | null;
  can_join: boolean;
  can_apply: boolean;
}

// ---------------------------------------------------------------------------
// Offer creation, immutable versioning & economics (PRD §22, §24, §25).
// ---------------------------------------------------------------------------
describe("offers: creation, immutable versions & economics", () => {
  it("creates a DRAFT offer with an immutable version 1 in integer minor units", async () => {
    const { owner, orgId } = await advertiser();
    const res = await h.as(owner, "POST", `/organizations/${orgId}/offers`, {
      name: "Signup CPA",
      vertical: "finance",
      version: V1,
    });
    expect(res.status).toBe(201);
    const { offer } = await json<{ offer: Offer }>(res);
    expect(offer.status).toBe("DRAFT");
    expect(offer.access_mode).toBe("PUBLIC");
    expect(offer.current_version_id).toBe(offer.current_version!.id);
    const v = offer.current_version!;
    expect(v.version_number).toBe(1);
    // Money survives the round-trip as an exact integer + upper-cased currency.
    expect(v.advertiser_payout_minor).toBe(5000);
    expect(v.affiliate_commission_minor).toBe(4000);
    expect(v.network_margin_minor).toBe(1000);
    expect(v.currency).toBe("USD");
    expect(Number.isInteger(v.advertiser_payout_minor)).toBe(true);
  });
  it("keeps version 1 immutable and moves the current pointer when a version is appended", async () => {
    const { owner, orgId } = await advertiser();
    const created = await json<{ offer: Offer }>(
      await h.as(owner, "POST", `/organizations/${orgId}/offers`, { name: "Versioned", version: V1 }),
    );
    const id = created.offer.id;
    const v1Id = created.offer.current_version_id!;

    // Append version 2 with a different payout — an INSERT, never an UPDATE.
    const v2Res = await h.as(owner, "POST", `/organizations/${orgId}/offers/${id}/versions`, {
      ...V1,
      advertiser_payout_minor: 7000,
      affiliate_commission_minor: 5000,
      change_summary: "raised payout",
    });
    expect(v2Res.status).toBe(201);
    const v2 = (await json<{ version: Version }>(v2Res)).version;
    expect(v2.version_number).toBe(2);
    expect(v2.id).not.toBe(v1Id);

    // Version 1, fetched by id, is byte-for-byte what it always was.
    const v1After = (await json<{ version: Version }>(
      await h.as(owner, "GET", `/organizations/${orgId}/offers/${id}/versions/${v1Id}`),
    )).version;
    expect(v1After.advertiser_payout_minor).toBe(5000);
    expect(v1After.version_number).toBe(1);

    // History is queryable, oldest-first, and the offer now points at v2.
    const { versions } = await json<{ versions: Version[] }>(
      await h.as(owner, "GET", `/organizations/${orgId}/offers/${id}/versions`),
    );
    expect(versions.map((x) => x.version_number)).toEqual([1, 2]);
    const offer = (await json<{ offer: Offer }>(await h.as(owner, "GET", `/organizations/${orgId}/offers/${id}`))).offer;
    expect(offer.current_version_id).toBe(v2.id);
    expect(offer.current_version!.advertiser_payout_minor).toBe(7000);
  });
  it("rejects a fractional (non-integer) money amount at the boundary", async () => {
    const { owner, orgId } = await advertiser();
    const res = await h.as(owner, "POST", `/organizations/${orgId}/offers`, {
      name: "Float payout",
      version: { ...V1, advertiser_payout_minor: 50.5 },
    });
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("rejects commission that exceeds the advertiser payout", async () => {
    const { owner, orgId } = await advertiser();
    const res = await h.as(owner, "POST", `/organizations/${orgId}/offers`, {
      name: "Upside down",
      version: { ...V1, affiliate_commission_minor: 6000, network_margin_minor: 0 },
    });
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("rejects a REVSHARE offer with no basis-points share", async () => {
    const { owner, orgId } = await advertiser();
    const res = await h.as(owner, "POST", `/organizations/${orgId}/offers`, {
      name: "Revshare no bps",
      version: { ...V1, payout_type: "REVSHARE", advertiser_payout_minor: 0, affiliate_commission_minor: 0, network_margin_minor: 0 },
    });
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("requires an advertiser profile before an offer can be created", async () => {
    const owner = await h.user("noprofile@acme.example");
    const orgId = await h.org(owner, "ADVERTISER", "No Profile Ads");
    const res = await h.as(owner, "POST", `/organizations/${orgId}/offers`, { name: "Orphan", version: V1 });
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("ADVERTISER_PROFILE_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Full review lifecycle, enforced server-side, with no advertiser self-approval.
// ---------------------------------------------------------------------------
describe("offers: lifecycle & platform review", () => {
  it("drives DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→LIVE with an append-only history", async () => {
    const { owner, orgId } = await advertiser();
    const plat = await platform();
    const offer = await toLive(owner, orgId, plat, { name: "Full lifecycle", version: V1 });
    expect(offer.status).toBe("LIVE");

    const { transitions } = await json<{ transitions: Array<{ from_status: string | null; to_status: string; actor_kind: string }> }>(
      await h.as(owner, "GET", `/organizations/${orgId}/offers/${offer.id}/history`),
    );
    expect(transitions.map((t) => t.to_status)).toEqual(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "LIVE"]);
    // The two review steps were performed by the PLATFORM actor, not the tenant.
    const review = transitions.filter((t) => t.to_status === "UNDER_REVIEW" || t.to_status === "APPROVED");
    expect(review.every((t) => t.actor_kind === "PLATFORM")).toBe(true);
  });

  it("forbids the advertiser from approving its own submitted offer", async () => {
    const { owner, orgId } = await advertiser();
    const created = await json<{ offer: Offer }>(
      await h.as(owner, "POST", `/organizations/${orgId}/offers`, { name: "Self approve", version: V1 }),
    );
    const id = created.offer.id;
    expect((await h.as(owner, "POST", `/organizations/${orgId}/offers/${id}/submit`)).status).toBe(200);
    // UNDER_REVIEW and APPROVED are PLATFORM-only edges: the tenant cannot take them.
    for (const to of ["UNDER_REVIEW", "APPROVED"]) {
      const res = await h.as(owner, "POST", `/organizations/${orgId}/offers/${id}/transition`, { to });
      expect(res.status).toBe(409);
      expect(await h.errorCode(res)).toBe("INVALID_TRANSITION");
    }
  });

  it("refuses to submit an offer that another tenant owns (404, no cross-tenant reach)", async () => {
    const a = await advertiser("a@acme.example", "Acme A");
    const b = await advertiser("b@beta.example", "Beta B");
    const created = await json<{ offer: Offer }>(
      await h.as(a.owner, "POST", `/organizations/${a.orgId}/offers`, { name: "A's offer", version: V1 }),
    );
    // B tries to read/submit A's offer through B's own org scope.
    expect((await h.as(b.owner, "GET", `/organizations/${b.orgId}/offers/${created.offer.id}`)).status).toBe(404);
    expect((await h.as(b.owner, "POST", `/organizations/${b.orgId}/offers/${created.offer.id}/submit`)).status).toBe(404);
  });
});
// ---------------------------------------------------------------------------
// Marketplace visibility + advertiser-economics confidentiality (PRD §28/§29/§116).
// ---------------------------------------------------------------------------
describe("offers: marketplace confidentiality & non-live gating", () => {
  it("shows a LIVE public offer to affiliates without ever leaking confidential economics", async () => {
    const { owner, orgId } = await advertiser();
    const plat = await platform();
    const live = await toLive(owner, orgId, plat, { name: "Public CPA", vertical: "finance", version: V1 });
    const aff = await affiliate();

    const { items } = await json<{ items: MktOffer[] }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace`),
    );
    const listed = items.find((o) => o.id === live.id);
    expect(listed).toBeDefined();
    expect(listed!.can_join).toBe(true);
    // The affiliate sees its own commission but NEVER the advertiser's economics.
    expect(listed!.version.affiliate_commission_minor).toBe(4000);
    const blob = JSON.stringify(listed);
    expect(blob).not.toContain("advertiser_payout");
    expect(blob).not.toContain("network_margin");
    expect(blob).not.toContain("budget_minor");

    // Detail exposes the joinable payload (destination_url) but still no economics.
    const detail = (await json<{ offer: MktOffer }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace/${live.id}`),
    )).offer;
    expect(detail.destination_url).toBe("https://track.example/click");
    expect(JSON.stringify(detail)).not.toContain("advertiser_payout");
  });

  it("never surfaces a non-live (DRAFT) offer in the marketplace", async () => {
    const { owner, orgId } = await advertiser();
    const created = await json<{ offer: Offer }>(
      await h.as(owner, "POST", `/organizations/${orgId}/offers`, { name: "Still a draft", version: V1 }),
    );
    const aff = await affiliate();
    const { items } = await json<{ items: MktOffer[] }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace`),
    );
    expect(items.some((o) => o.id === created.offer.id)).toBe(false);
    // Direct id access is gated the same way — 404, no existence oracle.
    expect((await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace/${created.offer.id}`)).status).toBe(404);
  });
});
// ---------------------------------------------------------------------------
// Access modes enforced server-side: private grants and application flow.
// ---------------------------------------------------------------------------
describe("offers: access-mode enforcement", () => {
  it("hides a PRIVATE offer until the advertiser approves a grant, then reveals it", async () => {
    const { owner, orgId } = await advertiser();
    const plat = await platform();
    const live = await toLive(owner, orgId, plat, { name: "Private deal", access_mode: "PRIVATE", version: V1 });
    const aff = await affiliate();

    // Ungranted: invisible in search AND on direct detail (404).
    const before = await json<{ items: MktOffer[] }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace`),
    );
    expect(before.items.some((o) => o.id === live.id)).toBe(false);
    expect((await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace/${live.id}`)).status).toBe(404);

    // Advertiser approves this specific affiliate.
    const grantRes = await h.as(owner, "PUT", `/organizations/${orgId}/offers/${live.id}/access`, {
      affiliate_organization_id: aff.orgId,
      status: "APPROVED",
    });
    expect(grantRes.status).toBe(201);

    // Now visible and joinable, with the destination payload exposed.
    const after = await json<{ items: MktOffer[] }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace`),
    );
    expect(after.items.some((o) => o.id === live.id)).toBe(true);
    const detail = (await json<{ offer: MktOffer }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace/${live.id}`),
    )).offer;
    expect(detail.my_access).toEqual({ status: "APPROVED" });
    expect(detail.can_join).toBe(true);
    expect(detail.destination_url).toBe("https://track.example/click");
  });

  it("keeps one affiliate's private grant from leaking to another affiliate", async () => {
    const { owner, orgId } = await advertiser();
    const plat = await platform();
    const live = await toLive(owner, orgId, plat, { name: "Private deal 2", access_mode: "PRIVATE", version: V1 });
    const granted = await affiliate("granted@aff.example", "Granted Co");
    const other = await affiliate("other@aff.example", "Other Co");
    expect(
      (await h.as(owner, "PUT", `/organizations/${orgId}/offers/${live.id}/access`, {
        affiliate_organization_id: granted.orgId,
        status: "APPROVED",
      })).status,
    ).toBe(201);
    // The other affiliate still sees nothing.
    const list = await json<{ items: MktOffer[] }>(
      await h.as(other.owner, "GET", `/organizations/${other.orgId}/marketplace`),
    );
    expect(list.items.some((o) => o.id === live.id)).toBe(false);
    expect((await h.as(other.owner, "GET", `/organizations/${other.orgId}/marketplace/${live.id}`)).status).toBe(404);
  });
  it("runs the APPLICATION_REQUIRED apply→approve→join flow", async () => {
    const { owner, orgId } = await advertiser();
    const plat = await platform();
    const live = await toLive(owner, orgId, plat, { name: "Apply to join", access_mode: "APPLICATION_REQUIRED", version: V1 });
    const aff = await affiliate();

    // Listed (application-required offers are publicly discoverable) but not yet joinable.
    const listed = (await json<{ items: MktOffer[] }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace`),
    )).items.find((o) => o.id === live.id)!;
    expect(listed.can_join).toBe(false);
    expect(listed.can_apply).toBe(true);

    // Affiliate applies → a REQUESTED grant.
    const applyRes = await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/marketplace/${live.id}/apply`);
    expect(applyRes.status).toBe(201);
    expect((await json<{ grant: Grant }>(applyRes)).grant.status).toBe("REQUESTED");

    // Advertiser sees the pending application and approves it.
    const grants = (await json<{ grants: Grant[] }>(
      await h.as(owner, "GET", `/organizations/${orgId}/offers/${live.id}/access`),
    )).grants;
    expect(grants.some((g) => g.affiliate_organization_id === aff.orgId && g.status === "REQUESTED")).toBe(true);
    const approve = await h.as(owner, "PUT", `/organizations/${orgId}/offers/${live.id}/access`, {
      affiliate_organization_id: aff.orgId,
      status: "APPROVED",
    });
    expect(approve.status).toBe(200); // grant already existed → 200, not 201

    // Now the affiliate may join.
    const detail = (await json<{ offer: MktOffer }>(
      await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/marketplace/${live.id}`),
    )).offer;
    expect(detail.can_join).toBe(true);
    expect(detail.my_access).toEqual({ status: "APPROVED" });
  });

  it("blocks the marketplace for a non-affiliate org type", async () => {
    const { owner, orgId } = await advertiser();
    const res = await h.as(owner, "GET", `/organizations/${orgId}/marketplace`);
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("AFFILIATE_ORG_INVALID");
  });
});
