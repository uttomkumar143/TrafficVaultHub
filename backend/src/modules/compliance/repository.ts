/**
 * ComplianceRepository — Phase 4 Unit 8b (PRD §45–§47, §115, §132).
 *
 * Persistence for versioned compliance rules, INSERT-only evaluations, cases
 * and their INSERT-only event history over migration 0009. Every mutation is
 * exposed as prepared statements so the service composes them with the audit
 * row (and any conversion_holds row) into ONE db.batch.
 *
 * Rules: compliance_rules.organization_id NULL = platform-wide rule, visible
 * to every tenant; a non-NULL row belongs to one tenant. Versions are
 * append-only: version_number = MAX + 1 computed INSIDE the INSERT (concurrent
 * writers collide on UNIQUE (organization_id, rule_key, version_number)
 * instead of both winning) and the previous current row is demoted to
 * is_current = 0 in the same batch. Definitions are never edited in place.
 *
 * Tenant scoping: reads go through `scopedQuery` (organization_id = ? first);
 * rule reads add `OR organization_id IS NULL` for platform-wide rules.
 * INSERTs and SET-first UPDATEs bind the tenant id explicitly.
 */

import type { Page, PageRequest } from "../../lib/pagination";
import { slicePage } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import type { ComplianceEvaluation, ComplianceOutcome, ComplianceSeverity, ComplianceSubjectType, RuleDefinition } from "./rules";

export const COMPLIANCE_CASE_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "WAITING_FOR_INFORMATION",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;
export type ComplianceCaseStatus = (typeof COMPLIANCE_CASE_STATUSES)[number];

export const COMPLIANCE_RESOLUTIONS = ["COMPLIANT", "NON_COMPLIANT", "NO_ACTION"] as const;
export type ComplianceResolution = (typeof COMPLIANCE_RESOLUTIONS)[number];

export type ComplianceCaseEventType =
  | "OPENED"
  | "ASSIGNED"
  | "STATUS_CHANGED"
  | "INFORMATION_REQUESTED"
  | "INFORMATION_RECEIVED"
  | "NOTE_ADDED"
  | "RESOLVED"
  | "CLOSED";

export type ComplianceActor = "TENANT" | "PLATFORM" | "SYSTEM";

export interface ComplianceRuleRow {
  id: string;
  /** NULL = platform-wide rule. */
  organization_id: string | null;
  rule_key: string;
  version_number: number;
  is_current: number;
  severity: ComplianceSeverity;
  applies_to: ComplianceSubjectType;
  definition_json: string;
  description: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface ComplianceEvaluationRow {
  id: string;
  organization_id: string;
  rule_id: string;
  subject_type: ComplianceSubjectType;
  subject_id: string;
  outcome: ComplianceOutcome;
  reason_code: string;
  details_json: string;
  case_id: string | null;
  evaluated_at: string;
}

export interface ComplianceCaseRow {
  id: string;
  organization_id: string;
  subject_type: ComplianceSubjectType;
  subject_id: string;
  affiliate_organization_id: string | null;
  rule_id: string | null;
  evaluation_id: string | null;
  status: ComplianceCaseStatus;
  severity: ComplianceSeverity;
  reason_code: string;
  summary: string | null;
  hold_id: string | null;
  assignee_user_id: string | null;
  resolution: ComplianceResolution | null;
  resolution_reason_code: string | null;
  resolved_at: string | null;
  opened_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComplianceCaseEventRow {
  id: string;
  organization_id: string;
  case_id: string;
  event_type: ComplianceCaseEventType;
  from_status: ComplianceCaseStatus | null;
  to_status: ComplianceCaseStatus | null;
  actor_type: ComplianceActor;
  actor_user_id: string | null;
  reason_code: string | null;
  note: string | null;
  request_id: string | null;
  created_at: string;
}

export interface RuleVersionInsert {
  id: string;
  rule_key: string;
  severity: ComplianceSeverity;
  applies_to: ComplianceSubjectType;
  definition: RuleDefinition;
  description: string | null;
  created_by_user_id: string | null;
}

export interface EvaluationInsert {
  id: string;
  rule_id: string;
  subject_type: ComplianceSubjectType;
  subject_id: string;
  evaluation: ComplianceEvaluation;
  case_id: string | null;
}

export interface ComplianceCaseInsert {
  id: string;
  subject_type: ComplianceSubjectType;
  subject_id: string;
  affiliate_organization_id: string | null;
  rule_id: string | null;
  evaluation_id: string | null;
  severity: ComplianceSeverity;
  reason_code: string;
  summary: string | null;
  /** conversion_holds row written EARLIER in the same batch (FK). */
  hold_id: string | null;
  opened_by_user_id: string | null;
}

export interface ComplianceCaseEventInsert {
  case_id: string;
  event_type: ComplianceCaseEventType;
  from_status: ComplianceCaseStatus | null;
  to_status: ComplianceCaseStatus | null;
  actor_type: ComplianceActor;
  actor_user_id: string | null;
  reason_code: string | null;
  note: string | null;
  request_id: string | null;
}

export interface ComplianceCaseListFilter {
  status?: ComplianceCaseStatus;
  subject_type?: ComplianceSubjectType;
  subject_id?: string;
  affiliate_organization_id?: string;
}

/** Out-of-CHECK sentinel: a stale expected status makes the UPDATE fail and the batch roll back. */
const CONFLICT_SENTINEL = "__STATE_CONFLICT__";

export function isCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CHECK constraint failed/i.test(msg);
}

export class ComplianceRepository {
  constructor(private readonly db: D1Database) {}

