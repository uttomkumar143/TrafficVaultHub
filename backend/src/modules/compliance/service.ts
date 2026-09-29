/**
 * ComplianceService — Phase 4 Unit 8c (PRD §45–§47, §115, §132).
 *
 * Rules: append-only versions (compliance.manage). PLATFORM staff may publish
 *   platform-wide versions (organization_id NULL, visible to every tenant);
 *   any tenant with compliance.manage publishes tenant-owned versions.
 *   Definitions are validated with parseRuleDefinition() before persisting.
 *
 * evaluate(): runs the pure rules engine over caller-supplied facts for every
 *   CURRENT rule that applies to the subject type (tenant-owned rule shadows
 *   the platform default of the same key) and writes ONE INSERT-only
 *   compliance_evaluations row per rule. FAIL-SAFE: INSUFFICIENT_INFORMATION is
 *   persisted as such and never coerced to PASS. When the aggregate is FAIL or
 *   a BLOCKING rule did not PASS, a compliance case is opened in the SAME
 *   batch; a BLOCKING case additionally writes a COMPLIANCE_BLOCK
 *   conversion_holds row (source_type COMPLIANCE_CASE, source_id = case id;
 *   per-conversion when a conversion is known, else affiliate-scoped) so the
 *   conversion state machine blocks payout eligibility immediately.
 *
 * Case lifecycle (pure table below, actor from tenant.organization.type):
 *   OPEN → INVESTIGATING                                  (T/P, compliance.resolve)
 *   INVESTIGATING → WAITING_FOR_INFORMATION               (T/P, compliance.resolve, note required)
 *   WAITING_FOR_INFORMATION → INVESTIGATING               (T/P, compliance.resolve)
 *   INVESTIGATING → ESCALATED                             (T/P, compliance.resolve, reason required)
 *   ESCALATED → INVESTIGATING                             (PLATFORM, compliance.manage)
 *   INVESTIGATING | ESCALATED → RESOLVED  via resolve()   (compliance.resolve; from ESCALATED: PLATFORM + compliance.manage)
 *   RESOLVED → CLOSED                                     (PLATFORM, compliance.manage)
 *   Invalid edge → 409 INVALID_CASE_TRANSITION; stale status → 409 CASE_STATE_CONFLICT
 *   (guarded UPDATE, whole batch rolls back, nothing written).
 *
 * resolve(): resolution COMPLIANT releases the case's COMPLIANCE_BLOCK hold in
 *   the same batch (the only automatic release; NON_COMPLIANT / NO_ACTION keep
 *   the hold, which can then only be released through
 *   ConversionService.releaseHold by a compliance.resolve holder).
 *
 * Every step is one db.batch: guarded UPDATE + INSERT-only
 * compliance_case_events row + audit_logs row (+ conversion_holds where relevant).
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { ConversionRepository, HoldRow } from "../conversions/repository";
import type { PermissionKey } from "../rbac/permissions";
import {
  COMPLIANCE_CASE_STATUSES,
  COMPLIANCE_RESOLUTIONS,
  type ComplianceActor,
  type ComplianceCaseEventRow,
  type ComplianceCaseEventType,
  type ComplianceCaseListFilter,
  type ComplianceCaseRow,
  type ComplianceCaseStatus,
  type ComplianceEvaluationRow,
  type ComplianceRepository,
  type ComplianceResolution,
  type ComplianceRuleRow,
} from "./repository";
import {
  evaluateRules,
  parseRuleDefinition,
  type ComplianceFacts,
  type ComplianceSeverity,
  type ComplianceSubjectType,
  type RuleInput,
  type RuleSetResult,
} from "./rules";

export interface ComplianceServiceOptions {
  now?: () => Date;
}

export interface CreateRuleVersionInput {
  rule_key: string;
  severity: ComplianceSeverity;
  applies_to: ComplianceSubjectType;
  /** Untrusted definition object; validated with parseRuleDefinition(). */
  definition: unknown;
  description?: string | null;
  /** PLATFORM actors only: publish as a platform-wide rule (organization_id NULL). */
  platform_wide?: boolean;
}

