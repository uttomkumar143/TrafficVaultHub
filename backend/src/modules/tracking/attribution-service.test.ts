/**
 * Phase 3 Unit 7d — AttributionService over the real migrations 0001–0008
 * (D1 shim). Seeds the FK graph directly; no HTTP (that is Unit 7e).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors";
import type { TenantContext } from "../../middleware/require-org";
import { AdvertiserRepository } from "../advertisers/repository";
import type { AuthenticatedContext } from "../auth/service";
import { toBase64Url } from "../auth/crypto-utils";
import { OfferRepository } from "../offers/repository";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { AttributionRepository } from "./attribution-repository";
import { AttributionService, DEFAULT_POLICY, type IssuedPostbackSecret } from "./attribution-service";
import { POSTBACK_HEADERS, signPostback } from "./postback-auth";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const OFFER = "offer-1";
const OFFER_ADV2 = "offer-adv2";
const VERSION = "ver-1";
const LINK = "link-1";
const USER = "user-1";
const PATH = "/postback/v1/conversions";
const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));
const NOW = new Date("2026-03-15T12:00:00.000Z");
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${USER}', 'adv@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap2', '${ADV2}', 'ACTIVE', 'Adv2 Co');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('fp1', '${AFF}', 'ACTIVE', 'Aff');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER_ADV2}', '${ADV2}', 'ap2', 'LIVE', 'PUBLIC', 'Other');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
    UPDATE offers SET current_version_id = '${VERSION}' WHERE id = '${OFFER}';
    INSERT INTO tracking_links (id, organization_id, affiliate_profile_id, offer_id, offer_organization_id, code)
      VALUES ('${LINK}', '${AFF}', 'fp1', '${OFFER}', '${ADV}', 'abcdefgh');
  `);
}

function click(db: TestD1, id: string, clickedAt: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id, offer_organization_id,
         destination_url, clicked_at)
       VALUES (?, ?, 'fp1', ?, ?, ?, ?, 'https://d.example/', ?)`,
    )
    .run(id, AFF, LINK, OFFER, VERSION, ADV, clickedAt);
}

function tenantFor(orgId: string, type: "ADVERTISER" | "AFFILIATE", perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type, name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
const ctx = { user: { id: USER, email: "adv@example.com" }, session: {} } as unknown as AuthenticatedContext;
const advManager = tenantFor(ADV, "ADVERTISER", ["attribution.read", "attribution.manage"]);
const advReader = tenantFor(ADV, "ADVERTISER", ["attribution.read"]);
const affReader = tenantFor(AFF, "AFFILIATE", ["attribution.read"]);

let db: TestD1;
let svc: AttributionService;
let repo: AttributionRepository;

function makeService(masterKey: string | undefined, now: Date = NOW): AttributionService {
  return new AttributionService(repo, new OfferRepository(db), new AdvertiserRepository(db), db, { masterKey, now: () => now });
}

beforeEach(() => {
  db = createTestD1();
  seed(db);
  repo = new AttributionRepository(db);
  svc = makeService(MASTER);
});
afterEach(() => db.close());

async function issueSecret(): Promise<IssuedPostbackSecret> {
  return svc.createSecret(ctx, advManager, { label: "prod" }, META);
}

interface SignedOptions {
  nonce?: string;
  timestamp?: number;
  secret?: string;
  keyId?: string;
  tamperSignature?: boolean;
}

/** Build a signed postback request the way an advertiser's server would. */
async function signed(issued: IssuedPostbackSecret, body: Record<string, unknown>, opts: SignedOptions = {}) {
  const raw = JSON.stringify(body);
  const timestamp = opts.timestamp ?? Math.floor(NOW.getTime() / 1000);
  const nonce = opts.nonce ?? `nonce-${crypto.randomUUID()}`;
  let signature = await signPostback(opts.secret ?? issued.secret, { method: "POST", path: PATH, timestamp, nonce, body: raw });
  if (opts.tamperSignature) signature = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
  const headers: Record<string, string> = {
    [POSTBACK_HEADERS.timestamp.toLowerCase()]: String(timestamp),
    [POSTBACK_HEADERS.nonce.toLowerCase()]: nonce,
    [POSTBACK_HEADERS.keyId.toLowerCase()]: opts.keyId ?? issued.key_id,
    [POSTBACK_HEADERS.signature.toLowerCase()]: signature,
  };
  return { method: "POST", path: PATH, body: raw, header: (n: string) => headers[n.toLowerCase()], meta: META };
}

