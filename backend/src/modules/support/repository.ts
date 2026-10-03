/**
 * Support / disputes / appeals persistence over D1 (migration 0012; PRD §81,
 * §82, §83, §127). Pure data access — WHO may do WHAT and the state-machine
 * policy live in `service.ts`; the 0012 triggers are the last line of
 * defence and surface through `classifySupportWriteError` as stable codes.
 *
 * Invariants enforced HERE, at the SQL level:
 *   * Every tenant READ goes through `scopedQuery` (`organization_id = ?`
 *     bound first). Child tables without an `organization_id` column
 *     (messages, events, evidence, decisions) are read through a JOIN on
 *     their parent so the predicate is still the first placeholder.
 *   * Writes bind the `TenantId` brand explicitly at the `organization_id`
 *     position (same pattern as `api-keys/repository.ts`).
 *   * Status changes are guarded UPDATEs (`… AND status = ?`): `changes` tells
 *     the service whether the transition happened; a concurrent change makes
 *     the statement a no-op rather than an illegal edge.
 *   * Nothing is deleted (0012 `*_no_delete` / `*_APPEND_ONLY` triggers).
 */
import { AppError } from "../../lib/errors";
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";

// ---- catalogues (mirror the 0012 CHECK constraints) ------------------------------------

export const TICKET_CATEGORIES = ["GENERAL", "ACCOUNT", "TRACKING", "OFFER", "CONVERSION", "PAYOUT", "BILLING", "TECHNICAL", "COMPLIANCE"] as const;
export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_USER", "WAITING_INTERNAL", "RESOLVED", "CLOSED"] as const;
export const MESSAGE_AUTHOR_TYPES = ["REQUESTER", "AGENT", "SYSTEM"] as const;
export const TICKET_EVENT_TYPES = ["CREATED", "STATUS_CHANGED", "ASSIGNED", "UNASSIGNED", "PRIORITY_CHANGED"] as const;

export const DISPUTE_CATEGORIES = ["CONVERSION", "TRACKING", "COMMISSION", "PAYOUT", "BILLING", "TRAFFIC", "OFFER", "COMPLIANCE"] as const;
export const DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "DECIDED", "WITHDRAWN"] as const;
export const DISPUTE_DECISIONS = ["UPHELD", "PARTIALLY_UPHELD", "REJECTED"] as const;
export const EVIDENCE_SIDES = ["TENANT", "NETWORK"] as const;
export const EVIDENCE_KINDS = ["TEXT", "URL", "RECORD_REF", "FILE_REF"] as const;

