/**
 * Compliance routes (Phase 4 Unit 10c; PRD §45–§47, §115, §132).
 *
 * Authenticated tenant sub-router mounted by `routes/organizations.ts` UNDER
 * `/:orgId/compliance` (inherits `requireAuth → requireOrg`, adds
 * `requirePermission`). The tenant is `:orgId`; every read and write is scoped
 * by `ComplianceService` to that organization (platform-wide rules with
 * organization_id NULL are visible to every tenant, never writable by one).
 *
 *   GET    /organizations/:orgId/compliance/rules                              compliance.read     → 200 { items }   ?applies_to=
 *   GET    /organizations/:orgId/compliance/rules/:ruleId                      compliance.read     → 200 { rule }
 *   GET    /organizations/:orgId/compliance/rules/key/:ruleKey/versions        compliance.read     → 200 { items }
 *   POST   /organizations/:orgId/compliance/rules                              compliance.manage   → 201 { rule }
 *            { rule_key, severity, applies_to, definition, description?, platform_wide? }
 *   POST   /organizations/:orgId/compliance/evaluations                        compliance.resolve  → 201 { result, evaluations, case, hold_id }
 *            { subject_type, subject_id, conversion_id?, affiliate_organization_id?, facts, rule_keys?, open_case? }
 *   GET    /organizations/:orgId/compliance/evaluations/:subjectType/:subjectId compliance.read    → 200 { items }
 *   GET    /organizations/:orgId/compliance/cases                              compliance.read     → 200 { items, next_cursor }
 *            ?status=&subject_type=&subject_id=&affiliate_organization_id=&limit=&cursor=
 *   GET    /organizations/:orgId/compliance/cases/:caseId                      compliance.read     → 200 { case, events, evaluation, rule, hold }
 *   POST   /organizations/:orgId/compliance/cases                              compliance.resolve  → 201 { case }
 *   POST   /organizations/:orgId/compliance/cases/:caseId/assign               compliance.resolve  → 200 { case }   { assignee_user_id | null }
 *   POST   /organizations/:orgId/compliance/cases/:caseId/notes                compliance.read     → 201 { events } { note }
 *   POST   /organizations/:orgId/compliance/cases/:caseId/transition           compliance.read*    → 200 { case }   { to, reason_code?, note? }
 *   POST   /organizations/:orgId/compliance/cases/:caseId/resolve              compliance.resolve* → 200 { case, events, evaluation, rule, hold }
 *            { resolution: COMPLIANT | NON_COMPLIANT | NO_ACTION, reason_code, note? }
 *
 *   (*) the route gate is the weakest key; the service's case table decides the
 *       real permission and actor per edge (compliance.resolve for most steps,
 *       PLATFORM + compliance.manage for ESCALATED → INVESTIGATING, RESOLVED →
 *       CLOSED and resolving an ESCALATED case). `to: RESOLVED` on the
 *       transition route is refused by the schema — RESOLVED is only reachable
 *       through /resolve with an explicit resolution.
 *
 * FAIL-SAFE: `POST /evaluations` persists INSUFFICIENT_INFORMATION as such; a
 * BLOCKING failure opens a case + COMPLIANCE_BLOCK hold in the same batch. No
 * route touches a conversion's lifecycle_status; only resolve(COMPLIANT)
 * releases the case's own hold. Definitions arrive as `unknown` and are
 * validated by parseRuleDefinition() inside the service.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requirePermission } from "../middleware/require-org";
import {
  ComplianceRepository,
  COMPLIANCE_CASE_STATUSES,
  COMPLIANCE_RESOLUTIONS,
  type ComplianceCaseListFilter,
} from "../modules/compliance/repository";
import type { ComplianceFacts, ComplianceSubjectType } from "../modules/compliance/rules";
import { ComplianceService } from "../modules/compliance/service";
import { ConversionRepository } from "../modules/conversions/repository";

const idSchema = z.string().uuid();
const reasonSchema = z.string().min(1).max(64);
const noteSchema = z.string().max(2000);
const SEVERITIES = ["INFO", "WARNING", "BLOCKING"] as const;
const SUBJECT_TYPES = ["AFFILIATE", "ADVERTISER", "OFFER", "CONVERSION"] as const;
const RULE_KEY = /^[a-z0-9_.-]{1,64}$/;
/** Every status except RESOLVED — RESOLVED is only reachable through /resolve. */
const TRANSITION_TARGETS = COMPLIANCE_CASE_STATUSES.filter((s) => s !== "RESOLVED") as unknown as readonly [string, ...string[]];

const stringList = z.array(z.string().min(1).max(256)).max(500);

