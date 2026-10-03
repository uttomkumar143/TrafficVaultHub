/**
 * Disputes (PRD §82) and appeals (PRD §83) — tenant face and PLATFORM face.
 *
 *   Tenant face  /organizations/:orgId/disputes          /organizations/:orgId/appeals
 *     GET  /                 list (status, limit, cursor)   GET  /
 *     POST /                 create (disputes.create)       POST /            submit (appeals.create)
 *     GET  /:id              record + decision/outcome      GET  /:id
 *     GET  /:id/evidence     both sides                     POST /:id/withdraw
 *     POST /:id/evidence     tenant side (disputes.create)
 *     POST /:id/withdraw     (disputes.create)
 *
 *   Platform face /organizations/:orgId/platform/{disputes,appeals}/tenants/:tenantOrgId/…
 *     same reads; POST /:id/evidence (network side), POST /:id/review, POST /:id/decide
 *     ({decision|outcome, reason, evidence[]}) under disputes.manage / appeals.manage.
 *
 * No raw status PATCH: review/decide/withdraw are the only edges.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requireScope, requireSession } from "../middleware/require-auth";
import { requirePermission } from "../middleware/require-org";
import {
  AppealService,
  GROUNDS_MAX_LENGTH,
  OUTCOME_EVIDENCE_MAX_ITEMS,
  OUTCOME_REASON_MAX_LENGTH,
} from "../modules/support/appeal-service";
import {
  DECISION_EVIDENCE_MAX_ITEMS,
  DECISION_REASON_MAX_LENGTH,
  DISPUTE_DESCRIPTION_MAX_LENGTH,
  DISPUTE_TITLE_MAX_LENGTH,
  DisputeService,
  EVIDENCE_CONTENT_MAX_LENGTH,
} from "../modules/support/dispute-service";
import {
  APPEAL_OUTCOMES,
  APPEAL_TYPES,
  DISPUTE_CATEGORIES,
  DISPUTE_DECISIONS,
  EVIDENCE_KINDS,
  SupportRepository,
} from "../modules/support/repository";
import { platformActorOf, REFERENCE_MAX_LENGTH, tenantActorOf, type ActorOf, type Ctx } from "./support";

const subject = z.string().min(1).max(REFERENCE_MAX_LENGTH);
const evidenceRefs = (max: number) => z.array(z.string().min(1).max(500)).max(max).default([]);

const createDisputeSchema = z
  .object({
    category: z.enum(DISPUTE_CATEGORIES),
    subject_type: subject,
    subject_id: subject,
    title: z.string().min(1).max(DISPUTE_TITLE_MAX_LENGTH),
    description: z.string().min(1).max(DISPUTE_DESCRIPTION_MAX_LENGTH),
    disputed_amount_minor: z.number().int().positive().nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
  })
  .strict();
const evidenceSchema = z.object({ kind: z.enum(EVIDENCE_KINDS), content: z.string().min(1).max(EVIDENCE_CONTENT_MAX_LENGTH) }).strict();
const decideDisputeSchema = z
  .object({ decision: z.enum(DISPUTE_DECISIONS), reason: z.string().min(1).max(DECISION_REASON_MAX_LENGTH), evidence: evidenceRefs(DECISION_EVIDENCE_MAX_ITEMS) })
  .strict();
const submitAppealSchema = z
  .object({ appeal_type: z.enum(APPEAL_TYPES), subject_type: subject, subject_id: subject, grounds: z.string().min(1).max(GROUNDS_MAX_LENGTH) })
  .strict();
const decideAppealSchema = z
  .object({ outcome: z.enum(APPEAL_OUTCOMES), reason: z.string().min(1).max(OUTCOME_REASON_MAX_LENGTH), evidence: evidenceRefs(OUTCOME_EVIDENCE_MAX_ITEMS) })
  .strict();

export function buildDisputeService(c: Ctx): DisputeService {
  return new DisputeService(new SupportRepository(c.env.DB), c.env.DB);
}
export function buildAppealService(c: Ctx): AppealService {
  return new AppealService(new SupportRepository(c.env.DB), c.env.DB);
}

// ---- disputes -------------------------------------------------------------------------

function registerDisputeRoutes(router: Hono<AppEnv>, prefix: string, actorOf: ActorOf, face: "TENANT" | "PLATFORM"): void {
  const id = (c: Ctx): string => c.req.param("disputeId") ?? "";
  const writeKey = face === "PLATFORM" ? "disputes.manage" : "disputes.create";

  router.get(`${prefix}/`, requireScope("disputes.read"), requirePermission("disputes.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildDisputeService(c).list(actorOf(c), page, c.req.query("status")), 200);
  });
  router.get(`${prefix}/:disputeId`, requireScope("disputes.read"), requirePermission("disputes.read"), async (c) => {
    return c.json(await buildDisputeService(c).get(actorOf(c), id(c)), 200);
  });
  router.get(`${prefix}/:disputeId/evidence`, requireScope("disputes.read"), requirePermission("disputes.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildDisputeService(c).evidence(actorOf(c), id(c), page), 200);
  });
  router.post(`${prefix}/:disputeId/evidence`, requireSession, requirePermission(writeKey), async (c) => {
    const body = await parseJsonBody(c, evidenceSchema);
    return c.json(await buildDisputeService(c).addEvidence(actorOf(c), id(c), body.kind, body.content, meta(c)), 201);
  });

  if (face === "TENANT") {
    router.post(`${prefix}/`, requireSession, requirePermission("disputes.create"), async (c) => {
      const body = await parseJsonBody(c, createDisputeSchema);
      return c.json(await buildDisputeService(c).create(actorOf(c), body, meta(c)), 201);
    });
    router.post(`${prefix}/:disputeId/withdraw`, requireSession, requirePermission("disputes.create"), async (c) => {
      return c.json(await buildDisputeService(c).withdraw(actorOf(c), id(c), meta(c)), 200);
    });
  } else {
    router.post(`${prefix}/:disputeId/review`, requireSession, requirePermission("disputes.manage"), async (c) => {
      return c.json(await buildDisputeService(c).review(actorOf(c), id(c), meta(c)), 200);
    });
    router.post(`${prefix}/:disputeId/decide`, requireSession, requirePermission("disputes.manage"), async (c) => {
      const body = await parseJsonBody(c, decideDisputeSchema);
      return c.json(await buildDisputeService(c).decide(actorOf(c), id(c), body, meta(c)), 200);
    });
  }
}

// ---- appeals --------------------------------------------------------------------------

function registerAppealRoutes(router: Hono<AppEnv>, prefix: string, actorOf: ActorOf, face: "TENANT" | "PLATFORM"): void {
  const id = (c: Ctx): string => c.req.param("appealId") ?? "";

  router.get(`${prefix}/`, requireScope("appeals.read"), requirePermission("appeals.read"), async (c) => {
    const page = parsePageRequest((n) => c.req.query(n));
    return c.json(await buildAppealService(c).list(actorOf(c), page, c.req.query("status")), 200);
  });
  router.get(`${prefix}/:appealId`, requireScope("appeals.read"), requirePermission("appeals.read"), async (c) => {
    return c.json(await buildAppealService(c).get(actorOf(c), id(c)), 200);
  });

  if (face === "TENANT") {
    router.post(`${prefix}/`, requireSession, requirePermission("appeals.create"), async (c) => {
      const body = await parseJsonBody(c, submitAppealSchema);
      return c.json(await buildAppealService(c).submit(actorOf(c), body, meta(c)), 201);
    });
    router.post(`${prefix}/:appealId/withdraw`, requireSession, requirePermission("appeals.create"), async (c) => {
      return c.json(await buildAppealService(c).withdraw(actorOf(c), id(c), meta(c)), 200);
    });
  } else {
    router.post(`${prefix}/:appealId/review`, requireSession, requirePermission("appeals.manage"), async (c) => {
      return c.json(await buildAppealService(c).review(actorOf(c), id(c), meta(c)), 200);
    });
    router.post(`${prefix}/:appealId/decide`, requireSession, requirePermission("appeals.manage"), async (c) => {
      const body = await parseJsonBody(c, decideAppealSchema);
      return c.json(await buildAppealService(c).decide(actorOf(c), id(c), body, meta(c)), 200);
    });
  }
}

// ---- routers --------------------------------------------------------------------------

export const disputeRoutes = new Hono<AppEnv>();
registerDisputeRoutes(disputeRoutes, "", tenantActorOf, "TENANT");

export const appealRoutes = new Hono<AppEnv>();
registerAppealRoutes(appealRoutes, "", tenantActorOf, "TENANT");

export const platformDisputeAppealRoutes = new Hono<AppEnv>();
registerDisputeRoutes(platformDisputeAppealRoutes, "/disputes/tenants/:tenantOrgId", platformActorOf, "PLATFORM");
registerAppealRoutes(platformDisputeAppealRoutes, "/appeals/tenants/:tenantOrgId", platformActorOf, "PLATFORM");
