/**
 * FraudService — Phase 4 Unit 7b (PRD §41–§44, §115).
 *
 * assess(): runs the pure risk engine over caller-supplied facts and stores
 *   the result as a fraud_assessments row. An assessment is EVIDENCE, never a
 *   verdict: the conversion's lifecycle_status is untouched. When the level
 *   reaches `open_case_at_or_above` a fraud case is opened in the SAME batch.
 *
 * Case lifecycle (pure table below, actor from tenant.organization.type):
 *   OPEN → UNDER_REVIEW → CONFIRMED | DISMISSED            (PLATFORM, fraud.review)
 *   CONFIRMED → APPEALED                                    (tenant side, fraud.read, note required)
 *   APPEALED → APPEAL_UPHELD | APPEAL_REJECTED              (PLATFORM, fraud.review, reason_code)
 *   CONFIRMED | DISMISSED | APPEAL_UPHELD | APPEAL_REJECTED → CLOSED (PLATFORM, fraud.review)
 *   Invalid edge → 409 INVALID_CASE_TRANSITION; stale status → 409 CASE_STATE_CONFLICT
 *   (guarded UPDATE, whole batch rolls back, nothing written).
 *
 * Every step is one db.batch: guarded UPDATE + INSERT-only fraud_case_events
 * row + audit_logs row (+ conversion_holds / fraud_actions where relevant).
 *
 * takeAction(): PLATFORM actor only. MONITOR / MANUAL_REVIEW / CONVERSION_HOLD /
 *   TRAFFIC_RESTRICTION need fraud.review; PAYOUT_HOLD / ACCOUNT_RESTRICTION /
 *   ACCOUNT_SUSPENSION need fraud.manage. CONVERSION_HOLD and PAYOUT_HOLD write
 *   a conversion_holds row (source FRAUD_CASE) in the same batch, so the
 *   conversion state machine blocks approval / payout eligibility immediately.
 *   Account-level actions are RECORDED only (audit metadata record_only: true);
 *   organizations.status is not mutated — known gap.
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { ConversionRepository } from "../conversions/repository";
import type { PermissionKey } from "../rbac/permissions";
import {
  type ActionInsert,
  type FraudActionRow,
  type FraudActionType,
  type FraudActor,
  type FraudAssessmentRow,
  type FraudCaseEventRow,
  type FraudCaseEventType,
  type FraudCaseListFilter,
  type FraudCaseRow,
  type FraudCaseStatus,
  type FraudRepository,
  type FraudSubjectType,
  FRAUD_ACTION_TYPES,
  FRAUD_CASE_STATUSES,
} from "./repository";
import { assessRisk, type RiskAssessment, type RiskFacts, type RiskLevel } from "./risk-engine";

export interface FraudServiceOptions {
  now?: () => Date;
}

export interface AssessInput {
  subject_type: FraudSubjectType;
  subject_id: string;
  conversion_id?: string | null;
  affiliate_organization_id?: string | null;
  facts: RiskFacts;
  /** Open a case in the same batch when the level reaches this threshold. */
  open_case_at_or_above?: RiskLevel;
  /** Reason code recorded on the auto-opened case (default AUTO_RISK_<LEVEL>). */
  case_reason_code?: string;
}

export interface AssessResult {
  assessment: FraudAssessmentRow;
  risk: RiskAssessment;
  case: FraudCaseRow | null;
}

export interface OpenCaseInput {
  severity: RiskLevel;
  reason_code: string;
  summary?: string | null;
  conversion_id?: string | null;
  affiliate_organization_id?: string | null;
  assessment_id?: string | null;
}

export interface CaseTransitionInput {
  reason_code?: string;
  note?: string | null;
}

export interface TakeActionInput {
  action_type: FraudActionType;
  reason_code: string;
  note?: string | null;
  /** Defaults to the case's conversion. */
  conversion_id?: string | null;
  /** Defaults to the case's affiliate. */
  affiliate_organization_id?: string | null;
}

export interface FraudCaseDetail {
  case: FraudCaseRow;
  events: FraudCaseEventRow[];
  actions: FraudActionRow[];
  assessment: FraudAssessmentRow | null;
}

const REASON_CODE = /^[A-Z0-9_]{1,64}$/;
const LEVEL_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

