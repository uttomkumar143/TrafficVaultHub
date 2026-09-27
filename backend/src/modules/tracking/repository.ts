/**
 * Tracking persistence over D1 (migration 0008; PRD §31–§34, §94, §116,
 * §129). Pure data access for `tracking_links` and `clicks` — policy lives in
 * `service.ts`. SmartLinks get their own repository (Unit 3). Mirrors
 * `modules/offers/repository.ts` / `modules/affiliates/repository.ts`.
 *
 * Two access paths, deliberately separate:
 *   * Tenant path — takes a `TenantId` (only obtainable from the caller's
 *     resolved membership) and runs through `scopedQuery`, so every statement
 *     is provably bound to `organization_id = ?` first. `organization_id` on a
 *     tracking link is the AFFILIATE organization that owns it.
 *   * Public path — `findActiveByCode` is the ONE lookup the unauthenticated
 *     redirect endpoint (Unit 2) performs. It addresses a link by its public
 *     `code`, not by tenant, and joins the offer + current version in a single
 *     statement so the hot path does one read before its one write.
 *
 * `clicks` is INSERT-only (a click is a fact — PRD §32). `insertClick` is the
 * hot-path write: exactly one prepared INSERT, no joins, no side queries, so
 * Unit 2 can stay inside the PRD §107 p95 < 100 ms budget.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { nowIso } from "../../lib/time";
import type { AccessGrantStatus, AccessMode, OfferStatus } from "../offers/state-machine";
import type { SubIds } from "./ids";

export const TRACKING_LINK_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type TrackingLinkStatus = (typeof TRACKING_LINK_STATUSES)[number];

export const DEVICE_TYPES = ["DESKTOP", "MOBILE", "TABLET", "TV", "OTHER"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const ROUTING_MODES = ["RULE_BASED", "WEIGHTED", "PERFORMANCE_BASED", "GEO_BASED", "DEVICE_BASED", "HYBRID"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface TrackingLinkRow {
  id: string;
  organization_id: string;
  affiliate_profile_id: string;
  offer_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  code: string;
  name: string | null;
  creative_id: string | null;
  status: TrackingLinkStatus;
  default_sub1: string | null;
  default_sub2: string | null;
  default_sub3: string | null;
  default_sub4: string | null;
  default_sub5: string | null;
  archived_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The redirect endpoint's single read (Unit 2): the link plus the offer facts
 * needed to decide eligibility and the destination — offer status/access mode,
 * the CURRENT version id + destination, and the caller's access grant status.
 * No advertiser-confidential economics are selected.
 */
export interface ResolvedTrackingLinkRow extends TrackingLinkRow {
  offer_status: OfferStatus;
  offer_access_mode: AccessMode;
  offer_version_id: string | null;
  offer_destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  grant_status: AccessGrantStatus | null;
}

export interface ClickRow {
  id: string;
  organization_id: string;
  affiliate_profile_id: string;
  tracking_link_id: string | null;
  smartlink_id: string | null;
  offer_id: string;
  offer_version_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  creative_id: string | null;
  sub1: string | null;
  sub2: string | null;
  sub3: string | null;
  sub4: string | null;
  sub5: string | null;
  country_code: string | null;
  region_code: string | null;
  device_type: DeviceType | null;
  os_family: string | null;
  browser_family: string | null;
  language: string | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  referrer_host: string | null;
  routing_mode: RoutingMode | null;
  routing_algorithm_version: string | null;
  decision_reason_code: string;
  failover_from_offer_id: string | null;
  destination_url: string;
  request_id: string | null;
  clicked_at: string;
  created_at: string;
}

/** Coarse request signals stored on a click (PRD §34 — never the raw IP). */
export interface ClickSignals {
  country_code: string | null;
  region_code: string | null;
  device_type: DeviceType | null;
  os_family: string | null;
  browser_family: string | null;
  language: string | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  referrer_host: string | null;
}

/** Everything a click row needs; the service/engine fills it, the repository only writes it. */
export interface ClickInsert extends ClickSignals {
  id: string;
  organization_id: string;
  affiliate_profile_id: string;
  tracking_link_id: string | null;
  smartlink_id: string | null;
  offer_id: string;
  offer_version_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  creative_id: string | null;
  subs: SubIds;
  routing_mode: RoutingMode | null;
  routing_algorithm_version: string | null;
  decision_reason_code: string;
  failover_from_offer_id: string | null;
  destination_url: string;
  request_id: string | null;
}

export interface TrackingLinkInput {
  id: string;
  affiliate_profile_id: string;
  offer_id: string;
  offer_organization_id: string;
  traffic_source_id: string | null;
  code: string;
  name: string | null;
  creative_id: string | null;
  defaults: SubIds;
  created_by_user_id: string | null;
}

export interface TrackingLinkPatch {
  name?: string | null;
  creative_id?: string | null;
  traffic_source_id?: string | null;
  default_sub1?: string | null;
  default_sub2?: string | null;
  default_sub3?: string | null;
  default_sub4?: string | null;
  default_sub5?: string | null;
}

