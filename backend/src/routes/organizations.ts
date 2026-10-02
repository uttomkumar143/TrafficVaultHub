/**
 * /api/v1/organizations — organizations & membership (Phase 1 Unit 3 + Unit 4
 * RBAC; ADR-002). Every route requires authentication. Every `:orgId` route
 * additionally goes through `requireOrg` (user → ACTIVE membership → role →
 * permissions; non-member → 404 no-enumeration) and a `requirePermission`
 * guard (403 FORBIDDEN). The acting organization is ALWAYS the path param —
 * never a body/query value (PRD §94).
 *
 * POST   /                                → 201 { organization }   create (type ∈ ADVERTISER|AFFILIATE|PARTNER|AGENCY); creator seated as owner
 * GET    /                                → 200 { organizations }  organizations the caller belongs to
 * GET    /:orgId                          → 200 { organization }   organizations.read
 * GET    /:orgId/me                       → 200 { membership, role, permissions }  (any ACTIVE member)
 * PATCH  /:orgId                          → 200 { organization }   organizations.update
 * GET    /:orgId/roles                    → 200 { roles }          organizations.read
 * GET    /:orgId/members                  → 200 { members }        members.read
 * POST   /:orgId/members                  → 201 { member }         members.manage; owner role required to grant an owner seat
 * PATCH  /:orgId/members/:memberId        → 200 { member }         members.manage; owner role required to touch an owner seat; LAST_OWNER guard
 * DELETE /:orgId/members/:memberId        → 204                    members.manage; owner role required to remove an owner; LAST_OWNER + SELF_MODIFICATION guards
 *
 * Sub-modules mounted under `/:orgId` (inherit requireAuth + requireOrg):
 *   /:orgId/advertiser(/*)              → routes/advertisers.ts  advertiserRoutes        (Phase 2 Unit 1, tenant)
 *   /:orgId/platform/advertisers(/*)    → routes/advertisers.ts  advertiserReviewRoutes  (Phase 2 Unit 1, PLATFORM org)
 *   /:orgId/affiliate(/*)               → routes/affiliates.ts   affiliateRoutes         (Phase 2 Unit 2, tenant)
 *   /:orgId/platform/affiliates(/*)     → routes/affiliates.ts   affiliateReviewRoutes   (Phase 2 Unit 2, PLATFORM org)
 *   /:orgId/offers(/*)                  → routes/offers.ts       offerRoutes             (Phase 2 Units 3–6, tenant)
 *   /:orgId/marketplace(/*)             → routes/offers.ts       marketplaceRoutes       (Phase 2 Unit 7, affiliate)
 *   /:orgId/platform/offers(/*)         → routes/offers.ts       offerReviewRoutes       (Phase 2 Unit 3, PLATFORM org)
 *   /:orgId/tracking-links(/*)          → routes/tracking.ts     trackingLinkRoutes      (Phase 3 Unit 1, affiliate)
 *   /:orgId/offers/:offerId/clicks      → routes/tracking.ts     offerClickRoutes        (Phase 3 Unit 1, advertiser)
 *   /:orgId/conversions/lifecycle, /:orgId/conversions/:id/{lifecycle,approve,reject,dispute,fraud-review,reverse}
 *                                       → routes/conversions.ts  conversionLifecycleRoutes (Phase 4 Unit 10a, advertiser)
 *   /:orgId/conversion-holds(/*)        → routes/conversions.ts  conversionHoldRoutes    (Phase 4 Unit 10a, advertiser)
 *   /:orgId/payouts(/*)                 → routes/payouts.ts      payoutRoutes            (Phase 5 Unit 13a, affiliate)
 *   /:orgId/platform/payouts, /:orgId/platform/affiliates/:affiliateOrgId/payouts(/*)
 *                                       → routes/payouts.ts      platformPayoutRoutes    (Phase 5 Unit 13b, PLATFORM org)
 *   /:orgId/billing/{profile,alerts}    → routes/billing.ts      billingRoutes           (Phase 5 Unit 14, advertiser)
 *   /:orgId/platform/billing/advertisers/:advertiserOrgId/{profile,evaluate}
 *                                       → routes/billing.ts      platformBillingRoutes   (Phase 5 Unit 14, PLATFORM org)
 *   /:orgId/api-keys(/*)                → routes/api-keys.ts     apiKeyRoutes            (Phase 6 Unit 3, any tenant)
 *   /:orgId/webhooks(/*)                → routes/webhooks.ts     webhookRoutes           (Phase 6 Unit 4, any tenant)
 *   /:orgId/platform/webhooks/{process-due,tenants/:tenantOrgId/...}
 *                                       → routes/webhooks.ts     platformWebhookRoutes   (Phase 6 Unit 4, PLATFORM org)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requireAuth } from "../middleware/require-auth";
import { requireOrg, requirePermission } from "../middleware/require-org";
import { SELF_SERVICE_ORG_TYPES } from "../modules/organizations/service";
import { advertiserReviewRoutes, advertiserRoutes } from "./advertisers";
import { apiKeyRoutes } from "./api-keys";
import { affiliateReviewRoutes, affiliateRoutes } from "./affiliates";
import { billingRoutes, platformBillingRoutes } from "./billing";
import { marketplaceRoutes, offerReviewRoutes, offerRoutes } from "./offers";
import { attributionPolicyRoutes, attributionRoutes, conversionRoutes, postbackSecretRoutes } from "./attribution";
import { conversionHoldRoutes, conversionLifecycleRoutes } from "./conversions";
import { complianceRoutes } from "./compliance";
import { fraudRoutes } from "./fraud";
import { ledgerRoutes, platformLedgerRoutes } from "./ledger";
import { payoutRoutes, platformPayoutRoutes } from "./payouts";
import { offerClickRoutes, trackingLinkRoutes } from "./tracking";
import { platformWebhookRoutes, webhookRoutes } from "./webhooks";

const nameSchema = z.string().trim().min(2).max(120);
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, digits and single hyphens");
/** PRD §9 role keys are UPPER_SNAKE_CASE identifiers. */
const roleKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z_]{1,63}$/);
const idSchema = z.string().uuid();

