/**
 * ComplianceRepository — Phase 4 Unit 8b tests (PRD §45–§47, §115, §132).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { ComplianceRepository } from "./repository";

const ADV = "org-adv-1" as TenantId;
const ADV2 = "org-adv-2" as TenantId;
const AFF = "org-aff-1";
const NOW = "2026-03-15T12:00:00.000Z";
const LATER = "2026-03-15T12:05:00.000Z";

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('user-1', 'u@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
  `);
}

function count(db: TestD1, sql: string, ...args: string[]): number {
  return (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
}

describe("ComplianceRepository", () => {
  let db: TestD1;
  let repo: ComplianceRepository;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new ComplianceRepository(db);
  });
  afterEach(() => db.close());

  it("rule versions are append-only (MAX+1 inside the INSERT, prior current demoted); platform-wide rules are visible to every tenant", async () => {
    // platform-wide v1
    await repo.batch(
      repo.ruleVersionStatements(
        null,
        {
          id: "r-geo-1",
          rule_key: "geo",
          severity: "BLOCKING",
          applies_to: "AFFILIATE",
          definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] },
          description: "no sanctioned geos",
          created_by_user_id: "user-1",
        },
        NOW,
      ),
    );
    // platform-wide v2 (definition NOT edited in place)
    await repo.batch(
      repo.ruleVersionStatements(
        null,
        {
          id: "r-geo-2",
          rule_key: "geo",
          severity: "BLOCKING",
          applies_to: "AFFILIATE",
          definition: { kind: "GEOGRAPHY", restricted_countries: ["KP", "IR"] },
          description: null,
          created_by_user_id: "user-1",
        },
        LATER,
      ),
    );
    // tenant-owned rule with the same key for ADV only
    await repo.batch(
      repo.ruleVersionStatements(
        ADV,
        {
          id: "r-geo-adv",
          rule_key: "geo",
          severity: "WARNING",
          applies_to: "AFFILIATE",
          definition: { kind: "GEOGRAPHY", allowed_countries: ["US", "CA"] },
          description: null,
          created_by_user_id: "user-1",
        },
        LATER,
      ),
    );

    const versions = await repo.listRuleVersions(ADV, "geo");
    expect(versions.map((v) => [v.id, v.organization_id, v.version_number, v.is_current])).toEqual([
      ["r-geo-adv", ADV, 1, 1],
      ["r-geo-2", null, 2, 1],
      ["r-geo-1", null, 1, 0],
    ]);
    expect(JSON.parse(versions[2]?.definition_json ?? "{}")).toEqual({ kind: "GEOGRAPHY", restricted_countries: ["KP"] });

    // current set for ADV: own rule first, then the platform default of the same key
    const current = await repo.listCurrentRules(ADV);
    expect(current.map((r) => r.id)).toEqual(["r-geo-adv", "r-geo-2"]);
    // ADV2 only sees the platform-wide current version
    expect((await repo.listCurrentRules(ADV2)).map((r) => r.id)).toEqual(["r-geo-2"]);
    expect((await repo.listCurrentRules(ADV2, "OFFER")).map((r) => r.id)).toEqual([]);
    expect(await repo.findRule(ADV2, "r-geo-adv")).toBeNull();
    expect(await repo.findRule(ADV2, "r-geo-2")).not.toBeNull();
    expect((await repo.listRuleVersions(ADV2, "geo")).map((r) => r.id)).toEqual(["r-geo-2", "r-geo-1"]);

    // duplicate version_number for the same owner+key is impossible (UNIQUE) — MAX+1 keeps incrementing
    await repo.batch(
      repo.ruleVersionStatements(
        ADV,
        {
          id: "r-geo-adv-2",
          rule_key: "geo",
          severity: "WARNING",
          applies_to: "AFFILIATE",
          definition: { kind: "GEOGRAPHY", allowed_countries: ["US"] },
          description: null,
          created_by_user_id: null,
        },
        LATER,
      ),
    );
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_rules WHERE rule_key = 'geo' AND is_current = 1")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_rules")).toBe(4);
    expect((await repo.findRule(ADV, "r-geo-adv-2"))?.version_number).toBe(2);
    expect((await repo.findRule(ADV, "r-geo-adv"))?.is_current).toBe(0);
  });

  it("evaluation + case + OPENED event persist in one batch; INSUFFICIENT_INFORMATION is stored as-is; reads are tenant-scoped", async () => {
    await repo.batch(
      repo.ruleVersionStatements(
        null,
        {
          id: "r-1",
          rule_key: "account",
          severity: "BLOCKING",
          applies_to: "AFFILIATE",
          definition: { kind: "ACCOUNT_STATUS", allowed_statuses: ["ACTIVE"], require_verified: true },
          description: null,
          created_by_user_id: null,
        },
        NOW,
      ),
    );
    const ok = await repo.batch([
      repo.caseStatement(
        ADV,
        {
          id: "case-1",
          subject_type: "AFFILIATE",
          subject_id: AFF,
          affiliate_organization_id: AFF,
          rule_id: "r-1",
          evaluation_id: null,
          severity: "BLOCKING",
          reason_code: "MISSING_REQUIRED_FACTS",
          summary: "identity not verified",
          hold_id: null,
          opened_by_user_id: "user-1",
        },
        NOW,
      ),
      repo.evaluationStatement(
        ADV,
        {
          id: "ev-1",
          rule_id: "r-1",
          subject_type: "AFFILIATE",
          subject_id: AFF,
          evaluation: {
            outcome: "INSUFFICIENT_INFORMATION",
            reason_code: "MISSING_REQUIRED_FACTS",
            details: { missing: ["identity_verified"] },
          },
          case_id: "case-1",
        },
        NOW,
      ),
      repo.eventStatement(
        ADV,
        {
          case_id: "case-1",
          event_type: "OPENED",
          from_status: null,
          to_status: "OPEN",
          actor_type: "SYSTEM",
          actor_user_id: "user-1",
          reason_code: "MISSING_REQUIRED_FACTS",
          note: null,
          request_id: "req-1",
        },
        NOW,
      ),
    ]);
    expect(ok).toBe(true);

    const ev = await repo.findEvaluation(ADV, "ev-1");
    expect(ev).toMatchObject({ outcome: "INSUFFICIENT_INFORMATION", reason_code: "MISSING_REQUIRED_FACTS", case_id: "case-1" });
    expect(JSON.parse(ev?.details_json ?? "{}")).toEqual({ missing: ["identity_verified"] });
    expect((await repo.listEvaluationsForSubject(ADV, "AFFILIATE", AFF)).map((r) => r.id)).toEqual(["ev-1"]);

    const c = await repo.findCase(ADV, "case-1");
    expect(c).toMatchObject({ status: "OPEN", severity: "BLOCKING", hold_id: null, assignee_user_id: null, resolution: null });
    expect((await repo.listEvents(ADV, "case-1")).map((e) => e.event_type)).toEqual(["OPENED"]);
    const listed = await repo.listCases(ADV, { limit: 10, cursor: null }, { subject_type: "AFFILIATE", subject_id: AFF, status: "OPEN" });
    expect(listed.items.map((r) => r.id)).toEqual(["case-1"]);
    expect((await repo.listCases(ADV, { limit: 10, cursor: null }, { status: "CLOSED" })).items).toEqual([]);

    // tenant isolation
    expect(await repo.findEvaluation(ADV2, "ev-1")).toBeNull();
    expect(await repo.findCase(ADV2, "case-1")).toBeNull();
    expect(await repo.listEvents(ADV2, "case-1")).toEqual([]);
    expect((await repo.listCases(ADV2, { limit: 10, cursor: null }, {})).items).toEqual([]);
  });

  it("guarded status update: stale expected status rolls back the WHOLE batch (no event, no assignee, no resolution)", async () => {
    await repo.batch([
      repo.caseStatement(
        ADV,
        {
          id: "case-1",
          subject_type: "OFFER",
          subject_id: "offer-1",
          affiliate_organization_id: null,
          rule_id: null,
          evaluation_id: null,
          severity: "WARNING",
          reason_code: "MANUAL",
          summary: null,
          hold_id: null,
          opened_by_user_id: null,
        },
        NOW,
      ),
    ]);
    const stale = await repo.batch([
      repo.statusStatement(ADV, "case-1", "INVESTIGATING", "RESOLVED", NOW, { resolution: "COMPLIANT", resolution_reason_code: "FAKE" }),
      repo.assigneeStatement(ADV, "case-1", "user-1", NOW),
      repo.eventStatement(
        ADV,
        {
          case_id: "case-1",
          event_type: "RESOLVED",
          from_status: "INVESTIGATING",
          to_status: "RESOLVED",
          actor_type: "PLATFORM",
          actor_user_id: "user-1",
          reason_code: "FAKE",
          note: null,
          request_id: null,
        },
        NOW,
      ),
    ]);
    expect(stale).toBe(false);
    const row = await repo.findCase(ADV, "case-1");
    expect(row).toMatchObject({ status: "OPEN", assignee_user_id: null, resolution: null, resolution_reason_code: null, resolved_at: null });
    expect(await repo.listEvents(ADV, "case-1")).toEqual([]);

    // correct expectation → applied, resolution fields written together
    const fresh = await repo.batch([
      repo.statusStatement(ADV, "case-1", "OPEN", "INVESTIGATING", LATER),
      repo.eventStatement(
        ADV,
        {
          case_id: "case-1",
          event_type: "STATUS_CHANGED",
          from_status: "OPEN",
          to_status: "INVESTIGATING",
          actor_type: "PLATFORM",
          actor_user_id: "user-1",
          reason_code: null,
          note: null,
          request_id: null,
        },
        LATER,
      ),
    ]);
    expect(fresh).toBe(true);
    const resolved = await repo.batch([
      repo.statusStatement(ADV, "case-1", "INVESTIGATING", "RESOLVED", LATER, { resolution: "NO_ACTION", resolution_reason_code: "FALSE_POSITIVE" }),
    ]);
    expect(resolved).toBe(true);
    expect(await repo.findCase(ADV, "case-1")).toMatchObject({
      status: "RESOLVED",
      resolution: "NO_ACTION",
      resolution_reason_code: "FALSE_POSITIVE",
      resolved_at: LATER,
      updated_at: LATER,
    });
    // a foreign tenant's guarded update touches nothing (0 rows) and does not violate CHECK
    expect(await repo.batch([repo.statusStatement(ADV2, "case-1", "RESOLVED", "CLOSED", LATER)])).toBe(true);
    expect((await repo.findCase(ADV, "case-1"))?.status).toBe("RESOLVED");
    expect(count(db, "SELECT COUNT(*) AS n FROM compliance_case_events")).toBe(1);
  });
});
