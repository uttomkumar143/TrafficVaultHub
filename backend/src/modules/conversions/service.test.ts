/**
 * ConversionService — Phase 4 Unit 5b tests (PRD §38–§40, §115, §124).
 * Definition-of-Done tests (by name):
 *   - "reversal keeps original and creates compensating record"
 *   - "fraud/compliance hold blocks PAYOUT_ELIGIBLE"
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { ConversionRepository } from "./repository";
import { ConversionService } from "./service";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
const PLAT = "org-plat";
const OFFER = "offer-1";
const VERSION = "ver-1";
const LINK = "link-1";
const USER = "user-1";
const NOW = new Date("2026-03-15T12:00:00.000Z");
const META = { ip_address: "203.0.113.9", user_agent: "vitest", request_id: "req-1" };
const T_ADV = ADV as TenantId;

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('${USER}', 'adv@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${PLAT}', 'PLATFORM', 'Plat', 'plat');
    INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', '${ADV}', 'ACTIVE', 'Adv Co');
    INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('fp1', '${AFF}', 'ACTIVE', 'Aff');
    INSERT INTO offers (id, organization_id, advertiser_profile_id, status, access_mode, name)
      VALUES ('${OFFER}', '${ADV}', 'ap1', 'LIVE', 'PUBLIC', 'Offer');
    INSERT INTO offer_versions (id, offer_id, organization_id, version_number, payout_type, currency, advertiser_payout_minor,
      affiliate_commission_minor, conversion_event, destination_url)
      VALUES ('${VERSION}', '${OFFER}', '${ADV}', 1, 'CPA', 'USD', 5000, 4000, 'signup', 'https://d.example/');
    UPDATE offers SET current_version_id = '${VERSION}' WHERE id = '${OFFER}';
    INSERT INTO tracking_links (id, organization_id, affiliate_profile_id, offer_id, offer_organization_id, code)
      VALUES ('${LINK}', '${AFF}', 'fp1', '${OFFER}', '${ADV}', 'abcdefgh');
    INSERT INTO clicks (id, organization_id, affiliate_profile_id, tracking_link_id, offer_id, offer_version_id, offer_organization_id,
      destination_url, clicked_at)
      VALUES ('click-1', '${AFF}', 'fp1', '${LINK}', '${OFFER}', '${VERSION}', '${ADV}', 'https://d.example/', '2026-03-15T11:00:00.000Z');
    INSERT INTO attribution_policies (id, offer_id, organization_id, version_number, window_seconds)
      VALUES ('pol-1', '${OFFER}', '${ADV}', 1, 2592000);
  `);
}

function conversion(db: TestD1, id: string, status: string, opts: { attributed?: boolean; click?: boolean; event?: string } = {}): void {
  const { attributed = true, click = true, event = "signup" } = opts;
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, click_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, occurred_at, received_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 10000, 'USD', '2026-03-15T11:30:00.000Z', '2026-03-15T11:31:00.000Z', ?)`,
    )
    .run(id, ADV, OFFER, VERSION, click ? "click-1" : null, AFF, `ext-${id}`, event, status, `${OFFER}|external_conversion_id|ext-${id}`);
  if (attributed) {
    db.sqlite
      .prepare(
        `INSERT INTO attributions (id, conversion_id, organization_id, click_id, affiliate_organization_id, offer_id, rule_version, decision, reason_code, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pol-1', 'ATTRIBUTED', 'LAST_CLICK', '2026-03-15T11:31:00.000Z')`,
      )
      .run(`att-${id}`, id, ADV, click ? "click-1" : null, AFF, OFFER);
  }
}

function tenantFor(orgId: string, type: "ADVERTISER" | "AFFILIATE" | "PLATFORM", perms: string[]): TenantContext {
  return {
    organization: { id: orgId, type, name: orgId, slug: orgId, status: "ACTIVE" },
    membership: { id: `m-${orgId}`, joined_at: null },
    role: { id: `r-${orgId}`, key: "custom", is_owner: false },
    permissions: new Set(perms),
  };
}
const ctx = { user: { id: USER, email: "adv@example.com" }, session: {} } as unknown as AuthenticatedContext;
const ALL = [
  "conversions.read",
  "conversions.approve",
  "conversions.reject",
  "conversions.reverse",
  "fraud.review",
  "fraud.manage",
  "compliance.resolve",
];
const adv = tenantFor(ADV, "ADVERTISER", ALL);
const advReader = tenantFor(ADV, "ADVERTISER", ["conversions.read"]);
const platform = tenantFor(ADV, "PLATFORM", ALL); // platform staff acting inside the advertiser tenant
const adv2 = tenantFor(ADV2, "ADVERTISER", ALL);

function count(db: TestD1, sql: string): number {
  return (db.sqlite.prepare(sql).get() as { n: number }).n;
}
function audits(db: TestD1, action: string): number {
  return (db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?").get(action) as { n: number }).n;
}

describe("ConversionService", () => {
  let db: TestD1;
  let repo: ConversionRepository;
  let svc: ConversionService;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new ConversionRepository(db);
    svc = new ConversionService(repo, db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it("approve: validation + guard + commission set once, history and audit in one batch; permission and tenant enforced", async () => {
    conversion(db, "c1", "PENDING");
    await expect(svc.approve(ctx, advReader, "c1", { reason_code: "OK" }, META)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(svc.approve(ctx, adv2, "c1", { reason_code: "OK" }, META)).rejects.toMatchObject({ status: 404 });

    const row = await svc.approve(ctx, adv, "c1", { reason_code: "MANUAL_APPROVAL" }, META);
    expect(row.lifecycle_status).toBe("APPROVED");
    expect(row.commission_amount_minor).toBe(4000);
    expect(row.commission_currency).toBe("USD");
    const detail = await svc.get(adv, "c1");
    expect(detail.history.map((h) => [h.from_status, h.to_status, h.actor_type, h.actor_user_id])).toEqual([
      ["PENDING", "APPROVED", "TENANT", USER],
    ]);
    expect(audits(db, "conversion.approved")).toBe(1);

    // already APPROVED → invalid edge, no second history/audit row
    await expect(svc.approve(ctx, adv, "c1", { reason_code: "AGAIN" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(1);
    expect(audits(db, "conversion.approved")).toBe(1);
  });

  it("approve refuses conversions that fail validation (422) or need review (409) and writes nothing", async () => {
    conversion(db, "c-noattr", "PENDING", { attributed: false });
    await expect(svc.approve(ctx, adv, "c-noattr", { reason_code: "OK" }, META)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_REJECTED",
    });

    conversion(db, "c-event", "PENDING", { event: "purchase" });
    await expect(svc.approve(ctx, adv, "c-event", { reason_code: "OK" }, META)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_REJECTED",
    });

    conversion(db, "c-hold", "PENDING");
    db.sqlite.exec(`UPDATE organizations SET status = 'RESTRICTED' WHERE id = '${AFF}'`);
    await expect(svc.approve(ctx, adv, "c-hold", { reason_code: "OK" }, META)).rejects.toMatchObject({
      status: 409,
      code: "VALIDATION_HOLD",
    });
    db.sqlite.exec(`UPDATE organizations SET status = 'ACTIVE' WHERE id = '${AFF}'`);

    // active CONVERSION_HOLD blocks → APPROVED via guardTransition
    await svc.placeHold(ctx, adv, { hold_type: "CONVERSION_HOLD", reason_code: "MANUAL_REVIEW", conversion_id: "c-hold" }, META);
    await expect(svc.approve(ctx, adv, "c-hold", { reason_code: "OK" }, META)).rejects.toMatchObject({ status: 409 });

    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM conversions WHERE lifecycle_status <> 'PENDING'")).toBe(0);
    expect(audits(db, "conversion.approved")).toBe(0);
  });

  it("reject/dispute require a reason; actor follows org type; FRAUD_REVIEW and DISPUTED decisions are platform-only", async () => {
    conversion(db, "c1", "PENDING");
    await expect(svc.reject(ctx, adv, "c1", { reason_code: "" }, META)).rejects.toMatchObject({ status: 400, code: "REASON_REQUIRED" });
    await expect(svc.reject(ctx, adv, "c1", { reason_code: "bad code!" }, META)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REASON_CODE",
    });
    // tenant may not send to FRAUD_REVIEW (state machine: PLATFORM/SYSTEM only)
    await expect(svc.sendToFraudReview(ctx, adv, "c1", { reason_code: "SUSPICIOUS" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
    });

    expect((await svc.reject(ctx, adv, "c1", { reason_code: "INVALID_LEAD", note: "bad phone" }, META)).lifecycle_status).toBe("REJECTED");
    expect((await svc.dispute(ctx, adv, "c1", { reason_code: "AFFILIATE_DISPUTE" }, META)).lifecycle_status).toBe("DISPUTED");
    // DISPUTED → APPROVED is PLATFORM only
    await expect(svc.approve(ctx, adv, "c1", { reason_code: "OK" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
    });
    expect((await svc.approve(ctx, platform, "c1", { reason_code: "DISPUTE_UPHELD" }, META)).lifecycle_status).toBe("APPROVED");

    const history = await repo.listHistory(T_ADV, "c1");
    expect(history.map((h) => `${h.to_status}:${h.actor_type}:${h.reason_code}`)).toEqual([
      "REJECTED:TENANT:INVALID_LEAD",
      "DISPUTED:TENANT:AFFILIATE_DISPUTE",
      "APPROVED:PLATFORM:DISPUTE_UPHELD",
    ]);
    expect(history[0]?.note).toBe("bad phone");

    conversion(db, "c2", "PENDING");
    expect((await svc.sendToFraudReview(ctx, platform, "c2", { reason_code: "VELOCITY" }, META)).lifecycle_status).toBe("FRAUD_REVIEW");
    expect(audits(db, "conversion.fraud_review")).toBe(1);
  });

  it("reversal keeps original and creates compensating record", async () => {
    conversion(db, "c1", "PENDING");
    await svc.approve(ctx, adv, "c1", { reason_code: "OK" }, META);
    const before = await repo.findById(T_ADV, "c1");

    await expect(svc.reverse(ctx, adv, "c1", { reason_code: "NOT_A_CODE" as never }, META)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REASON_CODE",
    });
    await expect(svc.reverse(ctx, advReader, "c1", { reason_code: "REFUND" }, META)).rejects.toMatchObject({ status: 403 });

    const detail = await svc.reverse(ctx, adv, "c1", { reason_code: "REFUND", note: "customer refunded" }, META);
    expect(detail.conversion.lifecycle_status).toBe("REVERSED");
    // original row untouched except lifecycle_status / updated_at
    const { lifecycle_status: _ls, updated_at: _ua, ...restBefore } = before!;
    const { lifecycle_status: _ls2, updated_at: _ua2, ...restAfter } = detail.conversion;
    expect(restAfter).toEqual(restBefore);
    expect(detail.conversion.commission_amount_minor).toBe(4000);
    expect(detail.conversion.sale_amount_minor).toBe(10000);
    // compensating record
    expect(detail.reversal).toMatchObject({
      conversion_id: "c1",
      reason_code: "REFUND",
      amount_minor: 4000,
      currency: "USD",
      reversed_by_user_id: USER,
      actor_type: "TENANT",
      note: "customer refunded",
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_reversals")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM conversions")).toBe(1);
    expect(audits(db, "conversion.reversed")).toBe(1);
    expect(detail.history.map((h) => h.to_status)).toEqual(["APPROVED", "REVERSED"]);

    // terminal: second reversal impossible, nothing written
    await expect(svc.reverse(ctx, adv, "c1", { reason_code: "CHARGEBACK" }, META)).rejects.toMatchObject({ status: 409 });
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_reversals")).toBe(1);
    // PENDING conversions cannot be reversed
    conversion(db, "c2", "PENDING");
    await expect(svc.reverse(ctx, adv, "c2", { reason_code: "REFUND" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
    });
  });

  it("fraud/compliance hold blocks PAYOUT_ELIGIBLE", async () => {
    conversion(db, "c1", "PENDING");
    await svc.approve(ctx, adv, "c1", { reason_code: "OK" }, META);
    await svc.internal.markLedgerPosted(T_ADV, "c1");
    await svc.internal.markEarned(T_ADV, "c1");

    // affiliate-scoped PAYOUT_HOLD from a fraud case
    await repo.insertHold(
      T_ADV,
      {
        id: "h-fraud",
        conversion_id: null,
        affiliate_organization_id: AFF,
        hold_type: "PAYOUT_HOLD",
        reason_code: "FRAUD_CASE",
        source_type: "FRAUD_CASE",
        source_id: "fc1",
        created_by_user_id: null,
      },
      NOW.toISOString(),
    );
    expect((await svc.isPayoutBlocked(adv, "c1")).blocked).toBe(true);
    await expect(svc.internal.markPayoutEligible(T_ADV, "c1")).rejects.toMatchObject({ status: 409 });
    expect((await repo.findById(T_ADV, "c1"))?.lifecycle_status).toBe("EARNED");

    await svc.releaseHold(ctx, adv, "h-fraud", { reason_code: "CASE_DISMISSED" }, META);
    // compliance block on the conversion itself
    await repo.insertHold(
      T_ADV,
      {
        id: "h-comp",
        conversion_id: "c1",
        affiliate_organization_id: null,
        hold_type: "COMPLIANCE_BLOCK",
        reason_code: "KYC_MISSING",
        source_type: "COMPLIANCE_CASE",
        source_id: "cc1",
        created_by_user_id: null,
      },
      NOW.toISOString(),
    );
    expect((await svc.isPayoutBlocked(adv, "c1")).facts).toEqual({ activeHoldTypes: ["COMPLIANCE_BLOCK"], fraudReviewOpen: false });
    await expect(svc.internal.markPayoutEligible(T_ADV, "c1")).rejects.toMatchObject({ status: 409 });
    // releasing a COMPLIANCE_BLOCK needs compliance.resolve
    await expect(
      svc.releaseHold(ctx, tenantFor(ADV, "ADVERTISER", ["conversions.read", "fraud.manage"]), "h-comp", { reason_code: "X" }, META),
    ).rejects.toMatchObject({ status: 403 });
    await svc.releaseHold(ctx, adv, "h-comp", { reason_code: "KYC_COMPLETE" }, META);

    // open fraud review on the affiliate also blocks
    db.sqlite.exec(`INSERT INTO fraud_cases (id, organization_id, affiliate_organization_id, status, severity, reason_code)
      VALUES ('fc2', '${ADV}', '${AFF}', 'UNDER_REVIEW', 'HIGH', 'VELOCITY')`);
    expect((await svc.isPayoutBlocked(adv, "c1")).blocked).toBe(true);
    await expect(svc.internal.markPayoutEligible(T_ADV, "c1")).rejects.toMatchObject({ status: 409 });
    db.sqlite.exec(`UPDATE fraud_cases SET status = 'DISMISSED' WHERE id = 'fc2'`);

    expect((await svc.isPayoutBlocked(adv, "c1")).blocked).toBe(false);
    expect((await svc.internal.markPayoutEligible(T_ADV, "c1")).lifecycle_status).toBe("PAYOUT_ELIGIBLE");
    expect((await svc.internal.markPaid(T_ADV, "c1")).lifecycle_status).toBe("PAID");
    const history = await repo.listHistory(T_ADV, "c1");
    expect(history.map((h) => `${h.to_status}:${h.actor_type}`)).toEqual([
      "APPROVED:TENANT",
      "LEDGER_POSTED:INTERNAL",
      "EARNED:INTERNAL",
      "PAYOUT_ELIGIBLE:INTERNAL",
      "PAID:INTERNAL",
    ]);
    expect(history.filter((h) => h.actor_type === "INTERNAL").every((h) => h.actor_user_id === null)).toBe(true);
    expect(audits(db, "conversion.internal.paid")).toBe(1);
  });

  it("internal-only statuses are unreachable through tenant decisions; internal ops respect the edges", async () => {
    conversion(db, "c1", "PENDING");
    await svc.approve(ctx, platform, "c1", { reason_code: "OK" }, META);
    // no public method targets LEDGER_POSTED..PAID; the private edge check rejects them defensively
    const anySvc = svc as unknown as { assertEdge: (f: string, t: string, a: string) => void };
    expect(() => anySvc.assertEdge("APPROVED", "LEDGER_POSTED", "PLATFORM")).toThrow(/internal-only/);
    // internal ops still obey the machine: EARNED cannot be reached from APPROVED directly
    await expect(svc.internal.markEarned(T_ADV, "c1")).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    await expect(svc.internal.markLedgerPosted("org-adv-2" as TenantId, "c1")).rejects.toMatchObject({ status: 404 });
    // SYSTEM intake path
    conversion(db, "c2", "RECEIVED");
    expect((await svc.internal.systemTransition(T_ADV, "c2", "VALIDATING", "INTAKE")).lifecycle_status).toBe("VALIDATING");
    expect((await svc.internal.systemTransition(T_ADV, "c2", "PENDING", "VALIDATED")).lifecycle_status).toBe("PENDING");
    await expect(svc.internal.systemTransition(T_ADV, "c2", "APPROVED", "NOPE")).rejects.toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
    });
  });

  it("holds: placeHold scope/permission rules, list/get expose active holds and payout_blocked", async () => {
    conversion(db, "c1", "PENDING");
    await expect(svc.placeHold(ctx, adv, { hold_type: "CONVERSION_HOLD", reason_code: "X" }, META)).rejects.toMatchObject({
      status: 400,
      code: "HOLD_SCOPE_REQUIRED",
    });
    await expect(
      svc.placeHold(
        ctx,
        tenantFor(ADV, "ADVERTISER", ["conversions.approve"]),
        { hold_type: "PAYOUT_HOLD", reason_code: "X", affiliate_organization_id: AFF },
        META,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.placeHold(ctx, adv, { hold_type: "CONVERSION_HOLD", reason_code: "X", conversion_id: "nope" }, META),
    ).rejects.toMatchObject({ status: 404 });

    const hold = await svc.placeHold(
      ctx,
      adv,
      { hold_type: "PAYOUT_HOLD", reason_code: "MANUAL_PAYOUT_HOLD", affiliate_organization_id: AFF },
      META,
    );
    expect(hold).toMatchObject({ status: "ACTIVE", source_type: "MANUAL", created_by_user_id: USER, affiliate_organization_id: AFF });
    expect(audits(db, "conversion.hold.placed")).toBe(1);

    const detail = await svc.get(adv, "c1");
    expect(detail.active_holds.map((h) => h.id)).toEqual([hold.id]);
    expect(detail.payout_blocked).toBe(true);
    const page = await svc.list(adv, { limit: 10, cursor: null }, { lifecycle_status: "PENDING" });
    expect(page.items.map((r) => r.id)).toEqual(["c1"]);
    await expect(svc.list(adv2, { limit: 10, cursor: null }, {})).resolves.toMatchObject({ items: [] });

    await svc.releaseHold(ctx, adv, hold.id, { reason_code: "CLEARED" }, META);
    await expect(svc.releaseHold(ctx, adv, hold.id, { reason_code: "CLEARED" }, META)).rejects.toMatchObject({
      status: 409,
      code: "HOLD_NOT_ACTIVE",
    });
    await expect(svc.releaseHold(ctx, adv2, hold.id, { reason_code: "CLEARED" }, META)).rejects.toMatchObject({ status: 404 });
    expect((await svc.get(adv, "c1")).payout_blocked).toBe(false);
  });
});