const createSchema = z.object({
  type: z.enum(SELF_SERVICE_ORG_TYPES),
  name: nameSchema,
  slug: slugSchema.optional(),
});
const updateSchema = z.object({ name: nameSchema });
const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: roleKeySchema,
});
const changeRoleSchema = z.object({ role: roleKeySchema });

/** Malformed member ids can never match a row → same 404 as unknown ids (no oracle). */
function memberId(c: { req: { param(name: string): string | undefined } }): string {
  const parsed = idSchema.safeParse(c.req.param("memberId"));
  if (!parsed.success) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  return parsed.data;
}

export const organizationRoutes = new Hono<AppEnv>();

// Every route in this module is protected — no exceptions (PRD §116).
organizationRoutes.use("*", requireAuth);
// Every tenant-scoped route resolves RBAC + tenant scope before its handler.
organizationRoutes.use("/:orgId", requireOrg);
organizationRoutes.use("/:orgId/*", requireOrg);

// Phase 5 Unit 13b — PLATFORM payout face. Mounted BEFORE the Phase 2 platform
// review routers on purpose: `affiliateReviewRoutes` guards `/platform/affiliates/*`
// with `requirePermission("affiliates.review")`, which finance staff do not hold.
// Registered first, a matching payout handler answers before that middleware runs;
// each payout route carries its own payouts.* permission and the service's
// PLATFORM-org check.
organizationRoutes.route("/:orgId/platform", platformPayoutRoutes);
// Phase 5 Unit 13c — platform ledger face (/platform/ledger/tenants/:tenantOrgId/...), same ordering rule.
organizationRoutes.route("/:orgId/platform", platformLedgerRoutes);
// Phase 5 Unit 14 — platform billing face (/platform/billing/advertisers/:advertiserOrgId/...), same ordering rule.
organizationRoutes.route("/:orgId/platform", platformBillingRoutes);
// Phase 6 Unit 4 — platform webhook face (/platform/webhooks/process-due, /platform/webhooks/tenants/:tenantOrgId/...), same ordering rule.
organizationRoutes.route("/:orgId/platform", platformWebhookRoutes);

// Phase 2 sub-modules (each route adds its own requirePermission).
organizationRoutes.route("/:orgId/advertiser", advertiserRoutes);
organizationRoutes.route("/:orgId/platform/advertisers", advertiserReviewRoutes);
organizationRoutes.route("/:orgId/affiliate", affiliateRoutes);
organizationRoutes.route("/:orgId/platform/affiliates", affiliateReviewRoutes);
organizationRoutes.route("/:orgId/offers", offerRoutes);
organizationRoutes.route("/:orgId/marketplace", marketplaceRoutes);
organizationRoutes.route("/:orgId/platform/offers", offerReviewRoutes);

// Phase 3 sub-modules. `offerClickRoutes` shares the `/offers` prefix with
// `offerRoutes`; its only path (`/:offerId/clicks`) is not defined there, so
// there is no overlap and the mount order does not matter.
organizationRoutes.route("/:orgId/tracking-links", trackingLinkRoutes);
organizationRoutes.route("/:orgId/offers", offerClickRoutes);

