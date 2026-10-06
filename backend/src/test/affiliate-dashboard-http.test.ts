/**
 * Affiliate dashboard HTTP tests (Phase 7 Unit 4).
 *
 *   GET /organizations/:orgId/affiliate/dashboard/overview
 *   GET /organizations/:orgId/affiliate/dashboard/offers
 *   GET /organizations/:orgId/affiliate/dashboard/links
 *
 * Covers: tenant isolation (B never sees A), 403 without permission, 404 for a
 * non-affiliate org, cursor pagination, the LEAK TEST (advertiser economics,
 * ip_hash, other affiliates' ids never appear), date-range bounding and
 * per-currency money (never summed across currencies).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, TestHarness, json } from "./fixtures";

interface Offer {
  id: string;
  status: string;
  current_version_id: string | null;
}
interface Link {
  id: string;
  code: string;
}
interface PageOf<T> {
  items: T[];
  next_cursor: string | null;
}
interface Money {
  currency: string;
  total_minor: number;
  count: number;
}
interface Overview {
  range: { from: string; to: string };
  clicks: { total: number };
  conversions: { total: number; by_lifecycle_status: Record<string, number> };
  earnings: (Money & { by_lifecycle_status: Record<string, { total_minor: number; count: number }> })[];
  payouts: { pending: Money[]; approved: Money[]; paid: Money[] };
  epc: { available: boolean };
  conversion_rate: { available: boolean };
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

async function activeAffiliate(plat: { token: string; orgId: string }, email = "aff@traffic.example", name = "Traffic Co") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {})).status).toBeLessThan(300);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(200);
  for (const to of ["APPROVED", "ACTIVE"]) {
    const res = await h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/affiliates/${created.profile.id}/transition`, { to });
    expect(res.status, to).toBe(200);
  }
  return { owner, orgId, profileId: created.profile.id };
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

async function world() {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
  const a = await activeAffiliate(plat, "a@aff.example", "Aff A");
  const b = await activeAffiliate(plat, "b@aff.example", "Aff B");
  return { plat, adv, offer, a, b };
}

const dash = (orgId: string) => `/organizations/${orgId}/affiliate/dashboard`;
const links = (orgId: string) => `/organizations/${orgId}/tracking-links`;

async function createLink(aff: { owner: string; orgId: string }, offerId: string, name?: string): Promise<Link> {
  const res = await h.as(aff.owner, "POST", links(aff.orgId), { offer_id: offerId, ...(name ? { name } : {}) });
  expect(res.status).toBe(201);
  return (await json<{ tracking_link: Link }>(res)).tracking_link;
}

async function seedClick(
  aff: { orgId: string; profileId: string },
  link: Link,
  offer: Offer,
  advOrgId: string,
  clickedAt: string,
  ipHash = "secret-ip-hash",
) {
  await h.db
    .prepare(
      `INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id,
         offer_organization_id, ip_hash, decision_reason_code, destination_url, clicked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OK', 'https://track.example/click', ?)`,
    )
    .bind(crypto.randomUUID(), aff.orgId, aff.profileId, link.id, offer.id, offer.current_version_id, advOrgId, ipHash, clickedAt)
    .run();
}

async function seedConversion(
  advOrgId: string,
  offer: Offer,
  affOrgId: string,
  lifecycle: string,
  occurredAt: string,
  commission: { amount: number; currency: string } | null,
) {
  await h.db
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, affiliate_organization_id,
         external_conversion_id, conversion_event, occurred_at, lifecycle_status, commission_amount_minor, commission_currency)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      advOrgId,
      offer.id,
      offer.current_version_id,
      affOrgId,
      `ext-${crypto.randomUUID()}`,
      occurredAt,
      lifecycle,
      commission?.amount ?? null,
      commission?.currency ?? null,
    )
    .run();
}

async function seedPayout(aff: { orgId: string; profileId: string }, status: string, amount: number, currency: string) {
  const u = await h.db.prepare("SELECT user_id FROM organization_members WHERE organization_id = ? LIMIT 1").bind(aff.orgId).first<{ user_id: string }>();
  // Approver must differ from requester (separation of duties CHECK): use the platform reviewer.
  const approver = await h.db.prepare("SELECT id FROM users WHERE lower(email) = 'rev@network.example'").first<{ id: string }>();
  const pm = `pm-${crypto.randomUUID()}`;
  await h.db
    .prepare(
      `INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at, is_default)
       VALUES (?, ?, ?, 'BANK_TRANSFER', 'stub', ?, 'Bank', ?, 'VERIFIED', '2026-01-01T00:00:00.000Z', 0)`,
    )
    .bind(pm, aff.orgId, aff.profileId, `tok-${pm}`, currency)
    .run();
  const approvedAt = ["APPROVED", "PROCESSING", "PAID"].includes(status) ? "2026-02-01T00:00:00.000Z" : null;
  await h.db
    .prepare(
      `INSERT INTO payouts (id, organization_id, payout_method_id, amount_minor, currency, idempotency_key, requested_by_user_id, requested_actor_type,
         status, approved_at, approved_by_user_id, paid_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'TENANT', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      aff.orgId,
      pm,
      amount,
      currency,
      `idem-${crypto.randomUUID()}`,
      u!.user_id,
      status,
      approvedAt,
      approvedAt ? approver!.id : null,
      status === "PAID" ? "2026-02-02T00:00:00.000Z" : null,
      status === "CANCELLED" ? "2026-02-02T00:00:00.000Z" : null,
    )
    .run();
}

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
describe("affiliate dashboard: overview", () => {
  it("aggregates own clicks, conversions by lifecycle, earnings per currency and payout buckets — never another affiliate's", async () => {
    const { adv, offer, a, b } = await world();
    const la = await createLink(a, offer.id);
    const lb = await createLink(b, offer.id);
    await seedClick(a, la, offer, adv.orgId, daysAgo(1));
    await seedClick(a, la, offer, adv.orgId, daysAgo(2));
    await seedClick(b, lb, offer, adv.orgId, daysAgo(1), "hash-of-b");

    await seedConversion(adv.orgId, offer, a.orgId, "APPROVED", daysAgo(1), { amount: 4000, currency: "USD" });
    await seedConversion(adv.orgId, offer, a.orgId, "APPROVED", daysAgo(1), { amount: 4000, currency: "USD" });
    await seedConversion(adv.orgId, offer, a.orgId, "PAID", daysAgo(3), { amount: 2500, currency: "EUR" });
    await seedConversion(adv.orgId, offer, a.orgId, "PENDING", daysAgo(1), null);
    await seedConversion(adv.orgId, offer, a.orgId, "REJECTED", daysAgo(1), null);
    await seedConversion(adv.orgId, offer, b.orgId, "APPROVED", daysAgo(1), { amount: 9999, currency: "USD" });

    await seedPayout(a, "REQUESTED", 1000, "USD");
    await seedPayout(a, "UNDER_REVIEW", 500, "USD");
    await seedPayout(a, "APPROVED", 700, "EUR");
    await seedPayout(a, "PAID", 300, "USD");
    await seedPayout(a, "CANCELLED", 123456, "USD");
    await seedPayout(b, "REQUESTED", 77777, "USD");

    const res = await h.as(a.owner, "GET", `${dash(a.orgId)}/overview`);
    expect(res.status).toBe(200);
    const { overview } = await json<{ overview: Overview }>(res);

    expect(overview.clicks.total).toBe(2);
    expect(overview.conversions.total).toBe(5);
    expect(overview.conversions.by_lifecycle_status).toEqual({ APPROVED: 2, PAID: 1, PENDING: 1, REJECTED: 1 });

    // Money per currency: USD and EUR are separate entries, never summed together.
    expect(overview.earnings).toEqual([
      { currency: "EUR", total_minor: 2500, count: 1, by_lifecycle_status: { PAID: { total_minor: 2500, count: 1 } } },
      { currency: "USD", total_minor: 8000, count: 2, by_lifecycle_status: { APPROVED: { total_minor: 8000, count: 2 } } },
    ]);
    for (const e of overview.earnings) expect(Number.isInteger(e.total_minor)).toBe(true);

    expect(overview.payouts.pending).toEqual([{ currency: "USD", total_minor: 1500, count: 2 }]);
    expect(overview.payouts.approved).toEqual([{ currency: "EUR", total_minor: 700, count: 1 }]);
    expect(overview.payouts.paid).toEqual([{ currency: "USD", total_minor: 300, count: 1 }]);

    // Not-yet-backed metrics are explicit, never placeholders.
    expect(overview.epc).toEqual({ available: false });
    expect(overview.conversion_rate).toEqual({ available: false });

    // B's numbers never appear in A's view.
    const text = JSON.stringify(overview);
    expect(text).not.toContain("9999");
    expect(text).not.toContain("77777");
    expect(text).not.toContain("123456");
    expect(text).not.toContain(b.orgId);
    expect(text).not.toContain(b.profileId);

    // Tenant isolation the other way: B sees only its own single click/conversion.
    const bo = (await json<{ overview: Overview }>(await h.as(b.owner, "GET", `${dash(b.orgId)}/overview`))).overview;
    expect(bo.clicks.total).toBe(1);
    expect(bo.conversions.total).toBe(1);
    expect(bo.earnings).toEqual([{ currency: "USD", total_minor: 9999, count: 1, by_lifecycle_status: { APPROVED: { total_minor: 9999, count: 1 } } }]);
    expect(bo.payouts.pending).toEqual([{ currency: "USD", total_minor: 77777, count: 1 }]);
  });

  it("bounds aggregates by the date range (default 30 days; explicit from/to; invalid → 400)", async () => {
    const { adv, offer, a } = await world();
    const la = await createLink(a, offer.id);
    await seedClick(a, la, offer, adv.orgId, daysAgo(1));
    await seedClick(a, la, offer, adv.orgId, daysAgo(10));
    await seedClick(a, la, offer, adv.orgId, daysAgo(45)); // outside default window
    await seedConversion(adv.orgId, offer, a.orgId, "APPROVED", daysAgo(1), { amount: 100, currency: "USD" });
    await seedConversion(adv.orgId, offer, a.orgId, "APPROVED", daysAgo(45), { amount: 100, currency: "USD" });

    const dflt = (await json<{ overview: Overview }>(await h.as(a.owner, "GET", `${dash(a.orgId)}/overview`))).overview;
    expect(dflt.clicks.total).toBe(2);
    expect(dflt.conversions.total).toBe(1);
    expect(new Date(dflt.range.to).getTime() - new Date(dflt.range.from).getTime()).toBe(30 * 86_400_000);

    const wide = (
      await json<{ overview: Overview }>(await h.as(a.owner, "GET", `${dash(a.orgId)}/overview?from=${daysAgo(60)}&to=${daysAgo(0)}`))
    ).overview;
    expect(wide.clicks.total).toBe(3);
    expect(wide.conversions.total).toBe(2);
    expect(wide.earnings).toEqual([{ currency: "USD", total_minor: 200, count: 2, by_lifecycle_status: { APPROVED: { total_minor: 200, count: 2 } } }]);

    const narrow = (
      await json<{ overview: Overview }>(await h.as(a.owner, "GET", `${dash(a.orgId)}/overview?from=${daysAgo(5)}&to=${daysAgo(0)}`))
    ).overview;
    expect(narrow.clicks.total).toBe(1);

    for (const q of ["from=not-a-date", `from=${daysAgo(0)}&to=${daysAgo(1)}`, `from=${daysAgo(400)}`]) {
      const bad = await h.as(a.owner, "GET", `${dash(a.orgId)}/overview?${q}`);
      expect(bad.status, q).toBe(400);
      expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
describe("affiliate dashboard: offers & links", () => {
  it("lists available offers with affiliate economics only and paginates by cursor", async () => {
    const { plat, adv, offer, a, b } = await world();
    const priv = await toLive(adv.owner, adv.orgId, plat, { name: "Private", access_mode: "PRIVATE", version: V1 });
    const second = await toLive(adv.owner, adv.orgId, plat, { name: "Second Public", version: { ...V1, currency: "eur", affiliate_commission_minor: 1234 } });
    // Only B is granted the private offer.
    expect(
      (await h.as(adv.owner, "PUT", `/organizations/${adv.orgId}/offers/${priv.id}/access`, { affiliate_organization_id: b.orgId, status: "APPROVED" })).status,
    ).toBeLessThan(300);

    const aAll = await json<PageOf<{ id: string; name: string; economics: Record<string, unknown> | null }>>(
      await h.as(a.owner, "GET", `${dash(a.orgId)}/offers`),
    );
    expect(aAll.items.map((o) => o.id).sort()).toEqual([offer.id, second.id].sort());
    expect(aAll.next_cursor).toBeNull();
    const sec = aAll.items.find((o) => o.id === second.id)!;
    expect(sec.economics).toEqual({ payout_type: "CPA", currency: "EUR", affiliate_commission_minor: 1234, revshare_percent_bps: null, conversion_event: "signup" });

    const bAll = await json<PageOf<{ id: string }>>(await h.as(b.owner, "GET", `${dash(b.orgId)}/offers`));
    expect(bAll.items.map((o) => o.id).sort()).toEqual([offer.id, priv.id, second.id].sort());

    // Cursor pagination.
    const p1 = await json<PageOf<{ id: string }>>(await h.as(b.owner, "GET", `${dash(b.orgId)}/offers?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<PageOf<{ id: string }>>(await h.as(b.owner, "GET", `${dash(b.orgId)}/offers?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect([...p1.items, ...p2.items].map((o) => o.id).sort()).toEqual([offer.id, priv.id, second.id].sort());
    expect((await h.as(b.owner, "GET", `${dash(b.orgId)}/offers?cursor=garbage`)).status).toBe(400);
  });

  it("lists own tracking links with per-link click counts; cursor paginates; other affiliates' links are invisible", async () => {
    const { adv, offer, a, b } = await world();
    const l0 = await createLink(a, offer.id, "L0");
    const l1 = await createLink(a, offer.id, "L1");
    const l2 = await createLink(a, offer.id, "L2");
    const lb = await createLink(b, offer.id, "LB");
    await seedClick(a, l0, offer, adv.orgId, daysAgo(1));
    await seedClick(a, l0, offer, adv.orgId, daysAgo(2));
    await seedClick(a, l2, offer, adv.orgId, daysAgo(1));
    await seedClick(b, lb, offer, adv.orgId, daysAgo(1), "hash-of-b");

    type L = { id: string; name: string | null; code: string; tracking_path: string; click_count: number };
    const all = await json<PageOf<L>>(await h.as(a.owner, "GET", `${dash(a.orgId)}/links`));
    expect(all.items.map((l) => l.id).sort()).toEqual([l0.id, l1.id, l2.id].sort());
    const byId = new Map(all.items.map((l) => [l.id, l]));
    expect(byId.get(l0.id)!.click_count).toBe(2);
    expect(byId.get(l1.id)!.click_count).toBe(0);
    expect(byId.get(l2.id)!.click_count).toBe(1);
    expect(byId.get(l0.id)!.tracking_path).toBe(`/t/${l0.code}`);
    expect(JSON.stringify(all)).not.toContain(lb.id);

    const p1 = await json<PageOf<L>>(await h.as(a.owner, "GET", `${dash(a.orgId)}/links?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await json<PageOf<L>>(await h.as(a.owner, "GET", `${dash(a.orgId)}/links?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`));
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((l) => l.id)).size).toBe(3);

    const bLinks = await json<PageOf<L>>(await h.as(b.owner, "GET", `${dash(b.orgId)}/links`));
    expect(bLinks.items.map((l) => l.id)).toEqual([lb.id]);
    expect(bLinks.items[0]!.click_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("affiliate dashboard: access control & leak test", () => {
  it("LEAK TEST: no endpoint ever emits advertiser economics, ip_hash, or another affiliate's identifiers", async () => {
    const { adv, offer, a, b } = await world();
    const la = await createLink(a, offer.id);
    const lb = await createLink(b, offer.id);
    await seedClick(a, la, offer, adv.orgId, daysAgo(1), "ultra-secret-ip-hash-a");
    await seedClick(b, lb, offer, adv.orgId, daysAgo(1), "ultra-secret-ip-hash-b");
    await seedConversion(adv.orgId, offer, a.orgId, "APPROVED", daysAgo(1), { amount: 4000, currency: "USD" });

    const FORBIDDEN_TOKENS = [
      "advertiser_payout_minor",
      "platform_margin_minor",
      "network_margin_minor",
      "ip_hash",
      "user_agent_hash",
      "ultra-secret-ip-hash",
      "5000", // V1.advertiser_payout_minor
      b.orgId,
      b.profileId,
      lb.id,
      lb.code,
    ];
    for (const path of ["/overview", "/offers", "/links"]) {
      const res = await h.as(a.owner, "GET", `${dash(a.orgId)}${path}`);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const tok of FORBIDDEN_TOKENS) expect(text, `${path} leaks ${tok}`).not.toContain(tok);
      // Positive control: the affiliate-facing commission IS present on offers.
      if (path === "/offers") expect(text).toContain('"affiliate_commission_minor":4000');
    }
  });

  it("403 FORBIDDEN without permission; cross-tenant access is 404; VIEWER can read", async () => {
    const { a, b } = await world();

    // Member of A with no tracking.read / offers.read: use a custom role via the VIEWER baseline minus… simplest:
    // a user who is not a member of A at all is 404 (no enumeration), and B's owner hitting A is also 404.
    for (const path of ["/overview", "/offers", "/links"]) {
      const cross = await h.as(b.owner, "GET", `${dash(a.orgId)}${path}`);
      expect(cross.status, `cross ${path}`).toBe(404);
    }

    // VIEWER holds tracking.read + offers.read → 200 on all three.
    const VIEWER = "viewer@aff.example";
    await h.user(VIEWER);
    await h.addMember(a.owner, a.orgId, VIEWER, "VIEWER");
    const vt = (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email: VIEWER, password: PASSWORD }))).token;
    for (const path of ["/overview", "/offers", "/links"]) {
      expect((await h.as(vt, "GET", `${dash(a.orgId)}${path}`)).status, `viewer ${path}`).toBe(200);
    }

    // Strip the VIEWER's permissions at the DB level → 403 FORBIDDEN from the permission gate.
    await h.db
      .prepare(
        `DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE key = 'VIEWER' AND organization_id IS NULL)
           AND permission_id IN (SELECT id FROM permissions WHERE key IN ('tracking.read','offers.read'))`,
      )
      .run();
    for (const path of ["/overview", "/offers", "/links"]) {
      const res = await h.as(vt, "GET", `${dash(a.orgId)}${path}`);
      expect(res.status, `no-perm ${path}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
  });

  it("a non-affiliate org (advertiser with tracking.read + offers.read) gets 404 NOT_FOUND, not data", async () => {
    const { adv } = await world();
    for (const path of ["/overview", "/offers", "/links"]) {
      const res = await h.as(adv.owner, "GET", `${dash(adv.orgId)}${path}`);
      expect(res.status, path).toBe(404);
      expect(await h.errorCode(res)).toBe("NOT_FOUND");
    }
  });
});