const baseBody = (over: Record<string, unknown> = {}) => ({
  offer_id: OFFER,
  external_conversion_id: "ext-1",
  conversion_event: "signup",
  occurred_at: NOW.toISOString(),
  sale_amount_minor: 1999,
  currency: "USD",
  ...over,
});

async function expectApp(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(`${e.status} ${e.code}`).toBe(`${status} ${code}`);
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe("policies", () => {
  it("returns the default before any version exists, then appends versions (never edits) with an audit row", async () => {
    const before = await svc.getCurrentPolicy(advReader, OFFER);
    expect(before).toMatchObject({ default: true, ...DEFAULT_POLICY });

    const v1 = await svc.createPolicyVersion(ctx, advManager, OFFER, { model: "FIRST_CLICK", window_seconds: 3600 }, META);
    expect(v1).toMatchObject({
      version_number: 1,
      is_current: true,
      model: "FIRST_CLICK",
      window_seconds: 3600,
      dedup_scope: "EXTERNAL_CONVERSION_ID",
    });

    const v2 = await svc.createPolicyVersion(ctx, advManager, OFFER, { fallback_rule: "HOLD_FOR_REVIEW" }, META);
    expect(v2).toMatchObject({ version_number: 2, is_current: true, model: "FIRST_CLICK", fallback_rule: "HOLD_FOR_REVIEW" });

    const versions = await svc.listPolicyVersions(advReader, OFFER);
    expect(versions.map((v) => [v.version_number, v.is_current])).toEqual([
      [2, true],
      [1, false],
    ]);
    const audits = db.sqlite.prepare(`SELECT action, target_id FROM audit_logs WHERE organization_id = ? ORDER BY created_at`).all(ADV) as {
      action: string;
      target_id: string;
    }[];
    expect(audits.map((a) => a.action)).toEqual(["attribution.policy.created", "attribution.policy.created"]);
    expect(audits[1]?.target_id).toBe(v2.id);
  });

  it("rejects invalid policy input, missing permission, wrong org type and foreign offers", async () => {
    await expectApp(svc.createPolicyVersion(ctx, advManager, OFFER, { window_seconds: 5 }, META), 400, "POLICY_INVALID");
    await expectApp(svc.createPolicyVersion(ctx, advManager, OFFER, { model: "LINEAR" }, META), 400, "POLICY_INVALID");
    await expectApp(svc.createPolicyVersion(ctx, advReader, OFFER, {}, META), 403, "FORBIDDEN");
    await expectApp(svc.getCurrentPolicy(affReader, OFFER), 400, "ORG_TYPE_NOT_ADVERTISER");
    await expectApp(svc.getCurrentPolicy(advReader, OFFER_ADV2), 404, "OFFER_NOT_FOUND");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM attribution_policies`).get()).toEqual({ n: 0 });
  });
});

describe("postback secrets", () => {
  it("creates a secret whose plaintext is returned once and never stored, logged or listed", async () => {
    const issued = await issueSecret();
    expect(issued.secret).toHaveLength(43);
    expect(issued.key_id).toBe(issued.id);
    expect(issued.secret_hint).toBe(issued.secret.slice(-4));

    const stored = db.sqlite
      .prepare(`SELECT secret_ciphertext, key_version FROM advertiser_postback_secrets WHERE id = ?`)
      .get(issued.id) as {
      secret_ciphertext: string;
      key_version: string;
    };
    expect(stored.secret_ciphertext).not.toContain(issued.secret);
    expect(stored.secret_ciphertext.startsWith("v1.")).toBe(true);
    expect(stored.key_version).toBe("POSTBACK_SECRET_KEY:v1");

    const audit = JSON.stringify(db.sqlite.prepare(`SELECT * FROM audit_logs`).all());
    expect(audit).not.toContain(issued.secret);
    expect(audit).toContain("attribution.postback_secret.created");

    const listed = await svc.listSecrets(advReader);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.secret);
    expect(JSON.stringify(listed)).not.toContain("ciphertext");
    expect(await svc.listSecrets(tenantFor(ADV2, "ADVERTISER", ["attribution.read"]))).toEqual([]);
  });

  it("fails CLOSED when POSTBACK_SECRET_KEY is missing or wrong", async () => {
    const noKey = makeService(undefined);
    await expectApp(noKey.createSecret(ctx, advManager, {}, META), 503, "POSTBACK_VAULT_UNAVAILABLE");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM advertiser_postback_secrets`).get()).toEqual({ n: 0 });

    const issued = await issueSecret();
    const wrongKey = makeService(toBase64Url(new Uint8Array(32).fill(9)));
    const req = await signed(issued, baseBody());
    await expectApp(wrongKey.processPostback(req), 503, "POSTBACK_VAULT_UNAVAILABLE");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 0 });
  });

  it("rotates (old key verifies inside grace, not after) and revokes (immediately dead)", async () => {
    const first = await issueSecret();
    const second = await svc.rotateSecret(ctx, advManager, first.id, META);
    expect(second.id).not.toBe(first.id);
    expect(second.secret).not.toBe(first.secret);
    const statuses = Object.fromEntries((await svc.listSecrets(advReader)).map((s) => [s.id, s.status]));
    expect(statuses).toEqual({ [first.id]: "ROTATED", [second.id]: "ACTIVE" });

    // Old secret still verifies inside the grace window …
    const withOld = await signed(first, baseBody({ external_conversion_id: "ext-old" }));
    expect((await svc.processPostback(withOld)).decision).toBe("REJECTED");
    // … but not after it.
    const later = makeService(MASTER, new Date(NOW.getTime() + 25 * 3600 * 1000));
    const ts = Math.floor(NOW.getTime() / 1000) + 25 * 3600;
    await expectApp(
      later.processPostback(await signed(first, baseBody({ external_conversion_id: "ext-late" }), { timestamp: ts })),
      401,
      "SIGNATURE_INVALID",
    );
    expect(
      (await later.processPostback(await signed(second, baseBody({ external_conversion_id: "ext-late" }), { timestamp: ts }))).decision,
    ).toBe("REJECTED");

    await expectApp(svc.rotateSecret(ctx, advManager, first.id, META), 409, "POSTBACK_SECRET_NOT_ACTIVE");
    const revoked = await svc.revokeSecret(ctx, advManager, second.id, META);
    expect(revoked.status).toBe("REVOKED");
    await expectApp(svc.processPostback(await signed(second, baseBody({ external_conversion_id: "ext-rev" }))), 401, "SIGNATURE_INVALID");
    await expectApp(svc.revokeSecret(ctx, advManager, second.id, META), 409, "POSTBACK_SECRET_NOT_ACTIVE");
    // Another tenant cannot see or touch it.
    const other = tenantFor(ADV2, "ADVERTISER", ["attribution.read", "attribution.manage"]);
    await expectApp(svc.revokeSecret(ctx, other, first.id, META), 404, "POSTBACK_SECRET_NOT_FOUND");
  });
});