const LINK_COLUMNS = `l.id, l.organization_id, l.affiliate_profile_id, l.offer_id, l.offer_organization_id,
  l.traffic_source_id, l.code, l.name, l.creative_id, l.status, l.default_sub1, l.default_sub2, l.default_sub3,
  l.default_sub4, l.default_sub5, l.archived_at, l.created_by_user_id, l.created_at, l.updated_at`;

const LINK_PATCH_KEYS = [
  "name",
  "creative_id",
  "traffic_source_id",
  "default_sub1",
  "default_sub2",
  "default_sub3",
  "default_sub4",
  "default_sub5",
] as const;

/** Thrown by `insertLink` when the generated `code` already exists; the service retries with a new code. */
export class TrackingCodeCollisionError extends Error {
  constructor() {
    super("tracking code collision");
    this.name = "TrackingCodeCollisionError";
  }
}

export class TrackingRepository {
  constructor(private readonly db: D1Database) {}

  // ---- tracking_links — tenant path (affiliate org) ------------------------

  async listLinks(
    tenantId: TenantId,
    page: PageRequest,
    filter: { offer_id?: string; status?: TrackingLinkStatus },
  ): Promise<Page<TrackingLinkRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.offer_id) {
      where.push("l.offer_id = ?");
      binds.push(filter.offer_id);
    }
    if (filter.status) {
      where.push("l.status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(l.created_at < ? OR (l.created_at = ? AND l.id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${LINK_COLUMNS} FROM tracking_links l
        WHERE l.organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<TrackingLinkRow>();
    return slicePage(res.results, page.limit);
  }

  findLink(tenantId: TenantId, linkId: string): Promise<TrackingLinkRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${LINK_COLUMNS} FROM tracking_links l WHERE l.organization_id = ? AND l.id = ?`,
      tenantId,
      linkId,
    ).first<TrackingLinkRow>();
  }

  /**
   * Insert a link plus caller-supplied audit statements atomically. A UNIQUE
   * violation on `code` surfaces as `TrackingCodeCollisionError` so the
   * service can mint a new code and retry; any other failure propagates.
   */
  async insertLink(tenantId: TenantId, input: TrackingLinkInput, extra: D1PreparedStatement[]): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO tracking_links
               (organization_id, id, affiliate_profile_id, offer_id, offer_organization_id, traffic_source_id, code,
                name, creative_id, default_sub1, default_sub2, default_sub3, default_sub4, default_sub5,
                created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            tenantId,
            input.id,
            input.affiliate_profile_id,
            input.offer_id,
            input.offer_organization_id,
            input.traffic_source_id,
            input.code,
            input.name,
            input.creative_id,
            input.defaults.sub1,
            input.defaults.sub2,
            input.defaults.sub3,
            input.defaults.sub4,
            input.defaults.sub5,
            input.created_by_user_id,
          ),
        ...extra,
      ]);
    } catch (e) {
      if (isUniqueViolation(e, "tracking_links.code")) throw new TrackingCodeCollisionError();
      throw e;
    }
  }

  /**
   * Patch name / creative / traffic source / default sub-IDs. Never status,
   * never offer, never code (a code is minted once and never reused). UPDATE
   * cannot lead with `organization_id = ?`, so it is prepared directly; the
   * WHERE still binds the branded `TenantId`.
   */
  async updateLink(tenantId: TenantId, linkId: string, patch: TrackingLinkPatch, extra: D1PreparedStatement[]): Promise<void> {
    const keys = LINK_PATCH_KEYS.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE tracking_links
              SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status <> 'ARCHIVED'`,
        )
        .bind(...keys.map((k) => patch[k] ?? null), nowIso(), tenantId, linkId),
      ...extra,
    ]);
  }

  /** ACTIVE ⇄ PAUSED, or → ARCHIVED (terminal; sets `archived_at`). Guarded by the expected `from` status. */
  async setLinkStatus(
    tenantId: TenantId,
    linkId: string,
    from: TrackingLinkStatus,
    to: TrackingLinkStatus,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE tracking_links
              SET status = ?, updated_at = ?${to === "ARCHIVED" ? ", archived_at = ?" : ""}
            WHERE organization_id = ? AND id = ? AND status = ?`,
        )
        .bind(to, now, ...(to === "ARCHIVED" ? [now] : []), tenantId, linkId, from),
      ...extra,
    ]);
  }

  // ---- tracking_links — public path (Unit 2 redirect) -----------------------

  /**
   * Resolve a public code to the link + offer facts in ONE statement. Returns
   * null for an unknown code or a non-ACTIVE link so the endpoint answers the
   * same way for "never existed" and "archived" (no enumeration). Offer
   * status is returned, not filtered, so the caller can record WHY a click
   * was refused (PRD §130) — the decision is the engine's, not SQL's.
   */
  findActiveByCode(code: string): Promise<ResolvedTrackingLinkRow | null> {
    return this.db
      .prepare(
        `SELECT ${LINK_COLUMNS},
                o.status AS offer_status, o.access_mode AS offer_access_mode,
                o.current_version_id AS offer_version_id,
                v.destination_url AS offer_destination_url,
                v.targeting_starts_at, v.targeting_ends_at,
                g.status AS grant_status
           FROM tracking_links l
           JOIN offers o ON o.id = l.offer_id
           LEFT JOIN offer_versions v ON v.id = o.current_version_id
           LEFT JOIN affiliate_offer_access g
                  ON g.offer_id = l.offer_id AND g.affiliate_organization_id = l.organization_id
          WHERE l.code = ? AND l.status = 'ACTIVE'`,
      )
      .bind(code)
      .first<ResolvedTrackingLinkRow>();
  }

  // ---- clicks — INSERT-only ---------------------------------------------------

  /** Build the single hot-path INSERT without executing it (for batching / waitUntil). */
  clickStatement(c: ClickInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO clicks
           (id, organization_id, affiliate_profile_id, tracking_link_id, smartlink_id, offer_id, offer_version_id,
            offer_organization_id, traffic_source_id, creative_id, sub1, sub2, sub3, sub4, sub5,
            country_code, region_code, device_type, os_family, browser_family, language, ip_hash, user_agent_hash,
            referrer_host, routing_mode, routing_algorithm_version, decision_reason_code, failover_from_offer_id,
            destination_url, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        c.id,
        c.organization_id,
        c.affiliate_profile_id,
        c.tracking_link_id,
        c.smartlink_id,
        c.offer_id,
        c.offer_version_id,
        c.offer_organization_id,
        c.traffic_source_id,
        c.creative_id,
        c.subs.sub1,
        c.subs.sub2,
        c.subs.sub3,
        c.subs.sub4,
        c.subs.sub5,
        c.country_code,
        c.region_code,
        c.device_type,
        c.os_family,
        c.browser_family,
        c.language,
        c.ip_hash,
        c.user_agent_hash,
        c.referrer_host,
        c.routing_mode,
        c.routing_algorithm_version,
        c.decision_reason_code,
        c.failover_from_offer_id,
        c.destination_url,
        c.request_id,
      );
  }

  /** The hot-path write (Unit 2): exactly one INSERT, nothing else. */
  async insertClick(c: ClickInsert): Promise<void> {
    await this.clickStatement(c).run();
  }

  /** Affiliate-side click list for one of the tenant's links (tenant = affiliate org). */
  async listClicksByLink(tenantId: TenantId, linkId: string, page: PageRequest): Promise<Page<ClickRow>> {
    const binds: unknown[] = [linkId];
    let cursorSql = "";
    if (page.cursor) {
      cursorSql = " AND (created_at < ? OR (created_at = ? AND id < ?))";
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM clicks
        WHERE organization_id = ? AND tracking_link_id = ?${cursorSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ClickRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * Advertiser-side click list for one of the tenant's OFFERS. The tenant is
   * the advertiser org, which on `clicks` is `offer_organization_id`, so this
   * cannot go through `scopedQuery`'s `organization_id = ?` check; the branded
   * `TenantId` is still the first bind and the only scope.
   */
  async listClicksByOffer(tenantId: TenantId, offerId: string, page: PageRequest): Promise<Page<ClickRow>> {
    const binds: unknown[] = [tenantId, offerId];
    let cursorSql = "";
    if (page.cursor) {
      cursorSql = " AND (created_at < ? OR (created_at = ? AND id < ?))";
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await this.db
      .prepare(
        `SELECT * FROM clicks
          WHERE offer_organization_id = ? AND offer_id = ?${cursorSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(...binds, page.limit + 1)
      .all<ClickRow>();
    return slicePage(res.results, page.limit);
  }

  // ---- eligibility facts (data access only; the decision is the service's) --

  /**
   * The offer facts an affiliate needs to be allowed to create a link for it:
   * status, access mode, owning org, whether a current version exists, and
   * the CALLER's grant status. Cross-tenant by nature (the affiliate does not
   * own the offer); `affiliateOrganizationId` comes from the resolved tenant,
   * never the client. Selects no confidential economics.
   */
  findOfferForLinking(
    offerId: string,
    affiliateOrganizationId: string,
  ): Promise<{
    id: string;
    organization_id: string;
    status: OfferStatus;
    access_mode: AccessMode;
    current_version_id: string | null;
    grant_status: AccessGrantStatus | null;
  } | null> {
    return this.db
      .prepare(
        `SELECT o.id, o.organization_id, o.status, o.access_mode, o.current_version_id, g.status AS grant_status
           FROM offers o
           LEFT JOIN affiliate_offer_access g ON g.offer_id = o.id AND g.affiliate_organization_id = ?
          WHERE o.id = ?`,
      )
      .bind(affiliateOrganizationId, offerId)
      .first();
  }
}

/** D1 / SQLite surface a UNIQUE violation as an Error whose message names the constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && msg.includes(constraint);
}
