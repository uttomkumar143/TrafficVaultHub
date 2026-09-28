/**
 * Tracking module — policy layer (Phase 3 Unit 1; PRD §31–§34, §94, §116,
 * §124, §129). SQL lives in `repository.ts`; ids / sub-ID hygiene in `ids.ts`;
 * the access rules in `eligibility.ts`. Mirrors `modules/offers/service.ts`:
 * it decides WHO may do WHAT and records every accepted mutation in
 * `audit_logs` in the same D1 batch as the change.
 *
 * Two faces, both enforced SERVER-SIDE:
 *   Affiliate (`tracking.read` / `tracking.manage`, AFFILIATE/PARTNER org):
 *     list · get · create · update · pause · resume · archive · clicks-by-link
 *   Advertiser/owner (`tracking.read`, ADVERTISER/AGENCY org):
 *     clicks-by-offer (clicks on the tenant's OWN offers)
 *
 * Invariants:
 *   * The affiliate organization on a link is ALWAYS the resolved tenant
 *     (`tenant.organization.id`), never a client-supplied id (PRD §94).
 *   * A link can only be created for an offer the affiliate may actually send
 *     traffic to — the same rule Phase 2's marketplace `can_join` enforces
 *     (LIVE + PUBLIC or an APPROVED grant, see `eligibility.ts`). A PRIVATE /
 *     INVITE_ONLY / AFFILIATE_SPECIFIC offer without an APPROVED grant is a
 *     404 (no enumeration of offers the caller cannot see), an inactive one
 *     the caller CAN see is a 409 OFFER_NOT_LINKABLE.
 *   * `traffic_source_id`, if given, must be one of the tenant's own declared
 *     sources (PRD §27) — looked up tenant-scoped, so another tenant's id is
 *     simply "not found" (400 TRAFFIC_SOURCE_INVALID).
 *   * Sub-ID defaults go through `sanitizeSubIds`; a rejected value is a 400
 *     naming the slot and the reason — never silently truncated or dropped.
 *   * `code` is minted server-side, UNIQUE, never reused; a collision is
 *     retried (bounded), never surfaced.
 *   * The link's status graph is ACTIVE ⇄ PAUSED → ARCHIVED (terminal).
 *
 * Error codes: TRACKING_LINK_NOT_FOUND 404 · OFFER_NOT_FOUND 404 ·
 *   OFFER_NOT_LINKABLE 409 · AFFILIATE_PROFILE_REQUIRED 400 ·
 *   AFFILIATE_NOT_ACTIVE 409 · TRAFFIC_SOURCE_INVALID 400 · SUB_ID_INVALID 400 ·
 *   INVALID_TRANSITION 409 · ORG_TYPE_NOT_AFFILIATE 400 ·
 *   ORG_TYPE_NOT_ADVERTISER 400 · FORBIDDEN 403
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AffiliateRepository } from "../affiliates/repository";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { OfferRepository } from "../offers/repository";
import type { PermissionKey } from "../rbac/permissions";
import { hasOfferAccess, offerRoutability } from "./eligibility";
import { generateTrackingCode, sanitizeSubIds, type SubIdKey, type SubIds } from "./ids";
import {
  TrackingCodeCollisionError,
  type ClickRow,
  type DeviceType,
  type RoutingMode,
  type TrackingLinkPatch,
  type TrackingLinkRow,
  type TrackingLinkStatus,
  type TrackingRepository,
} from "./repository";

/** Organization types that may own tracking links (PRD §8). */
export const TRACKING_OWNER_ORG_TYPES = ["AFFILIATE", "PARTNER"] as const;
/** Organization types that own offers and may read clicks on them. */
const OFFER_ORG_TYPES = ["ADVERTISER", "AGENCY"] as const;

/** Affiliate statuses under which new links may be created / resumed (PRD §19). */
const LINK_CREATING_AFFILIATE_STATUSES: ReadonlySet<string> = new Set(["ACTIVE"]);

/** How many fresh codes to try on a UNIQUE collision before giving up (60-bit codes: never in practice). */
const CODE_MINT_ATTEMPTS = 5;

export interface PublicTrackingLink {
  id: string;
  organization_id: string;
  offer_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  code: string;
  /** Path the affiliate publishes; the host is the deployment's tracking domain. */
  tracking_path: string;
  name: string | null;
  creative_id: string | null;
  status: TrackingLinkStatus;
  defaults: SubIds;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Status targets the caller may move this link to (UI hint only). */
  allowed_transitions: TrackingLinkStatus[];
}

