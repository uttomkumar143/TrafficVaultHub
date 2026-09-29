/**
 * Fraud routes (Phase 4 Unit 10b; PRD §41–§44, §115).
 *
 * Authenticated tenant sub-router mounted by `routes/organizations.ts` UNDER
 * `/:orgId/fraud` (inherits `requireAuth → requireOrg`, adds `requirePermission`).
 * The tenant is `:orgId`; every read and write is scoped by `FraudService` to
 * that organization, so a route can never reach another tenant's cases.
 *
 *   GET    /organizations/:orgId/fraud/cases                                  fraud.read    → 200 { items, next_cursor }
 *            ?status=&affiliate_organization_id=&conversion_id=&limit=&cursor=
 *   GET    /organizations/:orgId/fraud/cases/:caseId                          fraud.read    → 200 { case, events, actions, assessment }
 *   POST   /organizations/:orgId/fraud/cases                                  fraud.review  → 201 { case }
 *   POST   /organizations/:orgId/fraud/cases/:caseId/assign                   fraud.review  → 200 { case }      { reviewer_user_id | null }
 *   POST   /organizations/:orgId/fraud/cases/:caseId/notes                    fraud.read    → 201 { events }    { note }
 *   POST   /organizations/:orgId/fraud/cases/:caseId/transition               fraud.read*   → 200 { case }      { to, reason_code?, note? }
 *   POST   /organizations/:orgId/fraud/cases/:caseId/actions                  fraud.review* → 201 { action, hold_id }
 *   POST   /organizations/:orgId/fraud/assessments                            fraud.review  → 201 { assessment, risk, case }
 *   GET    /organizations/:orgId/fraud/assessments/:subjectType/:subjectId    fraud.read    → 200 { items }
 *
 *   (*) the route gate is the weakest key; the service decides the real one per
 *       edge (case table: fraud.review for decisions, fraud.read for the tenant
 *       appeal) and per action (PLATFORM actor only; PAYOUT_HOLD /
 *       ACCOUNT_RESTRICTION / ACCOUNT_SUSPENSION need fraud.manage).
 *
 * A risk score is evidence, never a verdict: `POST /assessments` records an
 * assessment (and optionally opens a case) but never touches a conversion's
 * lifecycle_status. Conversion holds created by CONVERSION_HOLD / PAYOUT_HOLD
 * actions are written by the service in the same batch as the action.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import { ConversionRepository } from "../modules/conversions/repository";
import {
  FRAUD_ACTION_TYPES,
  FRAUD_CASE_STATUSES,
  FraudRepository,
  type FraudCaseListFilter,
  type FraudCaseStatus,
  type FraudSubjectType,
} from "../modules/fraud/repository";
import type { RiskFacts } from "../modules/fraud/risk-engine";
import { FraudService } from "../modules/fraud/service";

const idSchema = z.string().uuid();
const reasonSchema = z.string().min(1).max(64);
const noteSchema = z.string().max(2000);
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const SUBJECT_TYPES = ["CONVERSION", "CLICK", "AFFILIATE"] as const;

/** Facts are caller-supplied evidence; unknown/malformed fields become ABSENT signals in the engine, never guesses. */
const factsSchema = z
  .object({
    velocity: z
      .object({
        window_seconds: z.number().int().positive(),
        conversions_in_window: z.number().int().nonnegative().optional(),
        clicks_in_window: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    duplicates: z
      .object({
        same_transaction_id_count: z.number().int().nonnegative().optional(),
        same_external_id_count: z.number().int().nonnegative().optional(),
        same_fingerprint_count: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    timing: z.object({ clicked_at: z.string().optional(), occurred_at: z.string().optional() }).strict().optional(),
    geo: z
      .object({
        click_country: z.string().nullable().optional(),
        conversion_country: z.string().nullable().optional(),
        restricted_countries: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    traffic_source: z
      .object({
        referrer: z.string().nullable().optional(),
        allowed_referrer_hosts: z.array(z.string()).optional(),
        conversion_rate_bps: z.number().int().nonnegative().optional(),
        baseline_conversion_rate_bps: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    automation: z
      .object({
        user_agent: z.string().nullable().optional(),
        same_user_agent_click_count: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const assessSchema = z
  .object({
    subject_type: z.enum(SUBJECT_TYPES),
    subject_id: z.string().min(1).max(128),
    conversion_id: idSchema.nullable().optional(),
    affiliate_organization_id: idSchema.nullable().optional(),
    facts: factsSchema,
    open_case_at_or_above: z.enum(RISK_LEVELS).optional(),
    case_reason_code: reasonSchema.optional(),
  })
  .strict();

const openCaseSchema = z
  .object({
    severity: z.enum(RISK_LEVELS),
    reason_code: reasonSchema,
    summary: z.string().max(2000).nullable().optional(),
    conversion_id: idSchema.nullable().optional(),
    affiliate_organization_id: idSchema.nullable().optional(),
    assessment_id: idSchema.nullable().optional(),
  })
  .strict();

const assignSchema = z.object({ reviewer_user_id: idSchema.nullable() }).strict();
const noteBodySchema = z.object({ note: noteSchema.min(1) }).strict();

const transitionSchema = z
  .object({
    to: z.enum(FRAUD_CASE_STATUSES),
    reason_code: reasonSchema.optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict();

const actionSchema = z
  .object({
    action_type: z.enum(FRAUD_ACTION_TYPES),
    reason_code: reasonSchema,
    note: noteSchema.nullable().optional(),
    conversion_id: idSchema.nullable().optional(),
    affiliate_organization_id: idSchema.nullable().optional(),
  })
  .strict();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function caseId(c: ParamCtx): string {
  const parsed = idSchema.safeParse(c.req.param("caseId"));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", "fraud case not found");
  return parsed.data;
}

function idFilter(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${name}`);
  return parsed.data;
}

function statusFilter(raw: string | undefined): FraudCaseStatus | undefined {
  if (!raw) return undefined;
  if (!(FRAUD_CASE_STATUSES as readonly string[]).includes(raw)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
  return raw as FraudCaseStatus;
}

/** Per-request service over the bound D1. */
export function buildFraudService(c: Ctx): FraudService {
  const db = c.env.DB;
  return new FraudService(new FraudRepository(db), new ConversionRepository(db), db);
}

export const fraudRoutes = new Hono<AppEnv>();

// ---- cases -----------------------------------------------------------------------

fraudRoutes.get("/cases", requirePermission("fraud.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: FraudCaseListFilter = {};
  const status = statusFilter(c.req.query("status"));
  if (status) filter.status = status;
  const affiliate = idFilter(c.req.query("affiliate_organization_id"), "affiliate_organization_id");
  if (affiliate) filter.affiliate_organization_id = affiliate;
  const conversion = idFilter(c.req.query("conversion_id"), "conversion_id");
  if (conversion) filter.conversion_id = conversion;
  const result = await buildFraudService(c).listCases(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

fraudRoutes.post("/cases", requirePermission("fraud.review"), async (c) => {
  const body = await parseJsonBody(c, openCaseSchema);
  const row = await buildFraudService(c).openCase(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ case: row }, 201);
});

fraudRoutes.get("/cases/:caseId", requirePermission("fraud.read"), async (c) => {
  const detail = await buildFraudService(c).getCase(c.get("tenant"), caseId(c));
  return c.json(detail, 200);
});

fraudRoutes.post("/cases/:caseId/assign", requirePermission("fraud.review"), async (c) => {
  const body = await parseJsonBody(c, assignSchema);
  const row = await buildFraudService(c).assign(c.get("auth"), c.get("tenant"), caseId(c), body.reviewer_user_id, meta(c));
  return c.json({ case: row }, 200);
});

fraudRoutes.post("/cases/:caseId/notes", requirePermission("fraud.read"), async (c) => {
  const body = await parseJsonBody(c, noteBodySchema);
  const events = await buildFraudService(c).addNote(c.get("auth"), c.get("tenant"), caseId(c), body.note, meta(c));
  return c.json({ events }, 201);
});

// The case table (service) decides the edge, the actor and the real permission.
fraudRoutes.post("/cases/:caseId/transition", requirePermission("fraud.read"), async (c) => {
  const { to, ...input } = await parseJsonBody(c, transitionSchema);
  const row = await buildFraudService(c).transition(c.get("auth"), c.get("tenant"), caseId(c), to, input, meta(c));
  return c.json({ case: row }, 200);
});

// PLATFORM actor only; high-impact actions upgraded to fraud.manage by the service.
fraudRoutes.post("/cases/:caseId/actions", requirePermission("fraud.review"), async (c) => {
  const body = await parseJsonBody(c, actionSchema);
  const result = await buildFraudService(c).takeAction(c.get("auth"), c.get("tenant"), caseId(c), body, meta(c));
  return c.json(result, 201);
});

// ---- assessments -------------------------------------------------------------------

fraudRoutes.post("/assessments", requirePermission("fraud.review"), async (c) => {
  const body = await parseJsonBody(c, assessSchema);
  const input = { ...body, facts: body.facts as RiskFacts };
  const result = await buildFraudService(c).assess(c.get("auth"), c.get("tenant"), input, meta(c));
  return c.json(result, 201);
});

fraudRoutes.get("/assessments/:subjectType/:subjectId", requirePermission("fraud.read"), async (c) => {
  const subjectType = c.req.param("subjectType");
  if (!(SUBJECT_TYPES as readonly string[]).includes(subjectType)) throw new AppError(404, "NOT_FOUND", "unknown subject type");
  const subjectId = c.req.param("subjectId");
  if (!subjectId || subjectId.length > 128) throw new AppError(404, "NOT_FOUND", "assessment not found");
  const items = await buildFraudService(c).listAssessments(c.get("tenant"), subjectType as FraudSubjectType, subjectId);
  return c.json({ items }, 200);
});