describe("processPostback", () => {
  it("attributes a signed postback to the last in-window click and records an explainable decision", async () => {
    const issued = await issueSecret();
    click(db, "clk-old", "2026-03-15T09:00:00.000Z");
    click(db, "clk-new", "2026-03-15T11:30:00.000Z");
    click(db, "clk-after", "2026-03-15T12:30:00.000Z");
    const out = await svc.processPostback(await signed(issued, baseBody()));
    expect(out).toMatchObject({ decision: "ATTRIBUTED", reason_code: "CLICK_MATCHED_LAST", duplicate: false });

    const got = await svc.getConversion(advReader, out.conversion_id);
    expect(got.conversion).toMatchObject({
      organization_id: ADV,
      offer_id: OFFER,
      offer_version_id: VERSION,
      click_id: "clk-new",
      affiliate_organization_id: AFF,
      status: "PENDING",
      source: "S2S_POSTBACK",
      sale_amount_minor: 1999,
      currency: "USD",
    });
    expect(got.attribution).toMatchObject({
      click_id: "clk-new",
      affiliate_organization_id: AFF,
      decision: "ATTRIBUTED",
      click_to_conversion_seconds: 1800,
      reason_code: "CLICK_MATCHED_LAST",
    });
    // A default policy row was materialized so rule_version is a real FK.
    const pol = await svc.getCurrentPolicy(advReader, OFFER);
    expect("id" in pol && pol.id === got.attribution?.rule_version).toBe(true);
    // Affiliate face sees its own attribution; advertiser list sees it too.
    const mine = await svc.listAttributionsForAffiliate(affReader, { limit: 10, cursor: null }, {});
    expect(mine.items.map((a) => a.conversion_id)).toEqual([out.conversion_id]);
    expect((await svc.listConversions(advReader, { limit: 10, cursor: null }, {})).items).toHaveLength(1);
    expect((await svc.listAttributions(advReader, { limit: 10, cursor: null }, { decision: "ATTRIBUTED" })).items).toHaveLength(1);
    // Secret usage was marked; the tenant of another advertiser sees nothing.
    expect((await svc.listSecrets(advReader))[0]?.last_used_at).toBe(NOW.toISOString());
    await expectApp(svc.getConversion(tenantFor(ADV2, "ADVERTISER", ["attribution.read"]), out.conversion_id), 404, "CONVERSION_NOT_FOUND");
  });

  it("rejects malformed headers, skewed timestamps, bad signatures and unknown key ids before touching state", async () => {
    const issued = await issueSecret();
    const bare = await signed(issued, baseBody());
    await expectApp(svc.processPostback({ ...bare, header: () => undefined }), 401, "SIGNATURE_MALFORMED");
    await expectApp(
      svc.processPostback(await signed(issued, baseBody(), { timestamp: Math.floor(NOW.getTime() / 1000) - 301 })),
      401,
      "TIMESTAMP_SKEW",
    );
    await expectApp(svc.processPostback(await signed(issued, baseBody(), { tamperSignature: true })), 401, "SIGNATURE_INVALID");
    await expectApp(svc.processPostback(await signed(issued, baseBody(), { secret: "not-the-secret" })), 401, "SIGNATURE_INVALID");
    await expectApp(svc.processPostback(await signed(issued, baseBody(), { keyId: crypto.randomUUID() })), 401, "SIGNATURE_INVALID");
    // Body tampering after signing is a signature failure too.
    const tampered = { ...bare, body: bare.body.replace("1999", "1") };
    await expectApp(svc.processPostback(tampered), 401, "SIGNATURE_INVALID");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM postback_nonces`).get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 0 });
  });

  it("rejects a replayed nonce (identical signed request) with 409 and writes nothing twice", async () => {
    const issued = await issueSecret();
    const req = await signed(issued, baseBody());
    const first = await svc.processPostback(req);
    expect(first.decision).toBe("REJECTED"); // no clicks yet
    await expectApp(svc.processPostback(req), 409, "REPLAY_DETECTED");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 1 });
  });

  it("deduplicates: same external_conversion_id → DUPLICATE, nothing new written; other scopes honoured", async () => {
    const issued = await issueSecret();
    click(db, "clk-1", "2026-03-15T11:00:00.000Z");
    const a = await svc.processPostback(await signed(issued, baseBody()));
    expect(a.decision).toBe("ATTRIBUTED");
    const b = await svc.processPostback(await signed(issued, baseBody()));
    expect(b).toMatchObject({
      decision: "DUPLICATE",
      reason_code: "DUPLICATE_EXTERNAL_ID",
      duplicate: true,
      conversion_id: a.conversion_id,
    });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM attributions`).get()).toEqual({ n: 1 });

    // TRANSACTION_ID scope: a new external id with a seen transaction id is a duplicate record (kept as evidence, never attributed).
    await svc.createPolicyVersion(ctx, advManager, OFFER, { dedup_scope: "TRANSACTION_ID" }, META);
    const c = await svc.processPostback(await signed(issued, baseBody({ external_conversion_id: "ext-2", transaction_id: "txn-9" })));
    expect(c.decision).toBe("ATTRIBUTED");
    const d = await svc.processPostback(await signed(issued, baseBody({ external_conversion_id: "ext-3", transaction_id: "txn-9" })));
    expect(d).toMatchObject({
      decision: "DUPLICATE",
      reason_code: "DUPLICATE_TRANSACTION_ID",
      duplicate: true,
      duplicate_of: c.conversion_id,
    });
    expect(d.conversion_id).not.toBe(c.conversion_id);
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 3 });
    const dRow = await svc.getConversion(advReader, d.conversion_id);
    expect(dRow.conversion.click_id).toBeNull();
    expect(dRow.conversion.status).toBe("REJECTED");
  });

  it("duplicate postback creates no duplicate conversion or downstream effect", async () => {
    // Definition of Done (Phase 4): the replayed postback leaves exactly ONE conversion, ONE attribution,
    // ONE idempotency key, and no history / hold / reversal rows — nothing downstream fires twice.
    const issued = await issueSecret();
    click(db, "clk-1", "2026-03-15T11:00:00.000Z");
    const first = await svc.processPostback(await signed(issued, baseBody()));
    expect(first.decision).toBe("ATTRIBUTED");
    const snapshot = () => ({
      conversions: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get(),
      attributions: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM attributions`).get(),
      history: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversion_status_history`).get(),
      holds: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversion_holds`).get(),
      reversals: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversion_reversals`).get(),
      keys: db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions WHERE idempotency_key IS NOT NULL`).get(),
    });
    const before = snapshot();
    expect(before).toEqual({
      conversions: { n: 1 },
      attributions: { n: 1 },
      history: { n: 0 },
      holds: { n: 0 },
      reversals: { n: 0 },
      keys: { n: 1 },
    });
    const row = db.sqlite.prepare(`SELECT lifecycle_status, idempotency_key FROM conversions WHERE id = ?`).get(first.conversion_id) as {
      lifecycle_status: string;
      idempotency_key: string;
    };
    expect(row.lifecycle_status).toBe("PENDING");
    expect(row.idempotency_key).toBe(`${OFFER}|external_conversion_id|ext-1`);

    // Same postback again (fresh nonce/timestamp — a real advertiser retry, not a replay).
    for (let i = 0; i < 2; i++) {
      const again = await svc.processPostback(await signed(issued, baseBody()));
      expect(again).toMatchObject({ decision: "DUPLICATE", duplicate: true, conversion_id: first.conversion_id, attribution_id: null });
    }
    expect(snapshot()).toEqual(before);
  });

  it("never trusts the body for tenant or affiliate: foreign offer → 404, foreign click → CLICK_OFFER_MISMATCH, no click → fallback", async () => {
    const issued = await issueSecret();
    // Offer owned by another advertiser is invisible to this key.
    await expectApp(svc.processPostback(await signed(issued, baseBody({ offer_id: OFFER_ADV2 }))), 404, "OFFER_NOT_FOUND");
    // Echoed click id from a different offer is never re-attributed.
    db.sqlite.exec(`INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('offer-b', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'B');
      INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
        affiliate_commission_minor, conversion_event, destination_url)
        VALUES ('ver-b', 'offer-b', '${ADV}', 1, 'CPA', 'USD', 100, 50, 'signup', 'https://b.example/');`);
    db.sqlite
      .prepare(
        `INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id, offer_organization_id,
           destination_url, clicked_at) VALUES ('clk-b', ?, 'fp1', ?, 'offer-b', 'ver-b', ?, 'https://d.example/', ?)`,
      )
      .run(AFF, LINK, ADV, "2026-03-15T11:00:00.000Z");
    const mism = await svc.processPostback(await signed(issued, baseBody({ click_id: "clk-b", affiliate_id: "org-attacker" })));
    expect(mism).toMatchObject({ decision: "REJECTED", reason_code: "CLICK_OFFER_MISMATCH" });
    const row = await svc.getConversion(advReader, mism.conversion_id);
    expect(row.conversion.affiliate_organization_id).toBeNull();
    expect(row.conversion.click_id).toBeNull();
    // HOLD_FOR_REVIEW fallback → HELD / FRAUD_REVIEW.
    await svc.createPolicyVersion(ctx, advManager, OFFER, { fallback_rule: "HOLD_FOR_REVIEW" }, META);
    const held = await svc.processPostback(await signed(issued, baseBody({ external_conversion_id: "ext-held" })));
    expect(held).toMatchObject({ decision: "HELD", reason_code: "NO_CLICK_IN_WINDOW" });
    expect((await svc.getConversion(advReader, held.conversion_id)).conversion.status).toBe("FRAUD_REVIEW");
  });

  it("validates the body strictly: money is integer minor units, currency ISO-3, occurred_at ISO-8601", async () => {
    const issued = await issueSecret();
    for (const bad of [
      { sale_amount_minor: 19.99 },
      { sale_amount_minor: -1 },
      { sale_amount_minor: 100, currency: null },
      { currency: "usd" },
      { occurred_at: "yesterday" },
      { external_conversion_id: "" },
      { external_conversion_id: "x".repeat(129) },
      { click_id: "has space" },
    ]) {
      await expectApp(svc.processPostback(await signed(issued, baseBody(bad))), 400, "POSTBACK_INVALID");
    }
    const notJson = await signed(issued, baseBody());
    const raw = "not json";
    const ts = Math.floor(NOW.getTime() / 1000);
    const nonce = `nonce-${crypto.randomUUID()}`;
    const sig = await signPostback(issued.secret, { method: "POST", path: PATH, timestamp: ts, nonce, body: raw });
    const hdr: Record<string, string> = {
      "x-tvh-timestamp": String(ts),
      "x-tvh-nonce": nonce,
      "x-tvh-key-id": issued.key_id,
      "x-tvh-signature": sig,
    };
    await expectApp(svc.processPostback({ ...notJson, body: raw, header: (n) => hdr[n.toLowerCase()] }), 400, "POSTBACK_INVALID");
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversions`).get()).toEqual({ n: 0 });
  });
});