interface CaseEdge {
  to: FraudCaseStatus;
  actors: readonly FraudActor[];
  permission: PermissionKey;
  event: FraudCaseEventType;
  reason: "required" | "optional";
  noteRequired?: boolean;
}

/** Pure case lifecycle table. */
const CASE_EDGES: Readonly<Record<FraudCaseStatus, readonly CaseEdge[]>> = {
  OPEN: [{ to: "UNDER_REVIEW", actors: ["PLATFORM"], permission: "fraud.review", event: "STATUS_CHANGED", reason: "optional" }],
  UNDER_REVIEW: [
    { to: "CONFIRMED", actors: ["PLATFORM"], permission: "fraud.review", event: "STATUS_CHANGED", reason: "required" },
    { to: "DISMISSED", actors: ["PLATFORM"], permission: "fraud.review", event: "STATUS_CHANGED", reason: "required" },
  ],
  CONFIRMED: [
    {
      to: "APPEALED",
      actors: ["TENANT", "PLATFORM"],
      permission: "fraud.read",
      event: "APPEAL_FILED",
      reason: "optional",
      noteRequired: true,
    },
    { to: "CLOSED", actors: ["PLATFORM"], permission: "fraud.review", event: "CLOSED", reason: "optional" },
  ],
  DISMISSED: [{ to: "CLOSED", actors: ["PLATFORM"], permission: "fraud.review", event: "CLOSED", reason: "optional" }],
  APPEALED: [
    { to: "APPEAL_UPHELD", actors: ["PLATFORM"], permission: "fraud.review", event: "APPEAL_DECIDED", reason: "required" },
    { to: "APPEAL_REJECTED", actors: ["PLATFORM"], permission: "fraud.review", event: "APPEAL_DECIDED", reason: "required" },
  ],
  APPEAL_UPHELD: [{ to: "CLOSED", actors: ["PLATFORM"], permission: "fraud.review", event: "CLOSED", reason: "optional" }],
  APPEAL_REJECTED: [{ to: "CLOSED", actors: ["PLATFORM"], permission: "fraud.review", event: "CLOSED", reason: "optional" }],
  CLOSED: [],
};

export function caseEdge(from: FraudCaseStatus, to: FraudCaseStatus, actor: FraudActor): CaseEdge | null {
  const edge = CASE_EDGES[from].find((e) => e.to === to);
  if (!edge || !edge.actors.includes(actor)) return null;
  return edge;
}

const REVIEW_ACTIONS: ReadonlySet<FraudActionType> = new Set(["MONITOR", "MANUAL_REVIEW", "CONVERSION_HOLD", "TRAFFIC_RESTRICTION"]);
const ACCOUNT_ACTIONS: ReadonlySet<FraudActionType> = new Set(["ACCOUNT_RESTRICTION", "ACCOUNT_SUSPENSION"]);

export function actionPermission(action: FraudActionType): PermissionKey {
  return REVIEW_ACTIONS.has(action) ? "fraud.review" : "fraud.manage";
}

