/**
 * ComplianceService — Phase 4 Unit 8c tests (PRD §45–§47, §115, §132).
 * Real migrations 0001–0009 over node:sqlite; every assertion reads the DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import type { TenantContext } from "../../middleware/require-org";
import type { AuthenticatedContext } from "../auth/service";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { ConversionRepository } from "../conversions/repository";
import { ConversionService } from "../conversions/service";
import { ComplianceRepository } from "./repository";
import { ComplianceService } from "./service";

const ADV = "org-adv-1";
const ADV2 = "org-adv-2";
const AFF = "org-aff-1";
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
const ALL = ["conversions.read", "conversions.approve", "compliance.read", "compliance.resolve", "compliance.manage", "fraud.manage"];
const platform = tenantFor(ADV, "PLATFORM", ALL); // platform staff acting inside the advertiser tenant
const adv = tenantFor(ADV, "ADVERTISER", ALL);
const advResolver = tenantFor(ADV, "ADVERTISER", ["compliance.read", "compliance.resolve"]);
const advReader = tenantFor(ADV, "ADVERTISER", ["compliance.read"]);
const adv2 = tenantFor(ADV2, "ADVERTISER", ALL);

function count(db: TestD1, sql: string, ...args: string[]): number {
  return (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}
function audits(db: TestD1, action: string): number {
  return count(db, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?", action);
}
async function rejects(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

describe("ComplianceService", () => {
  let db: TestD1;
  let convRepo: ConversionRepository;
  let repo: ComplianceRepository;
  let svc: ComplianceService;
  let conversions: ConversionService;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    convRepo = new ConversionRepository(db);
    repo = new ComplianceRepository(db);
    svc = new ComplianceService(repo, convRepo, db, { now: () => NOW });
    conversions = new ConversionService(convRepo, db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it("rule versions are append-only and audited; platform_wide needs a PLATFORM actor; invalid definitions are rejected before any write", async () => {
    const v1 = await svc.createRuleVersion(
      ctx,
      platform,
      { rule_key: "geo", severity: "BLOCKING", applies_to: "AFFILIATE", definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] }, platform_wide: true },
      META,
    );
    expect(v1.organization_id).toBeNull();
    expect(v1.version_number).toBe(1);
    const v2 = await svc.createRuleVersion(
      ctx,
      platform,
      { rule_key: "geo", severity: "BLOCKING", applies_to: "AFFILIATE", definition: { kind: "GEOGRAPHY", restricted_countries: ["KP", "IR"] }, platform_wide: true },
      META,
    );
    expect(v2.version_number).toBe(2);
    expect(v2.is_current).toBe(1);
    expect((await repo.findRule(T_ADV, v1.id))?.is_current).toBe(0);
    expect((await repo.findRule(T_ADV, v1.id))?.definition_json).toContain('"KP"'); // v1 untouched
    expect(await svc.listRuleVersions(adv, "geo")).toHaveLength(2);
    expect(audits(db, "compliance.rule.version_created")).toBe(2);

    // tenant cannot publish platform-wide; can publish tenant-owned (visible only to itself)
    await rejects(
      svc.createRuleVersion(ctx, adv, { rule_key: "geo", severity: "INFO", applies_to: "AFFILIATE", definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] }, platform_wide: true }, META),
      403,
      "PLATFORM_ONLY",
    );
    const own = await svc.createRuleVersion(
      ctx,
      adv,
      { rule_key: "geo", severity: "WARNING", applies_to: "AFFILIATE", definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] } },
      META,
    );
    expect(own.organization_id).toBe(ADV);
    expect((await svc.listRules(adv2)).map((r) => r.id)).toEqual([v2.id]); // ADV2 sees only the platform rule
    expect((await svc.listRules(adv)).map((r) => r.id)).toEqual([own.id, v2.id]); // tenant rule ordered first

    // validation happens before any write
    const before = count(db, "SELECT COUNT(*) AS n FROM compliance_rules");
    await rejects(
      svc.createRuleVersion(ctx, adv, { rule_key: "bad", severity: "INFO", applies_to: "OFFER", definition: { kind: "NOPE" } }, META),
      400,
      "INVALID_RULE_DEFINITION",
    );
    await rejects(
      svc.createRuleVersion(ctx, adv, { rule_key: "Bad Key!", severity: "INFO", applies_to: "OFFER", definition: { kind: "KEYWORDS", forbidden: [] } }, META),
      400,
      "INVALID_RULE_KEY",
    );
    await rejects(
      svc.createRuleVersion(ctx, advResolver, { rule_key: "x", severity: "INFO", applies_to: "OFFER", definition: { kind: "KEYWORDS", forbidden: [] } }, META),
      403,
      "FORBIDDEN",
    );
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_rules")).toBe(before);
  });

  it("missing required information yields INSUFFICIENT_INFORMATION (never PASS) and a BLOCKING rule opens a case with a COMPLIANCE_BLOCK hold in the same batch", async () => {
    conversion(db, "c-1", "APPROVED");
    await svc.createRuleVersion(
      ctx,
      platform,
      { rule_key: "geo", severity: "BLOCKING", applies_to: "CONVERSION", definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] }, platform_wide: true },
      META,
    );
    await svc.createRuleVersion(
      ctx,
      adv,
      { rule_key: "kw", severity: "INFO", applies_to: "CONVERSION", definition: { kind: "KEYWORDS", forbidden: ["free money"] } },
      META,
    );

    // facts carry keywords but NOT target_countries → geo is INSUFFICIENT_INFORMATION
    const res = await svc.evaluate(ctx, adv, { subject_type: "CONVERSION", subject_id: "c-1", facts: { keywords: ["signup bonus"] } }, META);
    expect(res.result.outcome).toBe("INSUFFICIENT_INFORMATION");
    expect(res.result.blocking).toBe(true);
    expect(res.evaluations).toHaveLength(2);
    const geoEval = res.evaluations.find((e) => e.outcome === "INSUFFICIENT_INFORMATION");
    expect(geoEval?.reason_code).toBe("MISSING_REQUIRED_FACTS");
    expect(JSON.parse(geoEval?.details_json ?? "{}").missing).toEqual(["target_countries"]);
    expect(res.evaluations.filter((e) => e.outcome === "PASS")).toHaveLength(1);
    expect(res.evaluations.some((e) => e.outcome === "PASS" && e.rule_id === geoEval?.rule_id)).toBe(false);

    // case + hold written in the same batch
    expect(res.case).not.toBeNull();
    expect(res.case?.status).toBe("OPEN");
    expect(res.case?.severity).toBe("BLOCKING");
    expect(res.case?.reason_code).toBe("MISSING_REQUIRED_FACTS");
    expect(res.case?.evaluation_id).toBe(geoEval?.id);
    expect(geoEval?.case_id).toBe(res.case?.id);
    expect(res.hold_id).not.toBeNull();
    expect(res.case?.hold_id).toBe(res.hold_id);
    const hold = await convRepo.findHold(T_ADV, res.hold_id as string);
    expect(hold).toMatchObject({ hold_type: "COMPLIANCE_BLOCK", status: "ACTIVE", source_type: "COMPLIANCE_CASE", source_id: res.case?.id, conversion_id: "c-1" });
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_case_events WHERE case_id = ? AND event_type = 'OPENED'", res.case?.id as string)).toBe(1);
    expect(audits(db, "compliance.evaluated")).toBe(1);

    // the hold blocks payout eligibility through the conversion state machine
    expect((await conversions.isPayoutBlocked(adv, "c-1")).blocked).toBe(true);
    expect(db.sqlite.prepare("SELECT lifecycle_status FROM conversions WHERE id = 'c-1'").get()).toEqual({ lifecycle_status: "APPROVED" });

    // full facts → PASS, no new case; evaluations are INSERT-only (history grows)
    const ok = await svc.evaluate(ctx, adv, { subject_type: "CONVERSION", subject_id: "c-1", facts: { keywords: ["x"], target_countries: ["US"] } }, META);
    expect(ok.result.outcome).toBe("PASS");
    expect(ok.case).toBeNull();
    expect(ok.hold_id).toBeNull();
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_evaluations")).toBe(4);
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_cases")).toBe(1);

    // permissions and tenant isolation
    await rejects(svc.evaluate(ctx, advReader, { subject_type: "CONVERSION", subject_id: "c-1", facts: {} }, META), 403, "FORBIDDEN");
    await rejects(svc.evaluate(ctx, adv2, { subject_type: "CONVERSION", subject_id: "c-1", facts: {} }, META), 404, "NOT_FOUND");
    await rejects(svc.getCase(adv2, res.case?.id as string), 404, "NOT_FOUND");
  });

  it("case lifecycle: guarded transitions, note/reason requirements, escalation needs platform compliance.manage; stale status rolls the batch back", async () => {
    const opened = await svc.openCase(
      ctx,
      advResolver,
      { subject_type: "AFFILIATE", subject_id: AFF, severity: "WARNING", reason_code: "BRAND_BIDDING_SUSPECTED", summary: "brand term in ad copy" },
      META,
    );
    expect(opened.status).toBe("OPEN");
    expect(opened.hold_id).toBeNull(); // WARNING → no hold
    expect(opened.affiliate_organization_id).toBe(AFF);

    await rejects(svc.transition(ctx, advReader, opened.id, "INVESTIGATING", {}, META), 403, "FORBIDDEN");
    await rejects(svc.transition(ctx, advResolver, opened.id, "CLOSED", {}, META), 409, "INVALID_CASE_TRANSITION");
    await rejects(svc.transition(ctx, advResolver, opened.id, "RESOLVED", {}, META), 400, "USE_RESOLVE");

    const inv = await svc.transition(ctx, advResolver, opened.id, "INVESTIGATING", {}, META);
    expect(inv.status).toBe("INVESTIGATING");
    await rejects(svc.transition(ctx, advResolver, opened.id, "WAITING_FOR_INFORMATION", {}, META), 400, "NOTE_REQUIRED");
    const waiting = await svc.transition(ctx, advResolver, opened.id, "WAITING_FOR_INFORMATION", { note: "please send the creatives" }, META);
    expect(waiting.status).toBe("WAITING_FOR_INFORMATION");
    await svc.addNote(ctx, advReader, opened.id, "creatives received via email", META);
    const back = await svc.transition(ctx, advResolver, opened.id, "INVESTIGATING", {}, META);
    expect(back.status).toBe("INVESTIGATING");

    await rejects(svc.transition(ctx, advResolver, opened.id, "ESCALATED", {}, META), 400, "REASON_REQUIRED");
    await rejects(svc.transition(ctx, advResolver, opened.id, "ESCALATED", { reason_code: "bad code" }, META), 400, "INVALID_REASON_CODE");
    const esc = await svc.transition(ctx, advResolver, opened.id, "ESCALATED", { reason_code: "NEEDS_PLATFORM_REVIEW" }, META);
    expect(esc.status).toBe("ESCALATED");

    // tenant cannot de-escalate or resolve an escalated case; platform without compliance.manage cannot either
    await rejects(svc.transition(ctx, adv, opened.id, "INVESTIGATING", {}, META), 409, "INVALID_CASE_TRANSITION");
    await rejects(svc.resolve(ctx, adv, opened.id, { resolution: "NO_ACTION", reason_code: "X" }, META), 409, "INVALID_CASE_TRANSITION");
    await rejects(
      svc.resolve(ctx, tenantFor(ADV, "PLATFORM", ["compliance.read", "compliance.resolve"]), opened.id, { resolution: "NO_ACTION", reason_code: "X" }, META),
      403,
      "FORBIDDEN",
    );

    // stale expected status → CHECK sentinel → whole batch rolls back, nothing written
    db.sqlite.prepare("UPDATE compliance_cases SET status = 'INVESTIGATING' WHERE id = ?").run(opened.id);
    const eventsBefore = count(db, "SELECT COUNT(*) AS n FROM compliance_case_events WHERE case_id = ?", opened.id);
    const auditBefore = count(db, "SELECT COUNT(*) AS n FROM audit_logs");
    const findCase = repo.findCase.bind(repo);
    repo.findCase = async (t, id) => {
      const row = await findCase(t, id);
      return row ? { ...row, status: "ESCALATED" } : row; // service believes it is still ESCALATED
    };
    await rejects(svc.transition(ctx, platform, opened.id, "INVESTIGATING", {}, META), 409, "CASE_STATE_CONFLICT");
    repo.findCase = findCase;
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_case_events WHERE case_id = ?", opened.id)).toBe(eventsBefore);
    expect(count(db, "SELECT COUNT(*) AS n FROM audit_logs")).toBe(auditBefore);
    expect(db.sqlite.prepare("SELECT status FROM compliance_cases WHERE id = ?").get(opened.id)).toEqual({ status: "INVESTIGATING" });

    // resolve from INVESTIGATING as tenant, then only platform compliance.manage closes
    const resolved = await svc.resolve(ctx, advResolver, opened.id, { resolution: "NO_ACTION", reason_code: "INSUFFICIENT_EVIDENCE" }, META);
    expect(resolved.case).toMatchObject({ status: "RESOLVED", resolution: "NO_ACTION", resolution_reason_code: "INSUFFICIENT_EVIDENCE", resolved_at: NOW.toISOString() });
    await rejects(svc.transition(ctx, adv, opened.id, "CLOSED", {}, META), 409, "INVALID_CASE_TRANSITION");
    const closed = await svc.transition(ctx, platform, opened.id, "CLOSED", {}, META);
    expect(closed.status).toBe("CLOSED");
    await rejects(svc.addNote(ctx, adv, opened.id, "too late", META), 409, "CASE_CLOSED");

    const detail = await svc.getCase(advReader, opened.id);
    expect(detail.events.map((e) => e.event_type)).toEqual([
      "OPENED",
      "STATUS_CHANGED",
      "INFORMATION_REQUESTED",
      "NOTE_ADDED",
      "INFORMATION_RECEIVED",
      "STATUS_CHANGED",
      "RESOLVED",
      "CLOSED",
    ]);
    expect(audits(db, "compliance.case.opened")).toBe(1);
    expect(audits(db, "compliance.case.resolved")).toBe(1);
    expect(audits(db, "compliance.case.closed")).toBe(1);
  });

  it("resolving COMPLIANT releases the COMPLIANCE_BLOCK hold in the same batch; NON_COMPLIANT keeps it and only compliance.resolve can release it manually", async () => {
    conversion(db, "c-1", "APPROVED");
    conversion(db, "c-2", "APPROVED");
    const a = await svc.openCase(ctx, platform, { subject_type: "CONVERSION", subject_id: "c-1", severity: "BLOCKING", reason_code: "UNAPPROVED_LANDING_PAGE" }, META);
    const b = await svc.openCase(ctx, platform, { subject_type: "CONVERSION", subject_id: "c-2", severity: "BLOCKING", reason_code: "UNAPPROVED_LANDING_PAGE" }, META);
    expect(a.hold_id).not.toBeNull();
    expect(b.hold_id).not.toBeNull();
    expect((await conversions.isPayoutBlocked(adv, "c-1")).blocked).toBe(true);
    expect((await conversions.isPayoutBlocked(adv, "c-2")).blocked).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_holds WHERE source_type = 'COMPLIANCE_CASE' AND hold_type = 'COMPLIANCE_BLOCK' AND status = 'ACTIVE'")).toBe(2);

    // COMPLIANT → hold released in the same batch
    await svc.transition(ctx, advResolver, a.id, "INVESTIGATING", {}, META);
    const ra = await svc.resolve(ctx, advResolver, a.id, { resolution: "COMPLIANT", reason_code: "LANDING_PAGE_APPROVED" }, META);
    expect(ra.case.resolution).toBe("COMPLIANT");
    expect(ra.hold).toMatchObject({ id: a.hold_id, status: "RELEASED", released_by_user_id: USER, released_reason_code: "LANDING_PAGE_APPROVED" });
    expect((await conversions.isPayoutBlocked(adv, "c-1")).blocked).toBe(false);
    expect(audits(db, "conversion.hold.released")).toBe(1);

    // NON_COMPLIANT → hold kept
    await svc.transition(ctx, advResolver, b.id, "INVESTIGATING", {}, META);
    const rb = await svc.resolve(ctx, advResolver, b.id, { resolution: "NON_COMPLIANT", reason_code: "LANDING_PAGE_REJECTED" }, META);
    expect(rb.hold?.status).toBe("ACTIVE");
    expect((await conversions.isPayoutBlocked(adv, "c-2")).blocked).toBe(true);

    // manual release of a COMPLIANCE_BLOCK hold requires compliance.resolve (fraud.manage / conversions.approve are not enough)
    const noResolve = tenantFor(ADV, "ADVERTISER", ["conversions.read", "conversions.approve", "fraud.manage"]);
    await rejects(conversions.releaseHold(ctx, noResolve, b.hold_id as string, { reason_code: "OVERRIDE" }, META), 403, "FORBIDDEN");
    const released = await conversions.releaseHold(ctx, advResolver, b.hold_id as string, { reason_code: "REMEDIATED" }, META);
    expect(released.status).toBe("RELEASED");
    expect((await conversions.isPayoutBlocked(adv, "c-2")).blocked).toBe(false);

    // resolving again is not possible (already RESOLVED)
    await rejects(svc.resolve(ctx, advResolver, b.id, { resolution: "COMPLIANT", reason_code: "X" }, META), 409, "INVALID_CASE_TRANSITION");
    // conversion lifecycle never touched by compliance
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM conversions WHERE lifecycle_status = 'APPROVED'").get()).toEqual({ n: 2 });
    expect(count(db, "SELECT COUNT(*) AS n FROM conversion_status_history")).toBe(0);
  });
});