export interface EvaluateInput {
  subject_type: ComplianceSubjectType;
  subject_id: string;
  conversion_id?: string | null;
  affiliate_organization_id?: string | null;
  facts: ComplianceFacts;
  /** Restrict the evaluation to these rule keys (default: every current rule for the subject type). */
  rule_keys?: readonly string[];
  /** Open a case when the aggregate is FAIL or a BLOCKING rule did not PASS (default true). */
  open_case?: boolean;
}

export interface EvaluateResult {
  result: RuleSetResult;
  evaluations: ComplianceEvaluationRow[];
  case: ComplianceCaseRow | null;
  hold_id: string | null;
}

export interface OpenComplianceCaseInput {
  subject_type: ComplianceSubjectType;
  subject_id: string;
  severity: ComplianceSeverity;
  reason_code: string;
  summary?: string | null;
  conversion_id?: string | null;
  affiliate_organization_id?: string | null;
  rule_id?: string | null;
  evaluation_id?: string | null;
}

export interface ComplianceStepInput {
  reason_code?: string;
  note?: string | null;
}

export interface ResolveInput {
  resolution: ComplianceResolution;
  reason_code: string;
  note?: string | null;
}

export interface ComplianceCaseDetail {
  case: ComplianceCaseRow;
  events: ComplianceCaseEventRow[];
  evaluation: ComplianceEvaluationRow | null;
  rule: ComplianceRuleRow | null;
  hold: HoldRow | null;
}

const REASON_CODE = /^[A-Z0-9_]{1,64}$/;
const RULE_KEY = /^[a-z0-9_.-]{1,64}$/;
const SEVERITY_RANK: Record<ComplianceSeverity, number> = { INFO: 0, WARNING: 1, BLOCKING: 2 };
const SEVERITIES: readonly ComplianceSeverity[] = ["INFO", "WARNING", "BLOCKING"];
const SUBJECT_TYPES: readonly ComplianceSubjectType[] = ["AFFILIATE", "ADVERTISER", "OFFER", "CONVERSION"];

interface CaseEdge {
  to: ComplianceCaseStatus;
  actors: readonly ComplianceActor[];
  permission: PermissionKey;
  event: ComplianceCaseEventType;
  reason: "required" | "optional";
  noteRequired?: boolean;
}

/** Pure case lifecycle table (RESOLVED is reached only through resolve()). */
const CASE_EDGES: Readonly<Record<ComplianceCaseStatus, readonly CaseEdge[]>> = {
  OPEN: [{ to: "INVESTIGATING", actors: ["TENANT", "PLATFORM"], permission: "compliance.resolve", event: "STATUS_CHANGED", reason: "optional" }],
  INVESTIGATING: [
    {
      to: "WAITING_FOR_INFORMATION",
      actors: ["TENANT", "PLATFORM"],
      permission: "compliance.resolve",
      event: "INFORMATION_REQUESTED",
      reason: "optional",
      noteRequired: true,
    },
    { to: "ESCALATED", actors: ["TENANT", "PLATFORM"], permission: "compliance.resolve", event: "STATUS_CHANGED", reason: "required" },
  ],
  WAITING_FOR_INFORMATION: [
    { to: "INVESTIGATING", actors: ["TENANT", "PLATFORM"], permission: "compliance.resolve", event: "INFORMATION_RECEIVED", reason: "optional" },
  ],
  ESCALATED: [{ to: "INVESTIGATING", actors: ["PLATFORM"], permission: "compliance.manage", event: "STATUS_CHANGED", reason: "optional" }],
  RESOLVED: [{ to: "CLOSED", actors: ["PLATFORM"], permission: "compliance.manage", event: "CLOSED", reason: "optional" }],
  CLOSED: [],
};

export function complianceCaseEdge(from: ComplianceCaseStatus, to: ComplianceCaseStatus, actor: ComplianceActor): CaseEdge | null {
  const edge = CASE_EDGES[from].find((e) => e.to === to);
  if (!edge || !edge.actors.includes(actor)) return null;
  return edge;
}

/** Statuses from which resolve() is allowed. */
const RESOLVABLE: ReadonlySet<ComplianceCaseStatus> = new Set(["INVESTIGATING", "ESCALATED"]);

