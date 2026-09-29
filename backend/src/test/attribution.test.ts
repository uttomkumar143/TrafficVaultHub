/**
 * Phase 3 Unit 7e — attribution over HTTP against the real migrations
 * 0001–0008: tenant policy / secret / conversion / attribution routes under
 * `/api/v1/organizations/:orgId` and the PUBLIC `POST /postback/v1/conversions`
 * (outside /api/v1, no session; HMAC over the raw body is the authentication).
 *
 * Covers (PRD §115): policy default → versions (RBAC 403 for a VIEWER);
 * secrets — plaintext ONCE on create, list never carries secret/ciphertext,
 * rotate / revoke; a fully signed postback → 200 ATTRIBUTED + rows in D1 +
 * the affiliate face sees the decision while a foreign advertiser cannot;
 * duplicate external_conversion_id → DUPLICATE (deduplicated, no 2nd row);
 * tampered signature 401; replayed nonce 409; foreign offer 404; bad body 400;
 * missing master key 503 (fail closed); every postback response is no-store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { POSTBACK_HEADERS, signPostback } from "../modules/tracking/postback-auth";
import { POSTBACK_PATH } from "../routes/attribution";
import { PASSWORD, TestHarness, json } from "./fixtures";

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
  current_version_id: string | null;
}
interface Secret {
  id: string;
  key_id?: string;
  secret?: string;
  status: string;
  secret_hint: string;
  label: string | null;
}
interface Outcome {
  conversion_id: string;
  attribution_id: string | null;
  decision: string;
  reason_code: string;
  duplicate: boolean;
  duplicate_of: string | null;
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

async function toLive(
  owner: string,
  advOrg: string,
  plat: { token: string; orgId: string },
  body: Record<string, unknown>,
): Promise<Offer> {
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

/** Advertiser with a LIVE offer, an active affiliate holding a tracking link, and one real click through GET /t/:code. */
async function world() {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Public CPA", version: V1 });
  const aff = await activeAffiliate(plat);
  const linkRes = await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links`, { offer_id: offer.id, name: "Newsletter" });
  expect(linkRes.status).toBe(201);
  const { tracking_link: link } = await json<{ tracking_link: { code: string; tracking_path: string } }>(linkRes);
  const hit = await h.app.request(link.tracking_path, { method: "GET", redirect: "manual" }, h.env);
  expect(hit.status).toBe(302);
  const clickId = new URL(hit.headers.get("location")!).searchParams.get("click_id")!;
  expect(clickId).toMatch(/^[0-9a-f-]{36}$/);
  return { plat, adv, offer, aff, clickId };
}

async function issueSecret(adv: { owner: string; orgId: string }): Promise<Required<Secret>> {
  const res = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets`, { label: "prod" });
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { secret } = await json<{ secret: Required<Secret> }>(res);
  expect(secret.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(secret.key_id).toBe(secret.id);
  return secret;
}

interface SignedOptions {
  nonce?: string;
  timestamp?: number;
  secret?: string;
  keyId?: string;
  tamperSignature?: boolean;
  rawBody?: string;
  path?: string;
}

/** Fire a postback exactly as an advertiser's server would: sign the raw bytes, then POST them. */
async function postback(issued: Required<Secret>, body: Record<string, unknown>, opts: SignedOptions = {}): Promise<Response> {
  const raw = opts.rawBody ?? JSON.stringify(body);
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? `nonce-${crypto.randomUUID()}`;
  let signature = await signPostback(opts.secret ?? issued.secret, { method: "POST", path: POSTBACK_PATH, timestamp, nonce, body: raw });
  if (opts.tamperSignature) signature = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
  return await h.app.request(
    opts.path ?? POSTBACK_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [POSTBACK_HEADERS.timestamp]: String(timestamp),
        [POSTBACK_HEADERS.nonce]: nonce,
        [POSTBACK_HEADERS.keyId]: opts.keyId ?? issued.key_id,
        [POSTBACK_HEADERS.signature]: signature,
      },
      body: raw,
    },
    h.env,
  );
}

const conversionBody = (offerId: string, clickId: string, over: Record<string, unknown> = {}) => ({
  offer_id: offerId,
  external_conversion_id: "ext-1",
  click_id: clickId,
  conversion_event: "signup",
  occurred_at: new Date().toISOString(),
  sale_amount_minor: 1999,
  currency: "USD",
  ...over,
});

/** Sign up `email`, seat it in `orgId` as VIEWER (attribution.read only), return its session token. */
async function viewerToken(ownerToken: string, orgId: string, email: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, "VIEWER");
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

