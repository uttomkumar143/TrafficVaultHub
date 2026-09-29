/**
 * Phase 4 Unit 10a — conversion lifecycle over HTTP against the real
 * migrations 0001–0009. The world is built through real routes (advertiser →
 * LIVE offer → active affiliate → tracking link → click → signed postback),
 * so the conversion under test is a genuine PENDING intake row.
 *
 * Covers (PRD §38–§40, §115):
 *   - list/get lifecycle face under /conversions (disjoint from the Phase 3
 *     attribution router mounted on the same prefix), filters validated;
 *   - approve / reject / dispute / reverse through named routes; reason rules
 *     surface as 400s; invalid edges as 409 INVALID_TRANSITION;
 *   - RBAC: VIEWER (conversions.read only) gets 403 on every mutation;
 *   - tenant isolation: a foreign advertiser gets 404 on read AND write, and
 *     nothing is written;
 *   - NO HTTP path reaches LEDGER_POSTED / EARNED / PAYOUT_ELIGIBLE / PAID:
 *     no generic transition route exists (404) and a `to`/`status` field in a
 *     decision body is rejected (400) before the service runs; rows untouched;
 *   - holds: place CONVERSION_HOLD blocks approve (409), release re-enables;
 *     PAYOUT_HOLD needs fraud.manage (403 for an advertiser owner).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { POSTBACK_HEADERS, signPostback } from "../modules/tracking/postback-auth";
import { POSTBACK_PATH } from "../routes/attribution";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));

const V1 = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click?src=tvh",
};

const COMPLETE_AFFILIATE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

interface Offer {
  id: string;
  status: string;
}
interface Conversion {
  id: string;
  lifecycle_status: string;
  commission_amount_minor: number | null;
  commission_currency: string | null;
}
interface Hold {
  id: string;
  hold_type: string;
  status: string;
  reason_code: string;
}
interface Detail {
  conversion: Conversion;
  history: Array<{ from_status: string; to_status: string; actor_type: string; reason_code: string }>;
  reversal: { reason_code: string; amount_minor: number; currency: string } | null;
  active_holds: Hold[];
  payout_blocked: boolean;
}

let h: TestHarness;

beforeEach(() => {
  h = new TestHarness();
  h.env.POSTBACK_SECRET_KEY = MASTER;
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

async function toLive(owner: string, advOrg: string, plat: { token: string; orgId: string }): Promise<Offer> {
  const created = await json<{ offer: Offer }>(await h.as(owner, "POST", `/organizations/${advOrg}/offers`, { name: "Public CPA", version: V1 }));
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}

async function postback(adv: { owner: string; orgId: string }, body: Record<string, unknown>): Promise<Response> {
  const res = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets`, { label: "prod" });
  expect(res.status).toBe(201);
  const { secret } = await json<{ secret: { id: string; secret: string } }>(res);
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${crypto.randomUUID()}`;
  const signature = await signPostback(secret.secret, { method: "POST", path: POSTBACK_PATH, timestamp, nonce, body: raw });
  return await h.app.request(
    POSTBACK_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [POSTBACK_HEADERS.timestamp]: String(timestamp),
        [POSTBACK_HEADERS.nonce]: nonce,
        [POSTBACK_HEADERS.keyId]: secret.id,
        [POSTBACK_HEADERS.signature]: signature,
      },
      body: raw,
    },
    h.env,
  );
}

/** Advertiser with a LIVE offer, an active affiliate, one real click and one PENDING conversion from a signed postback. */
async function world() {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat);
  const aff = await activeAffiliate(plat);
  const linkRes = await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links`, { offer_id: offer.id, name: "Newsletter" });
  expect(linkRes.status).toBe(201);
  const { tracking_link: link } = await json<{ tracking_link: { tracking_path: string } }>(linkRes);
  const hit = await h.app.request(link.tracking_path, { method: "GET", redirect: "manual" }, h.env);
  expect(hit.status).toBe(302);
  const clickId = new URL(hit.headers.get("location")!).searchParams.get("click_id")!;
  const pb = await postback(adv, {
    offer_id: offer.id,
    external_conversion_id: "ext-1",
    click_id: clickId,
    conversion_event: "signup",
    occurred_at: new Date().toISOString(),
    sale_amount_minor: 1999,
    currency: "USD",
  });
  expect(pb.status).toBe(200);
  const out = await json<{ conversion_id: string; decision: string }>(pb);
  expect(out.decision).toBe("ATTRIBUTED");
  return { plat, adv, offer, aff, conversionId: out.conversion_id };
}

/** Sign up `email`, seat it in `orgId` as VIEWER (conversions.read only), return its session token. */
async function viewerToken(ownerToken: string, orgId: string, email: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, "VIEWER");
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

function lifecycleOf(id: string): string {
  const row = h.db.sqlite.prepare("SELECT lifecycle_status FROM conversions WHERE id = ?").get(id) as { lifecycle_status: string };
  return row.lifecycle_status;
}

function count(table: string): number {
  return (h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const base = (orgId: string) => `/organizations/${orgId}/conversions`;

describe("conversion lifecycle routes", () => {
  it("list/get lifecycle face; approve sets commission once; reject/dispute need a reason; invalid edges 409; VIEWER 403", async () => {
    const { adv, offer, conversionId } = await world();
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");

    // Lifecycle list under the shared /conversions prefix — the literal
    // `/lifecycle` segment must not be swallowed by Phase 3's /:conversionId.
    const list = await h.as(adv.owner, "GET", `${base(adv.orgId)}/lifecycle?lifecycle_status=PENDING&offer_id=${offer.id}`);
    expect(list.status).toBe(200);
    const page = await json<{ items: Conversion[]; next_cursor: string | null }>(list);
    expect(page.items.map((c) => c.id)).toEqual([conversionId]);
    expect((await h.as(adv.owner, "GET", `${base(adv.orgId)}/lifecycle?lifecycle_status=NOPE`)).status).toBe(400);
    expect((await h.as(adv.owner, "GET", `${base(adv.orgId)}/lifecycle?offer_id=not-a-uuid`)).status).toBe(400);
    // Phase 3 face still answers on the same prefix.
    expect((await h.as(adv.owner, "GET", `${base(adv.orgId)}/${conversionId}`)).status).toBe(200);

    const before = await json<Detail>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/${conversionId}/lifecycle`));
    expect(before.conversion.lifecycle_status).toBe("PENDING");
    expect(before.history).toEqual([]);
    expect(before.active_holds).toEqual([]);
    expect(before.payout_blocked).toBe(false);
    // VIEWER may read the lifecycle face …
    expect((await h.as(viewer, "GET", `${base(adv.orgId)}/${conversionId}/lifecycle`)).status).toBe(200);
    // … but every mutation is 403 FORBIDDEN and writes nothing.
    for (const op of ["approve", "reject", "dispute", "fraud-review", "reverse"]) {
      const res = await h.as(viewer, "POST", `${base(adv.orgId)}/${conversionId}/${op}`, { reason_code: "X" });
      expect(res.status, op).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);

    // reject requires a reason (400 from the service, before any write)
    const noReason = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reject`, {});
    expect(noReason.status).toBe(400);
    expect(await h.errorCode(noReason)).toBe("REASON_REQUIRED");
    const badReason = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reject`, { reason_code: "lower case" });
    expect(badReason.status).toBe(400);
    expect(await h.errorCode(badReason)).toBe("INVALID_REASON_CODE");
    // unknown body keys are rejected by the route
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, { reason_code: "OK", extra: 1 })).status).toBe(400);
    // dispute from PENDING is not an edge (REJECTED → DISPUTED only)
    const badEdge = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/dispute`, { reason_code: "NOT_YET" });
    expect(badEdge.status).toBe(409);
    expect(await h.errorCode(badEdge)).toBe("INVALID_TRANSITION");
    // FRAUD_REVIEW is PLATFORM/SYSTEM only; the advertiser owner lacks fraud.review → 403 at the route gate
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/fraud-review`, { reason_code: "SUSPICIOUS" })).status).toBe(403);

    // approve (reason optional) → APPROVED, commission from the offer version, one history + one audit row
    const approved = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {});
    expect(approved.status).toBe(200);
    const { conversion } = await json<{ conversion: Conversion }>(approved);
    expect(conversion.lifecycle_status).toBe("APPROVED");
    expect(conversion.commission_amount_minor).toBe(4000);
    expect(conversion.commission_currency).toBe("USD");
    expect(lifecycleOf(conversionId)).toBe("APPROVED");
    expect((await h.auditRows("conversion.approved")).map((r) => r.target_id)).toEqual([conversionId]);

    // second approve → 409, nothing more written
    const again = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {});
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("INVALID_TRANSITION");
    expect(count("conversion_status_history")).toBe(1);

    const detail = await json<Detail>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/${conversionId}/lifecycle`));
    expect(detail.history.map((x) => [x.from_status, x.to_status, x.actor_type])).toEqual([["PENDING", "APPROVED", "TENANT"]]);
  });

  it("reject → dispute chain; reverse keeps the original row and returns the compensating record", async () => {
    const { adv, conversionId } = await world();

    const rejected = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reject`, { reason_code: "DUPLICATE_ORDER", note: "seen before" });
    expect(rejected.status).toBe(200);
    expect((await json<{ conversion: Conversion }>(rejected)).conversion.lifecycle_status).toBe("REJECTED");

    const disputed = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/dispute`, { reason_code: "AFFILIATE_APPEAL" });
    expect(disputed.status).toBe(200);
    expect((await json<{ conversion: Conversion }>(disputed)).conversion.lifecycle_status).toBe("DISPUTED");

    // DISPUTED → APPROVED is PLATFORM only: the advertiser cannot approve its way out
    const tenantApprove = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {});
    expect(tenantApprove.status).toBe(409);
    expect(await h.errorCode(tenantApprove)).toBe("INVALID_TRANSITION");
    // and reversal needs APPROVED
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "REFUND" })).status).toBe(409);

    // Status filter follows lifecycle_status, not the intake snapshot.
    const disputedOnly = await json<{ items: Conversion[] }>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/lifecycle?lifecycle_status=DISPUTED`));
    expect(disputedOnly.items.map((c) => c.id)).toEqual([conversionId]);
    const pendingOnly = await json<{ items: Conversion[] }>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/lifecycle?lifecycle_status=PENDING`));
    expect(pendingOnly.items).toEqual([]);

    expect(lifecycleOf(conversionId)).toBe("DISPUTED");
    expect(count("conversion_status_history")).toBe(2);
    expect((await h.auditRows("conversion.rejected")).length + (await h.auditRows("conversion.disputed")).length).toBe(2);
    expect(count("conversion_reversals")).toBe(0);
  });

  it("reverse an APPROVED conversion: reason must be a reversal code; original row stays, reversal + history + audit written", async () => {
    const { adv, conversionId } = await world();
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {})).status).toBe(200);

    const bad = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "NOT_A_REVERSAL_CODE" });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("INVALID_REASON_CODE");
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "REFUND", amount_minor: -1 })).status).toBe(400);
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "REFUND", amount_minor: 1.5 })).status).toBe(400);
    expect(lifecycleOf(conversionId)).toBe("APPROVED");

    const res = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "REFUND", note: "customer refunded" });
    expect(res.status).toBe(200);
    const detail = await json<Detail>(res);
    expect(detail.conversion.id).toBe(conversionId);
    expect(detail.conversion.lifecycle_status).toBe("REVERSED");
    expect(detail.conversion.commission_amount_minor).toBe(4000); // original amount untouched
    expect(detail.reversal).toMatchObject({ reason_code: "REFUND", amount_minor: 4000, currency: "USD" });
    expect(detail.history.map((x) => x.to_status)).toEqual(["APPROVED", "REVERSED"]);
    expect(count("conversion_reversals")).toBe(1);
    expect((await h.auditRows("conversion.reversed")).map((r) => r.target_id)).toEqual([conversionId]);

    const twice = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/reverse`, { reason_code: "REFUND" });
    expect(twice.status).toBe(409);
    expect(count("conversion_reversals")).toBe(1);
  });

  it("tenant isolation: a foreign advertiser gets 404 on read and every write; malformed ids are 404; nothing is written", async () => {
    const { adv, conversionId } = await world();
    const other = await advertiser("other@rival.example", "Rival Inc");

    expect((await h.as(other.owner, "GET", `${base(other.orgId)}/${conversionId}/lifecycle`)).status).toBe(404);
    for (const op of ["approve", "reject", "dispute", "reverse"]) {
      const res = await h.as(other.owner, "POST", `${base(other.orgId)}/${conversionId}/${op}`, { reason_code: "REFUND" });
      expect(res.status, op).toBe(404);
    }
    // cross-org id in the path: the tenant is `other`, so the lookup is scoped to `other` → 404
    expect((await h.as(other.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {})).status).toBe(404);
    expect((await h.as(adv.owner, "GET", `${base(adv.orgId)}/not-a-uuid/lifecycle`)).status).toBe(404);
    expect((await h.as(adv.owner, "GET", `${base(adv.orgId)}/${RANDOM_ID}/lifecycle`)).status).toBe(404);
    expect((await json<{ items: unknown[] }>(await h.as(other.owner, "GET", `${base(other.orgId)}/lifecycle`))).items).toEqual([]);

    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);
    expect(count("conversion_reversals")).toBe(0);
  });

  it("no HTTP path reaches the internal money pipeline (LEDGER_POSTED / EARNED / PAYOUT_ELIGIBLE / PAID)", async () => {
    const { adv, plat, conversionId } = await world();
    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {})).status).toBe(200);

    const internal = ["LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"];
    for (const to of internal) {
      // No generic transition route exists on either face.
      for (const path of [
        `${base(adv.orgId)}/${conversionId}/transition`,
        `${base(adv.orgId)}/${conversionId}/lifecycle`,
        `${base(adv.orgId)}/${conversionId}/${to.toLowerCase().replace("_", "-")}`,
        `${base(adv.orgId)}/${conversionId}/status`,
        `/organizations/${plat.orgId}/platform/conversions/${conversionId}/transition`,
      ]) {
        const res = await h.as(adv.owner, "POST", path, { to });
        expect(res.status, `${path} → ${to}`).toBe(404);
        const asPlatform = await h.as(plat.token, "POST", path, { to });
        expect(asPlatform.status, `platform ${path} → ${to}`).toBe(404);
      }
      // A decision body smuggling a target state is rejected by the strict schema.
      for (const op of ["approve", "reject", "dispute", "reverse"]) {
        const res = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/${op}`, { reason_code: "REFUND", to });
        expect(res.status, `${op} to=${to}`).toBe(400);
        const res2 = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/${op}`, { reason_code: "REFUND", lifecycle_status: to });
        expect(res2.status, `${op} lifecycle_status=${to}`).toBe(400);
      }
    }
    expect(lifecycleOf(conversionId)).toBe("APPROVED");
    expect(count("conversion_status_history")).toBe(1);
    const statuses = h.db.sqlite.prepare("SELECT DISTINCT to_status FROM conversion_status_history").all() as Array<{ to_status: string }>;
    expect(statuses.map((s) => s.to_status)).toEqual(["APPROVED"]);
  });

  it("holds: CONVERSION_HOLD blocks approval until released; PAYOUT_HOLD needs fraud.manage; release needs the hold-type permission", async () => {
    const { adv, aff, conversionId } = await world();
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");
    const holds = `/organizations/${adv.orgId}/conversion-holds`;

    // VIEWER cannot place holds; scope is required; PAYOUT_HOLD needs fraud.manage (advertiser owner lacks it).
    expect((await h.as(viewer, "POST", holds, { hold_type: "CONVERSION_HOLD", reason_code: "CHECK", conversion_id: conversionId })).status).toBe(403);
    expect((await h.as(adv.owner, "POST", holds, { hold_type: "CONVERSION_HOLD", reason_code: "CHECK" })).status).toBe(400);
    expect((await h.as(adv.owner, "POST", holds, { hold_type: "COMPLIANCE_BLOCK", reason_code: "CHECK", conversion_id: conversionId })).status).toBe(400);
    const payout = await h.as(adv.owner, "POST", holds, { hold_type: "PAYOUT_HOLD", reason_code: "SUSPECT", affiliate_organization_id: aff.orgId });
    expect(payout.status).toBe(403);
    expect(await h.errorCode(payout)).toBe("FORBIDDEN");
    expect(count("conversion_holds")).toBe(0);

    const placed = await h.as(adv.owner, "POST", holds, { hold_type: "CONVERSION_HOLD", reason_code: "MANUAL_CHECK", conversion_id: conversionId });
    expect(placed.status).toBe(201);
    const { hold } = await json<{ hold: Hold }>(placed);
    expect(hold).toMatchObject({ hold_type: "CONVERSION_HOLD", status: "ACTIVE", reason_code: "MANUAL_CHECK" });

    const detail = await json<Detail>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/${conversionId}/lifecycle`));
    expect(detail.active_holds.map((x) => x.id)).toEqual([hold.id]);
    // A CONVERSION_HOLD gates approval, not payout (payout_blocked is PAYOUT_HOLD / COMPLIANCE_BLOCK / open fraud review).
    expect(detail.payout_blocked).toBe(false);

    // approval is blocked by the active hold (409 CONVERSION_ON_HOLD), lifecycle unchanged
    const blocked = await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(await h.errorCode(blocked)).toBe("CONVERSION_ON_HOLD");
    expect(lifecycleOf(conversionId)).toBe("PENDING");

    // release: reason required; VIEWER 403; foreign tenant 404; owner OK
    expect((await h.as(adv.owner, "POST", `${holds}/${hold.id}/release`, {})).status).toBe(400);
    expect((await h.as(viewer, "POST", `${holds}/${hold.id}/release`, { reason_code: "DONE" })).status).toBe(403);
    const other = await advertiser("other@rival.example", "Rival Inc");
    expect((await h.as(other.owner, "POST", `/organizations/${other.orgId}/conversion-holds/${hold.id}/release`, { reason_code: "DONE" })).status).toBe(404);
    expect((await h.as(adv.owner, "POST", `${holds}/not-a-uuid/release`, { reason_code: "DONE" })).status).toBe(404);

    const released = await h.as(adv.owner, "POST", `${holds}/${hold.id}/release`, { reason_code: "CHECK_PASSED" });
    expect(released.status).toBe(200);
    expect((await json<{ hold: Hold }>(released)).hold.status).toBe("RELEASED");
    const twice = await h.as(adv.owner, "POST", `${holds}/${hold.id}/release`, { reason_code: "CHECK_PASSED" });
    expect(twice.status).toBe(409);
    expect(await h.errorCode(twice)).toBe("HOLD_NOT_ACTIVE");

    expect((await h.as(adv.owner, "POST", `${base(adv.orgId)}/${conversionId}/approve`, {})).status).toBe(200);
    const after = await json<Detail>(await h.as(adv.owner, "GET", `${base(adv.orgId)}/${conversionId}/lifecycle`));
    expect(after.conversion.lifecycle_status).toBe("APPROVED");
    expect(after.active_holds).toEqual([]);
    expect(after.payout_blocked).toBe(false);
    expect((await h.auditRows("conversion.hold.released")).map((r) => r.target_id)).toEqual([hold.id]);
  });
});
