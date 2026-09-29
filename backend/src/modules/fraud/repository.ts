/**
 * FraudRepository — Phase 4 Unit 7a (PRD §41–§44, §115).
 *
 * Persistence for fraud assessments, cases, case events and actions over
 * migration 0009. Cases carry an INSERT-only event history
 * (fraud_case_events); every mutation returns prepared statements so the
 * service composes them with the audit row (and any conversion_holds row)
 * into ONE db.batch.
 *
 * Tenant scoping: reads go through `scopedQuery` (organization_id = ? first);
 * INSERTs and SET-first UPDATEs bind the tenant id explicitly.
 */

import type { Page, PageRequest } from "../../lib/pagination";
import { slicePage } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import type { RiskLevel, RiskSignal } from "./risk-engine";

export const FRAUD_CASE_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "CONFIRMED",
  "DISMISSED",
  "APPEALED",
  "APPEAL_UPHELD",
  "APPEAL_REJECTED",
  "CLOSED",
] as const;
export type FraudCaseStatus = (typeof FRAUD_CASE_STATUSES)[number];

export const FRAUD_ACTION_TYPES = [
  "MONITOR",
  "MANUAL_REVIEW",
  "CONVERSION_HOLD",
  "TRAFFIC_RESTRICTION",
  "PAYOUT_HOLD",
  "ACCOUNT_RESTRICTION",
  "ACCOUNT_SUSPENSION",
] as const;
export type FraudActionType = (typeof FRAUD_ACTION_TYPES)[number];

export type FraudCaseEventType =
  "OPENED" | "ASSIGNED" | "STATUS_CHANGED" | "NOTE_ADDED" | "ACTION_TAKEN" | "APPEAL_FILED" | "APPEAL_DECIDED" | "CLOSED";

export type FraudActor = "TENANT" | "PLATFORM" | "SYSTEM";
export type FraudSubjectType = "CONVERSION" | "CLICK" | "AFFILIATE";

export interface FraudAssessmentRow {
  id: string;
  organization_id: string;
  subject_type: FraudSubjectType;
  subject_id: string;
  conversion_id: string | null;
  affiliate_organization_id: string | null;
  rule_version: string;
  score: number;
  level: RiskLevel;
  signals_json: string;
  evaluated_at: string;
}