function actorOf(tenant: TenantContext): ComplianceActor {
  return tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT";
}

function checkReason(code: string | undefined, required: boolean): string | null {
  if (code === undefined || code === "") {
    if (required) throw new AppError(400, "REASON_REQUIRED", "reason_code is required for this step");
    return null;
  }
  if (!REASON_CODE.test(code)) throw new AppError(400, "INVALID_REASON_CODE", "reason_code must match ^[A-Z0-9_]{1,64}$");
  return code;
}

function checkNote(note: string | null | undefined, required = false): string | null {
  if (note === undefined || note === null || note === "") {
    if (required) throw new AppError(400, "NOTE_REQUIRED", "a note is required for this step");
    return null;
  }
  if (note.length > 2000) throw new AppError(400, "NOTE_TOO_LONG", "note must be at most 2000 characters");
  return note;
}

function checkSummary(summary: string | null | undefined): string | null {
  if (summary === undefined || summary === null || summary === "") return null;
  if (summary.length > 2000) throw new AppError(400, "SUMMARY_TOO_LONG", "summary must be at most 2000 characters");
  return summary;
}

export class ComplianceService {
  private readonly audit: AuditRepository;
  private readonly now: () => Date;

  constructor(
    private readonly repo: ComplianceRepository,
    private readonly conversions: ConversionRepository,
    private readonly db: D1Database,
    options: ComplianceServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.now = options.now ?? (() => new Date());
  }

  // ---- rules ---------------------------------------------------------------------

  async listRules(tenant: TenantContext, appliesTo?: ComplianceSubjectType): Promise<ComplianceRuleRow[]> {
    this.require(tenant, "compliance.read");
    if (appliesTo !== undefined && !SUBJECT_TYPES.includes(appliesTo)) {
      throw new AppError(400, "INVALID_SUBJECT_TYPE", `applies_to must be one of ${SUBJECT_TYPES.join(", ")}`);
    }
    return this.repo.listCurrentRules(tenantIdOf(tenant), appliesTo);
  }

  async listRuleVersions(tenant: TenantContext, ruleKey: string): Promise<ComplianceRuleRow[]> {
    this.require(tenant, "compliance.read");
    return this.repo.listRuleVersions(tenantIdOf(tenant), ruleKey);
  }

  async getRule(tenant: TenantContext, ruleId: string): Promise<ComplianceRuleRow> {
    this.require(tenant, "compliance.read");
    const row = await this.repo.findRule(tenantIdOf(tenant), ruleId);
    if (!row) throw new AppError(404, "NOT_FOUND", "compliance rule not found");
    return row;
  }

