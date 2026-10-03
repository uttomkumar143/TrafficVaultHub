/**
 * Support tickets (PRD §81). State machine
 *   OPEN → IN_PROGRESS → WAITING_FOR_USER | WAITING_INTERNAL → RESOLVED → CLOSED
 * is checked here (clean 409 `SUPPORT_TICKET_ILLEGAL_TRANSITION` /
 * `SUPPORT_TICKET_FINAL`) AND by the 0012 triggers; the DB text never reaches
 * the client (`classifySupportWriteError`). Every mutation batches its audit
 * row with the write.
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import { assertRecordId, notFound, SupportAccess, type Actor } from "./access";
import {
  TICKET_STATUSES,
  type AgentAccessRow,
  type SupportRepository,
  type TicketCategory,
  type TicketEventRow,
  type TicketMessageRow,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
} from "./repository";

export const SUBJECT_MAX_LENGTH = 200;
export const MESSAGE_MAX_LENGTH = 8000;

/** Legal edges (mirror of `trg_support_tickets_legal_transition`). */
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  OPEN: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["WAITING_FOR_USER", "WAITING_INTERNAL", "RESOLVED"],
  WAITING_FOR_USER: ["IN_PROGRESS", "WAITING_INTERNAL", "RESOLVED", "CLOSED"],
  WAITING_INTERNAL: ["IN_PROGRESS", "WAITING_FOR_USER", "RESOLVED"],
  RESOLVED: ["IN_PROGRESS", "CLOSED"],
  CLOSED: [],
};

/** Edges a REQUESTER (tenant face) may drive itself; everything else is agent work. */
const REQUESTER_TRANSITIONS: Readonly<Partial<Record<TicketStatus, readonly TicketStatus[]>>> = {
  OPEN: ["CLOSED"],
  WAITING_FOR_USER: ["IN_PROGRESS", "CLOSED"],
  RESOLVED: ["IN_PROGRESS", "CLOSED"],
};

export function isTicketStatus(v: string): v is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(v);
}

export interface CreateTicketInput {
  category: TicketCategory;
  priority?: TicketPriority;
  subject: string;
  body: string;
  reference_type?: string | null;
  reference_id?: string | null;
}

export interface PublicTicket extends Omit<TicketRow, "organization_id"> {}
export interface PublicMessage extends Omit<TicketMessageRow, "is_internal"> {
  is_internal: boolean;
}

export function toPublicTicket(row: TicketRow): PublicTicket {
  const { organization_id: _org, ...rest } = row;
  return rest;
}

function toPublicMessage(row: TicketMessageRow): PublicMessage {
  return { ...row, is_internal: row.is_internal === 1 };
}

export class TicketService {
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

  async list(actor: Actor, page: PageRequest, status?: string): Promise<Page<PublicTicket>> {
    await this.access.ensure(actor, "support.read");
    if (status !== undefined && !isTicketStatus(status)) throw new AppError(400, "VALIDATION_ERROR", "Unknown ticket status");
    const res = await this.repo.listTickets(actor.tenantId, page, status === undefined ? {} : { status });
    return { items: res.items.map(toPublicTicket), next_cursor: res.next_cursor };
  }

  async get(actor: Actor, id: string): Promise<PublicTicket> {
    await this.access.ensure(actor, "support.read");
    return toPublicTicket(await this.load(actor, id));
  }

  /** Internal notes are only visible on the platform face. */
  async messages(actor: Actor, id: string, page: PageRequest): Promise<Page<PublicMessage>> {
    await this.access.ensure(actor, "support.read");
    await this.load(actor, id);
    const res = await this.repo.listMessages(actor.tenantId, id, page, actor.face === "PLATFORM");
    return { items: res.items.map(toPublicMessage), next_cursor: res.next_cursor };
  }

  async events(actor: Actor, id: string, page: PageRequest): Promise<Page<TicketEventRow>> {
    await this.access.ensure(actor, "support.read");
    await this.load(actor, id);
    return this.repo.listEvents(actor.tenantId, id, page);
  }

  // ---- write ------------------------------------------------------------------------

  /** Tenant face only (`support.create`); the opening message is written in the same batch. */
  async create(actor: Actor, input: CreateTicketInput, meta: RequestMeta): Promise<PublicTicket> {
    await this.access.ensure(actor, "support.create");
    const id = crypto.randomUUID();
    const userId = actor.auth.user.id;
    await this.repo.batch([
      this.repo.insertTicketStatement(actor.tenantId, {
        id,
        created_by_user_id: userId,
        category: input.category,
        priority: input.priority ?? "NORMAL",
        subject: input.subject,
        reference_type: input.reference_type ?? null,
        reference_id: input.reference_id ?? null,
      }),
      this.repo.insertMessageStatement({ id: crypto.randomUUID(), ticket_id: id, author_user_id: userId, author_type: "REQUESTER", body: input.body, is_internal: false }),
      this.repo.insertEventStatement({ id: crypto.randomUUID(), ticket_id: id, event_type: "CREATED", from_status: null, to_status: "OPEN", actor_user_id: userId, reason: null, metadata: null }),
      this.auditStatement(actor, "support.ticket.created", id, { category: input.category }, meta),
    ]);
    return toPublicTicket(await this.load(actor, id));
  }