export interface FraudCaseRow {
  id: string;
  organization_id: string;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
  assessment_id: string | null;
  status: FraudCaseStatus;
  severity: RiskLevel;
  reason_code: string;
  summary: string | null;
  reviewer_user_id: string | null;
  decision_reason_code: string | null;
  decided_at: string | null;
  appeal_note: string | null;
  appealed_by_user_id: string | null;
  appealed_at: string | null;
  opened_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FraudCaseEventRow {
  id: string;
  organization_id: string;
  case_id: string;
  event_type: FraudCaseEventType;
  from_status: FraudCaseStatus | null;
  to_status: FraudCaseStatus | null;
  actor_type: FraudActor;
  actor_user_id: string | null;
  reason_code: string | null;
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export interface FraudActionRow {
  id: string;
  organization_id: string;
  case_id: string;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
  action_type: FraudActionType;
  hold_id: string | null;
  reason_code: string;
  note: string | null;
  taken_by_user_id: string | null;
  actor_type: "PLATFORM" | "SYSTEM";
  request_id: string | null;
  created_at: string;
}

export interface AssessmentInsert {
  id: string;
  subject_type: FraudSubjectType;
  subject_id: string;
  conversion_id: string | null;
  affiliate_organization_id: string | null;
  rule_version: string;
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
}

export interface CaseInsert {
  id: string;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
  assessment_id: string | null;
  severity: RiskLevel;
  reason_code: string;
  summary: string | null;
  opened_by_user_id: string | null;
}

export interface CaseEventInsert {
  case_id: string;
  event_type: FraudCaseEventType;
  from_status: FraudCaseStatus | null;
  to_status: FraudCaseStatus | null;
  actor_type: FraudActor;
  actor_user_id: string | null;
  reason_code: string | null;
  note: string | null;
  request_id: string | null;
}

export interface ActionInsert {
  id: string;
  case_id: string;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
  action_type: FraudActionType;
  hold_id: string | null;
  reason_code: string;
  note: string | null;
  taken_by_user_id: string | null;
  actor_type: "PLATFORM" | "SYSTEM";
  request_id: string | null;
}

export interface FraudCaseListFilter {
  status?: FraudCaseStatus;
  affiliate_organization_id?: string;
  conversion_id?: string;
}

/** Out-of-CHECK sentinel: a stale expected status makes the UPDATE fail and the batch roll back. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";

export function isCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CHECK constraint failed/i.test(msg);
}

export class FraudRepository {
  constructor(private readonly db: D1Database) {}

  // ---- reads ---------------------------------------------------------------

  async findAssessment(tenantId: TenantId, id: string): Promise<FraudAssessmentRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_assessments WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<FraudAssessmentRow>();
    return row ?? null;
  }

  async listAssessmentsForSubject(tenantId: TenantId, subjectType: FraudSubjectType, subjectId: string): Promise<FraudAssessmentRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_assessments WHERE organization_id = ? AND subject_type = ? AND subject_id = ? ORDER BY evaluated_at DESC, rowid DESC`,
      tenantId,
      subjectType,
      subjectId,
    ).all<FraudAssessmentRow>();
    return res.results;
  }

  async findCase(tenantId: TenantId, id: string): Promise<FraudCaseRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_cases WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<FraudCaseRow>();
    return row ?? null;
  }

  async listCases(tenantId: TenantId, page: PageRequest, filter: FraudCaseListFilter): Promise<Page<FraudCaseRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.affiliate_organization_id) {
      where.push("affiliate_organization_id = ?");
      binds.push(filter.affiliate_organization_id);
    }
    if (filter.conversion_id) {
      where.push("conversion_id = ?");
      binds.push(filter.conversion_id);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_cases WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<FraudCaseRow>();
    return slicePage(res.results, page.limit);
  }

  async listEvents(tenantId: TenantId, caseId: string): Promise<FraudCaseEventRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_case_events WHERE organization_id = ? AND case_id = ? ORDER BY created_at ASC, rowid ASC`,
      tenantId,
      caseId,
    ).all<FraudCaseEventRow>();
    return res.results;
  }

  async listActions(tenantId: TenantId, caseId: string): Promise<FraudActionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM fraud_actions WHERE organization_id = ? AND case_id = ? ORDER BY created_at ASC, rowid ASC`,
      tenantId,
      caseId,
    ).all<FraudActionRow>();
    return res.results;
  }

  // ---- statements (composed into one batch by the service) -----------------

  assessmentStatement(tenantId: TenantId, a: AssessmentInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fraud_assessments
           (organization_id, id, subject_type, subject_id, conversion_id, affiliate_organization_id, rule_version, score, level, signals_json, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        a.id,
        a.subject_type,
        a.subject_id,
        a.conversion_id,
        a.affiliate_organization_id,
        a.rule_version,
        a.score,
        a.level,
        JSON.stringify(a.signals),
        now,
      );
  }

  caseStatement(tenantId: TenantId, c: CaseInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fraud_cases
           (organization_id, id, affiliate_organization_id, conversion_id, assessment_id, status, severity, reason_code, summary,
            opened_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        c.id,
        c.affiliate_organization_id,
        c.conversion_id,
        c.assessment_id,
        c.severity,
        c.reason_code,
        c.summary,
        c.opened_by_user_id,
        now,
        now,
      );
  }

  eventStatement(tenantId: TenantId, e: CaseEventInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fraud_case_events
           (organization_id, id, case_id, event_type, from_status, to_status, actor_type, actor_user_id, reason_code, note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        crypto.randomUUID(),
        e.case_id,
        e.event_type,
        e.from_status,
        e.to_status,
        e.actor_type,
        e.actor_user_id,
        e.reason_code,
        e.note,
        e.request_id,
        now,
      );
  }

  actionStatement(tenantId: TenantId, a: ActionInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fraud_actions
           (organization_id, id, case_id, affiliate_organization_id, conversion_id, action_type, hold_id, reason_code, note, taken_by_user_id,
            actor_type, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        a.id,
        a.case_id,
        a.affiliate_organization_id,
        a.conversion_id,
        a.action_type,
        a.hold_id,
        a.reason_code,
        a.note,
        a.taken_by_user_id,
        a.actor_type,
        a.request_id,
        now,
      );
  }

  /** Guarded status UPDATE: stale `expectedFrom` → CHECK violation → whole batch rolls back. */
  statusStatement(
    tenantId: TenantId,
    caseId: string,
    expectedFrom: FraudCaseStatus,
    to: FraudCaseStatus,
    now: string,
    extra: {
      decision_reason_code?: string;
      decided_at?: string;
      appeal_note?: string;
      appealed_by_user_id?: string;
      appealed_at?: string;
    } = {},
  ): D1PreparedStatement {
    const sets: string[] = ["status = CASE WHEN status = ? THEN ? ELSE ? END", "updated_at = ?"];
    const binds: unknown[] = [expectedFrom, to, CONFLICT_SENTINEL, now];
    if (extra.decision_reason_code !== undefined) {
      sets.push("decision_reason_code = ?", "decided_at = ?");
      binds.push(extra.decision_reason_code, extra.decided_at ?? now);
    }
    if (extra.appeal_note !== undefined) {
      sets.push("appeal_note = ?", "appealed_by_user_id = ?", "appealed_at = ?");
      binds.push(extra.appeal_note, extra.appealed_by_user_id ?? null, extra.appealed_at ?? now);
    }
    return this.db
      .prepare(`UPDATE fraud_cases SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`)
      .bind(...binds, tenantId, caseId);
  }

  reviewerStatement(tenantId: TenantId, caseId: string, reviewerUserId: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE fraud_cases SET reviewer_user_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .bind(reviewerUserId, now, tenantId, caseId);
  }

  // ---- mutations -------------------------------------------------------------

  /** Runs statements atomically; maps a CHECK violation (stale status guard) to `false`. */
  async batch(statements: D1PreparedStatement[]): Promise<boolean> {
    try {
      await this.db.batch(statements);
      return true;
    } catch (err) {
      if (isCheckViolation(err)) return false;
      throw err;
    }
  }
}