/** Click projection. Coarse signals only; never the hashes (they are internal correlation keys). */
export interface PublicClick {
  id: string;
  tracking_link_id: string | null;
  smartlink_id: string | null;
  offer_id: string;
  offer_version_id: string;
  traffic_source_id: string | null;
  creative_id: string | null;
  subs: SubIds;
  country_code: string | null;
  region_code: string | null;
  device_type: DeviceType | null;
  os_family: string | null;
  browser_family: string | null;
  language: string | null;
  referrer_host: string | null;
  routing_mode: RoutingMode | null;
  routing_algorithm_version: string | null;
  decision_reason_code: string;
  failover_from_offer_id: string | null;
  clicked_at: string;
}

export interface CreateTrackingLinkInput {
  offer_id: string;
  traffic_source_id?: string | null;
  name?: string | null;
  creative_id?: string | null;
  defaults?: Partial<Record<SubIdKey, unknown>> | null;
}

export interface UpdateTrackingLinkInput {
  traffic_source_id?: string | null;
  name?: string | null;
  creative_id?: string | null;
  defaults?: Partial<Record<SubIdKey, unknown>> | null;
}

const LINK_EDGES: Readonly<Record<TrackingLinkStatus, readonly TrackingLinkStatus[]>> = {
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export class TrackingService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: TrackingRepository,
    private readonly affiliates: AffiliateRepository,
    private readonly offers: OfferRepository,
    db: D1Database,
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- affiliate reads -------------------------------------------------------

  /** `tracking.read`. Cursor-paginated list of the org's own links. */
  async list(
    tenant: TenantContext,
    page: PageRequest,
    filter: { offer_id?: string; status?: TrackingLinkStatus },
  ): Promise<Page<PublicTrackingLink>> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.read");
    const result = await this.repo.listLinks(tenantIdOf(tenant), page, filter);
    return { items: result.items.map(toLink), next_cursor: result.next_cursor };
  }

  /** `tracking.read`. One of the org's own links. */
  async get(tenant: TenantContext, linkId: string): Promise<PublicTrackingLink> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.read");
    return toLink(await this.requireLink(tenant, linkId));
  }

  /** `tracking.read`. Clicks recorded against one of the org's own links, newest first. */
  async listClicks(tenant: TenantContext, linkId: string, page: PageRequest): Promise<Page<PublicClick>> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.read");
    await this.requireLink(tenant, linkId);
    const result = await this.repo.listClicksByLink(tenantIdOf(tenant), linkId, page);
    return { items: result.items.map(toClick), next_cursor: result.next_cursor };
  }

  // ---- affiliate writes ------------------------------------------------------

  /**
   * `tracking.manage`. Mint a tracking link for an offer the affiliate may
   * promote. The affiliate org and profile come from the tenant; the offer's
   * owning org is copied from the offer row (denormalized for fan-out).
   */
  async create(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: CreateTrackingLinkInput,
    meta: RequestMeta,
  ): Promise<PublicTrackingLink> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.manage");
    const tid = tenantIdOf(tenant);
    const profile = await this.requireActiveProfile(tenant);
    const offer = await this.requireLinkableOffer(tenant, input.offer_id);
    const trafficSourceId = await this.resolveTrafficSource(tenant, input.traffic_source_id);
    const defaults = parseDefaults(input.defaults);

    const id = crypto.randomUUID();
    let code = "";
    for (let attempt = 0; attempt < CODE_MINT_ATTEMPTS; attempt++) {
      code = generateTrackingCode();
      try {
        await this.repo.insertLink(
          tid,
          {
            id,
            affiliate_profile_id: profile.id,
            offer_id: offer.id,
            offer_organization_id: offer.organization_id,
            traffic_source_id: trafficSourceId,
            code,
            name: input.name?.trim() || null,
            creative_id: input.creative_id?.trim() || null,
            defaults,
            created_by_user_id: ctx.user.id,
          },
          [
            this.audit.statement({
              organization_id: tenant.organization.id,
              actor_user_id: ctx.user.id,
              action: "tracking_link.created",
              target_type: "tracking_link",
              target_id: id,
              metadata: { offer_id: offer.id, offer_organization_id: offer.organization_id, traffic_source_id: trafficSourceId },
              meta,
            }),
          ],
        );
        return toLink(await this.requireLink(tenant, id));
      } catch (e) {
        if (!(e instanceof TrackingCodeCollisionError)) throw e;
      }
    }
    throw new Error("could not mint a unique tracking code");
  }

  /** `tracking.manage`. Patch name / creative / traffic source / defaults; never status, offer or code. */
  async update(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    linkId: string,
    input: UpdateTrackingLinkInput,
    meta: RequestMeta,
  ): Promise<PublicTrackingLink> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.manage");
    const before = await this.requireLink(tenant, linkId);
    if (before.status === "ARCHIVED") {
      throw new AppError(409, "INVALID_TRANSITION", "An archived tracking link cannot be edited");
    }
    const patch: TrackingLinkPatch = {};
    if (input.name !== undefined) patch.name = input.name?.trim() || null;
    if (input.creative_id !== undefined) patch.creative_id = input.creative_id?.trim() || null;
    if (input.traffic_source_id !== undefined) {
      patch.traffic_source_id = await this.resolveTrafficSource(tenant, input.traffic_source_id);
    }
    if (input.defaults !== undefined) {
      const d = parseDefaults(input.defaults);
      patch.default_sub1 = d.sub1;
      patch.default_sub2 = d.sub2;
      patch.default_sub3 = d.sub3;
      patch.default_sub4 = d.sub4;
      patch.default_sub5 = d.sub5;
    }
    const fields = Object.keys(patch);
    if (fields.length > 0) {
      await this.repo.updateLink(tenantIdOf(tenant), linkId, patch, [
        this.audit.statement({
          organization_id: tenant.organization.id,
          actor_user_id: ctx.user.id,
          action: "tracking_link.updated",
          target_type: "tracking_link",
          target_id: linkId,
          metadata: { fields },
          meta,
        }),
      ]);
    }
    return toLink(await this.requireLink(tenant, linkId));
  }

  /**
   * `tracking.manage`. ACTIVE ⇄ PAUSED, or → ARCHIVED (terminal). Resuming
   * re-checks that the affiliate is still ACTIVE and the offer is still
   * linkable, so a paused link cannot be used to bypass a revoked grant.
   */
  async transition(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    linkId: string,
    to: TrackingLinkStatus,
    meta: RequestMeta,
  ): Promise<PublicTrackingLink> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "tracking.manage");
    const link = await this.requireLink(tenant, linkId);
    if (!LINK_EDGES[link.status].includes(to)) {
      throw new AppError(409, "INVALID_TRANSITION", `Cannot move tracking link from ${link.status} to ${to}`);
    }
    if (to === "ACTIVE") {
      await this.requireActiveProfile(tenant);
      await this.requireLinkableOffer(tenant, link.offer_id);
    }
    await this.repo.setLinkStatus(tenantIdOf(tenant), linkId, link.status, to, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "tracking_link.status_changed",
        target_type: "tracking_link",
        target_id: linkId,
        metadata: { from: link.status, to },
        meta,
      }),
    ]);
    return toLink(await this.requireLink(tenant, linkId));
  }

  // ---- advertiser reads ------------------------------------------------------

  /** `tracking.read`. Clicks on one of the ADVERTISER tenant's own offers, newest first. */
  async listOfferClicks(tenant: TenantContext, offerId: string, page: PageRequest): Promise<Page<PublicClick>> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "tracking.read");
    const tid = tenantIdOf(tenant);
    const offer = await this.offers.findById(tid, offerId);
    if (!offer) throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
    const result = await this.repo.listClicksByOffer(tid, offerId, page);
    return { items: result.items.map(toClick), next_cursor: result.next_cursor };
  }

  // ---- internals -------------------------------------------------------------

  private async requireLink(tenant: TenantContext, linkId: string): Promise<TrackingLinkRow> {
    const row = await this.repo.findLink(tenantIdOf(tenant), linkId);
    if (!row) throw new AppError(404, "TRACKING_LINK_NOT_FOUND", "Tracking link not found");
    return row;
  }

  /** The tenant must have an affiliate profile in a status that may send traffic. */
  private async requireActiveProfile(tenant: TenantContext): Promise<{ id: string }> {
    const profile = await this.affiliates.findByTenant(tenantIdOf(tenant));
    if (!profile) {
      throw new AppError(400, "AFFILIATE_PROFILE_REQUIRED", "Create an affiliate profile before creating tracking links");
    }
    if (!LINK_CREATING_AFFILIATE_STATUSES.has(profile.status)) {
      throw new AppError(409, "AFFILIATE_NOT_ACTIVE", `An affiliate in status ${profile.status} cannot create tracking links`);
    }
    return { id: profile.id };
  }

  /**
   * The offer must exist, be visible to the caller under its access mode, and
   * be routable right now. Visibility failure → 404 (no enumeration; the same
   * answer as "no such offer"); routability failure on a visible offer → 409
   * with the concrete reason.
   */
  private async requireLinkableOffer(tenant: TenantContext, offerId: string): Promise<{ id: string; organization_id: string }> {
    const affiliateOrgId = tenant.organization.id;
    const facts = await this.repo.findOfferForLinking(offerId, affiliateOrgId);
    if (!facts || !hasOfferAccess(facts.access_mode, facts.grant_status)) {
      throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
    }
    // The link-time check needs the current version's destination + window.
    const version = facts.current_version_id ? await this.offers.findVersionAny(facts.current_version_id) : null;
    const routability = offerRoutability({
      status: facts.status,
      access_mode: facts.access_mode,
      current_version_id: facts.current_version_id,
      destination_url: version?.destination_url ?? null,
      targeting_starts_at: version?.targeting_starts_at ?? null,
      targeting_ends_at: version?.targeting_ends_at ?? null,
      grant_status: facts.grant_status,
    });
    if (!routability.eligible) {
      throw new AppError(409, "OFFER_NOT_LINKABLE", `The offer cannot receive traffic right now (${routability.reason})`);
    }
    return { id: facts.id, organization_id: facts.organization_id };
  }

  /** null/undefined → no source; otherwise must be one of the TENANT's declared sources. */
  private async resolveTrafficSource(tenant: TenantContext, sourceId: string | null | undefined): Promise<string | null> {
    if (sourceId === undefined || sourceId === null || sourceId === "") return null;
    const src = await this.affiliates.findTrafficSourceById(tenantIdOf(tenant), sourceId);
    if (!src) throw new AppError(400, "TRAFFIC_SOURCE_INVALID", "traffic_source_id is not one of this organization's declared traffic sources");
    return src.id;
  }

  private assertAffiliateOrg(tenant: TenantContext): void {
    if (!(TRACKING_OWNER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_AFFILIATE", "Only affiliate or partner organizations can own tracking links");
    }
  }

  private assertOfferOrg(tenant: TenantContext): void {
    if (!(OFFER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_ADVERTISER", "Only advertiser or agency organizations can read clicks on offers");
    }
  }

  private ensurePermission(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) {
      throw new AppError(403, "FORBIDDEN", `Missing required permission: ${key}`);
    }
  }
}