  /**
   * Reply. Tenant face → REQUESTER message (never internal), platform face →
   * AGENT message (optionally internal) and `first_response_at` stamp. CLOSED
   * tickets refuse replies (409 `SUPPORT_TICKET_FINAL`).
   */
  async reply(actor: Actor, id: string, body: string, internal: boolean, meta: RequestMeta): Promise<PublicMessage> {
    await this.access.ensure(actor, actor.face === "PLATFORM" ? "support.manage" : "support.read");
    const ticket = await this.load(actor, id);
    if (ticket.status === "CLOSED") throw finalTicket();
    const isAgent = actor.face === "PLATFORM";
    const messageId = crypto.randomUUID();
    const userId = actor.auth.user.id;
    await this.repo.batch([
      this.repo.insertMessageStatement({ id: messageId, ticket_id: id, author_user_id: userId, author_type: isAgent ? "AGENT" : "REQUESTER", body, is_internal: isAgent && internal }),
      this.repo.ticketTouchStatement(actor.tenantId, id, ticket.status, this.now(), { firstResponse: isAgent && !internal }),
      this.auditStatement(actor, "support.ticket.replied", id, { author_type: isAgent ? "AGENT" : "REQUESTER", internal: isAgent && internal }, meta),
    ]);
    const page = await this.repo.listMessages(actor.tenantId, id, { limit: 100, cursor: null }, true);
    const row = page.items.find((m) => m.id === messageId);
    if (!row) throw notFound("Message");
    return toPublicMessage(row);
  }

  /** Status transition. Illegal edges → 409; requesters are limited to `REQUESTER_TRANSITIONS`. */
  async transition(actor: Actor, id: string, to: TicketStatus, reason: string | null, meta: RequestMeta): Promise<PublicTicket> {
    await this.access.ensure(actor, actor.face === "PLATFORM" ? "support.manage" : "support.read");
    const ticket = await this.load(actor, id);
    if (ticket.status === "CLOSED") throw finalTicket();
    const allowed = actor.face === "PLATFORM" ? TICKET_TRANSITIONS[ticket.status] : (REQUESTER_TRANSITIONS[ticket.status] ?? []);
    if (!allowed.includes(to)) {
      throw new AppError(409, "SUPPORT_TICKET_ILLEGAL_TRANSITION", `A ticket in ${ticket.status} cannot move to ${to}`);
    }
    const assign = actor.face === "PLATFORM" && ticket.assigned_agent_user_id === null && to === "IN_PROGRESS" ? actor.auth.user.id : undefined;
    const results = await this.repo.batch([
      this.repo.ticketTransitionStatement(actor.tenantId, id, ticket.status, to, this.now(), { assignTo: assign }),
      this.repo.insertEventStatement({ id: crypto.randomUUID(), ticket_id: id, event_type: "STATUS_CHANGED", from_status: ticket.status, to_status: to, actor_user_id: actor.auth.user.id, reason, metadata: null }),
      this.auditStatement(actor, "support.ticket.status_changed", id, { from: ticket.status, to, reason }, meta),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) throw new AppError(409, "SUPPORT_STATE_CONFLICT", "The ticket changed underneath this request");
    return toPublicTicket(await this.load(actor, id));
  }

  // ---- agent tenant access (platform administrators) -------------------------------

  async listAgentAccess(actor: Actor, page: PageRequest): Promise<Page<AgentAccessRow>> {
    this.access.ensureGrantAdmin(actor);
    await this.access.ensure(actor, "support.manage");
    return this.repo.listAgentAccess(actor.tenantId, page);
  }

  /** The grantee must be an ACTIVE member of the PLATFORM org (404 otherwise, no oracle). */
  async grantAgentAccess(actor: Actor, agentUserId: string, reason: string | null, expiresAt: string | null, meta: RequestMeta): Promise<AgentAccessRow> {
    this.access.ensureGrantAdmin(actor);
    await this.access.ensure(actor, "support.manage");
    assertRecordId(agentUserId, "User");
    if (!(await this.repo.isActiveMember(actor.ctx.organization.id, agentUserId))) throw notFound("User");
    await this.repo.batch([
      this.repo.grantAccessStatement(actor.tenantId, { agent_user_id: agentUserId, granted_by_user_id: actor.auth.user.id, reason, expires_at: expiresAt }),
      this.auditStatement(actor, "support.agent_access.granted", agentUserId, { reason, expires_at: expiresAt }, meta),
    ]);
    const row = await this.repo.findAccess(actor.tenantId, agentUserId);
    if (!row) throw notFound("Grant");
    return row;
  }

  async revokeAgentAccess(actor: Actor, agentUserId: string, meta: RequestMeta): Promise<AgentAccessRow> {
    this.access.ensureGrantAdmin(actor);
    await this.access.ensure(actor, "support.manage");
    assertRecordId(agentUserId, "User");
    const existing = await this.repo.findAccess(actor.tenantId, agentUserId);
    if (!existing) throw notFound("Grant");
    if (existing.revoked_at !== null) return existing;
    await this.repo.batch([
      this.repo.revokeAccessStatement(actor.tenantId, agentUserId, this.now()),
      this.auditStatement(actor, "support.agent_access.revoked", agentUserId, undefined, meta),
    ]);
    const row = await this.repo.findAccess(actor.tenantId, agentUserId);
    if (!row) throw notFound("Grant");
    return row;
  }

  // ---- helpers ----------------------------------------------------------------------

  private async load(actor: Actor, id: string): Promise<TicketRow> {
    assertRecordId(id, "Ticket");
    const row = await this.repo.findTicket(actor.tenantId, id);
    if (!row) throw notFound("Ticket");
    return row;
  }

  private auditStatement(actor: Actor, action: string, targetId: string, metadata: Record<string, unknown> | undefined, meta: RequestMeta): D1PreparedStatement {
    return this.audit.statement({
      organization_id: actor.tenantId,
      actor_user_id: actor.auth.user.id,
      action,
      target_type: "support_ticket",
      target_id: targetId,
      metadata: { ...(metadata ?? {}), face: actor.face },
      meta,
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function finalTicket(): AppError {
  return new AppError(409, "SUPPORT_TICKET_FINAL", "The ticket is closed");
}