  /** Appends a rule version (never edits in place). PLATFORM + platform_wide → organization_id NULL. */
  async createRuleVersion(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: CreateRuleVersionInput,
    meta: RequestMeta,
  ): Promise<ComplianceRuleRow> {
    this.require(tenant, "compliance.manage");
    const tenantId = tenantIdOf(tenant);
    if (!RULE_KEY.test(input.rule_key)) throw new AppError(400, "INVALID_RULE_KEY", "rule_key must match ^[a-z0-9_.-]{1,64}$");
    if (!SEVERITIES.includes(input.severity)) throw new AppError(400, "INVALID_SEVERITY", "severity must be INFO, WARNING or BLOCKING");
    if (!SUBJECT_TYPES.includes(input.applies_to)) {
      throw new AppError(400, "INVALID_SUBJECT_TYPE", `applies_to must be one of ${SUBJECT_TYPES.join(", ")}`);
    }
    const definition = parseRuleDefinition(input.definition);
    if (!definition) throw new AppError(400, "INVALID_RULE_DEFINITION", "definition is not a valid compliance rule definition");
    const description = input.description ?? null;
    if (description !== null && description.length > 2000) {
      throw new AppError(400, "DESCRIPTION_TOO_LONG", "description must be at most 2000 characters");
    }
    const platformWide = input.platform_wide === true;
    if (platformWide && actorOf(tenant) !== "PLATFORM") {
      throw new AppError(403, "PLATFORM_ONLY", "only platform staff can publish platform-wide compliance rules");
    }
    const owner: TenantId | null = platformWide ? null : tenantId;
    const now = this.now().toISOString();
    const id = crypto.randomUUID();
    await this.db.batch([
      ...this.repo.ruleVersionStatements(
        owner,
        {
          id,
          rule_key: input.rule_key,
          severity: input.severity,
          applies_to: input.applies_to,
          definition,
          description,
          created_by_user_id: ctx.user.id,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "compliance.rule.version_created", "compliance_rule", id, meta, {
        rule_key: input.rule_key,
        severity: input.severity,
        applies_to: input.applies_to,
        kind: definition.kind,
        platform_wide: platformWide,
      }),
    ]);
    const row = await this.repo.findRule(tenantId, id);
    if (!row) throw new AppError(500, "RULE_NOT_PERSISTED", "compliance rule version was not persisted");
    return row;
  }

  // ---- evaluations ----------------------------------------------------------------

  async listEvaluations(tenant: TenantContext, subjectType: ComplianceSubjectType, subjectId: string): Promise<ComplianceEvaluationRow[]> {
    this.require(tenant, "compliance.read");
    return this.repo.listEvaluationsForSubject(tenantIdOf(tenant), subjectType, subjectId);
  }

  /**
   * Evaluates every current applicable rule and persists one evaluation row
   * per rule. Fail-safe: a case is opened (and a COMPLIANCE_BLOCK hold placed
   * for BLOCKING severity) when the aggregate is FAIL or a BLOCKING rule
   * returned anything other than PASS — including INSUFFICIENT_INFORMATION.
   */
  async evaluate(ctx: AuthenticatedContext, tenant: TenantContext, input: EvaluateInput, meta: RequestMeta): Promise<EvaluateResult> {
    this.require(tenant, "compliance.resolve");
    const tenantId = tenantIdOf(tenant);
    if (!SUBJECT_TYPES.includes(input.subject_type)) {
      throw new AppError(400, "INVALID_SUBJECT_TYPE", `subject_type must be one of ${SUBJECT_TYPES.join(", ")}`);
    }
    if (!input.subject_id) throw new AppError(400, "SUBJECT_REQUIRED", "subject_id is required");
    if (!input.facts || typeof input.facts !== "object") throw new AppError(400, "FACTS_REQUIRED", "facts object is required");

    const scope = await this.resolveScope(tenantId, input.subject_type, input.subject_id, input.conversion_id, input.affiliate_organization_id);

    let rules = await this.repo.listCurrentRules(tenantId, input.subject_type);
    if (input.rule_keys) {
      const wanted = new Set(input.rule_keys);
      rules = rules.filter((r) => wanted.has(r.rule_key));
    }
    // A tenant-owned rule shadows the platform default with the same key (listCurrentRules orders tenant first).
    const seen = new Set<string>();
    rules = rules.filter((r) => (seen.has(r.rule_key) ? false : (seen.add(r.rule_key), true)));
    if (rules.length === 0) throw new AppError(409, "NO_APPLICABLE_RULES", `no current compliance rules apply to ${input.subject_type}`);

    const inputs: RuleInput[] = rules.map((r) => {
      const definition = parseRuleDefinition(JSON.parse(r.definition_json));
      if (!definition) throw new AppError(500, "CORRUPT_RULE_DEFINITION", `stored definition of rule ${r.id} is invalid`);
      return { rule_key: r.rule_key, version_number: r.version_number, severity: r.severity, definition };
    });
    const result = evaluateRules(inputs, input.facts);

    const openCase = input.open_case !== false && (result.outcome === "FAIL" || result.blocking);
    const now = this.now().toISOString();
    const caseId = openCase ? crypto.randomUUID() : null;

    // Worst offending rule decides the case severity / reason (BLOCKING > WARNING > INFO; FAIL before INSUFFICIENT).
    const offending = result.results
      .map((r, i) => ({ r, row: rules[i] as ComplianceRuleRow }))
      .filter((x) => x.r.evaluation.outcome !== "PASS")
      .sort((a, b) => {
        const sev = SEVERITY_RANK[b.r.severity] - SEVERITY_RANK[a.r.severity];
        if (sev !== 0) return sev;
        return (b.r.evaluation.outcome === "FAIL" ? 1 : 0) - (a.r.evaluation.outcome === "FAIL" ? 1 : 0);
      });
    const worst = offending[0] ?? null;

    const statements: D1PreparedStatement[] = [];
    const evaluationIds: string[] = [];
    let worstEvaluationId: string | null = null;
    result.results.forEach((r, i) => {
      const id = crypto.randomUUID();
      evaluationIds.push(id);
      const row = rules[i] as ComplianceRuleRow;
      if (worst && row.id === worst.row.id) worstEvaluationId = id;
      statements.push(
        this.repo.evaluationStatement(
          tenantId,
          {
            id,
            rule_id: row.id,
            subject_type: input.subject_type,
            subject_id: input.subject_id,
            evaluation: r.evaluation,
            // link only the non-PASS evaluations to the case opened by this run
            case_id: caseId && r.evaluation.outcome !== "PASS" ? caseId : null,
          },
          now,
        ),
      );
    });

    let holdId: string | null = null;
    if (caseId && worst) {
      const severity = worst.r.severity;
      const reason = worst.r.evaluation.reason_code;
      holdId = this.pushHoldIfBlocking(statements, tenantId, caseId, severity, reason, scope, ctx.user.id, now);
      statements.push(
        this.repo.caseStatement(
          tenantId,
          {
            id: caseId,
            subject_type: input.subject_type,
            subject_id: input.subject_id,
            affiliate_organization_id: scope.affiliateId,
            rule_id: worst.row.id,
            evaluation_id: worstEvaluationId,
            severity,
            reason_code: reason,
            summary: `Auto-opened: ${result.outcome}${result.blocking ? " (blocking)" : ""}; ${offending.length} of ${rules.length} rule(s) not PASS — ${offending
              .map((o) => `${o.row.rule_key}@v${o.row.version_number}:${o.r.evaluation.outcome}`)
              .join(", ")}`.slice(0, 2000),
            hold_id: holdId,
            opened_by_user_id: ctx.user.id,
          },
          now,
        ),
        this.repo.eventStatement(
          tenantId,
          {
            case_id: caseId,
            event_type: "OPENED",
            from_status: null,
            to_status: "OPEN",
            actor_type: "SYSTEM",
            actor_user_id: ctx.user.id,
            reason_code: reason,
            note: holdId ? `COMPLIANCE_BLOCK hold ${holdId}` : null,
            request_id: meta.request_id ?? null,
          },
          now,
        ),
      );
    }
    statements.push(
      this.auditStatement(tenant, ctx, "compliance.evaluated", "compliance_subject", input.subject_id, meta, {
        subject_type: input.subject_type,
        outcome: result.outcome,
        blocking: result.blocking,
        rules: result.results.map((r) => ({ rule_key: r.rule_key, version: r.version_number, outcome: r.evaluation.outcome, reason_code: r.evaluation.reason_code })),
        evaluation_ids: evaluationIds,
        case_id: caseId,
        hold_id: holdId,
      }),
    );
    await this.db.batch(statements);

    const all = await this.repo.listEvaluationsForSubject(tenantId, input.subject_type, input.subject_id);
    const evaluations = all.filter((e) => evaluationIds.includes(e.id));
    const complianceCase = caseId ? await this.repo.findCase(tenantId, caseId) : null;
    return { result, evaluations, case: complianceCase, hold_id: holdId };
  }

  // ---- cases ------------------------------------------------------------------------

  async listCases(tenant: TenantContext, page: PageRequest, filter: ComplianceCaseListFilter): Promise<Page<ComplianceCaseRow>> {
    this.require(tenant, "compliance.read");
    return this.repo.listCases(tenantIdOf(tenant), page, filter);
  }

  async getCase(tenant: TenantContext, caseId: string): Promise<ComplianceCaseDetail> {
    this.require(tenant, "compliance.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    const [events, evaluation, rule, hold] = await Promise.all([
      this.repo.listEvents(tenantId, caseId),
      row.evaluation_id ? this.repo.findEvaluation(tenantId, row.evaluation_id) : Promise.resolve(null),
      row.rule_id ? this.repo.findRule(tenantId, row.rule_id) : Promise.resolve(null),
      row.hold_id ? this.conversions.findHold(tenantId, row.hold_id) : Promise.resolve(null),
    ]);
    return { case: row, events, evaluation, rule, hold };
  }

