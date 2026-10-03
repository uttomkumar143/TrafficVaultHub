/**
 * Disputes (PRD §82). 8 categories; machine OPEN → UNDER_REVIEW → DECIDED,
 * withdrawal by the tenant from OPEN/UNDER_REVIEW. A decision is the record
 * `{decision, reason, evidence, actor, timestamp}` written append-only in the
 * same batch as the DECIDED transition. Final states (DECIDED/WITHDRAWN)
 * refuse every change with 409 `DISPUTE_FINAL`; the 0012 triggers back this up
 * and `classifySupportWriteError` keeps DB text out of responses.
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import { assertRecordId, notFound, SupportAccess, type Actor } from "./access";
import {
  DISPUTE_STATUSES,
  type DisputeCategory,
  type DisputeDecision,
  type DisputeDecisionRow,
  type DisputeRow,
  type DisputeStatus,
  type EvidenceKind,
  type EvidenceRow,
  type SupportRepository,
} from "./repository";

export const DISPUTE_TITLE_MAX_LENGTH = 200;
export const DISPUTE_DESCRIPTION_MAX_LENGTH = 8000;
export const EVIDENCE_CONTENT_MAX_LENGTH = 8000;
export const DECISION_REASON_MAX_LENGTH = 4000;
export const DECISION_EVIDENCE_MAX_ITEMS = 50;

const FINAL_STATES: ReadonlySet<DisputeStatus> = new Set(["DECIDED", "WITHDRAWN"]);

export function isDisputeStatus(v: string): v is DisputeStatus {
  return (DISPUTE_STATUSES as readonly string[]).includes(v);
}

export interface CreateDisputeInput {
  category: DisputeCategory;
  subject_type: string;
  subject_id: string;
  title: string;
  description: string;
  /** Integer minor units; must be paired with `currency`. */
  disputed_amount_minor?: number | null;
  currency?: string | null;
}

export interface DecideDisputeInput {
  decision: DisputeDecision;
  reason: string;
  /** References to evidence rows / records the decision rests on. */
  evidence: string[];
}

export interface PublicDispute extends Omit<DisputeRow, "organization_id"> {}

export interface PublicDecision {
  id: string;
  dispute_id: string;
  decision: DisputeDecision;
  reason: string;
  evidence: string[];
  actor: string;
  timestamp: string;
}

export function toPublicDispute(row: DisputeRow): PublicDispute {
  const { organization_id: _org, ...rest } = row;
  return rest;
}

export function toPublicDecision(row: DisputeDecisionRow): PublicDecision {
  let evidence: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.evidence);
    if (Array.isArray(parsed)) evidence = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    evidence = [];
  }
  return { id: row.id, dispute_id: row.dispute_id, decision: row.decision, reason: row.reason, evidence, actor: row.actor_user_id, timestamp: row.decided_at };
}

export class DisputeService {
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

  async list(actor: Actor, page: PageRequest, status?: string): Promise<Page<PublicDispute>> {
    await this.access.ensure(actor, "disputes.read");
    if (status !== undefined && !isDisputeStatus(status)) throw new AppError(400, "VALIDATION_ERROR", "Unknown dispute status");
    const res = await this.repo.listDisputes(actor.tenantId, page, status === undefined ? {} : { status });
    return { items: res.items.map(toPublicDispute), next_cursor: res.next_cursor };
  }

  async get(actor: Actor, id: string): Promise<{ dispute: PublicDispute; decision: PublicDecision | null }> {
    await this.access.ensure(actor, "disputes.read");
    const dispute = await this.load(actor, id);
    const decision = dispute.status === "DECIDED" ? await this.repo.findDisputeDecision(actor.tenantId, id) : null;
    return { dispute: toPublicDispute(dispute), decision: decision ? toPublicDecision(decision) : null };
  }

  /** Tenant face sees both sides' evidence; nothing is hidden once submitted (§82). */
  async evidence(actor: Actor, id: string, page: PageRequest): Promise<Page<EvidenceRow>> {
    await this.access.ensure(actor, "disputes.read");
    await this.load(actor, id);
    return this.repo.listEvidence(actor.tenantId, id, page, ["TENANT", "NETWORK"]);
  }

  // ---- write ------------------------------------------------------------------------

  /** Tenant face (`disputes.create`). One open dispute per subject (409 `DISPUTE_ALREADY_OPEN`). */
  async create(actor: Actor, input: CreateDisputeInput, meta: RequestMeta): Promise<PublicDispute> {
    await this.access.ensure(actor, "disputes.create");
    const amount = input.disputed_amount_minor ?? null;
    const currency = input.currency ?? null;
    if ((amount === null) !== (currency === null)) throw new AppError(400, "VALIDATION_ERROR", "disputed_amount_minor and currency must be given together");
    if (amount !== null && (!Number.isInteger(amount) || amount <= 0)) throw new AppError(400, "VALIDATION_ERROR", "disputed_amount_minor must be a positive integer");
    const id = crypto.randomUUID();
    await this.repo.batch([
      this.repo.insertDisputeStatement(actor.tenantId, {
        id,
        raised_by_user_id: actor.auth.user.id,
        category: input.category,
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        title: input.title,
        description: input.description,
        disputed_amount_minor: amount,
        currency,
      }),
      this.auditStatement(actor, "dispute.created", id, { category: input.category, subject_type: input.subject_type }, meta),
    ]);
    return toPublicDispute(await this.load(actor, id));
  }

