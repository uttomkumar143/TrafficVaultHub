/**
 * FraudService — Phase 4 Unit 7b tests (PRD §41–§44, §115).
 * Definition-of-Done tests (by name):
 *   - "fraud action CONVERSION_HOLD/PAYOUT_HOLD creates a conversion hold in the same batch and blocks payout"
 *   - "PAYOUT_HOLD and account-level actions require fraud.manage; account actions are recorded only"
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { ConversionRepository } from "../conversions/repository";
import { ConversionService } from "../conversions/service";
import { FraudRepository } from "./repository";
import { FraudService } from "./service";

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

function conversion(db: TestD1, id: string, status: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO conversions (id, organization_id, offer_id, offer_version_id, click_id, affiliate_organization_id, external_conversion_id,
         conversion_event, status, lifecycle_status, sale_amount_minor, currency, occurred_at, received_at, idempotency_key)
       VALUES (?, ?, ?, ?, 'click-1', ?, ?, 'signup', 'PENDING', ?, 10000, 'USD', '2026-03-15T11:30:00.000Z', '2026-03-15T11:31:00.000Z', ?)`,
    )
    .run(id, ADV, OFFER, VERSION, AFF, `ext-${id}`, status, `${OFFER}|external_conversion_id|ext-${id}`);
  db.sqlite
    .prepare(
      `INSERT INTO attributions (id, conversion_id, organization_id, click_id, affiliate_organization_id, offer_id, rule_version, decision, reason_code, decided_at)
       VALUES (?, ?, ?, 'click-1', ?, ?, 'pol-1', 'ATTRIBUTED', 'LAST_CLICK', '2026-03-15T11:31:00.000Z')`,
    )
    .run(`att-${id}`, id, ADV, AFF, OFFER);
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
const ALL = ["conversions.read", "conversions.approve", "fraud.read", "fraud.review", "fraud.manage"];
const platform = tenantFor(ADV, "PLATFORM", ALL); // platform staff acting inside the advertiser tenant
const platformReviewer = tenantFor(ADV, "PLATFORM", ["fraud.read", "fraud.review"]);
const adv = tenantFor(ADV, "ADVERTISER", ALL);
const advReader = tenantFor(ADV, "ADVERTISER", ["fraud.read"]);
const adv2 = tenantFor(ADV2, "ADVERTISER", ALL);

function count(db: TestD1, sql: string, ...args: string[]): number {
  return (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}
function audits(db: TestD1, action: string): number {
  return count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?", action);
}

const HIGH_RISK_FACTS = {
  velocity: { window_seconds: 3600, conversions_in_window: 500, clicks_in_window: 600 },
  duplicates: { same_transaction_id_count: 5, same_fingerprint_count: 9 },
  timing: { clicked_at: "2026-03-15T11:00:00.000Z", occurred_at: "2026-03-15T11:00:00.500Z" },
  automation: { user_agent: "HeadlessChrome/120", same_user_agent_click_count: 300 },
};

describe("FraudService", () => {
  let db: TestD1;
  let convRepo: ConversionRepository;
  let convSvc: ConversionService;
  let svc: FraudService;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    convRepo = new ConversionRepository(db);
    convSvc = new ConversionService(convRepo, db, { now: () => NOW });
    svc = new FraudService(new FraudRepository(db), convRepo, db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it("assess stores evidence (never a verdict) and auto-opens a case in the same batch at the threshold", async () => {
    conversion(db, "c1", "PENDING");
    await expect(svc.assess(ctx, advReader, { subject_type: "CONVERSION", subject_id: "c1", facts: {} }, META)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    await expect(svc.assess(ctx, adv2, { subject_type: "CONVERSION", subject_id: "c1", facts: {} }, META)).rejects.toMatchObject({
      status: 404,
    });

    const low = await svc.assess(
      ctx,
      platform,
      { subject_type: "CONVERSION", subject_id: "c1", facts: {}, open_case_at_or_above: "HIGH" },
      META,
    );
    expect(low.risk.level).toBe("LOW");
    expect(low.case).toBeNull();
    expect(low.assessment.conversion_id).toBe("c1");
    expect(low.assessment.affiliate_organization_id).toBe(AFF);

    const high = await svc.assess(
      ctx,
      platform,
      { subject_type: "CONVERSION", subject_id: "c1", facts: HIGH_RISK_FACTS, open_case_at_or_above: "HIGH" },
      META,
    );
    expect(["HIGH", "CRITICAL"]).toContain(high.risk.level);
    expect(high.case).not.toBeNull();
    expect(high.case?.status).toBe("OPEN");
    expect(high.case?.assessment_id).toBe(high.assessment.id);
    expect(high.case?.reason_code).toBe(`AUTO_RISK_${high.risk.level}`);
    expect(JSON.parse(high.assessment.signals_json)).toEqual(high.risk.signals);

    // evidence only: the conversion's lifecycle is untouched
    const conv = await convRepo.findById(T_ADV, "c1");
    expect(conv?.lifecycle_status).toBe("PENDING");
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_assessments")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_cases")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_case_events WHERE event_type = 'OPENED' AND actor_type = 'SYSTEM'")).toBe(1);
    expect(audits(db, "fraud.assessed")).toBe(2);
    const listed = await svc.listAssessments(platform, "CONVERSION", "c1");
    expect(listed).toHaveLength(2);
  });

  it("case machine: valid path OPEN→UNDER_REVIEW→CONFIRMED→APPEALED→APPEAL_REJECTED→CLOSED with INSERT-only events + audit per step", async () => {
    conversion(db, "c1", "PENDING");
    const opened = await svc.openCase(ctx, platform, { severity: "HIGH", reason_code: "MANUAL_SUSPICION", conversion_id: "c1" }, META);
    expect(opened.status).toBe("OPEN");
    expect(opened.affiliate_organization_id).toBe(AFF);
    await expect(svc.openCase(ctx, platform, { severity: "HIGH", reason_code: "bad code" }, META)).rejects.toMatchObject({
      code: "INVALID_REASON_CODE",
    });

    await svc.assign(ctx, platform, opened.id, USER, META);
    await svc.addNote(ctx, adv, opened.id, "looks like bot traffic", META);

    let row = await svc.transition(ctx, platform, opened.id, "UNDER_REVIEW", {}, META);
    expect(row.status).toBe("UNDER_REVIEW");
    // decisions need a reason code
    await expect(svc.transition(ctx, platform, opened.id, "CONFIRMED", {}, META)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    row = await svc.transition(ctx, platform, opened.id, "CONFIRMED", { reason_code: "BOT_TRAFFIC" }, META);
    expect(row.status).toBe("CONFIRMED");
    expect(row.decision_reason_code).toBe("BOT_TRAFFIC");
    expect(row.decided_at).toBe(NOW.toISOString());

    // appeal: tenant side with fraud.read, note required
    await expect(svc.transition(ctx, advReader, opened.id, "APPEALED", {}, META)).rejects.toMatchObject({ code: "NOTE_REQUIRED" });
    row = await svc.transition(ctx, advReader, opened.id, "APPEALED", { note: "our traffic is human, see logs" }, META);
    expect(row.status).toBe("APPEALED");
    expect(row.appeal_note).toBe("our traffic is human, see logs");
    expect(row.appealed_by_user_id).toBe(USER);

    // tenant cannot decide the appeal
    await expect(svc.transition(ctx, adv, opened.id, "APPEAL_REJECTED", { reason_code: "X" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_CASE_TRANSITION",
    });
    row = await svc.transition(ctx, platform, opened.id, "APPEAL_REJECTED", { reason_code: "EVIDENCE_STANDS" }, META);
    expect(row.status).toBe("APPEAL_REJECTED");
    row = await svc.transition(ctx, platform, opened.id, "CLOSED", {}, META);
    expect(row.status).toBe("CLOSED");

    const detail = await svc.getCase(platform, opened.id);
    expect(detail.events.map((e) => [e.event_type, e.from_status, e.to_status, e.actor_type])).toEqual([
      ["OPENED", null, "OPEN", "PLATFORM"],
      ["ASSIGNED", null, null, "PLATFORM"],
      ["NOTE_ADDED", null, null, "TENANT"],
      ["STATUS_CHANGED", "OPEN", "UNDER_REVIEW", "PLATFORM"],
      ["STATUS_CHANGED", "UNDER_REVIEW", "CONFIRMED", "PLATFORM"],
      ["APPEAL_FILED", "CONFIRMED", "APPEALED", "TENANT"],
      ["APPEAL_DECIDED", "APPEALED", "APPEAL_REJECTED", "PLATFORM"],
      ["CLOSED", "APPEAL_REJECTED", "CLOSED", "PLATFORM"],
    ]);
    expect(audits(db, "fraud.case.opened")).toBe(1);
    expect(audits(db, "fraud.case.under_review")).toBe(1);
    expect(audits(db, "fraud.case.confirmed")).toBe(1);
    expect(audits(db, "fraud.case.appealed")).toBe(1);
    expect(audits(db, "fraud.case.appeal_rejected")).toBe(1);
    expect(audits(db, "fraud.case.closed")).toBe(1);
    // closed cases are frozen
    await expect(svc.addNote(ctx, adv, opened.id, "late", META)).rejects.toMatchObject({ code: "CASE_CLOSED" });
    await expect(svc.transition(ctx, platform, opened.id, "OPEN", {}, META)).rejects.toMatchObject({ code: "INVALID_CASE_TRANSITION" });
  });

  it("invalid edge → 409 INVALID_CASE_TRANSITION; stale status → 409 CASE_STATE_CONFLICT with nothing written; tenant isolation", async () => {
    const opened = await svc.openCase(ctx, platform, { severity: "MEDIUM", reason_code: "VELOCITY", affiliate_organization_id: AFF }, META);
    await expect(svc.transition(ctx, platform, opened.id, "CONFIRMED", { reason_code: "X" }, META)).rejects.toMatchObject({
      status: 409,
      code: "INVALID_CASE_TRANSITION",
    });
    // tenant (non-platform) cannot start review even with the permission
    await expect(svc.transition(ctx, adv, opened.id, "UNDER_REVIEW", {}, META)).rejects.toMatchObject({ code: "INVALID_CASE_TRANSITION" });
    // other tenant cannot see the case
    await expect(svc.getCase(adv2, opened.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.transition(ctx, tenantFor(ADV2, "PLATFORM", ALL), opened.id, "UNDER_REVIEW", {}, META)).rejects.toMatchObject({
      status: 404,
    });

    const eventsBefore = count(db, "SELECT COUNT(*) AS n FROM fraud_case_events");
    const auditsBefore = count(db, "SELECT COUNT(*) AS n FROM audit_logs");
    // simulate a concurrent change between read and write
    db.sqlite.exec(`UPDATE fraud_cases SET status = 'UNDER_REVIEW' WHERE id = '${opened.id}'`);
    // service re-reads, so force staleness by racing through the repository guard directly
    const repo = new FraudRepository(db);
    const ok = await repo.batch([
      repo.statusStatement(T_ADV, opened.id, "OPEN", "UNDER_REVIEW", NOW.toISOString()),
      repo.eventStatement(
        T_ADV,
        {
          case_id: opened.id,
          event_type: "STATUS_CHANGED",
          from_status: "OPEN",
          to_status: "UNDER_REVIEW",
          actor_type: "PLATFORM",
          actor_user_id: USER,
          reason_code: null,
          note: null,
          request_id: null,
        },
        NOW.toISOString(),
      ),
    ]);
    expect(ok).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_case_events")).toBe(eventsBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(auditsBefore);
    expect((db.sqlite.prepare("SELECT status FROM fraud_cases WHERE id = ?").get(opened.id) as { status: string }).status).toBe(
      "UNDER_REVIEW",
    );

    // the service surfaces the same guard as CASE_STATE_CONFLICT
    const svcSpy = new FraudService(
      {
        ...repo,
        findCase: async () => ({ ...opened, status: "OPEN" as const }),
        listEvents: repo.listEvents.bind(repo),
        listActions: repo.listActions.bind(repo),
        statusStatement: repo.statusStatement.bind(repo),
        eventStatement: repo.eventStatement.bind(repo),
        batch: repo.batch.bind(repo),
      } as unknown as FraudRepository,
      convRepo,
      db,
      { now: () => NOW },
    );
    await expect(svcSpy.transition(ctx, platform, opened.id, "UNDER_REVIEW", {}, META)).rejects.toMatchObject({
      status: 409,
      code: "CASE_STATE_CONFLICT",
    });
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_case_events")).toBe(eventsBefore);
  });

  it("fraud action CONVERSION_HOLD/PAYOUT_HOLD creates a conversion hold in the same batch and blocks payout", async () => {
    conversion(db, "c1", "PENDING");
    const opened = await svc.openCase(ctx, platform, { severity: "HIGH", reason_code: "DUPLICATE_TXN", conversion_id: "c1" }, META);

    // tenant actors can never take actions
    await expect(svc.takeAction(ctx, adv, opened.id, { action_type: "MONITOR", reason_code: "X" }, META)).rejects.toMatchObject({
      status: 403,
      code: "PLATFORM_ONLY",
    });

    const holdRes = await svc.takeAction(
      ctx,
      platformReviewer,
      opened.id,
      { action_type: "CONVERSION_HOLD", reason_code: "DUPLICATE_TXN" },
      META,
    );
    expect(holdRes.hold_id).not.toBeNull();
    expect(holdRes.action.action_type).toBe("CONVERSION_HOLD");
    expect(holdRes.action.hold_id).toBe(holdRes.hold_id);
    const hold = db.sqlite.prepare("SELECT * FROM conversion_holds WHERE id = ?").get(holdRes.hold_id) as Record<string, unknown>;
    expect(hold).toMatchObject({
      organization_id: ADV,
      conversion_id: "c1",
      hold_type: "CONVERSION_HOLD",
      status: "ACTIVE",
      source_type: "FRAUD_CASE",
      source_id: opened.id,
      created_by_user_id: USER,
    });
    // an active CONVERSION_HOLD blocks approval through the conversion state machine
    await expect(convSvc.approve(ctx, adv, "c1", { reason_code: "OK" }, META)).rejects.toMatchObject({ status: 409 });

    // PAYOUT_HOLD (fraud.manage) → payout blocked for the conversion
    const payoutRes = await svc.takeAction(
      ctx,
      platform,
      opened.id,
      { action_type: "PAYOUT_HOLD", reason_code: "PENDING_INVESTIGATION" },
      META,
    );
    expect(payoutRes.hold_id).not.toBeNull();
    const blocked = await convSvc.isPayoutBlocked(adv, "c1");
    expect(blocked.blocked).toBe(true);
    const types = [...blocked.facts.activeHoldTypes].sort();
    expect(types).toEqual(["CONVERSION_HOLD", "PAYOUT_HOLD"]);
    expect(blocked.facts.fraudReviewOpen).toBe(true);

    // affiliate-scoped PAYOUT_HOLD when the case has no conversion
    const affCase = await svc.openCase(ctx, platform, { severity: "HIGH", reason_code: "PATTERN", affiliate_organization_id: AFF }, META);
    const affHold = await svc.takeAction(ctx, platform, affCase.id, { action_type: "PAYOUT_HOLD", reason_code: "PATTERN" }, META);
    const affRow = db.sqlite.prepare("SELECT * FROM conversion_holds WHERE id = ?").get(affHold.hold_id) as Record<string, unknown>;
    expect(affRow).toMatchObject({ conversion_id: null, affiliate_organization_id: AFF, hold_type: "PAYOUT_HOLD", source_id: affCase.id });
    // CONVERSION_HOLD without a conversion is refused
    await expect(
      svc.takeAction(ctx, platform, affCase.id, { action_type: "CONVERSION_HOLD", reason_code: "X" }, META),
    ).rejects.toMatchObject({
      code: "CONVERSION_REQUIRED",
    });

    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_actions")).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_holds")).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS n FROM fraud_case_events WHERE event_type = 'ACTION_TAKEN'")).toBe(3);
    expect(audits(db, "fraud.action.taken")).toBe(3);
  });

  it("PAYOUT_HOLD and account-level actions require fraud.manage; account actions are recorded only", async () => {
    conversion(db, "c1", "PENDING");
    const opened = await svc.openCase(ctx, platform, { severity: "CRITICAL", reason_code: "BOT_NETWORK", conversion_id: "c1" }, META);

    for (const action_type of ["PAYOUT_HOLD", "ACCOUNT_RESTRICTION", "ACCOUNT_SUSPENSION"] as const) {
      await expect(
        svc.takeAction(ctx, platformReviewer, opened.id, { action_type, reason_code: "BOT_NETWORK" }, META),
      ).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    }
    for (const action_type of ["MONITOR", "MANUAL_REVIEW", "TRAFFIC_RESTRICTION"] as const) {
      const res = await svc.takeAction(ctx, platformReviewer, opened.id, { action_type, reason_code: "BOT_NETWORK" }, META);
      expect(res.hold_id).toBeNull();
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_holds")).toBe(0);

    const before = (db.sqlite.prepare("SELECT status FROM organizations WHERE id = ?").get(AFF) as { status: string }).status;
    const restricted = await svc.takeAction(
      ctx,
      platform,
      opened.id,
      { action_type: "ACCOUNT_SUSPENSION", reason_code: "BOT_NETWORK" },
      META,
    );
    expect(restricted.action.action_type).toBe("ACCOUNT_SUSPENSION");
    expect(restricted.action.affiliate_organization_id).toBe(AFF);
    expect(restricted.hold_id).toBeNull();
    // recorded only: organizations.status is NOT mutated (known gap), audit metadata says so
    const after = (db.sqlite.prepare("SELECT status FROM organizations WHERE id = ?").get(AFF) as { status: string }).status;
    expect(after).toBe(before);
    const audit = db.sqlite
      .prepare("SELECT metadata FROM audit_logs WHERE action = 'fraud.action.taken' AND target_id = ?")
      .get(restricted.action.id) as { metadata: string };
    expect(JSON.parse(audit.metadata)).toMatchObject({ action_type: "ACCOUNT_SUSPENSION", record_only: true, case_id: opened.id });
    const monitorAudit = db.sqlite
      .prepare(
        "SELECT metadata FROM audit_logs WHERE action = 'fraud.action.taken' AND json_extract(metadata, '$.action_type') = 'MONITOR'",
      )
      .get() as { metadata: string };
    expect(JSON.parse(monitorAudit.metadata).record_only).toBe(false);

    // no actions on closed cases
    db.sqlite.exec(`UPDATE fraud_cases SET status = 'CLOSED' WHERE id = '${opened.id}'`);
    await expect(svc.takeAction(ctx, platform, opened.id, { action_type: "MONITOR", reason_code: "X" }, META)).rejects.toMatchObject({
      code: "CASE_CLOSED",
    });
  });
});
