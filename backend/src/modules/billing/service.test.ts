/**
 * Phase 5 Unit 8c — BillingService.evaluateFunding end-to-end over D1 (0011)
 * with the REAL OfferService (platformTransition), the REAL EligibilityCache
 * (MemoryKv) and the REAL eligibility / SmartLink engine functions. No mocks.
 *
 * DoD: an offer whose advertiser has insufficient funding capacity is PAUSED
 * through the audited transition and immediately disappears from SmartLink
 * eligibility (offerRoutability + candidateEligibility/route both reject it,
 * the cached offer facts are gone).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors";
import type { TenantContext } from "../../middleware/require-org";
import { AdvertiserRepository } from "../advertisers/repository";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import { LedgerRepository } from "../ledger/repository";
import { OfferRepository } from "../offers/repository";
import { OfferService } from "../offers/service";
import { offerRoutability, type OfferRoutingFacts } from "../tracking/eligibility";
import { EligibilityCache, MemoryKv, type CachedOfferFacts } from "../tracking/eligibility-cache";
import { candidateEligibility, route, type ClickContext, type SmartLinkCandidate } from "../tracking/smartlink-engine";
import { PASSWORD, TestHarness, json } from "../../test/fixtures";
import { BillingRepository, BillingService, FUNDING_PROTECTION_REASON } from "./service";

void PASSWORD;

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
const META: RequestMeta = { ip_address: null, user_agent: null, request_id: "req-billing-test" };
const NOW = new Date("2026-03-01T12:00:00.000Z");

interface Offer {
  id: string;
  organization_id: string;
  status: string;
  access_mode: string;
  current_version_id: string | null;
  current_version: { destination_url: string | null } | null;
}

let h: TestHarness;
let kv: MemoryKv;
let cache: EligibilityCache;
let offers: OfferService;
let billing: BillingRepository;
let svc: BillingService;

beforeEach(() => {
  h = new TestHarness();
  kv = new MemoryKv();
  cache = new EligibilityCache(kv);
  offers = new OfferService(new OfferRepository(h.db), new AdvertiserRepository(h.db), h.db, cache);
  billing = new BillingRepository(h.db);
  svc = new BillingService(billing, new LedgerRepository(h.db), offers, new AuditRepository(h.db), { now: () => NOW });
});
afterEach(() => h.close());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a TenantContext straight from D1 for a user's membership in an org (same as offer-cache-invalidation.test.ts). */
async function tenantFor(email: string, orgId: string): Promise<{ tenant: TenantContext; ctx: AuthenticatedContext }> {
  const row = await h.db
    .prepare(
      `SELECT u.id AS user_id, u.email, o.type, o.name, o.slug, o.status,
              m.id AS membership_id, m.joined_at, r.id AS role_id, r.key AS role_key, r.is_owner
         FROM users u
         JOIN organization_members m ON m.user_id = u.id AND m.organization_id = ?
         JOIN organizations o ON o.id = m.organization_id
         JOIN roles r ON r.id = m.role_id
        WHERE lower(u.email) = lower(?)`,
    )
    .bind(orgId, email)
    .first<{
      user_id: string; email: string; type: string; name: string; slug: string; status: string;
      membership_id: string; joined_at: string | null; role_id: string; role_key: string; is_owner: number;
    }>();
  if (!row) throw new Error("fixture: membership not found");
  const perms = await h.db
    .prepare(`SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`)
    .bind(row.role_id)
    .all<{ key: string }>();
  const tenant: TenantContext = {
    organization: { id: orgId, type: row.type as TenantContext["organization"]["type"], name: row.name, slug: row.slug, status: row.status },
    membership: { id: row.membership_id, joined_at: row.joined_at },
    role: { id: row.role_id, key: row.role_key, is_owner: row.is_owner === 1 },
    permissions: new Set(perms.results.map((p) => p.key)),
  };
  const ctx = { user: { id: row.user_id, email: row.email }, session: {} } as unknown as AuthenticatedContext;
  return { tenant, ctx };
}

interface Advertiser {
  email: string;
  token: string;
  orgId: string;
  profileId: string;
}