export const APPEAL_TYPES = ["ACCOUNT_RESTRICTION", "ACCOUNT_SUSPENSION", "CONVERSION_DECISION", "PAYOUT_HOLD", "COMPLIANCE_DECISION"] as const;
export const APPEAL_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "DECIDED", "WITHDRAWN"] as const;
export const APPEAL_OUTCOMES = ["ACCEPTED", "PARTIALLY_ACCEPTED", "REJECTED"] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type MessageAuthorType = (typeof MESSAGE_AUTHOR_TYPES)[number];
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number];
export type EvidenceSide = (typeof EVIDENCE_SIDES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type AppealType = (typeof APPEAL_TYPES)[number];
export type AppealStatus = (typeof APPEAL_STATUSES)[number];
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

// ---- rows ------------------------------------------------------------------------------

export interface TicketRow {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  assigned_agent_user_id: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  status: TicketStatus;
  reference_type: string | null;
  reference_id: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketMessageRow {
  id: string;
  ticket_id: string;
  author_user_id: string | null;
  author_type: MessageAuthorType;
  body: string;
  /** 0 | 1 as stored. */
  is_internal: number;
  created_at: string;
}

export interface TicketEventRow {
  id: string;
  ticket_id: string;
  event_type: TicketEventType;
  from_status: string | null;
  to_status: string | null;
  actor_user_id: string | null;
  reason: string | null;
  metadata: string | null;
  created_at: string;
}

export interface AgentAccessRow {
  agent_user_id: string;
  organization_id: string;
  granted_by_user_id: string | null;
  reason: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface DisputeRow {
  id: string;
  organization_id: string;
  raised_by_user_id: string | null;
  assigned_to_user_id: string | null;
  category: DisputeCategory;
  subject_type: string;
  subject_id: string;
  title: string;
  description: string;
  disputed_amount_minor: number | null;
  currency: string | null;
  status: DisputeStatus;
  decided_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRow {
  id: string;
  dispute_id: string;
  submitted_by_user_id: string | null;
  submitter_side: EvidenceSide;
  kind: EvidenceKind;
  content: string;
  created_at: string;
}

export interface DisputeDecisionRow {
  id: string;
  dispute_id: string;
  decision: DisputeDecision;
  reason: string;
  /** JSON array text as stored. */
  evidence: string;
  actor_user_id: string;
  decided_at: string;
  created_at: string;
}

export interface AppealRow {
  id: string;
  organization_id: string;
  submitted_by_user_id: string | null;
  assigned_to_user_id: string | null;
  appeal_type: AppealType;
  subject_type: string;
  subject_id: string;
  grounds: string;
  status: AppealStatus;
  decided_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppealDecisionRow {
  id: string;
  appeal_id: string;
  outcome: AppealOutcome;
  reason: string;
  /** JSON array text as stored. */
  evidence: string;
  actor_user_id: string;
  decided_at: string;
  created_at: string;
}

// ---- inserts ---------------------------------------------------------------------------

export interface TicketInsert {
  id: string;
  created_by_user_id: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  reference_type: string | null;
  reference_id: string | null;
}

export interface MessageInsert {
  id: string;
  ticket_id: string;
  author_user_id: string | null;
  author_type: MessageAuthorType;
  body: string;
  is_internal: boolean;
}

export interface EventInsert {
  id: string;
  ticket_id: string;
  event_type: TicketEventType;
  from_status: string | null;
  to_status: string | null;
  actor_user_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DisputeInsert {
  id: string;
  raised_by_user_id: string | null;
  category: DisputeCategory;
  subject_type: string;
  subject_id: string;
  title: string;
  description: string;
  disputed_amount_minor: number | null;
  currency: string | null;
}

export interface EvidenceInsert {
  id: string;
  dispute_id: string;
  submitted_by_user_id: string | null;
  submitter_side: EvidenceSide;
  kind: EvidenceKind;
  content: string;
}

export interface DisputeDecisionInsert {
  id: string;
  dispute_id: string;
  decision: DisputeDecision;
  reason: string;
  /** JSON array text. */
  evidence: string;
  actor_user_id: string;
  decided_at: string;
}

export interface AppealInsert {
  id: string;
  submitted_by_user_id: string | null;
  appeal_type: AppealType;
  subject_type: string;
  subject_id: string;
  grounds: string;
}

export interface AppealDecisionInsert {
  id: string;
  appeal_id: string;
  outcome: AppealOutcome;
  reason: string;
  /** JSON array text. */
  evidence: string;
  actor_user_id: string;
  decided_at: string;
}

const TICKET_COLUMNS = [
  "id", "organization_id", "created_by_user_id", "assigned_agent_user_id", "category", "priority", "subject", "status",
  "reference_type", "reference_id", "first_response_at", "resolved_at", "closed_at", "created_at", "updated_at",
].map((c) => `t.${c}`).join(", ");
const MESSAGE_COLUMNS = ["id", "ticket_id", "author_user_id", "author_type", "body", "is_internal", "created_at"].map((c) => `m.${c}`).join(", ");
const EVENT_COLUMNS = ["id", "ticket_id", "event_type", "from_status", "to_status", "actor_user_id", "reason", "metadata", "created_at"]
  .map((c) => `e.${c}`)
  .join(", ");
const ACCESS_COLUMNS = ["agent_user_id", "organization_id", "granted_by_user_id", "reason", "expires_at", "revoked_at", "created_at"].join(", ");
const DISPUTE_COLUMNS = [
  "id", "organization_id", "raised_by_user_id", "assigned_to_user_id", "category", "subject_type", "subject_id", "title", "description",
  "disputed_amount_minor", "currency", "status", "decided_at", "withdrawn_at", "created_at", "updated_at",
].map((c) => `d.${c}`).join(", ");
const EVIDENCE_COLUMNS = ["id", "dispute_id", "submitted_by_user_id", "submitter_side", "kind", "content", "created_at"].map((c) => `v.${c}`).join(", ");
const DISPUTE_DECISION_COLUMNS = ["id", "dispute_id", "decision", "reason", "evidence", "actor_user_id", "decided_at", "created_at"]
  .map((c) => `x.${c}`)
  .join(", ");
const APPEAL_COLUMNS = [
  "id", "organization_id", "submitted_by_user_id", "assigned_to_user_id", "appeal_type", "subject_type", "subject_id", "grounds", "status",
  "decided_at", "withdrawn_at", "created_at", "updated_at",
].map((c) => `a.${c}`).join(", ");
const APPEAL_DECISION_COLUMNS = ["id", "appeal_id", "outcome", "reason", "evidence", "actor_user_id", "decided_at", "created_at"]
  .map((c) => `x.${c}`)
  .join(", ");

/** Keyset predicate + binds for `(created_at, id)` DESC pagination (PRD §127). */
function cursorClause(page: PageRequest, alias: string, where: string[], binds: unknown[]): void {
  if (!page.cursor) return;
  where.push(`(${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`);
  binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
}

export class SupportRepository {
  constructor(private readonly db: D1Database) {}

  /** Run `statements` as ONE batch; DB refusals become stable AppErrors. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    try {
      return await this.db.batch(statements);
    } catch (err) {
      throw classifySupportWriteError(err);
    }
  }

  /** Existence + type of an organization (platform faces address tenants by id). */
  findOrganizationType(id: string): Promise<{ type: string } | null> {
    return this.db.prepare("SELECT type FROM organizations WHERE id = ?").bind(id).first<{ type: string }>();
  }

  // ======================================================================================
  // Agent tenant access (PRD §81 7a)
  // ======================================================================================

  /** True when `agentUserId` holds an unrevoked, unexpired grant on the tenant. */
  async agentHasAccess(agentUserId: string, tenantId: TenantId, now: string): Promise<boolean> {
    const row = await scopedQuery(
      this.db,
      `SELECT 1 AS ok FROM support_agent_tenant_access
        WHERE organization_id = ? AND agent_user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
      tenantId,
      agentUserId,
      now,
    ).first<{ ok: number }>();
    return row !== null;
  }

  async listAgentAccess(tenantId: TenantId, page: PageRequest): Promise<Page<AgentAccessRow>> {
    const where = ["organization_id = ?"];
    const binds: unknown[] = [];
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND agent_user_id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${ACCESS_COLUMNS} FROM support_agent_tenant_access WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, agent_user_id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<AgentAccessRow>();
    const items = res.results.map((r) => ({ ...r, id: r.agent_user_id }));
    const sliced = slicePage(items, page.limit);
    return { items: sliced.items.map(({ id: _id, ...rest }) => rest), next_cursor: sliced.next_cursor };
  }

  /** Upsert a grant: a revoked/expired row is re-activated in place. */
  grantAccessStatement(
    tenantId: TenantId,
    input: { agent_user_id: string; granted_by_user_id: string; reason: string | null; expires_at: string | null },
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_agent_tenant_access (organization_id, agent_user_id, granted_by_user_id, reason, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent_user_id, organization_id) DO UPDATE
           SET granted_by_user_id = excluded.granted_by_user_id, reason = excluded.reason,
               expires_at = excluded.expires_at, revoked_at = NULL`,
      )
      .bind(tenantId, input.agent_user_id, input.granted_by_user_id, input.reason, input.expires_at);
  }

  revokeAccessStatement(tenantId: TenantId, agentUserId: string, now: string): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE support_agent_tenant_access SET revoked_at = ? WHERE organization_id = ? AND agent_user_id = ? AND revoked_at IS NULL`)
      .bind(now, tenantId, agentUserId);
  }

  findAccess(tenantId: TenantId, agentUserId: string): Promise<AgentAccessRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${ACCESS_COLUMNS} FROM support_agent_tenant_access WHERE organization_id = ? AND agent_user_id = ?`,
      tenantId,
      agentUserId,
    ).first<AgentAccessRow>();
  }

  // ======================================================================================
  // Tickets (PRD §81)
  // ======================================================================================

  insertTicketStatement(tenantId: TenantId, input: TicketInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_tickets (organization_id, id, created_by_user_id, category, priority, subject, status, reference_type, reference_id)
         VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      )
      .bind(tenantId, input.id, input.created_by_user_id, input.category, input.priority, input.subject, input.reference_type, input.reference_id);
  }

  insertMessageStatement(input: MessageInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_type, body, is_internal)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.ticket_id, input.author_user_id, input.author_type, input.body, input.is_internal ? 1 : 0);
  }

  insertEventStatement(input: EventInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_ticket_events (id, ticket_id, event_type, from_status, to_status, actor_user_id, reason, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.ticket_id,
        input.event_type,
        input.from_status,
        input.to_status,
        input.actor_user_id,
        input.reason,
        input.metadata === null ? null : JSON.stringify(input.metadata),
      );
  }

  findTicket(tenantId: TenantId, id: string): Promise<TicketRow | null> {
    return scopedQuery(this.db, `SELECT ${TICKET_COLUMNS} FROM support_tickets t WHERE t.organization_id = ? AND t.id = ?`, tenantId, id).first<TicketRow>();
  }

  async listTickets(tenantId: TenantId, page: PageRequest, filter: { status?: TicketStatus } = {}): Promise<Page<TicketRow>> {
    const where = ["t.organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("t.status = ?");
      binds.push(filter.status);
    }
    cursorClause(page, "t", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${TICKET_COLUMNS} FROM support_tickets t WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<TicketRow>();
    return slicePage(res.results, page.limit);
  }

  /** Thread of one ticket; `includeInternal=false` hides agent-only notes (tenant face). */
  async listMessages(tenantId: TenantId, ticketId: string, page: PageRequest, includeInternal: boolean): Promise<Page<TicketMessageRow>> {
    const where = ["t.organization_id = ?", "m.ticket_id = ?"];
    const binds: unknown[] = [ticketId];
    if (!includeInternal) where.push("m.is_internal = 0");
    cursorClause(page, "m", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${MESSAGE_COLUMNS} FROM support_ticket_messages m JOIN support_tickets t ON t.id = m.ticket_id
        WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<TicketMessageRow>();
    return slicePage(res.results, page.limit);
  }

  async listEvents(tenantId: TenantId, ticketId: string, page: PageRequest): Promise<Page<TicketEventRow>> {
    const where = ["t.organization_id = ?", "e.ticket_id = ?"];
    const binds: unknown[] = [ticketId];
    cursorClause(page, "e", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${EVENT_COLUMNS} FROM support_ticket_events e JOIN support_tickets t ON t.id = e.ticket_id
        WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<TicketEventRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * Guarded status change `from → to`. Sets the lifecycle timestamps the 0012
   * CHECKs demand (`closed_at` ⇔ CLOSED) and `resolved_at` on RESOLVED.
   * `first_response_at` is stamped when `firstResponse` is set and still null.
   */
  ticketTransitionStatement(
    tenantId: TenantId,
    id: string,
    from: TicketStatus,
    to: TicketStatus,
    now: string,
    opts: { firstResponse?: boolean; assignTo?: string | null } = {},
  ): D1PreparedStatement {
    const sets = ["status = ?", "updated_at = ?"];
    const binds: unknown[] = [to, now];
    if (to === "CLOSED") {
      sets.push("closed_at = ?");
      binds.push(now);
    }
    if (to === "RESOLVED") {
      sets.push("resolved_at = ?");
      binds.push(now);
    }
    if (opts.firstResponse) {
      sets.push("first_response_at = COALESCE(first_response_at, ?)");
      binds.push(now);
    }
    if (opts.assignTo !== undefined) {
      sets.push("assigned_agent_user_id = ?");
      binds.push(opts.assignTo);
    }
    return this.db
      .prepare(`UPDATE support_tickets SET ${sets.join(", ")} WHERE organization_id = ? AND id = ? AND status = ?`)
      .bind(...binds, tenantId, id, from);
  }

  /** Non-status touch (agent reply, assignment) on a non-CLOSED ticket; guarded by current status. */
  ticketTouchStatement(
    tenantId: TenantId,
    id: string,
    currentStatus: TicketStatus,
    now: string,
    opts: { firstResponse?: boolean; assignTo?: string | null } = {},
  ): D1PreparedStatement {
    const sets = ["updated_at = ?"];
    const binds: unknown[] = [now];
    if (opts.firstResponse) {
      sets.push("first_response_at = COALESCE(first_response_at, ?)");
      binds.push(now);
    }
    if (opts.assignTo !== undefined) {
      sets.push("assigned_agent_user_id = ?");
      binds.push(opts.assignTo);
    }
    return this.db
      .prepare(`UPDATE support_tickets SET ${sets.join(", ")} WHERE organization_id = ? AND id = ? AND status = ?`)
      .bind(...binds, tenantId, id, currentStatus);
  }

  // ======================================================================================
  // Disputes (PRD §82)
  // ======================================================================================

  insertDisputeStatement(tenantId: TenantId, input: DisputeInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO disputes (organization_id, id, raised_by_user_id, category, subject_type, subject_id, title, description,
                               disputed_amount_minor, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      )
      .bind(
        tenantId,
        input.id,
        input.raised_by_user_id,
        input.category,
        input.subject_type,
        input.subject_id,
        input.title,
        input.description,
        input.disputed_amount_minor,
        input.currency,
      );
  }

  findDispute(tenantId: TenantId, id: string): Promise<DisputeRow | null> {
    return scopedQuery(this.db, `SELECT ${DISPUTE_COLUMNS} FROM disputes d WHERE d.organization_id = ? AND d.id = ?`, tenantId, id).first<DisputeRow>();
  }

  async listDisputes(tenantId: TenantId, page: PageRequest, filter: { status?: DisputeStatus } = {}): Promise<Page<DisputeRow>> {
    const where = ["d.organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("d.status = ?");
      binds.push(filter.status);
    }
    cursorClause(page, "d", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${DISPUTE_COLUMNS} FROM disputes d WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<DisputeRow>();
    return slicePage(res.results, page.limit);
  }

  insertEvidenceStatement(input: EvidenceInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dispute_evidence (id, dispute_id, submitted_by_user_id, submitter_side, kind, content) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.dispute_id, input.submitted_by_user_id, input.submitter_side, input.kind, input.content);
  }

  /** Evidence of one dispute; `sides` restricts what the caller's face may see. */
  async listEvidence(tenantId: TenantId, disputeId: string, page: PageRequest, sides: readonly EvidenceSide[]): Promise<Page<EvidenceRow>> {
    const where = ["d.organization_id = ?", "v.dispute_id = ?"];
    const binds: unknown[] = [disputeId];
    where.push(`v.submitter_side IN (${sides.map(() => "?").join(", ")})`);
    binds.push(...sides);
    cursorClause(page, "v", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${EVIDENCE_COLUMNS} FROM dispute_evidence v JOIN disputes d ON d.id = v.dispute_id
        WHERE ${where.join(" AND ")} ORDER BY v.created_at DESC, v.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<EvidenceRow>();
    return slicePage(res.results, page.limit);
  }

  disputeTransitionStatement(
    tenantId: TenantId,
    id: string,
    from: DisputeStatus,
    to: DisputeStatus,
    now: string,
    opts: { assignTo?: string | null } = {},
  ): D1PreparedStatement {
    const sets = ["status = ?", "updated_at = ?"];
    const binds: unknown[] = [to, now];
    if (to === "DECIDED") {
      sets.push("decided_at = ?");
      binds.push(now);
    }
    if (to === "WITHDRAWN") {
      sets.push("withdrawn_at = ?");
      binds.push(now);
    }
    if (opts.assignTo !== undefined) {
      sets.push("assigned_to_user_id = ?");
      binds.push(opts.assignTo);
    }
    return this.db
      .prepare(`UPDATE disputes SET ${sets.join(", ")} WHERE organization_id = ? AND id = ? AND status = ?`)
      .bind(...binds, tenantId, id, from);
  }

  insertDisputeDecisionStatement(input: DisputeDecisionInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dispute_decisions (id, dispute_id, decision, reason, evidence, actor_user_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.dispute_id, input.decision, input.reason, input.evidence, input.actor_user_id, input.decided_at);
  }

  findDisputeDecision(tenantId: TenantId, disputeId: string): Promise<DisputeDecisionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${DISPUTE_DECISION_COLUMNS} FROM dispute_decisions x JOIN disputes d ON d.id = x.dispute_id WHERE d.organization_id = ? AND x.dispute_id = ?`,
      tenantId,
      disputeId,
    ).first<DisputeDecisionRow>();
  }

  // ======================================================================================
  // Appeals (PRD §83)
  // ======================================================================================

  insertAppealStatement(tenantId: TenantId, input: AppealInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO appeals (organization_id, id, submitted_by_user_id, appeal_type, subject_type, subject_id, grounds, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED')`,
      )
      .bind(tenantId, input.id, input.submitted_by_user_id, input.appeal_type, input.subject_type, input.subject_id, input.grounds);
  }

  findAppeal(tenantId: TenantId, id: string): Promise<AppealRow | null> {
    return scopedQuery(this.db, `SELECT ${APPEAL_COLUMNS} FROM appeals a WHERE a.organization_id = ? AND a.id = ?`, tenantId, id).first<AppealRow>();
  }

  async listAppeals(tenantId: TenantId, page: PageRequest, filter: { status?: AppealStatus } = {}): Promise<Page<AppealRow>> {
    const where = ["a.organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("a.status = ?");
      binds.push(filter.status);
    }
    cursorClause(page, "a", where, binds);
    const res = await scopedQuery(
      this.db,
      `SELECT ${APPEAL_COLUMNS} FROM appeals a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<AppealRow>();
    return slicePage(res.results, page.limit);
  }

  appealTransitionStatement(
    tenantId: TenantId,
    id: string,
    from: AppealStatus,
    to: AppealStatus,
    now: string,
    opts: { assignTo?: string | null } = {},
  ): D1PreparedStatement {
    const sets = ["status = ?", "updated_at = ?"];
    const binds: unknown[] = [to, now];
    if (to === "DECIDED") {
      sets.push("decided_at = ?");
      binds.push(now);
    }
    if (to === "WITHDRAWN") {
      sets.push("withdrawn_at = ?");
      binds.push(now);
    }
    if (opts.assignTo !== undefined) {
      sets.push("assigned_to_user_id = ?");
      binds.push(opts.assignTo);
    }
    return this.db
      .prepare(`UPDATE appeals SET ${sets.join(", ")} WHERE organization_id = ? AND id = ? AND status = ?`)
      .bind(...binds, tenantId, id, from);
  }

  insertAppealDecisionStatement(input: AppealDecisionInsert): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO appeal_decisions (id, appeal_id, outcome, reason, evidence, actor_user_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.id, input.appeal_id, input.outcome, input.reason, input.evidence, input.actor_user_id, input.decided_at);
  }

  findAppealDecision(tenantId: TenantId, appealId: string): Promise<AppealDecisionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${APPEAL_DECISION_COLUMNS} FROM appeal_decisions x JOIN appeals a ON a.id = x.appeal_id WHERE a.organization_id = ? AND x.appeal_id = ?`,
      tenantId,
      appealId,
    ).first<AppealDecisionRow>();
  }
}

// ---- error classification ------------------------------------------------------------------

/** Trigger reason codes 0012 may raise for these tables (allow-list; nothing else is echoed). */
const TRIGGER_CODES: ReadonlySet<string> = new Set([
  "SUPPORT_TICKET_IMMUTABLE",
  "SUPPORT_TICKET_FINAL",
  "SUPPORT_TICKET_ILLEGAL_TRANSITION",
  "SUPPORT_TICKET_MESSAGES_APPEND_ONLY",
  "SUPPORT_TICKET_EVENTS_APPEND_ONLY",
  "DISPUTE_IMMUTABLE",
  "DISPUTE_FINAL",
  "DISPUTE_ILLEGAL_TRANSITION",
  "DISPUTE_NOT_OPEN",
  "DISPUTE_EVIDENCE_APPEND_ONLY",
  "DISPUTE_DECISIONS_APPEND_ONLY",
  "APPEAL_IMMUTABLE",
  "APPEAL_FINAL",
  "APPEAL_ILLEGAL_TRANSITION",
  "APPEAL_DECISIONS_APPEND_ONLY",
]);

/**
 * Maps a failed batch to a stable AppError. Every code here means "nothing
 * was written" (the batch rolled back as a whole). The DB message is only
 * pattern-matched — it is never copied into the response (PRD §116).
 */
export function classifySupportWriteError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: disputes\./i.test(msg)) {
    return new AppError(409, "DISPUTE_ALREADY_OPEN", "An open dispute already exists for this subject");
  }
  if (/UNIQUE constraint failed: appeals\./i.test(msg)) {
    return new AppError(409, "APPEAL_ALREADY_OPEN", "An open appeal already exists for this subject");
  }
  if (/UNIQUE constraint failed: dispute_decisions\./i.test(msg)) {
    return new AppError(409, "DISPUTE_FINAL", "The dispute has already been decided");
  }
  if (/UNIQUE constraint failed: appeal_decisions\./i.test(msg)) {
    return new AppError(409, "APPEAL_FINAL", "The appeal has already been decided");
  }
  for (const code of TRIGGER_CODES) {
    if (msg.includes(code)) return new AppError(409, code, "The record is in a state that does not allow this change");
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new AppError(409, "SUPPORT_STATE_CONFLICT", "The record changed underneath this request; nothing was written");
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new AppError(404, "NOT_FOUND", "A referenced record does not exist");
  }
  return new AppError(500, "SUPPORT_WRITE_FAILED", "The request could not be persisted");
}