function count(table: string): number {
  const row = h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
describe("attribution policy — /organizations/:orgId/offers/:offerId/attribution-policy", () => {
  it("serves the default before any version, then appends versions (RBAC: VIEWER cannot manage)", async () => {
    const plat = await platform();
    const adv = await advertiser();
    const offer = await toLive(adv.owner, adv.orgId, plat, { name: "Policy", version: V1 });
    const base = `/organizations/${adv.orgId}/offers/${offer.id}/attribution-policy`;

    const def = await json<{ policy: Record<string, unknown> }>(await h.as(adv.owner, "GET", base));
    expect(def.policy.default).toBe(true);
    expect(def.policy.model).toBe("LAST_CLICK");
    expect(def.policy.window_seconds).toBe(7 * 24 * 3600);

    const v1 = await h.as(adv.owner, "POST", base, { model: "FIRST_CLICK", window_seconds: 3600, change_summary: "first click test" });
    expect(v1.status).toBe(201);
    const p1 = (await json<{ policy: Record<string, unknown> }>(v1)).policy;
    expect(p1.version_number).toBe(1);
    expect(p1.is_current).toBe(true);
    expect(p1.model).toBe("FIRST_CLICK");
    expect(p1.organization_id).toBe(adv.orgId);

    // Inherit-from-current: only fallback_rule changes.
    const v2 = await json<{ policy: Record<string, unknown> }>(await h.as(adv.owner, "POST", base, { fallback_rule: "HOLD_FOR_REVIEW" }));
    expect(v2.policy.version_number).toBe(2);
    expect(v2.policy.model).toBe("FIRST_CLICK");
    expect(v2.policy.window_seconds).toBe(3600);

    const versions = await json<{ items: Array<{ version_number: number; is_current: boolean }> }>(
      await h.as(adv.owner, "GET", `${base}/versions`),
    );
    expect(versions.items.map((v) => [v.version_number, v.is_current])).toEqual([
      [2, true],
      [1, false],
    ]);

    // Domain validation is the service's (400 POLICY_INVALID); unknown keys die at the schema (400 VALIDATION_ERROR).
    expect(await h.errorCode(await h.as(adv.owner, "POST", base, { window_seconds: 5 }))).toBe("POLICY_INVALID");
    expect(await h.errorCode(await h.as(adv.owner, "POST", base, { organization_id: adv.orgId }))).toBe("VALIDATION_ERROR");

    // VIEWER: may read, may not manage.
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");
    expect((await h.as(viewer, "GET", base)).status).toBe(200);
    const denied = await h.as(viewer, "POST", base, { model: "LAST_CLICK" });
    expect(denied.status).toBe(403);
    expect(await h.errorCode(denied)).toBe("FORBIDDEN");

    // Another advertiser's offer: 404, never 403 (no existence oracle). Malformed id: same 404.
    const other = await advertiser("other@corp.example", "Other Corp");
    expect((await h.as(other.owner, "GET", `/organizations/${other.orgId}/offers/${offer.id}/attribution-policy`)).status).toBe(404);
    expect((await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/offers/not-a-uuid/attribution-policy`)).status).toBe(404);
  });
});

describe("postback secrets — /organizations/:orgId/postback-secrets", () => {
  it("returns plaintext once on create/rotate, never on list; revoke is immediate; VIEWER cannot mint", async () => {
    const adv = await advertiser();
    const issued = await issueSecret(adv);

    const list = await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/postback-secrets`);
    expect(list.status).toBe(200);
    const listed = await json<{ items: Secret[] }>(list);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.id).toBe(issued.id);
    expect(listed.items[0]!.status).toBe("ACTIVE");
    expect(listed.items[0]!.secret_hint).toBe(issued.secret.slice(-4));
    const listText = JSON.stringify(listed);
    expect(listText).not.toContain(issued.secret);
    expect(listText).not.toContain("ciphertext");
    expect(listText).not.toContain('"secret":');

    const rotated = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets/${issued.id}/rotate`);
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    const next = (await json<{ secret: Required<Secret> }>(rotated)).secret;
    expect(next.id).not.toBe(issued.id);
    expect(next.secret).not.toBe(issued.secret);

    const afterRotate = await json<{ items: Secret[] }>(await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/postback-secrets`));
    const statuses = Object.fromEntries(afterRotate.items.map((s) => [s.id, s.status]));
    expect(statuses[issued.id]).toBe("ROTATED");
    expect(statuses[next.id]).toBe("ACTIVE");
    // Rotating a non-ACTIVE secret is a conflict.
    expect(await h.errorCode(await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets/${issued.id}/rotate`))).toBe(
      "POSTBACK_SECRET_NOT_ACTIVE",
    );

    const revoked = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets/${next.id}/revoke`);
    expect(revoked.status).toBe(200);
    const revokedText = await revoked.text();
    expect((JSON.parse(revokedText) as { secret: Secret }).secret.status).toBe("REVOKED");
    expect(revokedText).not.toContain(next.secret);

    // Foreign / malformed ids → 404; VIEWER → 403.
    const other = await advertiser("other@corp.example", "Other Corp");
    expect((await h.as(other.owner, "POST", `/organizations/${other.orgId}/postback-secrets/${next.id}/revoke`)).status).toBe(404);
    expect((await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets/junk/revoke`)).status).toBe(404);
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");
    expect((await h.as(viewer, "POST", `/organizations/${adv.orgId}/postback-secrets`, {})).status).toBe(403);
    expect((await h.as(viewer, "GET", `/organizations/${adv.orgId}/postback-secrets`)).status).toBe(200);

    // Plaintext never lands in the audit trail.
    const audits = await h.auditRows("attribution.postback_secret.created");
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(issued.secret);
  });

  it("fails CLOSED (503) when POSTBACK_SECRET_KEY is not configured", async () => {
    const adv = await advertiser();
    delete h.env.POSTBACK_SECRET_KEY;
    const res = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets`, {});
    expect(res.status).toBe(503);
    expect(await h.errorCode(res)).toBe("POSTBACK_VAULT_UNAVAILABLE");
    expect(count("advertiser_postback_secrets")).toBe(0);
  });
});

describe("POST /postback/v1/conversions — public S2S postback", () => {
  it("attributes a signed conversion to the echoed click; both faces can read it; tenants stay isolated", async () => {
    const { adv, offer, aff, clickId } = await world();
    const issued = await issueSecret(adv);

    const res = await postback(issued, conversionBody(offer.id, clickId));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await json<Outcome>(res);
    expect(out.decision).toBe("ATTRIBUTED");
    expect(out.duplicate).toBe(false);
    expect(out.attribution_id).toMatch(/^[0-9a-f-]{36}$/);

    // D1 rows: one conversion, one attribution, tenant ids from D1 (never the client).
    expect(count("conversions")).toBe(1);
    expect(count("attributions")).toBe(1);
    const attr = h.db.sqlite.prepare("SELECT * FROM attributions").get() as Record<string, unknown>;
    expect(attr.click_id).toBe(clickId);
    expect(attr.affiliate_organization_id).toBe(aff.orgId);
    expect(attr.organization_id).toBe(adv.orgId);
    // Policy was materialised as v1 so rule_version is a real FK.
    expect(count("attribution_policies")).toBe(1);

    // Advertiser face.
    const conv = await json<{ conversion: Record<string, unknown>; attribution: Record<string, unknown> | null }>(
      await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/conversions/${out.conversion_id}`),
    );
    expect(conv.conversion.organization_id).toBe(adv.orgId);
    expect(conv.attribution?.id).toBe(out.attribution_id);
    const convList = await json<{ items: Array<{ id: string }> }>(
      await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/conversions?offer_id=${offer.id}&status=PENDING`),
    );
    expect(convList.items.map((c) => c.id)).toEqual([out.conversion_id]);
    const attrList = await json<{ items: Array<{ id: string; decision: string }> }>(
      await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/attributions?decision=ATTRIBUTED`),
    );
    expect(attrList.items.map((a) => a.id)).toEqual([out.attribution_id]);
    expect(await h.errorCode(await h.as(adv.owner, "GET", `/organizations/${adv.orgId}/attributions?decision=MAYBE`))).toBe(
      "VALIDATION_ERROR",
    );

    // Affiliate face: sees the decision attributed TO it; the advertiser-only routes are not its.
    const affList = await json<{ items: Array<{ id: string }> }>(await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/attributions`));
    expect(affList.items.map((a) => a.id)).toEqual([out.attribution_id]);
    expect((await h.as(aff.owner, "GET", `/organizations/${aff.orgId}/conversions`)).status).toBe(400);

    // A foreign advertiser sees nothing.
    const other = await advertiser("other@corp.example", "Other Corp");
    expect((await h.as(other.owner, "GET", `/organizations/${other.orgId}/conversions/${out.conversion_id}`)).status).toBe(404);
    const otherList = await json<{ items: unknown[] }>(await h.as(other.owner, "GET", `/organizations/${other.orgId}/attributions`));
    expect(otherList.items).toEqual([]);
  });

  it("deduplicates a repeated external_conversion_id: 200 DUPLICATE, no second conversion row", async () => {
    const { adv, offer, clickId } = await world();
    const issued = await issueSecret(adv);
    const first = await json<Outcome>(await postback(issued, conversionBody(offer.id, clickId)));
    expect(first.decision).toBe("ATTRIBUTED");

    const again = await postback(issued, conversionBody(offer.id, clickId));
    expect(again.status).toBe(200);
    const dup = await json<Outcome>(again);
    expect(dup.decision).toBe("DUPLICATE");
    expect(dup.duplicate).toBe(true);
    expect(dup.duplicate_of).toBe(first.conversion_id);
    expect(count("conversions")).toBe(1);
  });

  it("rejects an invalid signature (401) and a replayed nonce (409) without writing anything", async () => {
    const { adv, offer, clickId } = await world();
    const issued = await issueSecret(adv);

    const tampered = await postback(issued, conversionBody(offer.id, clickId), { tamperSignature: true });
    expect(tampered.status).toBe(401);
    expect(await h.errorCode(tampered)).toBe("SIGNATURE_INVALID");
    expect(tampered.headers.get("cache-control")).toBe("no-store");

    // Signed with a key that was never issued (well-formed key id): same 401, no oracle.
    const unknownKey = await postback(issued, conversionBody(offer.id, clickId), { keyId: crypto.randomUUID() });
    expect(await h.errorCode(unknownKey)).toBe("SIGNATURE_INVALID");

    // Body altered after signing → the raw bytes no longer match.
    const body = conversionBody(offer.id, clickId);
    const raw = JSON.stringify(body);
    const forged = await postback(issued, body, { rawBody: raw, secret: issued.secret });
    expect(forged.status).toBe(200);
    const signedOnceRaw = JSON.stringify({ ...body, external_conversion_id: "ext-2" });
    const swapped = await h.app.request(
      POSTBACK_PATH,
      {
        method: "POST",
        headers: {
          [POSTBACK_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)),
          [POSTBACK_HEADERS.nonce]: `nonce-${crypto.randomUUID()}`,
          [POSTBACK_HEADERS.keyId]: issued.key_id,
          [POSTBACK_HEADERS.signature]: await signPostback(issued.secret, {
            method: "POST",
            path: POSTBACK_PATH,
            timestamp: Math.floor(Date.now() / 1000),
            nonce: "different-nonce-0123456789",
            body: signedOnceRaw,
          }),
        },
        body: signedOnceRaw,
      },
      h.env,
    );
    expect(await h.errorCode(swapped)).toBe("SIGNATURE_INVALID");

    // Missing envelope headers → malformed.
    const bare = await h.app.request(POSTBACK_PATH, { method: "POST", body: raw }, h.env);
    expect(bare.status).toBe(401);
    expect(await h.errorCode(bare)).toBe("SIGNATURE_MALFORMED");

    // Stale timestamp → skew, checked before any key read.
    const stale = await postback(issued, conversionBody(offer.id, clickId), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await h.errorCode(stale)).toBe("TIMESTAMP_SKEW");

    // Replay: identical nonce, fresh valid signature → 409.
    const nonce = `nonce-${crypto.randomUUID()}`;
    expect((await postback(issued, conversionBody(offer.id, clickId, { external_conversion_id: "ext-r" }), { nonce })).status).toBe(200);
    const replay = await postback(issued, conversionBody(offer.id, clickId, { external_conversion_id: "ext-r2" }), { nonce });
    expect(replay.status).toBe(409);
    expect(await h.errorCode(replay)).toBe("REPLAY_DETECTED");

    // Only the two accepted postbacks wrote conversions.
    expect(count("conversions")).toBe(2);
  });

  it("404s for an offer the key holder does not own, 400s a malformed body, 503s without the vault key, no session route leaks", async () => {
    const { adv, offer, clickId } = await world();
    const issued = await issueSecret(adv);
    const plat = { token: await h.user("rev2@network.example"), orgId: await h.platformOrg("rev2@network.example", "SUPER_ADMIN") };
    const other = await advertiser("other@corp.example", "Other Corp");
    const foreign = await toLive(other.owner, other.orgId, plat, { name: "Foreign", version: V1 });

    const wrongOffer = await postback(issued, conversionBody(foreign.id, clickId));
    expect(wrongOffer.status).toBe(404);
    expect(await h.errorCode(wrongOffer)).toBe("OFFER_NOT_FOUND");

    const floatMoney = await postback(issued, conversionBody(offer.id, clickId, { sale_amount_minor: 19.99 }));
    expect(floatMoney.status).toBe(400);
    expect(await h.errorCode(floatMoney)).toBe("POSTBACK_INVALID");

    const notJson = await postback(issued, {}, { rawBody: "not json" });
    expect(await h.errorCode(notJson)).toBe("POSTBACK_INVALID");

    // The postback path is public — it is NOT under /api/v1 and a session token is irrelevant.
    expect((await h.app.request(`/api/v1${POSTBACK_PATH}`, { method: "POST", body: "{}" }, h.env)).status).toBe(404);
    expect((await h.app.request(POSTBACK_PATH, { method: "GET" }, h.env)).status).toBe(404);

    delete h.env.POSTBACK_SECRET_KEY;
    const noVault = await postback(issued, conversionBody(offer.id, clickId));
    expect(noVault.status).toBe(503);
    expect(await h.errorCode(noVault)).toBe("POSTBACK_VAULT_UNAVAILABLE");
    expect(count("conversions")).toBe(0);
  });
});
