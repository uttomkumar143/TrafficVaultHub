/**
 * Phase 3 Unit 1 — Tracking links & click reads (PRD §31–§34, §94, §116,
 * §124). HTTP → requireAuth → requireOrg → requirePermission →
 * TrackingService → TrackingRepository → D1 shim on the real migrations
 * 0001–0008.
 *
 * Covers:
 *   - link creation for an ACTIVE affiliate against a LIVE PUBLIC offer, with a
 *     server-minted UNIQUE code and an audit row;
 *   - sub-ID hygiene (too long / email-shaped / wrong type → 400 naming the slot);
 *   - cross-tenant isolation (another affiliate's link is a 404);
 *   - access enforcement (ungranted PRIVATE offer → 404; inactive offer → 409);
 *   - affiliate lifecycle gating (no profile → 400; non-ACTIVE → 409);
 *   - permission denial (VIEWER read-only → 403 on manage; advertiser org → 400);
 *   - status graph ACTIVE ⇄ PAUSED → ARCHIVED and resume re-checks;
 *   - cursor pagination over links; click lists on both sides.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

interface Link {
  id: string;
  organization_id: string;
  offer_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  code: string;
  tracking_path: string;
  name: string | null;
  creative_id: string | null;
  status: string;
  defaults: Record<"sub1" | "sub2" | "sub3" | "sub4" | "sub5", string | null>;
  archived_at: string | null;
  allowed_transitions: string[];
}
interface Offer {
  id: string;
  status: string;
  current_version_id: string | null;
}
interface PageOf<T> {
  items: T[];
  next_cursor: string | null;
}

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

const COMPLETE_AFFILIATE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

async function platform(email = "rev@network.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  return { token, orgId };
}

async function advertiser(email = "adv@acme.example", name = "Acme Ads") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: name })).status).toBe(201);
  return { owner, orgId };
}

/** Affiliate owner + org; profile driven to ACTIVE via the real review flow. */
async function activeAffiliate(plat: { token: string; orgId: string }, email = "aff@traffic.example", name = "Traffic Co") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  const src = await json<{ source: { id: string } }>(
    await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {}),
  );
  expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(200);
  for (const to of ["APPROVED", "ACTIVE"]) {
    const res = await h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/affiliates/${created.profile.id}/transition`, { to });
    expect(res.status, to).toBe(200);
  }
  return { owner, orgId, profileId: created.profile.id, trafficSourceId: src.source.id };
}

async function toLive(owner: string, advOrg: string, plat: { token: string; orgId: string }, body: Record<string, unknown>): Promise<Offer> {
  const created = await json<{ offer: Offer }>(await h.as(owner, "POST", `/organizations/${advOrg}/offers`, body));
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}

/** One advertiser with a LIVE PUBLIC offer + one ACTIVE affiliate. */
async function world() {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
  const aff = await activeAffiliate(plat);
  return { plat, adv, offer, aff };
}

const links = (orgId: string) => `/organizations/${orgId}/tracking-links`;

// ---------------------------------------------------------------------------
describe("tracking links: creation & codes", () => {
  it("creates a link with a server-minted code, tenant-derived org ids and an audit row", async () => {
    const { adv, offer, aff } = await world();
    const res = await h.as(aff.owner, "POST", links(aff.orgId), {
      offer_id: offer.id,
      name: "Newsletter",
      creative_id: "banner-728",
      traffic_source_id: aff.trafficSourceId,
      defaults: { sub1: "nl", sub3: " campaign-9 " },
    });
    expect(res.status).toBe(201);
    const { tracking_link: link } = await json<{ tracking_link: Link }>(res);
    expect(link.organization_id).toBe(aff.orgId);
    expect(link.offer_id).toBe(offer.id);
    expect(link.offer_organization_id).toBe(adv.orgId);
    expect(link.traffic_source_id).toBe(aff.trafficSourceId);
    expect(link.status).toBe("ACTIVE");
    expect(link.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(link.tracking_path).toBe(`/t/${link.code}`);
    expect(link.defaults).toEqual({ sub1: "nl", sub2: null, sub3: "campaign-9", sub4: null, sub5: null });
    expect(link.allowed_transitions).toEqual(["PAUSED", "ARCHIVED"]);

    const audit = await h.auditRows("tracking_link.created");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.organization_id).toBe(aff.orgId);
    expect(audit[0]!.target_id).toBe(link.id);

    // Readable back under the same tenant.
    const got = await h.as(aff.owner, "GET", `${links(aff.orgId)}/${link.id}`);
    expect(got.status).toBe(200);
    expect((await json<{ tracking_link: Link }>(got)).tracking_link.code).toBe(link.code);
  });

  it("mints a distinct code for every link, even for the same offer", async () => {
    const { offer, aff } = await world();
    const codes = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id });
      expect(res.status).toBe(201);
      codes.add((await json<{ tracking_link: Link }>(res)).tracking_link.code);
    }
    expect(codes.size).toBe(8);
    const rows = await h.db.prepare("SELECT COUNT(DISTINCT code) AS n, COUNT(*) AS total FROM tracking_links").first<{ n: number; total: number }>();
    expect(rows).toEqual({ n: 8, total: 8 });
  });

  it("rejects a client-supplied organization_id / affiliate id (strict body)", async () => {
    const { offer, aff } = await world();
    for (const extra of [{ organization_id: RANDOM_ID }, { affiliate_profile_id: RANDOM_ID }, { code: "HACKEDCODE12" }]) {
      const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects invalid sub-ID defaults naming the slot and reason; never truncates", async () => {
    const { offer, aff } = await world();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sub2: "x".repeat(256) }, "sub2 (TOO_LONG)"],
      [{ sub4: "someone@example.com" }, "sub4 (PERSONAL_DATA)"],
      [{ sub5: 42 }, "sub5 (INVALID_TYPE)"],
    ];
    for (const [defaults, expected] of cases) {
      const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id, defaults });
      expect(res.status, expected).toBe(400);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe("SUB_ID_INVALID");
      expect(body.error.message).toContain(expected);
    }
    // Exactly 255 is the boundary and is accepted verbatim.
    const ok = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id, defaults: { sub1: "y".repeat(255) } });
    expect(ok.status).toBe(201);
    expect((await json<{ tracking_link: Link }>(ok)).tracking_link.defaults.sub1).toHaveLength(255);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM tracking_links").first<{ n: number }>())!.n).toBe(1);
  });

  it("rejects a traffic source that is not the tenant's own", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
    const a = await activeAffiliate(plat, "a@aff.example", "Aff A");
    const b = await activeAffiliate(plat, "b@aff.example", "Aff B");
    const res = await h.as(a.owner, "POST", links(a.orgId), { offer_id: offer.id, traffic_source_id: b.trafficSourceId });
    expect(res.status).toBe(400);
    expect(await h.errorCode(res)).toBe("TRAFFIC_SOURCE_INVALID");
    // Unknown id → same answer.
    const unknown = await h.as(a.owner, "POST", links(a.orgId), { offer_id: offer.id, traffic_source_id: RANDOM_ID });
    expect(unknown.status).toBe(400);
    expect(await h.errorCode(unknown)).toBe("TRAFFIC_SOURCE_INVALID");
  });
});

// ---------------------------------------------------------------------------
describe("tracking links: offer eligibility & affiliate gating", () => {
  it("returns 404 for an ungranted PRIVATE offer and 201 once the advertiser approves the grant", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const priv = await toLive(adv.owner, adv.orgId, plat, { name: "Private", access_mode: "PRIVATE", version: V1 });
    const aff = await activeAffiliate(plat);

    const denied = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: priv.id });
    expect(denied.status).toBe(404);
    expect(await h.errorCode(denied)).toBe("OFFER_NOT_FOUND");

    expect(
      (await h.as(adv.owner, "PUT", `/organizations/${adv.orgId}/offers/${priv.id}/access`, {
        affiliate_organization_id: aff.orgId,
        status: "APPROVED",
      })).status,
    ).toBe(201);
    expect((await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: priv.id })).status).toBe(201);

    // Revoking the grant makes a paused link un-resumable.
    const created = await json<{ tracking_link: Link }>(await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: priv.id }));
    const id = created.tracking_link.id;
    expect((await h.as(aff.owner, "POST", `${links(aff.orgId)}/${id}/transition`, { to: "PAUSED" })).status).toBe(200);
    expect(
      (await h.as(adv.owner, "PUT", `/organizations/${adv.orgId}/offers/${priv.id}/access`, {
        affiliate_organization_id: aff.orgId,
        status: "REVOKED",
      })).status,
    ).toBe(200);
    const resume = await h.as(aff.owner, "POST", `${links(aff.orgId)}/${id}/transition`, { to: "ACTIVE" });
    expect(resume.status).toBe(404);
    expect(await h.errorCode(resume)).toBe("OFFER_NOT_FOUND");
  });

  it("rejects an inactive (PAUSED) visible offer with 409 OFFER_NOT_LINKABLE, and a DRAFT one with 409 too", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const paused = await toLive(adv.owner, adv.orgId, plat, { name: "Paused", version: V1 });
    expect((await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/offers/${paused.id}/transition`, { to: "PAUSED" })).status).toBe(200);
    const draft = await json<{ offer: Offer }>(await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/offers`, { name: "Draft", version: V1 }));
    const aff = await activeAffiliate(plat);

    for (const offerId of [paused.id, draft.offer.id]) {
      const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offerId });
      expect(res.status, offerId).toBe(409);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(body.error.code).toBe("OFFER_NOT_LINKABLE");
      expect(body.error.message).toContain("OFFER_NOT_LIVE");
    }
    // Unknown / malformed offer ids → 404, no oracle.
    expect((await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: RANDOM_ID })).status).toBe(404);
    expect((await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: "not-a-uuid" })).status).toBe(400);
  });

  it("requires an ACTIVE affiliate profile", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });

    // No profile at all.
    const bare = await h.user("bare@aff.example");
    const bareOrg = await h.org(bare, "AFFILIATE", "Bare");
    const noProfile = await h.as(bare, "POST", links(bareOrg), { offer_id: offer.id });
    expect(noProfile.status).toBe(400);
    expect(await h.errorCode(noProfile)).toBe("AFFILIATE_PROFILE_REQUIRED");

    // Profile exists but is only EMAIL_VERIFIED.
    expect((await h.as(bare, "POST", `/organizations/${bareOrg}/affiliate`, COMPLETE_AFFILIATE)).status).toBe(201);
    const notActive = await h.as(bare, "POST", links(bareOrg), { offer_id: offer.id });
    expect(notActive.status).toBe(409);
    expect(await h.errorCode(notActive)).toBe("AFFILIATE_NOT_ACTIVE");
  });
});

// ---------------------------------------------------------------------------
describe("tracking links: tenant isolation & permissions", () => {
  it("never lets one affiliate see, edit or transition another affiliate's link", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
    const a = await activeAffiliate(plat, "a@aff.example", "Aff A");
    const b = await activeAffiliate(plat, "b@aff.example", "Aff B");
    const link = (await json<{ tracking_link: Link }>(await h.as(a.owner, "POST", links(a.orgId), { offer_id: offer.id }))).tracking_link;

    expect((await h.as(b.owner, "GET", `${links(b.orgId)}/${link.id}`)).status).toBe(404);
    expect((await h.as(b.owner, "PATCH", `${links(b.orgId)}/${link.id}`, { name: "stolen" })).status).toBe(404);
    expect((await h.as(b.owner, "POST", `${links(b.orgId)}/${link.id}/transition`, { to: "PAUSED" })).status).toBe(404);
    expect((await h.as(b.owner, "GET", `${links(b.orgId)}/${link.id}/clicks`)).status).toBe(404);
    // B's list does not contain A's link.
    const list = await json<PageOf<Link>>(await h.as(b.owner, "GET", links(b.orgId)));
    expect(list.items).toEqual([]);
    // B is not a member of A's org → 404 from requireOrg (no enumeration).
    expect((await h.as(b.owner, "GET", links(a.orgId))).status).toBe(404);
    // Anonymous → 401.
    expect((await h.api("GET", links(a.orgId))).status).toBe(401);
  });

  it("VIEWER can read but not manage (403); advertiser org cannot own links (400)", async () => {
    const { adv, offer, aff } = await world();
    const link = (await json<{ tracking_link: Link }>(await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id }))).tracking_link;

    const VIEWER = "viewer@traffic.example";
    await h.user(VIEWER);
    await h.addMember(aff.owner, aff.orgId, VIEWER, "VIEWER");
    const vt = (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email: VIEWER, password: PASSWORD }))).token;

    expect((await h.as(vt, "GET", links(aff.orgId))).status).toBe(200);
    expect((await h.as(vt, "GET", `${links(aff.orgId)}/${link.id}`)).status).toBe(200);
    expect((await h.as(vt, "GET", `${links(aff.orgId)}/${link.id}/clicks`)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", links(aff.orgId), { offer_id: offer.id }],
      ["PATCH", `${links(aff.orgId)}/${link.id}`, { name: "x" }],
      ["POST", `${links(aff.orgId)}/${link.id}/transition`, { to: "PAUSED" }],
    ] as const) {
      const res = await h.as(vt, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }

    // An advertiser org holds tracking.read but is the wrong org type for links.
    const advList = await h.as(adv.owner, "GET", links(adv.orgId));
    expect(advList.status).toBe(400);
    expect(await h.errorCode(advList)).toBe("ORG_TYPE_NOT_AFFILIATE");
    // …and an affiliate org is the wrong type for the offer-side click list.
    const affClicks = await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/offers/${offer.id}/clicks`);
    expect(affClicks.status).toBe(400);
    expect(await h.errorCode(affClicks)).toBe("ORG_TYPE_NOT_ADVERTISER");
  });
});

