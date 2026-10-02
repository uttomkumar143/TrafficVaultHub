/**
 * Billing HTTP face — Phase 5 Unit 14 (routes/billing.ts) through the real app.
 *
 *  - tenant face: profile + alerts, billing.read RBAC (ADVERTISER_OWNER /
 *    BILLING_MANAGER yes, VIEWER no), tenant isolation (another advertiser's
 *    profile / alerts never visible), 404 without a profile
 *  - no raw balance / profile edit route: PUT/PATCH/POST/DELETE on /profile
 *    and /alerts → 404, profile row byte-identical
 *  - platform face: non-PLATFORM 403, ANALYST (billing.read, no manage) 403
 *    on evaluate, FINANCE_MANAGER (billing.manage but NO offers.pause) 403,
 *    OPERATIONS_ADMIN (billing.manage + offers.pause) evaluates;
 *    malformed advertiser id 404; money validation 400 matrix
 *  - insufficient capacity pauses LIVE offers ONLY through the real service
 *    (asserted via GET offers), alerts land only on the evaluated tenant and
 *    are visible only to that tenant; repeat run is idempotent
 *  - cross-currency: an EUR offer is never mixed into a USD requirement
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

const V_USD = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click",
};
const V_EUR = { ...V_USD, currency: "eur", advertiser_payout_minor: 900_000, affiliate_commission_minor: 800_000, network_margin_minor: 100_000 };

interface Advertiser {
  token: string;
  orgId: string;
  profileId: string;
}
interface Platform {
  token: string;
  orgId: string;
}

let seq = 0;
async function advertiser(name = "Acme"): Promise<Advertiser> {
  seq += 1;
  const email = `adv${seq}@${name.toLowerCase()}.example`;
  const token = await h.user(email);
  const orgId = await h.org(token, "ADVERTISER", `${name} ${seq}`);
  expect((await h.as(token, "POST", `/organizations/${orgId}/advertiser`, { company_name: `${name} ${seq}` })).status).toBe(201);
  const prof = await h.db.prepare(`SELECT id FROM advertiser_profiles WHERE organization_id = ?`).bind(orgId).first<{ id: string }>();
  if (!prof) throw new Error("fixture: advertiser profile missing");
  return { token, orgId, profileId: prof.id };
}

async function platform(role: "SUPER_ADMIN" | "OPERATIONS_ADMIN" | "FINANCE_MANAGER" | "ANALYST" = "SUPER_ADMIN"): Promise<Platform> {
  const email = `${role.toLowerCase()}@network.example`;
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, role);
  return { token, orgId };
}

async function member(ownerToken: string, orgId: string, email: string, role: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, role);
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

/** Insert a 0011 billing profile directly (there is no write API: known gap). */
async function billingProfile(adv: Advertiser, p: { funding_model?: string; currency?: string; credit_limit_minor?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const limit = p.credit_limit_minor ?? 0;
  await h.db
    .prepare(
      `INSERT INTO advertiser_billing_profiles
         (id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor, available_credit_minor, payment_terms_days)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
    )
    .bind(id, adv.orgId, adv.profileId, p.funding_model ?? "CREDIT", p.currency ?? "USD", limit, limit)
    .run();
  return id;
}

/** Create → submit → platform review → LIVE through the real HTTP state machine. */
async function liveOffer(adv: Advertiser, plat: Platform, version: Record<string, unknown> = V_USD, name = "Live"): Promise<string> {
  const created = await json<{ offer: { id: string } }>(
    await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers`, { name, access_mode: "PUBLIC", version }),
  );
  const id = created.offer.id;
  expect((await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  expect((await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers/${id}/transition`, { to: "LIVE" })).status).toBe(200);
  return id;
}

async function offerStatus(adv: Advertiser, offerId: string): Promise<string> {
  const res = await h.as(adv.token, "GET", `/organizations/${adv.orgId}/offers/${offerId}`);
  expect(res.status).toBe(200);
  return (await json<{ offer: { status: string } }>(res)).offer.status;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const r = await h.db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

const B = (orgId: string, path: string) => `/organizations/${orgId}/billing${path}`;
const P = (plat: Platform, advOrgId: string, path: string) => `/organizations/${plat.orgId}/platform/billing/advertisers/${advOrgId}${path}`;

describe("billing HTTP — tenant face", () => {
  it("profile + alerts: billing.read RBAC, 404 without profile, tenant isolation", async () => {
    const a = await advertiser();
    const b = await advertiser("Beta");

    // No profile yet → 404 (not a 500, not an empty object).
    expect((await h.as(a.token, "GET", B(a.orgId, "/profile"))).status).toBe(404);

    const profileId = await billingProfile(a, { credit_limit_minor: 10_000 });
    const res = await h.as(a.token, "GET", B(a.orgId, "/profile"));
    expect(res.status).toBe(200);
    const { profile } = await json<{ profile: { id: string; organization_id: string; currency: string; credit_limit_minor: number } }>(res);
    expect(profile.id).toBe(profileId);
    expect(profile.organization_id).toBe(a.orgId);
    expect(profile.currency).toBe("USD");
    expect(profile.credit_limit_minor).toBe(10_000);
    expect(Number.isInteger(profile.credit_limit_minor)).toBe(true);

    expect(await json<{ items: unknown[] }>(await h.as(a.token, "GET", B(a.orgId, "/alerts")))).toEqual({ items: [] });

    // RBAC inside the advertiser org: BILLING_MANAGER reads, VIEWER is refused.
    const billingMgr = await member(a.token, a.orgId, "bm@acme.example", "BILLING_MANAGER");
    const viewer = await member(a.token, a.orgId, "viewer@acme.example", "VIEWER");
    expect((await h.as(billingMgr, "GET", B(a.orgId, "/profile"))).status).toBe(200);
    expect((await h.as(billingMgr, "GET", B(a.orgId, "/alerts"))).status).toBe(200);
    const v1 = await h.as(viewer, "GET", B(a.orgId, "/profile"));
    expect(v1.status).toBe(403);
    expect(await h.errorCode(v1)).toBe("FORBIDDEN");
    expect((await h.as(viewer, "GET", B(a.orgId, "/alerts"))).status).toBe(403);

    // Tenant isolation: B's owner is not a member of A → 404 (no oracle), and B has no profile of its own.
    expect((await h.as(b.token, "GET", B(a.orgId, "/profile"))).status).toBe(404);
    expect((await h.as(b.token, "GET", B(a.orgId, "/alerts"))).status).toBe(404);
    expect((await h.as(b.token, "GET", B(b.orgId, "/profile"))).status).toBe(404);
  });

  it("no raw balance / profile edit route exists (PUT/PATCH/POST/DELETE → 404, row unchanged)", async () => {
    const a = await advertiser();
    await billingProfile(a, { credit_limit_minor: 10_000 });
    const before = await h.db.prepare(`SELECT * FROM advertiser_billing_profiles WHERE organization_id = ?`).bind(a.orgId).first();

    for (const method of ["PUT", "PATCH", "POST", "DELETE"]) {
      for (const path of ["/profile", "/alerts", "/profile/balance"]) {
        const res = await h.as(a.token, method, B(a.orgId, path), { credit_limit_minor: 999_999_999, currency: "USD" });
        expect([404, 405], `${method} ${path}`).toContain(res.status);
      }
    }
    const after = await h.db.prepare(`SELECT * FROM advertiser_billing_profiles WHERE organization_id = ?`).bind(a.orgId).first();
    expect(after).toEqual(before);
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts`)).toBe(0);
  });
});

