/**
 * FraudRepository — Phase 4 Unit 7a tests (PRD §41–§44, §115).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantId } from "../../lib/tenant-scope";
import { createTestD1, type TestD1 } from "../../test/d1-sqlite";
import { FraudRepository } from "./repository";

const ADV = "org-adv-1" as TenantId;
const ADV2 = "org-adv-2" as TenantId;
const AFF = "org-aff-1";
const NOW = "2026-03-15T12:00:00.000Z";

function seed(db: TestD1): void {
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('user-1', 'u@example.com');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV}', 'ADVERTISER', 'Adv', 'adv');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${ADV2}', 'ADVERTISER', 'Adv2', 'adv2');
    INSERT INTO organizations (id, type, name, slug) VALUES ('${AFF}', 'AFFILIATE', 'Aff', 'aff');
  `);
}

describe("FraudRepository", () => {
  let db: TestD1;
  let repo: FraudRepository;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    repo = new FraudRepository(db);
  });
  afterEach(() => db.close());

  it("assessment + case + OPENED event persist in one batch; reads are tenant-scoped", async () => {
    const ok = await repo.batch([
      repo.assessmentStatement(
        ADV,
        {
          id: "as-1",
          subject_type: "AFFILIATE",
          subject_id: AFF,
          conversion_id: null,
          affiliate_organization_id: AFF,
          rule_version: "fraud-rules-v1",
          score: 60,
          level: "HIGH",
          signals: [{ code: "VELOCITY_CONVERSIONS", weight: 20, evidence: { per_hour: 50 } }],
        },
        NOW,
      ),
      repo.caseStatement(
        ADV,
        {
          id: "case-1",
          affiliate_organization_id: AFF,
          conversion_id: null,
          assessment_id: "as-1",
          severity: "HIGH",
          reason_code: "VELOCITY",
          summary: null,
          opened_by_user_id: "user-1",
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
          actor_type: "PLATFORM",
          actor_user_id: "user-1",
          reason_code: "VELOCITY",
          note: null,
          request_id: "req-1",
        },
        NOW,
      ),
    ]);
    expect(ok).toBe(true);

    const a = await repo.findAssessment(ADV, "as-1");
    expect(a?.level).toBe("HIGH");
    expect(JSON.parse(a?.signals_json ?? "[]")).toHaveLength(1);
    expect((await repo.listAssessmentsForSubject(ADV, "AFFILIATE", AFF)).map((r) => r.id)).toEqual(["as-1"]);

    const c = await repo.findCase(ADV, "case-1");
    expect(c).toMatchObject({ status: "OPEN", severity: "HIGH", reason_code: "VELOCITY", reviewer_user_id: null });
    expect((await repo.listEvents(ADV, "case-1")).map((e) => e.event_type)).toEqual(["OPENED"]);

    // tenant isolation
    expect(await repo.findAssessment(ADV2, "as-1")).toBeNull();
    expect(await repo.findCase(ADV2, "case-1")).toBeNull();
    expect(await repo.listEvents(ADV2, "case-1")).toEqual([]);
    expect((await repo.listCases(ADV2, { limit: 10, cursor: null }, {})).items).toEqual([]);
  });

  it("guarded status update: stale expected status rolls back the WHOLE batch (no event, no reviewer change)", async () => {
    await repo.batch([
      repo.caseStatement(
        ADV,
        {
          id: "case-1",
          affiliate_organization_id: AFF,
          conversion_id: null,
          assessment_id: null,
          severity: "LOW",
          reason_code: "X",
          summary: null,
          opened_by_user_id: null,
        },
        NOW,
      ),
    ]);
    const stale = await repo.batch([
      repo.statusStatement(ADV, "case-1", "UNDER_REVIEW", "CONFIRMED", NOW, { decision_reason_code: "FAKE" }),
      repo.reviewerStatement(ADV, "case-1", "user-1", NOW),
      repo.eventStatement(
        ADV,
        {
          case_id: "case-1",
          event_type: "STATUS_CHANGED",
          from_status: "UNDER_REVIEW",
          to_status: "CONFIRMED",
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
    const c = await repo.findCase(ADV, "case-1");
    expect(c).toMatchObject({ status: "OPEN", reviewer_user_id: null, decision_reason_code: null, decided_at: null });
    expect(await repo.listEvents(ADV, "case-1")).toEqual([]);

    const ok = await repo.batch([
      repo.statusStatement(ADV, "case-1", "OPEN", "UNDER_REVIEW", NOW),
      repo.reviewerStatement(ADV, "case-1", "user-1", NOW),
    ]);
    expect(ok).toBe(true);
    expect(await repo.findCase(ADV, "case-1")).toMatchObject({ status: "UNDER_REVIEW", reviewer_user_id: "user-1" });

    const appealed = await repo.batch([
      repo.statusStatement(ADV, "case-1", "UNDER_REVIEW", "CONFIRMED", NOW, { decision_reason_code: "BOT_TRAFFIC" }),
      repo.statusStatement(ADV, "case-1", "CONFIRMED", "APPEALED", NOW, { appeal_note: "we dispute", appealed_by_user_id: "user-1" }),
    ]);
    expect(appealed).toBe(true);
    expect(await repo.findCase(ADV, "case-1")).toMatchObject({
      status: "APPEALED",
      decision_reason_code: "BOT_TRAFFIC",
      decided_at: NOW,
      appeal_note: "we dispute",
      appealed_by_user_id: "user-1",
      appealed_at: NOW,
    });
  });

  it("actions persist with their case; list ordering and pagination cursor over cases", async () => {
    for (const [id, ts] of [
      ["case-a", "2026-03-15T10:00:00.000Z"],
      ["case-b", "2026-03-15T11:00:00.000Z"],
      ["case-c", "2026-03-15T11:00:00.000Z"],
    ] as const) {
      await repo.batch([
        repo.caseStatement(
          ADV,
          {
            id,
            affiliate_organization_id: AFF,
            conversion_id: null,
            assessment_id: null,
            severity: "MEDIUM",
            reason_code: "R",
            summary: null,
            opened_by_user_id: null,
          },
          ts,
        ),
      ]);
    }
    await repo.batch([
      repo.actionStatement(
        ADV,
        {
          id: "act-1",
          case_id: "case-a",
          affiliate_organization_id: AFF,
          conversion_id: null,
          action_type: "MONITOR",
          hold_id: null,
          reason_code: "R",
          note: null,
          taken_by_user_id: "user-1",
          actor_type: "PLATFORM",
          request_id: null,
        },
        NOW,
      ),
      repo.actionStatement(
        ADV,
        {
          id: "act-2",
          case_id: "case-a",
          affiliate_organization_id: AFF,
          conversion_id: null,
          action_type: "TRAFFIC_RESTRICTION",
          hold_id: null,
          reason_code: "R",
          note: "n",
          taken_by_user_id: "user-1",
          actor_type: "PLATFORM",
          request_id: null,
        },
        NOW,
      ),
    ]);
    expect((await repo.listActions(ADV, "case-a")).map((a) => a.action_type)).toEqual(["MONITOR", "TRAFFIC_RESTRICTION"]);
    expect(await repo.listActions(ADV2, "case-a")).toEqual([]);

    const p1 = await repo.listCases(ADV, { limit: 2, cursor: null }, {});
    expect(p1.items.map((c) => c.id)).toEqual(["case-c", "case-b"]);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await repo.listCases(ADV, { limit: 2, cursor: { created_at: "2026-03-15T11:00:00.000Z", id: "case-b" } }, {});
    expect(p2.items.map((c) => c.id)).toEqual(["case-a"]);
    expect(p2.next_cursor).toBeNull();
    expect((await repo.listCases(ADV, { limit: 10, cursor: null }, { status: "OPEN", affiliate_organization_id: AFF })).items).toHaveLength(
      3,
    );
    expect((await repo.listCases(ADV, { limit: 10, cursor: null }, { status: "CLOSED" })).items).toHaveLength(0);
  });
});