// Phase 3 Unit 7e — attribution. `attributionPolicyRoutes` also shares the
// `/offers` prefix (`/:offerId/attribution-policy[/versions]`), again disjoint
// from every path in `offerRoutes` / `offerClickRoutes`.
organizationRoutes.route("/:orgId/offers", attributionPolicyRoutes);
organizationRoutes.route("/:orgId/postback-secrets", postbackSecretRoutes);
// Phase 4 Unit 10a — conversion lifecycle shares the `/conversions` prefix.
// Mounted FIRST so the literal `/lifecycle` segment is matched before the
// attribution router's `/:conversionId`; every other Phase 4 path is a POST
// sub-resource the Phase 3 router never defines. No route reaches the
// internal money-pipeline states (LEDGER_POSTED/EARNED/PAYOUT_ELIGIBLE/PAID).
organizationRoutes.route("/:orgId/conversions", conversionLifecycleRoutes);
organizationRoutes.route("/:orgId/conversions", conversionRoutes);
organizationRoutes.route("/:orgId/conversion-holds", conversionHoldRoutes);
organizationRoutes.route("/:orgId/attributions", attributionRoutes);
// Phase 4 Unit 10b — fraud cases / assessments / actions over FraudService
// (risk scores are evidence, never a verdict; conversion lifecycle untouched).
organizationRoutes.route("/:orgId/fraud", fraudRoutes);
// Phase 4 Unit 10c — compliance rules / evaluations / cases over ComplianceService
// (fail-safe: INSUFFICIENT_INFORMATION is never PASS; RESOLVED only via /resolve).
organizationRoutes.route("/:orgId/compliance", complianceRoutes);

// Phase 5 Unit 13a — affiliate-facing payouts (request / read / cancel; tenant = owning affiliate org).
organizationRoutes.route("/:orgId/payouts", payoutRoutes);

// Phase 5 Unit 13c — tenant ledger face (balances / journals read-only, adjustments request+post, reserves).
organizationRoutes.route("/:orgId/ledger", ledgerRoutes);

// Phase 5 Unit 14 — advertiser billing face (own profile + funding alerts, read-only).
organizationRoutes.route("/:orgId/billing", billingRoutes);

// Phase 6 Unit 3 — API keys (secret shown once; hash never selected by a read path).
organizationRoutes.route("/:orgId/api-keys", apiKeyRoutes);

// Phase 6 Unit 4 — webhook subscriptions + delivery log (secret shown once; ciphertext never selected by a read path).
organizationRoutes.route("/:orgId/webhooks", webhookRoutes);

organizationRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const organization = await c.get("organizationService").create(c.get("auth"), body, meta(c));
  return c.json({ organization }, 201);
});

organizationRoutes.get("/", async (c) => {
  const organizations = await c.get("organizationService").listMine(c.get("auth"));
  return c.json({ organizations }, 200);
});

organizationRoutes.get("/:orgId", requirePermission("organizations.read"), async (c) => {
  const organization = await c.get("organizationService").get(c.get("auth"), c.get("tenant"));
  return c.json({ organization }, 200);
});

/**
 * The caller's own authority inside this organization — what the frontend
 * uses to render/hide actions. Purely informational: the server re-checks
 * every permission on every request regardless of what the client saw here.
 */
organizationRoutes.get("/:orgId/me", async (c) => {
  const t = c.get("tenant");
  return c.json(
    {
      organization: { id: t.organization.id, type: t.organization.type, name: t.organization.name },
      membership: { id: t.membership.id, joined_at: t.membership.joined_at },
      role: { key: t.role.key, is_owner: t.role.is_owner },
      permissions: [...t.permissions].sort(),
    },
    200,
  );
});

organizationRoutes.patch("/:orgId", requirePermission("organizations.update"), async (c) => {
  const body = await parseJsonBody(c, updateSchema);
  const organization = await c.get("organizationService").update(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ organization }, 200);
});

organizationRoutes.get("/:orgId/roles", requirePermission("organizations.read"), async (c) => {
  const roles = await c.get("organizationService").listAssignableRoles(c.get("tenant"));
  return c.json({ roles }, 200);
});

organizationRoutes.get("/:orgId/members", requirePermission("members.read"), async (c) => {
  // Additive: keeps the `members` key, adds `next_cursor` (PRD §71/§127).
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await c.get("organizationService").listMembersPage(c.get("tenant"), page);
  return c.json(result, 200);
});

organizationRoutes.post("/:orgId/members", requirePermission("members.manage"), async (c) => {
  const body = await parseJsonBody(c, addMemberSchema);
  const member = await c.get("organizationService").addMember(c.get("auth"), c.get("tenant"), body, meta(c));
  return c.json({ member }, 201);
});

organizationRoutes.patch("/:orgId/members/:memberId", requirePermission("members.manage"), async (c) => {
  const body = await parseJsonBody(c, changeRoleSchema);
  const member = await c.get("organizationService").changeMemberRole(c.get("auth"), c.get("tenant"), memberId(c), body, meta(c));
  return c.json({ member }, 200);
});

organizationRoutes.delete("/:orgId/members/:memberId", requirePermission("members.manage"), async (c) => {
  await c.get("organizationService").removeMember(c.get("auth"), c.get("tenant"), memberId(c), meta(c));
  return c.body(null, 204);
});
