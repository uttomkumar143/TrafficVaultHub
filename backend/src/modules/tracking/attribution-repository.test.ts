/**
 * Phase 3 Unit 7c — AttributionRepository over the real migrations 0001–0008
 * (D1 shim). Seeds the FK graph directly; no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AttributionRepository, ConversionDuplicateError, type AttributionInsert, type ConversionInsert } from "./attribution-repository";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const OFFER2 = "offer-2";
const VERSION = "ver-1";
const LINK = "link-1";
const T0 = "2026-03-15T12:00:00.000Z";

const tid = (org: string) => org as TenantId;

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap2', '${ADV2}', 'ACTIVE', 'Adv2 Co');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('fp1', '${AFF}', 'ACTIVE', 'Aff');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER2}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer 2');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
    INSERT INTO tracking_links (id, organization_id, affiliate_profile_id, offer_id, offer_organization_id, code)
      VALUES ('${LINK}', '${AFF}', 'fp1', '${OFFER}', '${ADV}', 'abcdefgh');
  `);
}

function click(db: TestD1, id: string, clickedAt: string, offerId = OFFER): void {
  db.sqlite
    .prepare(
      `INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id, offer_organization_id,
         destination_url, clicked_at)
       VALUES (?, ?, 'fp1', ?, ?, ?, ?, 'https://d.example/', ?)`,
    )
    .run(id, AFF, LINK, offerId, VERSION, ADV, clickedAt);
}

const conversion = (over: Partial<ConversionInsert> = {}): ConversionInsert => ({
  id: "conv-1",
  offer_id: OFFER,
  offer_version_id: VERSION,
  click_id: null,
  affiliate_organization_id: null,
  external_conversion_id: "ext-1",
  transaction_id: null,
  event_id: null,
  conversion_event: "signup",
  status: "PENDING",
  source: "S2S_POSTBACK",
  sale_amount_minor: 1999,
  currency: "USD",
  occurred_at: T0,
  request_id: null,
  idempotency_key: null,
  ...over,
});

const attribution = (over: Partial<AttributionInsert> = {}): AttributionInsert => ({
  id: "attr-1",
  conversion_id: "conv-1",
  click_id: null,
  affiliate_organization_id: null,
  offer_id: OFFER,
  rule_version: "pol-1",
  decision: "REJECTED",
  reason_code: "NO_CLICK_IN_WINDOW",
  click_to_conversion_seconds: null,
  request_id: null,
  ...over,
});

let db: TestD1;
let repo: AttributionRepository;

beforeEach(async () => {
  db = createTestD1();
  seed(db);
  repo = new AttributionRepository(db);
  await repo.insertPolicyVersion(
    tid(ADV),
    {
      id: "pol-1",
      offer_id: OFFER,
      model: "LAST_CLICK",
      window_seconds: 86400,
      dedup_scope: "EXTERNAL_CONVERSION_ID",
      fallback_rule: "REJECT",
      require_signature: true,
      change_summary: null,
      created_by_user_id: null,
    },
    [],
  );
});
afterEach(() => db.close());

describe("attribution_policies", () => {
  it("appends versions (version_number + 1) and keeps exactly one is_current per offer", async () => {
    await repo.insertPolicyVersion(
      tid(ADV),
      {
        id: "pol-2",
        offer_id: OFFER,
        model: "FIRST_CLICK",
        window_seconds: 3600,
        dedup_scope: "TRANSACTION_ID",
        fallback_rule: "HOLD_FOR_REVIEW",
        require_signature: false,
        change_summary: "tighter",
        created_by_user_id: null,
      },
      [],
    );
    const versions = await repo.listPolicyVersions(tid(ADV), OFFER);
    expect(versions.map((v) => [v.id, v.version_number, v.is_current])).toEqual([
      ["pol-2", 2, 1],
      ["pol-1", 1, 0],
    ]);
    const current = await repo.findCurrentPolicy(tid(ADV), OFFER);
    expect(current?.id).toBe("pol-2");
    expect(current?.model).toBe("FIRST_CLICK");
    expect(current?.require_signature).toBe(0);
    expect((await repo.findCurrentPolicyForOffer(ADV, OFFER))?.id).toBe("pol-2");
    // Another tenant sees nothing; another offer has no policy.
    expect(await repo.findCurrentPolicy(tid(ADV2), OFFER)).toBeNull();
    expect(await repo.findCurrentPolicyForOffer(ADV, OFFER2)).toBeNull();
  });
});

describe("listClickCandidates", () => {
  it("returns clicks inside the window (plus post-conversion slack) newest first and always the echoed click", async () => {
    click(db, "c-old", "2026-03-13T11:00:00.000Z"); // outside a 1-day window
    click(db, "c-in-1", "2026-03-15T10:00:00.000Z");
    click(db, "c-in-2", "2026-03-15T11:30:00.000Z");
    click(db, "c-after", "2026-03-15T12:30:00.000Z"); // within slack
    click(db, "c-far", "2026-03-16T12:00:00.000Z"); // beyond slack
    click(db, "c-other", "2026-03-15T11:45:00.000Z", OFFER2);
    const rows = await repo.listClickCandidates({
      advertiser_organization_id: ADV,
      offer_id: OFFER,
      occurred_at: T0,
      window_seconds: 86400,
      echoed_click_id: null,
    });
    expect(rows.map((r) => r.id)).toEqual(["c-after", "c-in-2", "c-in-1"]);
    expect(rows[0]?.organization_id).toBe(AFF);

    const withEcho = await repo.listClickCandidates({
      advertiser_organization_id: ADV,
      offer_id: OFFER,
      occurred_at: T0,
      window_seconds: 86400,
      echoed_click_id: "c-other",
    });
    expect(withEcho.map((r) => r.id)).toContain("c-other");
    expect(withEcho.find((r) => r.id === "c-other")?.offer_id).toBe(OFFER2);
    // Echoed click owned by another advertiser org is NOT surfaced.
    const foreign = await repo.listClickCandidates({
      advertiser_organization_id: ADV2,
      offer_id: OFFER,
      occurred_at: T0,
      window_seconds: 86400,
      echoed_click_id: "c-in-1",
    });
    expect(foreign).toEqual([]);
  });
});

describe("conversions + attributions", () => {
  it("writes conversion and attribution in one batch; repeated external id → ConversionDuplicateError, nothing written", async () => {
    await repo.insertConversionWithAttribution(ADV, conversion(), attribution());
    const conv = await repo.findConversion(tid(ADV), "conv-1");
    expect(conv?.external_conversion_id).toBe("ext-1");
    expect(conv?.sale_amount_minor).toBe(1999);
    const attr = await repo.findAttributionByConversion(tid(ADV), "conv-1");
    expect(attr?.decision).toBe("REJECTED");
    expect(attr?.rule_version).toBe("pol-1");

    await expect(
      repo.insertConversionWithAttribution(ADV, conversion({ id: "conv-2" }), attribution({ id: "attr-2", conversion_id: "conv-2" })),
    ).rejects.toBeInstanceOf(ConversionDuplicateError);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM conversions").get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM attributions").get()).toEqual({ n: 1 });
    // Same external id on a different offer is a different conversion.
    await repo.insertConversionWithAttribution(
      ADV,
      conversion({ id: "conv-3", offer_id: OFFER2, offer_version_id: null }),
      attribution({ id: "attr-3", conversion_id: "conv-3", offer_id: OFFER2 }),
    );
    expect(await repo.findConversion(tid(ADV2), "conv-1")).toBeNull();
  });

  it("findDuplicateConversion probes transaction_id and click+event scopes", async () => {
    click(db, "c1", "2026-03-15T11:00:00.000Z");
    await repo.insertConversionWithAttribution(
      ADV,
      conversion({ transaction_id: "tx-9", click_id: "c1", affiliate_organization_id: AFF }),
      attribution({
        decision: "ATTRIBUTED",
        reason_code: "CLICK_MATCHED_LAST",
        click_id: "c1",
        affiliate_organization_id: AFF,
        click_to_conversion_seconds: 3600,
      }),
    );
    expect(await repo.findDuplicateConversion(ADV, OFFER, { column: "transaction_id", value: "tx-9" })).toBe("conv-1");
    expect(await repo.findDuplicateConversion(ADV, OFFER, { column: "transaction_id", value: "tx-other" })).toBeNull();
    expect(await repo.findDuplicateConversion(ADV, OFFER, { column: "click_event", value: "c1\u0000signup" })).toBe("conv-1");
    expect(await repo.findDuplicateConversion(ADV, OFFER, { column: "click_event", value: "c1\u0000purchase" })).toBeNull();
    expect(await repo.findDuplicateConversion(ADV, OFFER, { column: "external_conversion_id", value: "ext-1" })).toBe("conv-1");
    expect(await repo.findDuplicateConversion(ADV2, OFFER, { column: "external_conversion_id", value: "ext-1" })).toBeNull();
  });

  it("lists conversions / attributions for the advertiser and credited attributions for the affiliate", async () => {
    click(db, "c1", "2026-03-15T11:00:00.000Z");
    await repo.insertConversionWithAttribution(
      ADV,
      conversion({ click_id: "c1", affiliate_organization_id: AFF }),
      attribution({
        decision: "ATTRIBUTED",
        reason_code: "CLICK_MATCHED_LAST",
        click_id: "c1",
        affiliate_organization_id: AFF,
        click_to_conversion_seconds: 3600,
      }),
    );
    await repo.insertConversionWithAttribution(
      ADV,
      conversion({ id: "conv-2", external_conversion_id: "ext-2", status: "REJECTED" }),
      attribution({ id: "attr-2", conversion_id: "conv-2" }),
    );
    const page = { limit: 10, cursor: null };
    expect((await repo.listConversions(tid(ADV), page, {})).items).toHaveLength(2);
    expect((await repo.listConversions(tid(ADV), page, { status: "REJECTED" })).items.map((c) => c.id)).toEqual(["conv-2"]);
    expect((await repo.listConversions(tid(ADV), page, { offer_id: OFFER2 })).items).toHaveLength(0);
    expect((await repo.listConversions(tid(ADV2), page, {})).items).toHaveLength(0);
    expect((await repo.listAttributions(tid(ADV), page, { decision: "ATTRIBUTED" })).items.map((a) => a.id)).toEqual(["attr-1"]);
    const forAff = await repo.listAttributionsForAffiliate(tid(AFF), page, {});
    expect(forAff.items.map((a) => a.id)).toEqual(["attr-1"]);
    expect((await repo.listAttributionsForAffiliate(tid(ADV), page, {})).items).toHaveLength(0);
    // Pagination: limit 1 yields a cursor.
    const first = await repo.listAttributions(tid(ADV), { limit: 1, cursor: null }, {});
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
  });
});

describe("advertiser_postback_secrets", () => {
  const secret = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    advertiser_profile_id: "ap1",
    label: "prod",
    secret_ciphertext: `v1.iv.ct-${id}`,
    key_version: "POSTBACK_SECRET_KEY:v1",
    secret_hint: "ab12",
    created_by_user_id: null,
    ...over,
  });

  it("tenant reads never select ciphertext; verification read does, only for usable rows", async () => {
    await repo.insertSecret(tid(ADV), secret("s1"), []);
    const list = await repo.listSecrets(tid(ADV));
    expect(list).toHaveLength(1);
    expect(list[0]?.secret_hint).toBe("ab12");
    expect(list[0]?.status).toBe("ACTIVE");
    expect(JSON.stringify(list)).not.toContain("ct-s1");
    expect(JSON.stringify(await repo.findSecret(tid(ADV), "s1"))).not.toContain("secret_ciphertext");
    expect(await repo.findSecret(tid(ADV2), "s1")).toBeNull();

    const v = await repo.findActiveSecretForVerification("s1", T0);
    expect(v?.organization_id).toBe(ADV);
    expect(v?.secret_ciphertext).toBe("v1.iv.ct-s1");
    expect(await repo.findActiveSecretForVerification("nope", T0)).toBeNull();

    await repo.touchSecret("s1", T0);
    expect((await repo.findSecret(tid(ADV), "s1"))?.last_used_at).toBe(T0);
  });

  it("rotate keeps the old key verifiable until expires_at, then not; revoke is immediate and tenant-scoped", async () => {
    await repo.insertSecret(tid(ADV), secret("s1"), []);
    const grace = "2026-03-16T12:00:00.000Z";
    await repo.rotateSecret(tid(ADV), "s1", secret("s2", { secret_hint: "cd34" }), grace, T0, []);
    const rows = await repo.listSecrets(tid(ADV));
    expect(rows.map((r) => [r.id, r.status, r.expires_at])).toEqual(
      expect.arrayContaining([
        ["s2", "ACTIVE", null],
        ["s1", "ROTATED", grace],
      ]),
    );
    expect((await repo.findActiveSecretForVerification("s1", T0))?.status).toBe("ROTATED");
    expect(await repo.findActiveSecretForVerification("s1", "2026-03-16T12:00:00.001Z")).toBeNull();
    expect((await repo.findActiveSecretForVerification("s2", "2027-01-01T00:00:00.000Z"))?.status).toBe("ACTIVE");

    // Wrong tenant cannot revoke; right tenant can.
    expect(await repo.revokeSecret(tid(ADV2), "s2", T0, [])).toBe(false);
    expect(await repo.revokeSecret(tid(ADV), "s2", T0, [])).toBe(true);
    expect(await repo.findActiveSecretForVerification("s2", T0)).toBeNull();
    expect((await repo.findSecret(tid(ADV), "s2"))?.revoked_at).toBe(T0);
    // Already revoked → no-op.
    expect(await repo.revokeSecret(tid(ADV), "s2", T0, [])).toBe(false);
    // Rotating a non-ACTIVE row inserts the new key but leaves the old one untouched.
    await repo.rotateSecret(tid(ADV), "s2", secret("s3"), grace, T0, []);
    expect((await repo.findSecret(tid(ADV), "s2"))?.status).toBe("REVOKED");
    expect((await repo.findSecret(tid(ADV), "s3"))?.status).toBe("ACTIVE");
  });
});

describe("postback_nonces", () => {
  it("claimNonce is insert-or-fail per org; purge removes expired rows only", async () => {
    const n = {
      organization_id: ADV,
      nonce: "nonce-0123456789abcdef",
      secret_id: null,
      signed_at: T0,
      expires_at: "2026-03-15T12:05:00.000Z",
    };
    expect(await repo.claimNonce(n)).toBe(true);
    expect(await repo.claimNonce(n)).toBe(false); // replay
    expect(await repo.claimNonce({ ...n, organization_id: ADV2 })).toBe(true); // other org, same nonce
    expect(await repo.claimNonce({ ...n, nonce: "nonce-fresh-0123456789", expires_at: "2026-03-15T13:00:00.000Z" })).toBe(true);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM postback_nonces").get()).toEqual({ n: 3 });
    expect(await repo.purgeExpiredNonces("2026-03-15T12:05:00.000Z")).toBe(2);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM postback_nonces").get()).toEqual({ n: 1 });
    // The purged nonce can be claimed again — harmless, its timestamp is past the skew window.
    expect(await repo.claimNonce(n)).toBe(true);
  });
});