function actorOf(tenant: TenantContext): FraudActor {
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

export class FraudService {
  private readonly audit: AuditRepository;
  private readonly now: () => Date;

  constructor(
    private readonly repo: FraudRepository,
    private readonly conversions: ConversionRepository,
    private readonly db: D1Database,
    options: FraudServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.now = options.now ?? (() => new Date());
  }

  // ---- reads -----------------------------------------------------------------

  async listCases(tenant: TenantContext, page: PageRequest, filter: FraudCaseListFilter): Promise<Page<FraudCaseRow>> {
    this.require(tenant, "fraud.read");
    return this.repo.listCases(tenantIdOf(tenant), page, filter);
  }

  async getCase(tenant: TenantContext, caseId: string): Promise<FraudCaseDetail> {
    this.require(tenant, "fraud.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    const [events, actions, assessment] = await Promise.all([
      this.repo.listEvents(tenantId, caseId),
      this.repo.listActions(tenantId, caseId),
      row.assessment_id ? this.repo.findAssessment(tenantId, row.assessment_id) : Promise.resolve(null),
    ]);
    return { case: row, events, actions, assessment };
  }

  async listAssessments(tenant: TenantContext, subjectType: FraudSubjectType, subjectId: string): Promise<FraudAssessmentRow[]> {
    this.require(tenant, "fraud.read");
    return this.repo.listAssessmentsForSubject(tenantIdOf(tenant), subjectType, subjectId);
  }

  // ---- assessment --------------------------------------------------------------

  async assess(ctx: AuthenticatedContext, tenant: TenantContext, input: AssessInput, meta: RequestMeta): Promise<AssessResult> {
    this.require(tenant, "fraud.review");
    const tenantId = tenantIdOf(tenant);
    if (!input.subject_id) throw new AppError(400, "SUBJECT_REQUIRED", "subject_id is required");
    const conversionId = input.conversion_id ?? (input.subject_type === "CONVERSION" ? input.subject_id : null);
    let affiliateId = input.affiliate_organization_id ?? (input.subject_type === "AFFILIATE" ? input.subject_id : null);
    if (conversionId) {
      const conversion = await this.conversions.findById(tenantId, conversionId);
      if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");
      affiliateId = affiliateId ?? conversion.affiliate_organization_id;
    }

    const risk = assessRisk(input.facts);
    const now = this.now().toISOString();
    const assessmentId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.repo.assessmentStatement(
        tenantId,
        {
          id: assessmentId,
          subject_type: input.subject_type,
          subject_id: input.subject_id,
          conversion_id: conversionId,
          affiliate_organization_id: affiliateId,
          rule_version: risk.rule_version,
          score: risk.score,
          level: risk.level,
          signals: risk.signals,
        },
        now,
      ),
    ];

    let caseId: string | null = null;
    const threshold = input.open_case_at_or_above;
    if (threshold && LEVEL_RANK[risk.level] >= LEVEL_RANK[threshold]) {
      caseId = crypto.randomUUID();
      const reason = checkReason(input.case_reason_code ?? `AUTO_RISK_${risk.level}`, true) as string;
      statements.push(
        this.repo.caseStatement(
          tenantId,
          {
            id: caseId,
            affiliate_organization_id: affiliateId,
            conversion_id: conversionId,
            assessment_id: assessmentId,
            severity: risk.level,
            reason_code: reason,
            summary: `Auto-opened: ${risk.rule_version} score ${risk.score} (${risk.level}), ${risk.signals.length} signal(s)`,
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
            note: null,
            request_id: meta.request_id ?? null,
          },
          now,
        ),
      );
    }
    statements.push(
      this.auditStatement(tenant, ctx, "fraud.assessed", "fraud_assessment", assessmentId, meta, {
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        rule_version: risk.rule_version,
        score: risk.score,
        level: risk.level,
        signal_codes: risk.signals.map((s) => s.code),
        case_id: caseId,
      }),
    );
    await this.db.batch(statements);

    const assessment = await this.repo.findAssessment(tenantId, assessmentId);
    if (!assessment) throw new AppError(500, "ASSESSMENT_NOT_PERSISTED", "assessment was not persisted");
    const fraudCase = caseId ? await this.repo.findCase(tenantId, caseId) : null;
    return { assessment, risk, case: fraudCase };
  }

  // ---- cases -------------------------------------------------------------------

  async openCase(ctx: AuthenticatedContext, tenant: TenantContext, input: OpenCaseInput, meta: RequestMeta): Promise<FraudCaseRow> {
    this.require(tenant, "fraud.review");
    const tenantId = tenantIdOf(tenant);
    const reason = checkReason(input.reason_code, true) as string;
    if (!(input.severity in LEVEL_RANK)) throw new AppError(400, "INVALID_SEVERITY", "severity must be LOW, MEDIUM, HIGH or CRITICAL");
    const summary = input.summary ?? null;
    if (summary && summary.length > 2000) throw new AppError(400, "SUMMARY_TOO_LONG", "summary must be at most 2000 characters");
    let affiliateId = input.affiliate_organization_id ?? null;
    const conversionId = input.conversion_id ?? null;
    if (conversionId) {
      const conversion = await this.conversions.findById(tenantId, conversionId);
      if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");
      affiliateId = affiliateId ?? conversion.affiliate_organization_id;
    }
    if (input.assessment_id) {
      const assessment = await this.repo.findAssessment(tenantId, input.assessment_id);
      if (!assessment) throw new AppError(404, "NOT_FOUND", "assessment not found");
    }
    const now = this.now().toISOString();
    const id = crypto.randomUUID();
    await this.db.batch([
      this.repo.caseStatement(
        tenantId,
        {
          id,
          affiliate_organization_id: affiliateId,
          conversion_id: conversionId,
          assessment_id: input.assessment_id ?? null,
          severity: input.severity,
          reason_code: reason,
          summary,
          opened_by_user_id: ctx.user.id,
        },
        now,
      ),
      this.repo.eventStatement(
        tenantId,
        {
          case_id: id,
          event_type: "OPENED",
          from_status: null,
          to_status: "OPEN",
          actor_type: actorOf(tenant),
          actor_user_id: ctx.user.id,
          reason_code: reason,
          note: summary,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "fraud.case.opened", "fraud_case", id, meta, {
        severity: input.severity,
        reason_code: reason,
        conversion_id: conversionId,
        affiliate_organization_id: affiliateId,
      }),
    ]);
    return this.mustFindCase(tenantId, id);
  }

  async assign(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    reviewerUserId: string | null,
    meta: RequestMeta,
  ): Promise<FraudCaseRow> {
    this.require(tenant, "fraud.review");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    if (row.status === "CLOSED") throw new AppError(409, "CASE_CLOSED", "a closed case cannot be reassigned");
    const now = this.now().toISOString();
    await this.db.batch([
      this.repo.reviewerStatement(tenantId, caseId, reviewerUserId, now),
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
          note: reviewerUserId ? `assigned to ${reviewerUserId}` : "unassigned",
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "fraud.case.assigned", "fraud_case", caseId, meta, { reviewer_user_id: reviewerUserId }),
    ]);
    return this.mustFindCase(tenantId, caseId);
  }

  async addNote(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    note: string,
    meta: RequestMeta,
  ): Promise<FraudCaseEventRow[]> {
    this.require(tenant, "fraud.read");
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
      this.auditStatement(tenant, ctx, "fraud.case.note_added", "fraud_case", caseId, meta, { length: text.length }),
    ]);
    return this.repo.listEvents(tenantId, caseId);
  }

  async transition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    to: FraudCaseStatus,
    input: CaseTransitionInput,
    meta: RequestMeta,
  ): Promise<FraudCaseRow> {
    if (!FRAUD_CASE_STATUSES.includes(to)) throw new AppError(400, "INVALID_STATUS", `unknown case status ${String(to)}`);
    this.require(tenant, "fraud.read");
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    const actor = actorOf(tenant);
    const edge = caseEdge(row.status, to, actor);
    if (!edge) throw new AppError(409, "INVALID_CASE_TRANSITION", `${actor} cannot move a fraud case from ${row.status} to ${to}`);
    this.require(tenant, edge.permission);
    const reason = checkReason(input.reason_code, edge.reason === "required");
    const note = checkNote(input.note, edge.noteRequired === true);
    const now = this.now().toISOString();

    const extra: Parameters<FraudRepository["statusStatement"]>[5] = {};
    const isDecision = to === "CONFIRMED" || to === "DISMISSED" || to === "APPEAL_UPHELD" || to === "APPEAL_REJECTED";
    if (isDecision && reason) {
      extra.decision_reason_code = reason;
      extra.decided_at = now;
    }
    if (to === "APPEALED") {
      extra.appeal_note = note as string;
      extra.appealed_by_user_id = ctx.user.id;
      extra.appealed_at = now;
    }

    const ok = await this.repo.batch([
      this.repo.statusStatement(tenantId, caseId, row.status, to, now, extra),
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
      this.auditStatement(tenant, ctx, `fraud.case.${to.toLowerCase()}`, "fraud_case", caseId, meta, {
        from: row.status,
        to,
        reason_code: reason,
        actor,
      }),
    ]);
    if (!ok) throw new AppError(409, "CASE_STATE_CONFLICT", `fraud case is no longer ${row.status}`);
    return this.mustFindCase(tenantId, caseId);
  }

  // ---- actions -------------------------------------------------------------------

  async takeAction(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    caseId: string,
    input: TakeActionInput,
    meta: RequestMeta,
  ): Promise<{ action: FraudActionRow; hold_id: string | null }> {
    if (actorOf(tenant) !== "PLATFORM") throw new AppError(403, "PLATFORM_ONLY", "fraud actions can only be taken by platform staff");
    if (!FRAUD_ACTION_TYPES.includes(input.action_type)) {
      throw new AppError(400, "INVALID_ACTION_TYPE", `action_type must be one of ${FRAUD_ACTION_TYPES.join(", ")}`);
    }
    this.require(tenant, actionPermission(input.action_type));
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    if (row.status === "CLOSED") throw new AppError(409, "CASE_CLOSED", "no actions can be taken on a closed case");
    const reason = checkReason(input.reason_code, true) as string;
    const note = checkNote(input.note);

    const conversionId = input.conversion_id ?? row.conversion_id;
    let affiliateId = input.affiliate_organization_id ?? row.affiliate_organization_id;
    if (conversionId) {
      const conversion = await this.conversions.findById(tenantId, conversionId);
      if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");
      affiliateId = affiliateId ?? conversion.affiliate_organization_id;
    }

    const now = this.now().toISOString();
    const actionId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    let holdId: string | null = null;

    if (input.action_type === "CONVERSION_HOLD" || input.action_type === "PAYOUT_HOLD") {
      if (input.action_type === "CONVERSION_HOLD" && !conversionId) {
        throw new AppError(400, "CONVERSION_REQUIRED", "CONVERSION_HOLD needs a conversion");
      }
      if (!conversionId && !affiliateId) throw new AppError(400, "HOLD_SCOPE_REQUIRED", "PAYOUT_HOLD needs a conversion or an affiliate");
      holdId = crypto.randomUUID();
      statements.push(
        this.conversions.holdStatement(
          tenantId,
          {
            id: holdId,
            conversion_id: conversionId,
            // affiliate-scoped PAYOUT_HOLD when there is no conversion; per-conversion otherwise
            affiliate_organization_id: conversionId ? null : affiliateId,
            hold_type: input.action_type,
            reason_code: reason,
            source_type: "FRAUD_CASE",
            source_id: caseId,
            created_by_user_id: ctx.user.id,
          },
          now,
        ),
      );
    }

    const recordOnly = ACCOUNT_ACTIONS.has(input.action_type);
    const action: ActionInsert = {
      id: actionId,
      case_id: caseId,
      affiliate_organization_id: affiliateId,
      conversion_id: conversionId,
      action_type: input.action_type,
      hold_id: holdId,
      reason_code: reason,
      note,
      taken_by_user_id: ctx.user.id,
      actor_type: "PLATFORM",
      request_id: meta.request_id ?? null,
    };
    statements.push(
      this.repo.actionStatement(tenantId, action, now),
      this.repo.eventStatement(
        tenantId,
        {
          case_id: caseId,
          event_type: "ACTION_TAKEN",
          from_status: null,
          to_status: null,
          actor_type: "PLATFORM",
          actor_user_id: ctx.user.id,
          reason_code: reason,
          note: note ?? `${input.action_type}${holdId ? ` hold ${holdId}` : ""}`,
          request_id: meta.request_id ?? null,
        },
        now,
      ),
      this.auditStatement(tenant, ctx, "fraud.action.taken", "fraud_action", actionId, meta, {
        case_id: caseId,
        action_type: input.action_type,
        reason_code: reason,
        conversion_id: conversionId,
        affiliate_organization_id: affiliateId,
        hold_id: holdId,
        // account-level actions are recorded only; organizations.status is NOT mutated (known gap)
        record_only: recordOnly,
      }),
    );
    await this.db.batch(statements);

    const actions = await this.repo.listActions(tenantId, caseId);
    const persisted = actions.find((a) => a.id === actionId);
    if (!persisted) throw new AppError(500, "ACTION_NOT_PERSISTED", "fraud action was not persisted");
    return { action: persisted, hold_id: holdId };
  }

  // ---- helpers -----------------------------------------------------------------------

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private async mustFindCase(tenantId: TenantId, caseId: string): Promise<FraudCaseRow> {
    const row = await this.repo.findCase(tenantId, caseId);
    if (!row) throw new AppError(404, "NOT_FOUND", "fraud case not found");
    return row;
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