/** Sanitize default sub-IDs; a rejected slot is a 400 that names the slot and the reason (PRD §34). */
function parseDefaults(raw: Partial<Record<SubIdKey, unknown>> | null | undefined): SubIds {
  const { values, rejected } = sanitizeSubIds(raw);
  if (rejected.length > 0) {
    const first = rejected[0]!;
    throw new AppError(400, "SUB_ID_INVALID", `Invalid request: defaults.${first.key} (${first.reason})`);
  }
  return values;
}

/** Public path for a code — the redirect endpoint of Unit 2. */
export function trackingPathFor(code: string): string {
  return `/t/${code}`;
}

// ---- mappers (explicit allow-lists — the security boundary, PRD §116) -------

function toLink(r: TrackingLinkRow): PublicTrackingLink {
  return {
    id: r.id,
    organization_id: r.organization_id,
    offer_id: r.offer_id,
    offer_organization_id: r.offer_organization_id,
    traffic_source_id: r.traffic_source_id,
    code: r.code,
    tracking_path: trackingPathFor(r.code),
    name: r.name,
    creative_id: r.creative_id,
    status: r.status,
    defaults: {
      sub1: r.default_sub1,
      sub2: r.default_sub2,
      sub3: r.default_sub3,
      sub4: r.default_sub4,
      sub5: r.default_sub5,
    },
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    allowed_transitions: [...LINK_EDGES[r.status]],
  };
}

function toClick(c: ClickRow): PublicClick {
  return {
    id: c.id,
    tracking_link_id: c.tracking_link_id,
    smartlink_id: c.smartlink_id,
    offer_id: c.offer_id,
    offer_version_id: c.offer_version_id,
    traffic_source_id: c.traffic_source_id,
    creative_id: c.creative_id,
    subs: { sub1: c.sub1, sub2: c.sub2, sub3: c.sub3, sub4: c.sub4, sub5: c.sub5 },
    country_code: c.country_code,
    region_code: c.region_code,
    device_type: c.device_type,
    os_family: c.os_family,
    browser_family: c.browser_family,
    language: c.language,
    referrer_host: c.referrer_host,
    routing_mode: c.routing_mode,
    routing_algorithm_version: c.routing_algorithm_version,
    decision_reason_code: c.decision_reason_code,
    failover_from_offer_id: c.failover_from_offer_id,
    clicked_at: c.clicked_at,
  };
}