// ---------------------------------------------------------------------------
describe("tracking links: lifecycle, updates, pagination & click reads", () => {
  it("walks ACTIVE → PAUSED → ACTIVE → ARCHIVED (terminal) with audit rows; archived links are read-only", async () => {
    const { offer, aff } = await world();
    const link = (await json<{ tracking_link: Link }>(await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id }))).tracking_link;
    const move = (to: string) => h.as(aff.owner, "POST", `${links(aff.orgId)}/${link.id}/transition`, { to });

    const paused = await json<{ tracking_link: Link }>(await move("PAUSED"));
    expect(paused.tracking_link.status).toBe("PAUSED");
    expect(paused.tracking_link.allowed_transitions).toEqual(["ACTIVE", "ARCHIVED"]);
    expect((await json<{ tracking_link: Link }>(await move("ACTIVE"))).tracking_link.status).toBe("ACTIVE");
    // Same-state and unknown targets are rejected.
    const same = await move("ACTIVE");
    expect(same.status).toBe(409);
    expect(await h.errorCode(same)).toBe("INVALID_TRANSITION");
    expect((await move("BOGUS")).status).toBe(400);

    const archived = await json<{ tracking_link: Link }>(await move("ARCHIVED"));
    expect(archived.tracking_link.status).toBe("ARCHIVED");
    expect(archived.tracking_link.archived_at).not.toBeNull();
    expect(archived.tracking_link.allowed_transitions).toEqual([]);
    expect((await move("ACTIVE")).status).toBe(409);
    const edit = await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/${link.id}`, { name: "too late" });
    expect(edit.status).toBe(409);
    expect(await h.errorCode(edit)).toBe("INVALID_TRANSITION");

    const audit = await h.auditRows("tracking_link.status_changed");
    expect(audit.map((a) => JSON.parse(a.metadata!).to)).toEqual(["PAUSED", "ACTIVE", "ARCHIVED"]);
  });

  it("patches name / creative / defaults / traffic source but never code, offer or status", async () => {
    const { offer, aff } = await world();
    const link = (await json<{ tracking_link: Link }>(
      await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offer.id, name: "v1", defaults: { sub1: "a", sub2: "b" } }),
    )).tracking_link;

    const res = await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/${link.id}`, {
      name: "v2",
      creative_id: "cr-1",
      traffic_source_id: aff.trafficSourceId,
      defaults: { sub2: "B" }, // replaces the whole set: sub1 is cleared
    });
    expect(res.status).toBe(200);
    const after = (await json<{ tracking_link: Link }>(res)).tracking_link;
    expect(after.name).toBe("v2");
    expect(after.creative_id).toBe("cr-1");
    expect(after.traffic_source_id).toBe(aff.trafficSourceId);
    expect(after.defaults).toEqual({ sub1: null, sub2: "B", sub3: null, sub4: null, sub5: null });
    expect(after.code).toBe(link.code);
    expect(after.status).toBe("ACTIVE");

    for (const body of [{ code: "NEWCODE12345" }, { offer_id: RANDOM_ID }, { status: "PAUSED" }]) {
      const bad = await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/${link.id}`, body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
    const badSub = await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/${link.id}`, { defaults: { sub3: "me@x.io" } });
    expect(badSub.status).toBe(400);
    expect(await h.errorCode(badSub)).toBe("SUB_ID_INVALID");
    // Malformed / unknown link ids → 404.
    expect((await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/not-a-uuid`, { name: "x" })).status).toBe(404);
    expect((await h.as(aff.owner, "PATCH", `${links(aff.orgId)}/${RANDOM_ID}`, { name: "x" })).status).toBe(404);
  });

  it("paginates the link list newest-first with an opaque cursor and honours filters", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const o1 = await toLive(adv.owner, adv.orgId, plat, { name: "One", version: V1 });
    const o2 = await toLive(adv.owner, adv.orgId, plat, { name: "Two", version: V1 });
    const aff = await activeAffiliate(plat);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: i % 2 === 0 ? o1.id : o2.id, name: `L${i}` });
      expect(res.status).toBe(201);
      ids.push((await json<{ tracking_link: Link }>(res)).tracking_link.id);
    }
    expect((await h.as(aff.owner, "POST", `${links(aff.orgId)}/${ids[4]}/transition`, { to: "PAUSED" })).status).toBe(200);

    const p1 = await json<PageOf<Link>>(await h.as(aff.owner, "GET", `${links(aff.orgId)}?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<PageOf<Link>>(await h.as(aff.owner, "GET", `${links(aff.orgId)}?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`));
    expect(p2.items).toHaveLength(2);
    const p3 = await json<PageOf<Link>>(await h.as(aff.owner, "GET", `${links(aff.orgId)}?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`));
    expect(p3.items).toHaveLength(1);
    expect(p3.next_cursor).toBeNull();
    const seen = [...p1.items, ...p2.items, ...p3.items].map((l) => l.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());

    const byOffer = await json<PageOf<Link>>(await h.as(aff.owner, "GET", `${links(aff.orgId)}?offer_id=${o1.id}`));
    expect(byOffer.items.map((l) => l.name).sort()).toEqual(["L0", "L2", "L4"]);
    const paused = await json<PageOf<Link>>(await h.as(aff.owner, "GET", `${links(aff.orgId)}?status=PAUSED`));
    expect(paused.items.map((l) => l.name)).toEqual(["L4"]);
    expect((await h.as(aff.owner, "GET", `${links(aff.orgId)}?status=BOGUS`)).status).toBe(400);
    expect((await h.as(aff.owner, "GET", `${links(aff.orgId)}?offer_id=nope`)).status).toBe(400);
  });

  it("lists clicks per link (affiliate) and per offer (advertiser), each within its own tenant scope", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
    const a = await activeAffiliate(plat, "a@aff.example", "Aff A");
    const b = await activeAffiliate(plat, "b@aff.example", "Aff B");
    const la = (await json<{ tracking_link: Link }>(await h.as(a.owner, "POST", links(a.orgId), { offer_id: offer.id }))).tracking_link;
    const lb = (await json<{ tracking_link: Link }>(await h.as(b.owner, "POST", links(b.orgId), { offer_id: offer.id }))).tracking_link;

    // Seed click facts directly (the public redirect that writes them is Unit 2).
    const insert = h.db.prepare(
      `INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id,
         offer_organization_id, sub1, ip_hash, decision_reason_code, destination_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OK', 'https://track.example/click')`,
    );
    await insert.bind(crypto.randomUUID(), a.orgId, a.profileId, la.id, offer.id, offer.current_version_id, adv.orgId, "a1", "hash-a").run();
    await insert.bind(crypto.randomUUID(), a.orgId, a.profileId, la.id, offer.id, offer.current_version_id, adv.orgId, "a2", "hash-a").run();
    await insert.bind(crypto.randomUUID(), b.orgId, b.profileId, lb.id, offer.id, offer.current_version_id, adv.orgId, "b1", "hash-b").run();

    const aClicks = await json<PageOf<{ tracking_link_id: string; subs: { sub1: string | null } }>>(
      await h.as(a.owner, "GET", `${links(a.orgId)}/${la.id}/clicks`),
    );
    expect(aClicks.items).toHaveLength(2);
    expect(aClicks.items.every((c) => c.tracking_link_id === la.id)).toBe(true);
    // Internal hashes are never projected.
    expect(JSON.stringify(aClicks)).not.toContain("hash-a");
    expect(JSON.stringify(aClicks)).not.toContain("ip_hash");

    const advClicks = await json<PageOf<{ subs: { sub1: string | null } }>>(
      await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/offers/${offer.id}/clicks?limit=2`),
    );
    expect(advClicks.items).toHaveLength(2);
    expect(advClicks.next_cursor).not.toBeNull();
    const rest = await json<PageOf<{ subs: { sub1: string | null } }>>(
      await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/offers/${offer.id}/clicks?cursor=${encodeURIComponent(advClicks.next_cursor!)}`),
    );
    expect(rest.items).toHaveLength(1);
    expect([...advClicks.items, ...rest.items].map((c) => c.subs.sub1).sort()).toEqual(["a1", "a2", "b1"]);

    // Another advertiser cannot read clicks on this offer.
    const other = await advertiser("other@ads.example", "Other Ads");
    expect((await h.as(other.owner, "GET", `/organizations/${other.orgId}/offers/${offer.id}/clicks`)).status).toBe(404);
  });
});
