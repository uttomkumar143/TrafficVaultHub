/**
 * Support tickets (PRD §81) — tenant face and PLATFORM face.
 *
 *   Tenant face  (mounted at /organizations/:orgId/support, requireAuth → requireOrg)
 *     GET  /tickets?status=&limit=&cursor=      POST /tickets
 *     GET  /tickets/:ticketId                   GET  /tickets/:ticketId/messages
 *     GET  /tickets/:ticketId/events            POST /tickets/:ticketId/messages   (requester reply)
 *     POST /tickets/:ticketId/transition        {status, reason?}  (requester edges only)
 *
 *   Platform face (mounted at /organizations/:orgId/platform, PLATFORM org only)
 *     …/support/tenants/:tenantOrgId/tickets(/:ticketId/…)  same shape, agent semantics
 *     …/support/tenants/:tenantOrgId/agents        GET | POST {user_id, reason?, expires_at?}
 *     …/support/tenants/:tenantOrgId/agents/:userId/revoke   POST
 *
 * There is no raw status PATCH: every change goes through `/transition` so the
 * §81 machine (service + 0012 triggers) is the only path. Ids are validated to
 * UUID shape and answered 404 otherwise (no oracle).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requireScope, requireSession } from "../middleware/require-auth";
import { requirePermission } from "../middleware/require-org";
import { platformActor, tenantActor, type Actor } from "../modules/support/access";
import { SupportRepository, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "../modules/support/repository";
import { MESSAGE_MAX_LENGTH, SUBJECT_MAX_LENGTH, TicketService } from "../modules/support/ticket-service";

export type Ctx = Context<AppEnv>;
export type ActorOf = (c: Ctx) => Actor;

export const REFERENCE_MAX_LENGTH = 64;

const createTicketSchema = z
  .object({
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    subject: z.string().min(1).max(SUBJECT_MAX_LENGTH),
    body: z.string().min(1).max(MESSAGE_MAX_LENGTH),
    reference_type: z.string().min(1).max(REFERENCE_MAX_LENGTH).nullable().optional(),
    reference_id: z.string().min(1).max(REFERENCE_MAX_LENGTH).nullable().optional(),
  })
  .strict();

const replySchema = z.object({ body: z.string().min(1).max(MESSAGE_MAX_LENGTH), internal: z.boolean().optional() }).strict();

const transitionSchema = z.object({ status: z.enum(TICKET_STATUSES), reason: z.string().min(1).max(1000).nullable().optional() }).strict();

const grantSchema = z
  .object({
    user_id: z.string().min(1).max(64),
    reason: z.string().min(1).max(500).nullable().optional(),
    expires_at: z.string().datetime().nullable().optional(),
  })
  .strict();

export function buildTicketService(c: Ctx): TicketService {
  return new TicketService(new SupportRepository(c.env.DB), c.env.DB);
}

/** Tenant face: the resolved `:orgId` context is the target tenant. */
export const tenantActorOf: ActorOf = (c) => tenantActor(c.get("auth"), c.get("tenant"));

/** Platform face: PLATFORM org (403 otherwise) acting on `:tenantOrgId` (404 when malformed/unknown/ungranted). */
export const platformActorOf: ActorOf = (c) => platformActor(c.get("auth"), c.get("tenant"), c.req.param("tenantOrgId") ?? "");

/** Registers the ticket routes under `prefix` on `router`; `manageKey` gates writes on this face. */
function registerTicketRoutes(router: Hono<AppEnv>, prefix: string, actorOf: ActorOf, manageKey: "support.read" | "support.manage"): void {
  const id = (c: Ctx): string => c.req.param("ticketId") ?? "";

  router.get(`${prefix}/tickets`, requireScope("support.read"), requirePermission("support.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildTicketService(c).list(actorOf(c), page, c.req.query("status")), 200);
  });

  router.post(`${prefix}/tickets`, requireSession, requirePermission("support.create"), async (c) => {
    const body = await parseJsonBody(c, createTicketSchema);
    return c.json(await buildTicketService(c).create(actorOf(c), body, meta(c)), 201);
  });

  router.get(`${prefix}/tickets/:ticketId`, requireScope("support.read"), requirePermission("support.read"), async (c) => {
    return c.json(await buildTicketService(c).get(actorOf(c), id(c)), 200);
  });

  router.get(`${prefix}/tickets/:ticketId/messages`, requireScope("support.read"), requirePermission("support.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildTicketService(c).messages(actorOf(c), id(c), page), 200);
  });

  router.get(`${prefix}/tickets/:ticketId/events`, requireScope("support.read"), requirePermission("support.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildTicketService(c).events(actorOf(c), id(c), page), 200);
  });

  router.post(`${prefix}/tickets/:ticketId/messages`, requireSession, requirePermission(manageKey), async (c) => {
    const body = await parseJsonBody(c, replySchema);
    return c.json(await buildTicketService(c).reply(actorOf(c), id(c), body.body, body.internal === true, meta(c)), 201);
  });

  router.post(`${prefix}/tickets/:ticketId/transition`, requireSession, requirePermission(manageKey), async (c) => {
    const body = await parseJsonBody(c, transitionSchema);
    return c.json(await buildTicketService(c).transition(actorOf(c), id(c), body.status, body.reason ?? null, meta(c)), 200);
  });
}

// ---- tenant face ----------------------------------------------------------------------

export const supportRoutes = new Hono<AppEnv>();
registerTicketRoutes(supportRoutes, "", tenantActorOf, "support.read");

// ---- platform face --------------------------------------------------------------------

export const platformSupportRoutes = new Hono<AppEnv>();
const P = "/support/tenants/:tenantOrgId";
registerTicketRoutes(platformSupportRoutes, P, platformActorOf, "support.manage");

platformSupportRoutes.get(`${P}/agents`, requireSession, requirePermission("support.manage"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  return c.json(await buildTicketService(c).listAgentAccess(platformActorOf(c), page), 200);
});

platformSupportRoutes.post(`${P}/agents`, requireSession, requirePermission("support.manage"), async (c) => {
  const body = await parseJsonBody(c, grantSchema);
  const grant = await buildTicketService(c).grantAgentAccess(platformActorOf(c), body.user_id, body.reason ?? null, body.expires_at ?? null, meta(c));
  return c.json(grant, 201);
});

platformSupportRoutes.post(`${P}/agents/:userId/revoke`, requireSession, requirePermission("support.manage"), async (c) => {
  const grant = await buildTicketService(c).revokeAgentAccess(platformActorOf(c), c.req.param("userId") ?? "", meta(c));
  return c.json(grant, 200);
});