  /** Manually opens a case; BLOCKING severity places a COMPLIANCE_BLOCK hold in the same batch. */
  async openCase(ctx: AuthenticatedContext, tenant: TenantContext, input: OpenComplianceCaseInput, meta: RequestMeta): Promise<ComplianceCaseRow> {
    this.require(tenant, "compliance.resolve");
    const tenantId = tenantIdOf(tenant);
    if (!SUBJECT_TYPES.includes(input.subject_type)) {
      throw new AppError(400, "INVALID_SUBJECT_TYPE", `subject_type must be one of ${SUBJECT_TYPES.join(", ")}`);
    }
    if (!input.subject_id) throw new AppError(400, "SUBJECT_REQUIRED", "subject_id is required");
    if (!SEVERITIES.includes(input.severity)) throw new AppError(400, "INVALID_SEVERITY", "severity must be INFO, WARNING or BLOCKING");
    const reason = checkReason(input.reason_code, true) as string;
    const summary = checkSummary(input.summary);
    const scope = await this.resolveScope(tenantId, input.subject_type, input.subject_id, input.conversion_id, input.affiliate_organization_id);
    if (input.rule_id && !(await this.repo.findRule(tenantId, input.rule_id))) throw new AppError(404, "NOT_FOUND", "compliance rule not found");
    if (input.evaluation_id && !(await this.repo.findEvaluation(tenantId, input.evaluation_id))) {
      throw new AppError(404, "NOT_FOUND", "compliance evaluation not found");
    }

    const now = this.now().toISOString();
    const caseId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    const holdId = this.pushHoldIfBlocking(statements, tenantId, caseId, input.severity, reason, scope, ctx.user.id, now);
    const actor = actorOf(tenant);
    statements.push(
      this.repo.caseStatement(
        tenantId,
        {
          id: caseId,
          subject_type: input.subject_type,
          subject_id: input.subject_id,
          affiliate_organization_id: scope.affiliateId,
          rule_id: input.rule_id ?? null,
          evaluation_id: input.evaluation_id ?? null,
          severity: input.severity,
          reason_code: reason,
          summary,
          hold_id: holdId,
          opened_by_user_id: ctx.user.id,
        },
        now,
      ),
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: "OPENED",
          from_status: null,
          to_status: "OPEN",
          actor_type: actor,
          actor_user_id: ctx.user.id,
          reason_code: reason,
          note: summary,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "compliance.case.opened", "compliance_case", caseId, meta, {
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        severity: input.severity,
        reason_code: reason,
        conversion_id: scope.conversionId,
        affiliate_organization_id: scope.affiliateId,
        hold_id: holdId,
        actor,
      }),
    );
    await this.db.batch(statements);
    return this.mustFindCase(tenantId, caseId);
  }

  async assign(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    assigneeUserId: string | null,
    meta: RequestMeta,
  ): Promise<ComplianceCaseRow> {
    this.require(tenant, "compliance.resolve");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    if (row.status === "CLOSED") throw new AppError(409, "CASE_CLOSED", "a closed case cannot be reassigned");
    const now = this.now().toISOString();
    await this.db.batch([
      this.repo.assigneeStatement(tenantId, caseId, assigneeUserId, now),
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: "ASSIGNED",
          from_status: null,
          to_status: null,
          actor_type: actorOf(tenant),
          actor_user_id: ctx.user.id,
          reason_code: null,
          note: assigneeUserId ? `assigned to ${assigneeUserId}` : "unassigned",
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "compliance.case.assigned", "compliance_case", caseId, meta, {
        assignee_user_id: assigneeUserId,
        previous_assignee_user_id: row.assignee_user_id,
      }),
    ]);
    return this.mustFindCase(tenantId, caseId);
  }

  async addNote(ctx: AuthenticatedContext, tenant: TenantContext, caseId: string, note: string, meta: RequestMeta): Promise<ComplianceCaseEventRow[]> {
    this.require(tenant, "compliance.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    if (row.status === "CLOSED") throw new AppError(409, "CASE_CLOSED", "a closed case cannot receive notes");
    const text = checkNote(note, true) as string;
    const now = this.now().toISOString();
    await this.db.batch([
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: "NOTE_ADDED",
          from_status: null,
          to_status: null,
          actor_type: actorOf(tenant),
          actor_user_id: ctx.user.id,
          reason_code: null,
          note: text,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "compliance.case.note_added", "compliance_case", caseId, meta, { length: text.length }),
    ]);
    return this.repo.listEvents(tenantId, caseId);
  }

  /** Moves a case along the pure lifecycle table (everything except → RESOLVED, see resolve()). */
  async transition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    to: ComplianceCaseStatus,
    input: ComplianceStepInput,
    meta: RequestMeta,
  ): Promise<ComplianceCaseRow> {
    if (!COMPLIANCE_CASE_STATUSES.includes(to)) throw new AppError(400, "INVALID_STATUS", `unknown case status ${String(to)}`);
    if (to === "RESOLVED") throw new AppError(400, "USE_RESOLVE", "use resolve() with a resolution to move a case to RESOLVED");
    this.require(tenant, "compliance.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    const actor = actorOf(tenant);
    const edge = complianceCaseEdge(row.status, to, actor);
    if (!edge) throw new AppError(409, "INVALID_CASE_TRANSITION", `${actor} cannot move a compliance case from ${row.status} to ${to}`);
    this.require(tenant, edge.permission);
    const reason = checkReason(input.reason_code, edge.reason === "required");
    const note = checkNote(input.note, edge.noteRequired === true);
    const now = this.now().toISOString();

    const ok = await this.repo.batch([
      this.repo.statusStatement(tenantId, caseId, row.status, to, now),
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: edge.event,
          from_status: row.status,
          to_status: to,
          actor_type: actor,
          actor_user_id: ctx.user.id,
          reason_code: reason,
          note,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, `compliance.case.${to.toLowerCase()}`, "compliance_case", caseId, meta, {
        from: row.status,
        to,
        reason_code: reason,
        actor,
      }),
    ]);
    if (!ok) throw new AppError(409, "CASE_STATE_CONFLICT", `compliance case is no longer ${row.status}`);
    return this.mustFindCase(tenantId, caseId);
  }

  /**
   * INVESTIGATING | ESCALATED → RESOLVED with a resolution. COMPLIANT releases
   * the case's COMPLIANCE_BLOCK hold in the same batch; other resolutions keep it.
   */
  async resolve(ctx: AuthenticatedContext, tenant: TenantContext, caseId: string, input: ResolveInput, meta: RequestMeta): Promise<ComplianceCaseDetail> {
    this.require(tenant, "compliance.resolve");
    if (!COMPLIANCE_RESOLUTIONS.includes(input.resolution)) {
      throw new AppError(400, "INVALID_RESOLUTION", `resolution must be one of ${COMPLIANCE_RESOLUTIONS.join(", ")}`);
    }
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    const actor = actorOf(tenant);
    if (!RESOLVABLE.has(row.status)) {
      throw new AppError(409, "INVALID_CASE_TRANSITION", `${actor} cannot resolve a compliance case from ${row.status}`);
    }
    if (row.status === "ESCALATED") {
      if (actor !== "PLATFORM") throw new AppError(409, "INVALID_CASE_TRANSITION", "an escalated case can only be resolved by platform staff");
      this.require(tenant, "compliance.manage");
    }
    const reason = checkReason(input.reason_code, true) as string;
    const note = checkNote(input.note);
    const now = this.now().toISOString();

    const statements: D1PreparedStatement[] = [
      this.repo.statusStatement(tenantId, caseId, row.status, "RESOLVED", now, {
        resolution: input.resolution,
        resolution_reason_code: reason,
        resolved_at: now,
      }),
    ];
    let releasedHoldId: string | null = null;
    if (input.resolution === "COMPLIANT" && row.hold_id) {
      const hold = await this.conversions.findHold(tenantId, row.hold_id);
      if (hold && hold.status === "ACTIVE") {
        releasedHoldId = hold.id;
        statements.push(this.conversions.releaseHoldStatement(tenantId, hold.id, ctx.user.id, reason, now));
        statements.push(
          this.auditStatement(tenant, ctx, "conversion.hold.released", "conversion_hold", hold.id, meta, {
            hold_type: hold.hold_type,
            reason_code: reason,
            source: "COMPLIANCE_CASE",
            case_id: caseId,
          }),
        );
      }
    }
    statements.push(
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: "RESOLVED",
          from_status: row.status,
          to_status: "RESOLVED",
          actor_type: actor,
          actor_user_id: ctx.user.id,
          reason_code: reason,
          note: note ?? `${input.resolution}${releasedHoldId ? ` — released hold ${releasedHoldId}` : row.hold_id ? " — hold kept" : ""}`,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "compliance.case.resolved", "compliance_case", caseId, meta, {
        from: row.status,
        resolution: input.resolution,
        reason_code: reason,
        hold_id: row.hold_id,
        hold_released: releasedHoldId !== null,
        actor,
      }),
    );
    const ok = await this.repo.batch(statements);
    if (!ok) throw new AppError(409, "CASE_STATE_CONFLICT", `compliance case is no longer ${row.status}`);
    return this.getCase(tenant, caseId);
  }

  // ---- helpers ----------------------------------------------------------------------

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private async mustFindCase(tenantId: TenantId, caseId: string): Promise<ComplianceCaseRow> {
    const row = await this.repo.findCase(tenantId, caseId);
    if (!row) throw new AppError(404, "NOT_FOUND", "compliance case not found");
    return row;
  }

  /** Derives the conversion / affiliate a case or hold applies to; a named conversion must be visible to the tenant. */
  private async resolveScope(
    tenantId: TenantId,
    subjectType: ComplianceSubjectType,
    subjectId: string,
    conversionIdInput: string | null | undefined,
    affiliateIdInput: string | null | undefined,
  ): Promise<{ conversionId: string | null; affiliateId: string | null }> {
    const conversionId = conversionIdInput ?? (subjectType === "CONVERSION" ? subjectId : null);
    let affiliateId = affiliateIdInput ?? (subjectType === "AFFILIATE" ? subjectId : null);
    if (conversionId) {
      const conversion = await this.conversions.findById(tenantId, conversionId);
      if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");
      affiliateId = affiliateId ?? conversion.affiliate_organization_id;
    }
    return { conversionId, affiliateId };
  }

  /**
   * For BLOCKING severity, pushes a COMPLIANCE_BLOCK conversion_holds row
   * (source COMPLIANCE_CASE) BEFORE the case row so the case's hold_id FK
   * resolves inside the batch. Returns the hold id, or null when there is no
   * conversion / affiliate to scope the hold to (or severity is not BLOCKING).
   */
  private pushHoldIfBlocking(
    statements: D1PreparedStatement[],
    tenantId: TenantId,
    caseId: string,
    severity: ComplianceSeverity,
    reason: string,
    scope: { conversionId: string | null; affiliateId: string | null },
    userId: string,
    now: string,
  ): string | null {
    if (severity !== "BLOCKING") return null;
    if (!scope.conversionId && !scope.affiliateId) return null;
    const holdId = crypto.randomUUID();
    statements.push(
      this.conversions.holdStatement(
        tenantId,
        {
          id: holdId,
          conversion_id: scope.conversionId,
          // affiliate-scoped when there is no conversion; per-conversion otherwise
          affiliate_organization_id: scope.conversionId ? null : scope.affiliateId,
          hold_type: "COMPLIANCE_BLOCK",
          reason_code: reason,
          source_type: "COMPLIANCE_CASE",
          source_id: caseId,
          created_by_user_id: userId,
        },
        now,
      ),
    );
    return holdId;
  }

  private auditStatement(
    tenant: TenantContext,
    ctx: AuthenticatedContext,
    action: string,
    targetType: string,
    targetId: string,
    meta: RequestMeta,
    metadata: Record<string, unknown>,
  ): D1PreparedStatement {
    return this.audit.statement({
      organization_id: tenant.organization.id,
      actor_user_id: ctx.user.id,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata,
      meta,
    });
  }
}