/** Facts are caller-supplied evidence; unknown fields are rejected, absent fields yield INSUFFICIENT_INFORMATION in the engine. */
const factsSchema = z
  .object({
    traffic_sources: stringList.optional(),
    target_countries: stringList.optional(),
    bids_on_brand_terms: z.boolean().optional(),
    domains: stringList.optional(),
    keywords: stringList.optional(),
    creative_texts: z.array(z.string().max(4000)).max(500).optional(),
    incentivized_traffic: z.boolean().optional(),
    landing_page_urls: z.array(z.string().max(2048)).max(500).optional(),
    creative_ids: stringList.optional(),
    promotional_methods: stringList.optional(),
    account_status: z.string().max(64).nullable().optional(),
    identity_verified: z.boolean().optional(),
    tax_info_on_file: z.boolean().optional(),
  })
  .strict();

const createRuleSchema = z
  .object({
    rule_key: z.string().regex(RULE_KEY),
    severity: z.enum(SEVERITIES),
    applies_to: z.enum(SUBJECT_TYPES),
    // Validated structurally by parseRuleDefinition() in the service (400 INVALID_RULE_DEFINITION).
    definition: z.record(z.string(), z.unknown()),
    description: z.string().max(2000).nullable().optional(),
    platform_wide: z.boolean().optional(),
  })
  .strict();

const evaluateSchema = z
  .object({
    subject_type: z.enum(SUBJECT_TYPES),
    subject_id: z.string().min(1).max(128),
    conversion_id: idSchema.nullable().optional(),
    affiliate_organization_id: idSchema.nullable().optional(),
    facts: factsSchema,
    rule_keys: z.array(z.string().regex(RULE_KEY)).max(100).optional(),
    open_case: z.boolean().optional(),
  })
  .strict();

const openCaseSchema = z
  .object({
    subject_type: z.enum(SUBJECT_TYPES),
    subject_id: z.string().min(1).max(128),
    severity: z.enum(SEVERITIES),
    reason_code: reasonSchema,
    summary: z.string().max(2000).nullable().optional(),
    conversion_id: idSchema.nullable().optional(),
    affiliate_organization_id: idSchema.nullable().optional(),
    rule_id: idSchema.nullable().optional(),
    evaluation_id: idSchema.nullable().optional(),
  })
  .strict();

const assignSchema = z.object({ assignee_user_id: idSchema.nullable() }).strict();
const noteBodySchema = z.object({ note: noteSchema.min(1) }).strict();