describe("billing HTTP — platform face", () => {
  it("non-PLATFORM 403, billing.read-only 403 on evaluate, malformed id 404, money validation 400", async () => {
    const a = await advertiser();
    const b = await advertiser("Beta");
    await billingProfile(a, { credit_limit_minor: 10_000 });
    const fin = await platform("OPERATIONS_ADMIN");
    const analyst = await platform("ANALYST");
    const finance = await platform("FINANCE_MANAGER");

    // An advertiser org is never a platform face, even against itself.
    const own = await h.as(b.token, "POST", `/organizations/${b.orgId}/platform/billing/advertisers/${a.orgId}/evaluate`, {});
    expect(own.status).toBe(403);
    expect((await h.as(b.token, "GET", `/organizations/${b.orgId}/platform/billing/advertisers/${a.orgId}/profile`)).status).toBe(403);
    // ... and cannot read another advertiser's profile through the tenant face either.
    expect((await h.as(b.token, "GET", B(a.orgId, "/profile"))).status).toBe(404);

    // ANALYST holds billing.read (profile OK) but not billing.manage (evaluate 403 before any write).
    expect((await h.as(analyst.token, "GET", P(analyst, a.orgId, "/profile"))).status).toBe(200);
    const an = await h.as(analyst.token, "POST", P(analyst, a.orgId, "/evaluate"), {});
    expect(an.status).toBe(403);
    expect(await h.errorCode(an)).toBe("FORBIDDEN");
    // FINANCE_MANAGER holds billing.manage but not offers.pause: the service refuses (evaluate really pauses offers).
    const fm = await h.as(finance.token, "POST", P(finance, a.orgId, "/evaluate"), {});
    expect(fm.status).toBe(403);
    expect(await h.errorCode(fm)).toBe("FORBIDDEN");
    expect((await h.as(finance.token, "GET", P(finance, a.orgId, "/profile"))).status).toBe(200);

    // Malformed / unknown advertiser ids → 404.
    expect((await h.as(fin.token, "POST", P(fin, "not-a-uuid", "/evaluate"), {})).status).toBe(404);
    expect((await h.as(fin.token, "POST", P(fin, RANDOM_ID, "/evaluate"), {})).status).toBe(404);
    expect((await h.as(fin.token, "GET", P(fin, "../../x", "/profile"))).status).toBe(404);
    expect((await h.as(fin.token, "GET", P(fin, b.orgId, "/profile"))).status).toBe(404); // no profile

    // Money: integer minor units only.
    for (const body of [
      { required_minor: 10.5 },
      { required_minor: -1 },
      { required_minor: "100" },
      { required_minor: Number.MAX_SAFE_INTEGER + 2 },
      { required_minor: 100, currency: "EUR" }, // currency is the profile's; never a body field
      { amount_minor: 100 },
    ]) {
      const res = await h.as(fin.token, "POST", P(fin, a.orgId, "/evaluate"), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
    }
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_billing_profiles WHERE funding_protection_active = 1`)).toBe(0);
  });

  it("insufficient capacity pauses LIVE offers through the real service; alerts only for that tenant; idempotent repeat", async () => {
    const plat = await platform("SUPER_ADMIN");
    const fin = await platform("OPERATIONS_ADMIN");
    const a = await advertiser();
    const b = await advertiser("Beta");
    await billingProfile(a, { credit_limit_minor: 1_000 }); // < 5000 required by the USD offer
    await billingProfile(b, { credit_limit_minor: 1_000 });
    const offerA = await liveOffer(a, plat);
    const offerB = await liveOffer(b, plat);
    expect(await offerStatus(a, offerA)).toBe("LIVE");

    const res = await h.as(fin.token, "POST", P(fin, a.orgId, "/evaluate"), {});
    expect(res.status).toBe(200);
    const { evaluation } = await json<{
      evaluation: { organization_id: string; protection_activated: boolean; paused_offer_ids: string[]; alerts_written: number; ignored_other_currency_offer_ids: string[] };
    }>(res);
    expect(evaluation.organization_id).toBe(a.orgId);
    expect(evaluation.protection_activated).toBe(true);
    expect(evaluation.paused_offer_ids).toEqual([offerA]);
    expect(evaluation.ignored_other_currency_offer_ids).toEqual([]);
    expect(evaluation.alerts_written).toBe(2);

    // Paused through the real OfferService (visible on the offer API), B untouched.
    expect(await offerStatus(a, offerA)).toBe("PAUSED");
    expect(await offerStatus(b, offerB)).toBe("LIVE");

    // Alerts: ABOUT A (both audiences), visible to A only; B sees none.
    const alertsA = await json<{ items: Array<{ organization_id: string; audience: string }> }>(await h.as(a.token, "GET", B(a.orgId, "/alerts")));
    expect(alertsA.items).toHaveLength(2);
    expect(alertsA.items.map((x) => x.audience).sort()).toEqual(["ADVERTISER", "OPERATIONS"]);
    expect(alertsA.items.every((x) => x.organization_id === a.orgId)).toBe(true);
    expect((await json<{ items: unknown[] }>(await h.as(b.token, "GET", B(b.orgId, "/alerts")))).items).toEqual([]);

    const prof = await json<{ profile: { funding_protection_active: number | boolean } }>(await h.as(a.token, "GET", B(a.orgId, "/profile")));
    expect(Boolean(prof.profile.funding_protection_active)).toBe(true);

    // Repeat run: nothing new.
    const again = await json<{ evaluation: { protection_activated: boolean; paused_offer_ids: string[]; alerts_written: number } }>(
      await h.as(fin.token, "POST", P(fin, a.orgId, "/evaluate"), {}),
    );
    expect(again.evaluation.protection_activated).toBe(false);
    expect(again.evaluation.paused_offer_ids).toEqual([]);
    expect(again.evaluation.alerts_written).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts WHERE organization_id = ?`, a.orgId)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts WHERE organization_id = ?`, b.orgId)).toBe(0);
  });

  it("cross-currency is never mixed: EUR offer excluded from a USD requirement; sufficient USD capacity pauses nothing", async () => {
    const plat = await platform("SUPER_ADMIN");
    const fin = await platform("OPERATIONS_ADMIN");
    const a = await advertiser();
    await billingProfile(a, { currency: "USD", credit_limit_minor: 6_000 }); // ≥ 5000 USD; EUR 900000 must NOT count
    const usd = await liveOffer(a, plat, V_USD, "USD offer");
    const eur = await liveOffer(a, plat, V_EUR, "EUR offer");

    const res = await h.as(fin.token, "POST", P(fin, a.orgId, "/evaluate"), {});
    expect(res.status).toBe(200);
    const { evaluation } = await json<{
      evaluation: { protection_activated: boolean; paused_offer_ids: string[]; ignored_other_currency_offer_ids: string[]; alerts_written: number };
    }>(res);
    expect(evaluation.protection_activated).toBe(false);
    expect(evaluation.paused_offer_ids).toEqual([]);
    expect(evaluation.ignored_other_currency_offer_ids).toEqual([eur]);
    expect(evaluation.alerts_written).toBe(0);
    expect(await offerStatus(a, usd)).toBe("LIVE");
    expect(await offerStatus(a, eur)).toBe("LIVE");

    // Explicit override above capacity (same currency) → pause both LIVE offers, EUR still reported as ignored.
    const over = await json<{ evaluation: { protection_activated: boolean; paused_offer_ids: string[]; ignored_other_currency_offer_ids: string[] } }>(
      await h.as(fin.token, "POST", P(fin, a.orgId, "/evaluate"), { required_minor: 7_000 }),
    );
    expect(over.evaluation.protection_activated).toBe(true);
    expect([...over.evaluation.paused_offer_ids].sort()).toEqual([usd, eur].sort());
    expect(over.evaluation.ignored_other_currency_offer_ids).toEqual([eur]);
    expect(await offerStatus(a, usd)).toBe("PAUSED");
    expect(await offerStatus(a, eur)).toBe("PAUSED");
  });
});