let advSeq = 0;
async function advertiser(name = "Acme Ads"): Promise<Advertiser> {
  advSeq += 1;
  const email = `adv${advSeq}@${name.toLowerCase().replace(/[^a-z]/g, "")}.example`;
  const token = await h.user(email);
  const orgId = await h.org(token, "ADVERTISER", name);
  expect((await h.as(token, "POST", `/organizations/${orgId}/advertiser`, { company_name: name })).status).toBe(201);
  const prof = await h.db
    .prepare(`SELECT id FROM advertiser_profiles WHERE organization_id = ?`)
    .bind(orgId)
    .first<{ id: string }>();
  if (!prof) throw new Error("fixture: advertiser profile missing");
  return { email, token, orgId, profileId: prof.id };
}

interface Platform {
  email: string;
  token: string;
  orgId: string;
}

async function platform(role: "SUPER_ADMIN" | "FINANCE_MANAGER" | "COMPLIANCE_MANAGER" | "ANALYST" = "SUPER_ADMIN"): Promise<Platform> {
  const email = `${role.toLowerCase()}@network.example`;
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, role);
  return { email, token, orgId };
}

/** Create → submit → platform review → LIVE through the real HTTP state machine. */
async function liveOffer(adv: Advertiser, plat: Platform, version: Record<string, unknown> = V1, name = "Live"): Promise<Offer> {
  const created = await json<{ offer: Offer }>(
    await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers`, { name, access_mode: "PUBLIC", version }),
  );
  const id = created.offer.id;
  expect((await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(adv.token, "POST", `/organizations/${adv.orgId}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}

interface ProfileInput {
  funding_model?: "PREPAID" | "POSTPAID" | "CREDIT";
  currency?: string;
  credit_limit_minor?: number;
  used_credit_minor?: number;
  payment_terms_days?: number | null;
}

/** Insert a 0011 billing profile directly (no write API exists until Unit 9+). */
async function billingProfile(adv: Advertiser, p: ProfileInput = {}): Promise<string> {
  const id = crypto.randomUUID();
  const model = p.funding_model ?? "CREDIT";
  const limit = p.credit_limit_minor ?? 0;
  const used = p.used_credit_minor ?? 0;
  await h.db
    .prepare(
      `INSERT INTO advertiser_billing_profiles
         (id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor,
          available_credit_minor, payment_terms_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, adv.orgId, adv.profileId, model, p.currency ?? "USD", limit, used, limit - used, p.payment_terms_days ?? null)
    .run();
  return id;
}

/** Fresh routing facts straight from D1 (what the click path reads). */
async function factsFromDb(offerId: string): Promise<OfferRoutingFacts & { organization_id: string; current_version_id: string | null }> {
  const row = await h.db
    .prepare(
      `SELECT o.organization_id, o.status, o.access_mode, o.current_version_id,
              v.destination_url, v.targeting_starts_at, v.targeting_ends_at
         FROM offers o LEFT JOIN offer_versions v ON v.id = o.current_version_id
        WHERE o.id = ?`,
    )
    .bind(offerId)
    .first<{
      organization_id: string; status: string; access_mode: string; current_version_id: string | null;
      destination_url: string | null; targeting_starts_at: string | null; targeting_ends_at: string | null;
    }>();
  if (!row) throw new Error("fixture: offer missing");
  return {
    organization_id: row.organization_id,
    status: row.status as OfferRoutingFacts["status"],
    access_mode: row.access_mode as OfferRoutingFacts["access_mode"],
    current_version_id: row.current_version_id,
    destination_url: row.destination_url,
    targeting_starts_at: row.targeting_starts_at,
    targeting_ends_at: row.targeting_ends_at,
    grant_status: null,
  };
}

async function candidateFromDb(offerId: string): Promise<SmartLinkCandidate> {
  const f = await factsFromDb(offerId);
  return {
    offer_id: offerId,
    offer_organization_id: f.organization_id,
    weight: 100,
    priority: 1,
    enabled: true,
    facts: f,
    targeting: [],
  };
}

const CLICK: ClickContext = {
  country_code: "US",
  region_code: null,
  device_type: "MOBILE",
  os_family: null,
  browser_family: null,
  language: null,
  traffic_source_id: null,
  now: NOW,
};

function cachedFactsOf(offer: Offer): CachedOfferFacts {
  return {
    offer_id: offer.id,
    organization_id: offer.organization_id,
    status: offer.status as CachedOfferFacts["status"],
    access_mode: offer.access_mode as CachedOfferFacts["access_mode"],
    current_version_id: offer.current_version_id,
    destination_url: offer.current_version?.destination_url ?? null,
    targeting_starts_at: null,
    targeting_ends_at: null,
    epoch: "2026-01-01T00:00:00.000Z",
  };
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const r = await h.db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function status(offerId: string): Promise<string> {
  const r = await h.db.prepare(`SELECT status FROM offers WHERE id = ?`).bind(offerId).first<{ status: string }>();
  return r?.status ?? "<missing>";
}

async function protection(orgId: string): Promise<{ active: number; since: string | null }> {
  const r = await h.db
    .prepare(`SELECT funding_protection_active AS active, funding_protection_since AS since FROM advertiser_billing_profiles WHERE organization_id = ?`)
    .bind(orgId)
    .first<{ active: number; since: string | null }>();
  if (!r) throw new Error("profile missing");
  return r;
}

/** Accepts a thunk: permission/validation failures are thrown SYNCHRONOUSLY (before any promise / I/O). */
async function expectAppError(run: () => Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    const err = e as AppError;
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected AppError ${status} ${code}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BillingService.evaluateFunding (Phase 5 Unit 8c)", () => {
  it("insufficient advertiser capacity pauses the offer and it disappears from SmartLink eligibility", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const offer = await liveOffer(adv, plat);
    // CREDIT profile: capacity = 10 000 − 8 000 = 2 000 < required 5 000 (max LIVE payout).
    await billingProfile(adv, { funding_model: "CREDIT", credit_limit_minor: 10_000, used_credit_minor: 8_000 });

    // BEFORE: routable, a SmartLink candidate, and cached.
    expect(offerRoutability(await factsFromDb(offer.id), NOW)).toEqual({ eligible: true });
    const before = route(
      { smartlink_id: "sl-1", routing_mode: "RULE_BASED", status: "ACTIVE", fallback_url: null },
      [await candidateFromDb(offer.id)],
      CLICK,
    );
    expect(before.outcome).toBe("OFFER");
    if (before.outcome === "OFFER") expect(before.offer_id).toBe(offer.id);
    await cache.putOffer(cachedFactsOf(offer));
    expect(await cache.getOffer(offer.id)).not.toBeNull();

    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);
    const result = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);

    expect(result.decision.ok).toBe(false);
    expect(result.decision.required_minor).toBe(5000);
    expect(result.decision.capacity_minor).toBe(2000);
    expect(result.decision.shortfall_minor).toBe(3000);
    expect(result.protection_activated).toBe(true);
    expect(result.protection_since).toBe(NOW.toISOString());
    expect(result.paused_offer_ids).toEqual([offer.id]);
    expect(result.alerts_written).toBe(2);

    // Paused via the REAL transition path: offers.status + offer_status_transitions row with the reason.
    expect(await status(offer.id)).toBe("PAUSED");
    const transition = await h.db
      .prepare(
        `SELECT from_status, to_status, actor_kind, reason, actor_user_id FROM offer_status_transitions
          WHERE offer_id = ? AND to_status = 'PAUSED'`,
      )
      .bind(offer.id)
      .all<{ from_status: string; to_status: string; actor_kind: string; reason: string; actor_user_id: string }>();
    expect(transition.results).toHaveLength(1);
    expect(transition.results[0]).toMatchObject({
      from_status: "LIVE",
      to_status: "PAUSED",
      actor_kind: "PLATFORM",
      reason: FUNDING_PROTECTION_REASON,
      actor_user_id: ctx.user.id,
    });

    // Cache entry invalidated (deleted by OfferService around the write).
    expect(await cache.getOffer(offer.id)).toBeNull();
    expect(kv.calls.some((c) => c.op === "delete" && c.key.includes(offer.id))).toBe(true);

    // AFTER: ineligible and no longer a SmartLink candidate (real engine, fresh facts).
    const after = await factsFromDb(offer.id);
    expect(offerRoutability(after, NOW)).toEqual({ eligible: false, reason: "OFFER_NOT_LIVE" });
    const cand = await candidateFromDb(offer.id);
    expect(candidateEligibility(cand, CLICK)).toEqual({ eligible: false, reason: "OFFER_NOT_LIVE" });
    const decision = route(
      { smartlink_id: "sl-1", routing_mode: "RULE_BASED", status: "ACTIVE", fallback_url: null },
      [cand],
      CLICK,
    );
    expect(decision.outcome).toBe("NO_ELIGIBLE_OFFER");
    if (decision.outcome === "NO_ELIGIBLE_OFFER") expect(decision.rejected).toEqual([{ offer_id: offer.id, reason: "OFFER_NOT_LIVE" }]);

    // Profile flipped + funding event + audit.
    expect(await protection(adv.orgId)).toEqual({ active: 1, since: NOW.toISOString() });
    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_funding_events WHERE organization_id = ? AND event_type = 'FUNDING_PROTECTION_TRIGGERED'`, adv.orgId)).toBe(1);
    const audit = await h.auditRows("billing.funding_protection_evaluated");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.organization_id).toBe(adv.orgId);
  });

  it("running evaluateFunding twice: exactly 2 funding_alerts (ADVERTISER + OPERATIONS), one funding_protection event, one pause", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const offer = await liveOffer(adv, plat);
    await billingProfile(adv, { funding_model: "CREDIT", credit_limit_minor: 1_000, used_credit_minor: 0 });
    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);

    const first = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(first.protection_activated).toBe(true);
    expect(first.alerts_written).toBe(2);
    expect(first.paused_offer_ids).toEqual([offer.id]);

    // Second run through the SAME insufficient path: with every offer paused the
    // measured requirement is 0 (documented: no LIVE offers → 0, read-only), so
    // re-assert the original requirement explicitly to exercise idempotency.
    const second = await svc.evaluateFunding(ctx, tenant, adv.orgId, { required_minor: 5000 }, META);
    expect(second.decision.ok).toBe(false);
    expect(second.protection_activated).toBe(false);
    expect(second.protection_active).toBe(true);
    expect(second.protection_since).toBe(first.protection_since);
    expect(second.alerts_written).toBe(0);
    expect(second.paused_offer_ids).toEqual([]); // nothing LIVE any more → no second pause

    // Measured (no override) with nothing LIVE: requirement 0 → sufficient → read-only, protection stays on.
    const third = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(third.decision.ok).toBe(true);
    expect(third.decision.required_minor).toBe(0);
    expect(third.protection_active).toBe(true);
    expect(third.protection_activated).toBe(false);
    expect(third.alerts_written).toBe(0);

    const alerts = await billing.listAlerts(adv.orgId as never);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.audience).sort()).toEqual(["ADVERTISER", "OPERATIONS"]);
    expect(new Set(alerts.map((a) => a.dedupe_key)).size).toBe(1);
    expect(alerts[0]?.dedupe_key).toBe(`INSUFFICIENT_CAPACITY:${first.billing_profile_id}:${first.protection_since}`);
    for (const a of alerts) {
      expect(a.alert_type).toBe("INSUFFICIENT_CAPACITY");
      expect(a.severity).toBe("CRITICAL");
      expect(JSON.parse(a.payload)).toMatchObject({ audience: a.audience, live_offer_ids: [offer.id], shortfall_minor: 4000 });
    }

    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_funding_events WHERE organization_id = ?`, adv.orgId)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM offer_status_transitions WHERE offer_id = ? AND to_status = 'PAUSED'`, offer.id)).toBe(1);
    expect(await status(offer.id)).toBe("PAUSED");
    // Both insufficient runs are audited (the audit is the evaluation record, not the alert); the read-only run is not.
    expect(await h.auditRows("billing.funding_protection_evaluated")).toHaveLength(2);
  });

  it("sufficient capacity changes nothing (no alerts, no pause, funding_protection_active stays 0)", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const offer = await liveOffer(adv, plat);
    // Exact boundary: capacity 5 000 ≥ required 5 000.
    await billingProfile(adv, { funding_model: "CREDIT", credit_limit_minor: 5_000, used_credit_minor: 0 });
    await cache.putOffer(cachedFactsOf(offer));
    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);

    const result = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(result.decision.ok).toBe(true);
    expect(result.decision.required_minor).toBe(5000);
    expect(result.protection_active).toBe(false);
    expect(result.protection_activated).toBe(false);
    expect(result.paused_offer_ids).toEqual([]);
    expect(result.alerts_written).toBe(0);
    expect(result.prepaid_balance_minor).toBeNull();

    expect(await status(offer.id)).toBe("LIVE");
    expect(await protection(adv.orgId)).toEqual({ active: 0, since: null });
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts WHERE organization_id = ?`, adv.orgId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_funding_events WHERE organization_id = ?`, adv.orgId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM offer_status_transitions WHERE offer_id = ? AND to_status = 'PAUSED'`, offer.id)).toBe(0);
    expect(await h.auditRows("billing.funding_protection_evaluated")).toHaveLength(0);
    // Still routable and still cached — a read-only evaluation never touches the cache.
    expect(offerRoutability(await factsFromDb(offer.id), NOW)).toEqual({ eligible: true });
    expect(await cache.getOffer(offer.id)).not.toBeNull();
    expect(kv.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("PREPAID: ADVERTISER_PREPAID ledger balance in the profile currency is the capacity (no account → 0 → pause)", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const offer = await liveOffer(adv, plat);
    await billingProfile(adv, { funding_model: "PREPAID", credit_limit_minor: 0, used_credit_minor: 0 });
    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);

    const result = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(result.prepaid_balance_minor).toBe(0);
    expect(result.decision.ok).toBe(false);
    expect(result.decision.capacity_minor).toBe(0);
    expect(result.paused_offer_ids).toEqual([offer.id]);
    expect(await status(offer.id)).toBe("PAUSED");
  });

  it("403 sync without billing.manage (also: non-PLATFORM org) before any write", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const offer = await liveOffer(adv, plat);
    await billingProfile(adv, { funding_model: "CREDIT", credit_limit_minor: 1_000, used_credit_minor: 0 });

    // COMPLIANCE_MANAGER: PLATFORM org, has offers.pause but NOT billing.manage.
    const compliance = await platform("COMPLIANCE_MANAGER");
    const c = await tenantFor(compliance.email, compliance.orgId);
    expect(c.tenant.permissions.has("offers.pause")).toBe(true);
    expect(c.tenant.permissions.has("billing.manage")).toBe(false);
    // Synchronous: the throw happens before a promise even exists (no I/O started).
    let thrown: unknown = null;
    try {
      void svc.evaluateFunding(c.ctx, c.tenant, adv.orgId, {}, META);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(403);
    expect((thrown as AppError).code).toBe("FORBIDDEN");
    expect((thrown as AppError).message).toContain("billing.manage");

    // FINANCE_MANAGER: has billing.manage but NOT offers.pause → still 403.
    const finance = await platform("FINANCE_MANAGER");
    const f = await tenantFor(finance.email, finance.orgId);
    expect(f.tenant.permissions.has("billing.manage")).toBe(true);
    expect(f.tenant.permissions.has("offers.pause")).toBe(false);
    await expectAppError(() => svc.evaluateFunding(f.ctx, f.tenant, adv.orgId, {}, META), 403, "FORBIDDEN");

    // Non-PLATFORM org (the advertiser owner about its own org) → 403 regardless of permissions.
    const a = await tenantFor(adv.email, adv.orgId);
    await expectAppError(() => svc.evaluateFunding(a.ctx, a.tenant, adv.orgId, {}, META), 403, "FORBIDDEN");

    // Nothing was written anywhere.
    expect(await status(offer.id)).toBe("LIVE");
    expect(await protection(adv.orgId)).toEqual({ active: 0, since: null });
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_funding_events`)).toBe(0);
    expect(await h.auditRows("billing.funding_protection_evaluated")).toHaveLength(0);

    // Reads: billing.read is scoped to the caller's own org; a non-platform caller cannot read another advertiser.
    const own = await svc.getMyProfile(a.tenant);
    expect(own.organization_id).toBe(adv.orgId);
    await expectAppError(() => svc.getProfileFor(a.tenant, adv.orgId), 403, "FORBIDDEN");
  });

  it("tenant isolation (another advertiser's offers untouched)", async () => {
    const plat = await platform("SUPER_ADMIN");
    const broke = await advertiser("Broke Ads");
    const solvent = await advertiser("Solvent Ads");
    const brokeOffer = await liveOffer(broke, plat, V1, "Broke Live");
    const solventOffer = await liveOffer(solvent, plat, V1, "Solvent Live");
    await billingProfile(broke, { funding_model: "CREDIT", credit_limit_minor: 100, used_credit_minor: 0 });
    await billingProfile(solvent, { funding_model: "CREDIT", credit_limit_minor: 100, used_credit_minor: 0 }); // also "broke" — must NOT be evaluated
    await cache.putOffer(cachedFactsOf(solventOffer));
    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);

    const result = await svc.evaluateFunding(ctx, tenant, broke.orgId, {}, META);
    expect(result.organization_id).toBe(broke.orgId);
    expect(result.paused_offer_ids).toEqual([brokeOffer.id]);

    expect(await status(brokeOffer.id)).toBe("PAUSED");
    expect(await status(solventOffer.id)).toBe("LIVE");
    expect(await protection(broke.orgId)).toEqual({ active: 1, since: NOW.toISOString() });
    expect(await protection(solvent.orgId)).toEqual({ active: 0, since: null });
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts WHERE organization_id = ?`, broke.orgId)).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts WHERE organization_id = ?`, solvent.orgId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM advertiser_funding_events WHERE organization_id = ?`, solvent.orgId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM offer_status_transitions WHERE organization_id = ? AND to_status = 'PAUSED'`, solvent.orgId)).toBe(0);
    expect(await cache.getOffer(solventOffer.id)).not.toBeNull();
    expect(offerRoutability(await factsFromDb(solventOffer.id), NOW)).toEqual({ eligible: true });

    // Alerts list is tenant-scoped too.
    const solventOwner = await tenantFor(solvent.email, solvent.orgId);
    expect(await svc.listMyAlerts(solventOwner.tenant)).toEqual([]);
    const brokeOwner = await tenantFor(broke.email, broke.orgId);
    expect(await svc.listMyAlerts(brokeOwner.tenant)).toHaveLength(2);
  });

  it("different currency required_minor is never mixed in (no cross-currency math)", async () => {
    const adv = await advertiser();
    const plat = await platform("SUPER_ADMIN");
    const usd = await liveOffer(adv, plat, { ...V1, currency: "usd", advertiser_payout_minor: 3000, affiliate_commission_minor: 2000 }, "USD offer");
    const eur = await liveOffer(adv, plat, { ...V1, currency: "eur", advertiser_payout_minor: 900_000, affiliate_commission_minor: 800_000, network_margin_minor: 100_000 }, "EUR offer");
    // USD profile with capacity 4 000: enough for the USD offer (3 000); the EUR
    // 900 000 must NOT be mixed into the requirement (would otherwise pause).
    await billingProfile(adv, { funding_model: "CREDIT", currency: "USD", credit_limit_minor: 4_000, used_credit_minor: 0 });
    const { tenant, ctx } = await tenantFor(plat.email, plat.orgId);

    const ok = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(ok.decision.ok).toBe(true);
    expect(ok.decision.currency).toBe("USD");
    expect(ok.decision.required_minor).toBe(3000);
    expect(ok.ignored_other_currency_offer_ids).toEqual([eur.id]);
    expect(ok.paused_offer_ids).toEqual([]);
    expect(await status(usd.id)).toBe("LIVE");
    expect(await status(eur.id)).toBe("LIVE");
    expect(await count(`SELECT COUNT(*) AS n FROM funding_alerts`)).toBe(0);

    // Now make the USD requirement exceed capacity: a 4 500 USD offer. Required = 4 500 (not 900 000).
    const usd2 = await liveOffer(adv, plat, { ...V1, currency: "usd", advertiser_payout_minor: 4500, affiliate_commission_minor: 3500 }, "USD offer 2");
    const insufficient = await svc.evaluateFunding(ctx, tenant, adv.orgId, {}, META);
    expect(insufficient.decision.ok).toBe(false);
    expect(insufficient.decision.required_minor).toBe(4500);
    expect(insufficient.decision.capacity_minor).toBe(4000);
    expect(insufficient.decision.shortfall_minor).toBe(500);
    expect(insufficient.ignored_other_currency_offer_ids).toEqual([eur.id]);
    // Protection pauses every LIVE offer of the advertiser (the EUR one cannot be funded by this profile either).
    expect(new Set(insufficient.paused_offer_ids)).toEqual(new Set([usd.id, eur.id, usd2.id]));
    const alerts = await billing.listAlerts(adv.orgId as never);
    expect(alerts).toHaveLength(2);
    for (const a of alerts) {
      const payload = JSON.parse(a.payload) as { currency: string; required_minor: number; capacity_minor: number };
      expect(payload.currency).toBe("USD");
      expect(payload.required_minor).toBe(4500);
      expect(payload.capacity_minor).toBe(4000);
    }
    // A float / negative override is rejected before any I/O.
    await expectAppError(() => svc.evaluateFunding(ctx, tenant, adv.orgId, { required_minor: 10.5 }, META), 400, "VALIDATION_ERROR");
    await expectAppError(() => svc.evaluateFunding(ctx, tenant, adv.orgId, { required_minor: -1 }, META), 400, "VALIDATION_ERROR");
  });
});