  /** Evidence is append-only and only accepted while OPEN/UNDER_REVIEW (409 `DISPUTE_FINAL`). */
  async addEvidence(actor: Actor, id: string, kind: EvidenceKind, content: string, meta: RequestMeta): Promise<EvidenceRow> {
    await this.access.ensure(actor, actor.face === "PLATFORM" ? "disputes.manage" : "disputes.create");
    const dispute = await this.load(actor, id);
    if (FINAL_STATES.has(dispute.status)) throw finalDispute();
    const evidenceId = crypto.randomUUID();
    await this.repo.batch([
      this.repo.insertEvidenceStatement({
        id: evidenceId,
        dispute_id: id,
        submitted_by_user_id: actor.auth.user.id,
        submitter_side: actor.face === "PLATFORM" ? "NETWORK" : "TENANT",
        kind,
        content,
      }),
      this.auditStatement(actor, "dispute.evidence_added", id, { evidence_id: evidenceId, kind }, meta),
    ]);
    const page = await this.repo.listEvidence(actor.tenantId, id, { limit: 100, cursor: null }, ["TENANT", "NETWORK"]);
    const row = page.items.find((e) => e.id === evidenceId);
    if (!row) throw notFound("Evidence");
    return row;
  }

  /** Platform face (`disputes.manage`): OPEN → UNDER_REVIEW, assigning the reviewer. */
  async review(actor: Actor, id: string, meta: RequestMeta): Promise<PublicDispute> {
    await this.access.ensure(actor, "disputes.manage");
    const dispute = await this.load(actor, id);
    if (FINAL_STATES.has(dispute.status)) throw finalDispute();
    if (dispute.status !== "OPEN") throw illegal(dispute.status, "UNDER_REVIEW");
    await this.transition(actor, dispute, "UNDER_REVIEW", [], { assignTo: actor.auth.user.id }, meta);
    return toPublicDispute(await this.load(actor, id));
  }

  /** Platform face: UNDER_REVIEW → DECIDED with the audited decision record. */
  async decide(actor: Actor, id: string, input: DecideDisputeInput, meta: RequestMeta): Promise<{ dispute: PublicDispute; decision: PublicDecision }> {
    await this.access.ensure(actor, "disputes.manage");
    const dispute = await this.load(actor, id);
    if (FINAL_STATES.has(dispute.status)) throw finalDispute();
    if (dispute.status !== "UNDER_REVIEW") throw illegal(dispute.status, "DECIDED");
    const now = this.now();
    const decisionId = crypto.randomUUID();
    await this.transition(
      actor,
      dispute,
      "DECIDED",
      [
        this.repo.insertDisputeDecisionStatement({
          id: decisionId,
          dispute_id: id,
          decision: input.decision,
          reason: input.reason,
          evidence: JSON.stringify(input.evidence),
          actor_user_id: actor.auth.user.id,
          decided_at: now,
        }),
      ],
      { now, metadata: { decision: input.decision, decision_id: decisionId } },
      meta,
    );
    const [after, decision] = await Promise.all([this.load(actor, id), this.repo.findDisputeDecision(actor.tenantId, id)]);
    if (!decision) throw notFound("Decision");
    return { dispute: toPublicDispute(after), decision: toPublicDecision(decision) };
  }

  /** Tenant face (`disputes.create`): withdraw while not final. */
  async withdraw(actor: Actor, id: string, meta: RequestMeta): Promise<PublicDispute> {
    await this.access.ensure(actor, "disputes.create");
    const dispute = await this.load(actor, id);
    if (FINAL_STATES.has(dispute.status)) throw finalDispute();
    await this.transition(actor, dispute, "WITHDRAWN", [], {}, meta);
    return toPublicDispute(await this.load(actor, id));
  }

  // ---- helpers ----------------------------------------------------------------------

  private async transition(
    actor: Actor,
    dispute: DisputeRow,
    to: DisputeStatus,
    extra: D1PreparedStatement[],
    opts: { assignTo?: string; now?: string; metadata?: Record<string, unknown> },
    meta: RequestMeta,
  ): Promise<void> {
    const now = opts.now ?? this.now();
    const results = await this.repo.batch([
      this.repo.disputeTransitionStatement(actor.tenantId, dispute.id, dispute.status, to, now, opts.assignTo === undefined ? {} : { assignTo: opts.assignTo }),
      ...extra,
      this.auditStatement(actor, `dispute.${to.toLowerCase()}`, dispute.id, { from: dispute.status, to, ...(opts.metadata ?? {}) }, meta),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new AppError(409, "SUPPORT_STATE_CONFLICT", "The dispute changed underneath this request");
  }

  private async load(actor: Actor, id: string): Promise<DisputeRow> {
    assertRecordId(id, "Dispute");
    const row = await this.repo.findDispute(actor.tenantId, id);
    if (!row) throw notFound("Dispute");
    return row;
  }

  private auditStatement(actor: Actor, action: string, targetId: string, metadata: Record<string, unknown>, meta: RequestMeta): D1PreparedStatement {
    return this.audit.statement({
      organization_id: actor.tenantId,
      actor_user_id: actor.auth.user.id,
      action,
      target_type: "dispute",
      target_id: targetId,
      metadata: { ...metadata, face: actor.face },
      meta,
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function finalDispute(): AppError {
  return new AppError(409, "DISPUTE_FINAL", "The dispute is already decided or withdrawn");
}

function illegal(from: DisputeStatus, to: DisputeStatus): AppError {
  return new AppError(409, "DISPUTE_ILLEGAL_TRANSITION", `A dispute in ${from} cannot move to ${to}`);
}