  // ---- rules -----------------------------------------------------------------

  /** A rule is visible to a tenant when it owns it or when it is platform-wide (organization_id IS NULL). */
  async findRule(tenantId: TenantId, id: string): Promise<ComplianceRuleRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_rules WHERE (organization_id = ? OR organization_id IS NULL) AND id = ?`,
      tenantId,
      id,
    ).first<ComplianceRuleRow>();
    return row ?? null;
  }

  /**
   * Current rule versions that apply to the tenant: its own rules plus
   * platform-wide ones. When both define the same rule_key the tenant's row
   * comes first (organization_id NOT NULL sorts before NULL) so the service can
   * let a tenant rule override a platform default by key.
   */
  async listCurrentRules(tenantId: TenantId, appliesTo?: ComplianceSubjectType): Promise<ComplianceRuleRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_rules
        WHERE (organization_id = ? OR organization_id IS NULL) AND is_current = 1${appliesTo ? " AND applies_to = ?" : ""}
        ORDER BY rule_key ASC, organization_id IS NULL ASC, version_number DESC`,
      tenantId,
      ...(appliesTo ? [appliesTo] : []),
    ).all<ComplianceRuleRow>();
    return res.results;
  }

  /** Every version of one rule key visible to the tenant (own or platform-wide), newest first. */
  async listRuleVersions(tenantId: TenantId, ruleKey: string): Promise<ComplianceRuleRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_rules WHERE (organization_id = ? OR organization_id IS NULL) AND rule_key = ?
        ORDER BY organization_id IS NULL ASC, version_number DESC`,
      tenantId,
      ruleKey,
    ).all<ComplianceRuleRow>();
    return res.results;
  }

  /**
   * Append a rule version for `owner` (a tenant id, or null for a platform-wide
   * rule). Returns [demote-previous-current, insert-new-version] to be run in
   * ONE batch. version_number = MAX + 1 inside the INSERT; the caller never
   * chooses it. `organization_id IS ?` matches NULL owners too.
   */
  ruleVersionStatements(owner: TenantId | null, r: RuleVersionInsert, now: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(`UPDATE compliance_rules SET is_current = 0 WHERE organization_id IS ? AND rule_key = ? AND is_current = 1`)
        .bind(owner, r.rule_key),
      this.db
        .prepare(
          `INSERT INTO compliance_rules
             (organization_id, id, rule_key, version_number, is_current, severity, applies_to, definition_json, description,
              created_by_user_id, created_at)
           SELECT ?, ?, ?, COALESCE(MAX(version_number), 0) + 1, 1, ?, ?, ?, ?, ?, ?
             FROM compliance_rules WHERE organization_id IS ? AND rule_key = ?`,
        )
        .bind(
          owner,
          r.id,
          r.rule_key,
          r.severity,
          r.applies_to,
          JSON.stringify(r.definition),
          r.description,
          r.created_by_user_id,
          now,
          owner,
          r.rule_key,
        ),
    ];
  }

  // ---- evaluations ---------------------------------------------------------------

  async findEvaluation(tenantId: TenantId, id: string): Promise<ComplianceEvaluationRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_evaluations WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<ComplianceEvaluationRow>();
    return row ?? null;
  }

  async listEvaluationsForSubject(
    tenantId: TenantId,
    subjectType: ComplianceSubjectType,
    subjectId: string,
  ): Promise<ComplianceEvaluationRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_evaluations WHERE organization_id = ? AND subject_type = ? AND subject_id = ?
        ORDER BY evaluated_at DESC, rowid DESC`,
      tenantId,
      subjectType,
      subjectId,
    ).all<ComplianceEvaluationRow>();
    return res.results;
  }

  evaluationStatement(tenantId: TenantId, e: EvaluationInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO compliance_evaluations
           (organization_id, id, rule_id, subject_type, subject_id, outcome, reason_code, details_json, case_id, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        e.id,
        e.rule_id,
        e.subject_type,
        e.subject_id,
        e.evaluation.outcome,
        e.evaluation.reason_code,
        JSON.stringify(e.evaluation.details),
        e.case_id,
        now,
      );
  }

  // ---- cases -------------------------------------------------------------------------

  async findCase(tenantId: TenantId, id: string): Promise<ComplianceCaseRow | null> {
    const row = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_cases WHERE organization_id = ? AND id = ?`,
      tenantId,
      id,
    ).first<ComplianceCaseRow>();
    return row ?? null;
  }

  async listCases(tenantId: TenantId, page: PageRequest, filter: ComplianceCaseListFilter): Promise<Page<ComplianceCaseRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.subject_type) {
      where.push("subject_type = ?");
      binds.push(filter.subject_type);
    }
    if (filter.subject_id) {
      where.push("subject_id = ?");
      binds.push(filter.subject_id);
    }
    if (filter.affiliate_organization_id) {
      where.push("affiliate_organization_id = ?");
      binds.push(filter.affiliate_organization_id);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_cases WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ComplianceCaseRow>();
    return slicePage(res.results, page.limit);
  }

  async listEvents(tenantId: TenantId, caseId: string): Promise<ComplianceCaseEventRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM compliance_case_events WHERE organization_id = ? AND case_id = ? ORDER BY created_at ASC, rowid ASC`,
      tenantId,
      caseId,
    ).all<ComplianceCaseEventRow>();
    return res.results;
  }

  caseStatement(tenantId: TenantId, c: ComplianceCaseInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO compliance_cases
           (organization_id, id, subject_type, subject_id, affiliate_organization_id, rule_id, evaluation_id, status, severity,
            reason_code, summary, hold_id, opened_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tenantId,
        c.id,
        c.subject_type,
        c.subject_id,
        c.affiliate_organization_id,
        c.rule_id,
        c.evaluation_id,
        c.severity,
        c.reason_code,
        c.summary,
        c.hold_id,
        c.opened_by_user_id,
        now,
        now,
      );
  }

  eventStatement(tenantId: TenantId, e: ComplianceCaseEventInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO compliance_case_events
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

  /**
   * Guarded status UPDATE: stale `expectedFrom` → CHECK violation → the whole
   * batch rolls back. `resolution` fields are written only on → RESOLVED.
   */
  statusStatement(
    tenantId: TenantId,
    caseId: string,
    expectedFrom: ComplianceCaseStatus,
    to: ComplianceCaseStatus,
    now: string,
    extra: {
      resolution?: ComplianceResolution;
      resolution_reason_code?: string;
      resolved_at?: string;
    } = {},
  ): D1PreparedStatement {
    const sets: string[] = ["status = CASE WHEN status = ? THEN ? ELSE ? END", "updated_at = ?"];
    const binds: unknown[] = [expectedFrom, to, CONFLICT_SENTINEL, now];
    if (extra.resolution !== undefined) {
      sets.push("resolution = ?", "resolution_reason_code = ?", "resolved_at = ?");
      binds.push(extra.resolution, extra.resolution_reason_code ?? null, extra.resolved_at ?? now);
    }
    return this.db
      .prepare(`UPDATE compliance_cases SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`)
      .bind(...binds, tenantId, caseId);
  }

  assigneeStatement(tenantId: TenantId, caseId: string, assigneeUserId: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE compliance_cases SET assignee_user_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .bind(assigneeUserId, now, tenantId, caseId);
  }

  // ---- mutations -----------------------------------------------------------------------

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
