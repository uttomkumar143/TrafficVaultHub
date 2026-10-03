/**
 * Appeals (PRD §83). 5 subjects (ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION,
 * CONVERSION_DECISION, PAYOUT_HOLD, COMPLIANCE_DECISION); machine
 * SUBMITTED → UNDER_REVIEW → DECIDED, withdrawal from either open state.
 * One open appeal per (type, subject) — `ux_appeals_open_subject` → 409
 * `APPEAL_ALREADY_OPEN`. The outcome is an append-only record
 * `{outcome, reason, evidence, actor, timestamp}` written in the same batch as
 * the DECIDED transition and mirrored into `audit_logs`.
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import { assertRecordId, notFound, SupportAccess, type Actor } from "./access";
import {
  APPEAL_STATUSES,
  type AppealDecisionRow,
  type AppealOutcome,
  type AppealRow,
  type AppealStatus,
  type AppealType,
  type SupportRepository,
} from "./repository";

export const GROUNDS_MAX_LENGTH = 8000;
export const OUTCOME_REASON_MAX_LENGTH = 4000;
export const OUTCOME_EVIDENCE_MAX_ITEMS = 50;

const FINAL_STATES: ReadonlySet<AppealStatus> = new Set(["DECIDED", "WITHDRAWN"]);

export function isAppealStatus(v: string): v is AppealStatus {
  return (APPEAL_STATUSES as readonly string[]).includes(v);
}

export interface SubmitAppealInput {
  appeal_type: AppealType;
  subject_type: string;
  subject_id: string;
  grounds: string;
}

export interface DecideAppealInput {
  outcome: AppealOutcome;
  reason: string;
  evidence: string[];
}

export interface PublicAppeal extends Omit<AppealRow, "organization_id"> {}

export interface PublicOutcome {
  id: string;
  appeal_id: string;
  outcome: AppealOutcome;
  reason: string;
  evidence: string[];
  actor: string;
  timestamp: string;
}

export function toPublicAppeal(row: AppealRow): PublicAppeal {
  const { organization_id: _org, ...rest } = row;
  return rest;
}

export function toPublicOutcome(row: AppealDecisionRow): PublicOutcome {
  let evidence: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.evidence);
    if (Array.isArray(parsed)) evidence = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    evidence = [];
  }
  return { id: row.id, appeal_id: row.appeal_id, outcome: row.outcome, reason: row.reason, evidence, actor: row.actor_user_id, timestamp: row.decided_at };
}

export class AppealService {
  private readonly audit: AuditRepository;
  private readonly access: SupportAccess;
  private readonly clock: () => Date;

  constructor(
    private readonly repo: SupportRepository,
    db: D1Database,
    opts: { now?: () => Date } = {},
  ) {
    this.audit = new AuditRepository(db);
    this.clock = opts.now ?? (() => new Date());
    this.access = new SupportAccess(repo, this.clock);
  }

  // ---- read ------------------------------------------------------------------------

  async list(actor: Actor, page: PageRequest, status?: string): Promise<Page<PublicAppeal>> {
    await this.access.ensure(actor, "appeals.read");
    if (status !== undefined && !isAppealStatus(status)) throw new AppError(400, "VALIDATION_ERROR", "Unknown appeal status");
    const res = await this.repo.listAppeals(actor.tenantId, page, status === undefined ? {} : { status });
    return { items: res.items.map(toPublicAppeal), next_cursor: res.next_cursor };
  }

  async get(actor: Actor, id: string): Promise<{ appeal: PublicAppeal; outcome: PublicOutcome | null }> {
    await this.access.ensure(actor, "appeals.read");
    const appeal = await this.load(actor, id);
    const outcome = appeal.status === "DECIDED" ? await this.repo.findAppealDecision(actor.tenantId, id) : null;
    return { appeal: toPublicAppeal(appeal), outcome: outcome ? toPublicOutcome(outcome) : null };
  }

  // ---- write ------------------------------------------------------------------------

  /** Tenant face (`appeals.create`). */
  async submit(actor: Actor, input: SubmitAppealInput, meta: RequestMeta): Promise<PublicAppeal> {
    await this.access.ensure(actor, "appeals.create");
    const id = crypto.randomUUID();
    await this.repo.batch([
      this.repo.insertAppealStatement(actor.tenantId, {
        id,
        submitted_by_user_id: actor.auth.user.id,
        appeal_type: input.appeal_type,
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        grounds: input.grounds,
      }),
      this.auditStatement(actor, "appeal.submitted", id, { appeal_type: input.appeal_type, subject_type: input.subject_type }, meta),
    ]);
    return toPublicAppeal(await this.load(actor, id));
  }

  /** Platform face (`appeals.manage`): SUBMITTED → UNDER_REVIEW, assigning the reviewer. */
  async review(actor: Actor, id: string, meta: RequestMeta): Promise<PublicAppeal> {
    await this.access.ensure(actor, "appeals.manage");
    const appeal = await this.load(actor, id);
    if (FINAL_STATES.has(appeal.status)) throw finalAppeal();
    if (appeal.status !== "SUBMITTED") throw illegal(appeal.status, "UNDER_REVIEW");
    await this.transition(actor, appeal, "UNDER_REVIEW", [], { assignTo: actor.auth.user.id }, meta);
    return toPublicAppeal(await this.load(actor, id));
  }

  /** Platform face: UNDER_REVIEW → DECIDED with the audited outcome. */
  async decide(actor: Actor, id: string, input: DecideAppealInput, meta: RequestMeta): Promise<{ appeal: PublicAppeal; outcome: PublicOutcome }> {
    await this.access.ensure(actor, "appeals.manage");
    const appeal = await this.load(actor, id);
    if (FINAL_STATES.has(appeal.status)) throw finalAppeal();
    if (appeal.status !== "UNDER_REVIEW") throw illegal(appeal.status, "DECIDED");
    const now = this.now();
    const decisionId = crypto.randomUUID();
    await this.transition(
      actor,
      appeal,
      "DECIDED",
      [
        this.repo.insertAppealDecisionStatement({
          id: decisionId,
          appeal_id: id,
          outcome: input.outcome,
          reason: input.reason,
          evidence: JSON.stringify(input.evidence),
          actor_user_id: actor.auth.user.id,
          decided_at: now,
        }),
      ],
      { now, metadata: { outcome: input.outcome, decision_id: decisionId, reason: input.reason } },
      meta,
    );
    const [after, outcome] = await Promise.all([this.load(actor, id), this.repo.findAppealDecision(actor.tenantId, id)]);
    if (!outcome) throw notFound("Outcome");
    return { appeal: toPublicAppeal(after), outcome: toPublicOutcome(outcome) };
  }

  /** Tenant face (`appeals.create`): withdraw while not final. */
  async withdraw(actor: Actor, id: string, meta: RequestMeta): Promise<PublicAppeal> {
    await this.access.ensure(actor, "appeals.create");
    const appeal = await this.load(actor, id);
    if (FINAL_STATES.has(appeal.status)) throw finalAppeal();
    await this.transition(actor, appeal, "WITHDRAWN", [], {}, meta);
    return toPublicAppeal(await this.load(actor, id));
  }

  // ---- helpers ----------------------------------------------------------------------

  private async transition(
    actor: Actor,
    appeal: AppealRow,
    to: AppealStatus,
    extra: D1PreparedStatement[],
    opts: { assignTo?: string; now?: string; metadata?: Record<string, unknown> },
    meta: RequestMeta,
  ): Promise<void> {
    const now = opts.now ?? this.now();
    const results = await this.repo.batch([
      this.repo.appealTransitionStatement(actor.tenantId, appeal.id, appeal.status, to, now, opts.assignTo === undefined ? {} : { assignTo: opts.assignTo }),
      ...extra,
      this.auditStatement(actor, `appeal.${to.toLowerCase()}`, appeal.id, { from: appeal.status, to, ...(opts.metadata ?? {}) }, meta),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new AppError(409, "SUPPORT_STATE_CONFLICT", "The appeal changed underneath this request");
  }

  private async load(actor: Actor, id: string): Promise<AppealRow> {
    assertRecordId(id, "Appeal");
    const row = await this.repo.findAppeal(actor.tenantId, id);
    if (!row) throw notFound("Appeal");
    return row;
  }

  private auditStatement(actor: Actor, action: string, targetId: string, metadata: Record<string, unknown>, meta: RequestMeta): D1PreparedStatement {
    return this.audit.statement({
      organization_id: actor.tenantId,
      actor_user_id: actor.auth.user.id,
      action,
      target_type: "appeal",
      target_id: targetId,
      metadata: { ...metadata, face: actor.face },
      meta,
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function finalAppeal(): AppError {
  return new AppError(409, "APPEAL_FINAL", "The appeal is already decided or withdrawn");
}

function illegal(from: AppealStatus, to: AppealStatus): AppError {
  return new AppError(409, "APPEAL_ILLEGAL_TRANSITION", `An appeal in ${from} cannot move to ${to}`);
}