const transitionSchema = z
  .object({
    to: z.enum(TRANSITION_TARGETS),
    reason_code: reasonSchema.optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict();

const resolveSchema = z
  .object({
    resolution: z.enum(COMPLIANCE_RESOLUTIONS),
    reason_code: reasonSchema,
    note: noteSchema.nullable().optional(),
  })
  .strict();

type Ctx = Context<AppEnv>;
type ParamCtx = { req: { param(name: string): string | undefined } };

/** Malformed ids can never match a row → the same 404 as an unknown id (no oracle). */
function paramId(c: ParamCtx, name: string, what: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new AppError(404, "NOT_FOUND", `${what} not found`);
  return parsed.data;
}

function subjectTypeParam(raw: string | undefined, status: 400 | 404): ComplianceSubjectType {
  if (raw && (SUBJECT_TYPES as readonly string[]).includes(raw)) return raw as ComplianceSubjectType;
  if (status === 404) throw new AppError(404, "NOT_FOUND", "unknown subject type");
  throw new AppError(400, "VALIDATION_ERROR", "Invalid request: subject_type");
}

function idFilter(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${name}`);
  return parsed.data;
}

/** Per-request service over the bound D1. */
export function buildComplianceService(c: Ctx): ComplianceService {
  const db = c.env.DB;
  return new ComplianceService(new ComplianceRepository(db), new ConversionRepository(db), db);
}

export const complianceRoutes = new Hono<AppEnv>();

// ---- rules -----------------------------------------------------------------------

complianceRoutes.get("/rules", requirePermission("compliance.read"), async (c) => {
  const raw = c.req.query("applies_to");
  const appliesTo = raw ? subjectTypeParam(raw, 400) : undefined;
  const items = await buildComplianceService(c).listRules(c.get("tenant"), appliesTo);
  return c.json({ items }, 200);
});

complianceRoutes.post("/rules", requirePermission("compliance.manage"), async (c) => {
  const body = await parseJsonBody(c, createRuleSchema);
  const rule = await buildComplianceService(c).createRuleVersion(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ rule }, 201);
});

// Literal segment registered before /rules/:ruleId so "key" is never read as an id.
complianceRoutes.get("/rules/key/:ruleKey/versions", requirePermission("compliance.read"), async (c) => {
  const ruleKey = c.req.param("ruleKey");
  if (!ruleKey || !RULE_KEY.test(ruleKey)) throw new AppError(404, "NOT_FOUND", "compliance rule not found");
  const items = await buildComplianceService(c).listRuleVersions(c.get("tenant"), ruleKey);
  return c.json({ items }, 200);
});

complianceRoutes.get("/rules/:ruleId", requirePermission("compliance.read"), async (c) => {
  const rule = await buildComplianceService(c).getRule(c.get("tenant"), paramId(c, "ruleId", "compliance rule"));
  return c.json({ rule }, 200);
});

// ---- evaluations -------------------------------------------------------------------

complianceRoutes.post("/evaluations", requirePermission("compliance.resolve"), async (c) => {
  const body = await parseJsonBody(c, evaluateSchema);
  const input = { ...body, facts: body.facts as ComplianceFacts };
  const result = await buildComplianceService(c).evaluate(c.get("auth"), c.get("tenant"), input, meta(c));
  return c.json(result, 201);
});

complianceRoutes.get("/evaluations/:subjectType/:subjectId", requirePermission("compliance.read"), async (c) => {
  const subjectType = subjectTypeParam(c.req.param("subjectType"), 404);
  const subjectId = c.req.param("subjectId");
  if (!subjectId || subjectId.length > 128) throw new AppError(404, "NOT_FOUND", "evaluation not found");
  const items = await buildComplianceService(c).listEvaluations(c.get("tenant"), subjectType, subjectId);
  return c.json({ items }, 200);
});

// ---- cases -----------------------------------------------------------------------

complianceRoutes.get("/cases", requirePermission("compliance.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const filter: ComplianceCaseListFilter = {};
  const status = c.req.query("status");
  if (status) {
    if (!(COMPLIANCE_CASE_STATUSES as readonly string[]).includes(status))
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
    filter.status = status as ComplianceCaseListFilter["status"];
  }
  const subjectType = c.req.query("subject_type");
  if (subjectType) filter.subject_type = subjectTypeParam(subjectType, 400);
  const subjectId = c.req.query("subject_id");
  if (subjectId) {
    if (subjectId.length > 128) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: subject_id");
    filter.subject_id = subjectId;
  }
  const affiliate = idFilter(c.req.query("affiliate_organization_id"), "affiliate_organization_id");
  if (affiliate) filter.affiliate_organization_id = affiliate;
  const result = await buildComplianceService(c).listCases(c.get("tenant"), page, filter);
  return c.json(result, 200);
});

complianceRoutes.post("/cases", requirePermission("compliance.resolve"), async (c) => {
  const body = await parseJsonBody(c, openCaseSchema);
  const row = await buildComplianceService(c).openCase(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ case: row }, 201);
});

complianceRoutes.get("/cases/:caseId", requirePermission("compliance.read"), async (c) => {
  const detail = await buildComplianceService(c).getCase(c.get("tenant"), paramId(c, "caseId", "compliance case"));
  return c.json(detail, 200);
});

complianceRoutes.post("/cases/:caseId/assign", requirePermission("compliance.resolve"), async (c) => {
  const body = await parseJsonBody(c, assignSchema);
  const row = await buildComplianceService(c).assign(
    c.get("auth"),
    c.get("tenant"),
    paramId(c, "caseId", "compliance case"),
    body.assignee_user_id,
    meta(c),
  );
  return c.json({ case: row }, 200);
});

complianceRoutes.post("/cases/:caseId/notes", requirePermission("compliance.read"), async (c) => {
  const body = await parseJsonBody(c, noteBodySchema);
  const events = await buildComplianceService(c).addNote(
    c.get("auth"),
    c.get("tenant"),
    paramId(c, "caseId", "compliance case"),
    body.note,
    meta(c),
  );
  return c.json({ events }, 201);
});

// The case table (service) decides the edge, the actor and the real permission; RESOLVED is not a valid target here.
complianceRoutes.post("/cases/:caseId/transition", requirePermission("compliance.read"), async (c) => {
  const { to, ...input } = await parseJsonBody(c, transitionSchema);
  const row = await buildComplianceService(c).transition(
    c.get("auth"),
    c.get("tenant"),
    paramId(c, "caseId", "compliance case"),
    to as ComplianceCaseListFilter["status"] & string,
    input,
    meta(c),
  );
  return c.json({ case: row }, 200);
});

// resolve(): the only way to RESOLVED; COMPLIANT releases the case's COMPLIANCE_BLOCK hold in the same batch.
complianceRoutes.post("/cases/:caseId/resolve", requirePermission("compliance.resolve"), async (c) => {
  const body = await parseJsonBody(c, resolveSchema);
  const detail = await buildComplianceService(c).resolve(
    c.get("auth"),
    c.get("tenant"),
    paramId(c, "caseId", "compliance case"),
    body,
    meta(c),
  );
  return c.json(detail, 200);
});
