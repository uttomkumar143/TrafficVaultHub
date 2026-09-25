/**
 * Offer persistence over D1 (migration 0007; PRD §22–§30, §92, §94, §116).
 * Pure data access — lifecycle policy lives in `state-machine.ts` /
 * `service.ts`. Mirrors `modules/affiliates/repository.ts`.
 *
 * Two access paths, deliberately separate:
 *   * Tenant path — takes a `TenantId` (only obtainable from the caller's
 *     resolved membership) and runs through `scopedQuery`, so every statement
 *     is provably bound to `organization_id = ?` first.
 *   * Platform path — `*Any*` methods used ONLY by the review service behind
 *     `offers.approve` (a platform permission). They address offers by id
 *     across tenants; the service never exposes them to tenant routes.
 *
 * Versioning (PRD §23): `offer_versions` is INSERT-only. The repository
 * deliberately exposes NO update/delete for version rows or their targeting —
 * history is immutable by construction. Every accepted lifecycle transition
 * is written to `offer_status_transitions` (append-only) and `audit_logs` in
 * the same atomic batch as the status change.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { nowIso } from "../../lib/time";
import type {
  AccessGrantStatus,
  AccessMode,
  ActorKind,
  OfferStatus,
  PayoutType,
  TargetingDimension,
} from "./state-machine";

export interface OfferRow {
  id: string;
  organization_id: string;
  advertiser_profile_id: string;
  status: OfferStatus;
  access_mode: AccessMode;
  name: string;
  vertical: string | null;
  description: string | null;
  current_version_id: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row joined with the owning organization's display fields (platform lists). */
export interface OfferWithOrgRow extends OfferRow {
  organization_name: string;
  organization_slug: string;
  organization_type: string;
}

export interface OfferVersionRow {
  id: string;
  offer_id: string;
  organization_id: string;
  version_number: number;
  payout_type: PayoutType;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor: number;
  revshare_percent_bps: number | null;
  daily_conversion_cap: number | null;
  total_conversion_cap: number | null;
  budget_minor: number | null;
  attribution_window_seconds: number;
  conversion_event: string;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface OfferTargetingRow {
  id: string;
  offer_version_id: string;
  offer_id: string;
  organization_id: string;
  dimension: TargetingDimension;
  value: string;
  created_at: string;
}

export interface OfferTransitionRow {
  id: string;
  offer_id: string;
  organization_id: string;
  from_status: OfferStatus | null;
  to_status: OfferStatus;
  actor_user_id: string | null;
  actor_kind: ActorKind;
  reason: string | null;
  request_id: string | null;
  created_at: string;
}

export interface AffiliateOfferAccessRow {
  id: string;
  offer_id: string;
  organization_id: string;
  affiliate_organization_id: string;
  status: AccessGrantStatus;
  reason: string | null;
  requested_at: string | null;
  decided_at: string | null;
  decided_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Economic fields of a version. Money is ALWAYS integer minor units + a
 * 3-letter currency (PRD §88: never a float, never combined ambiguously).
 * Revshare is integer basis points (0..10000), never a float percentage.
 * `network_margin_minor` is advisory: the network derives margin from
 * advertiser_payout − affiliate_commission, and the row records it explicitly
 * only when the network sets one (PRD §24).
 */
export interface OfferVersionInput {
  payout_type: PayoutType;
  currency: string;
  advertiser_payout_minor: number;
  affiliate_commission_minor: number;
  network_margin_minor?: number;
  revshare_percent_bps?: number | null;
  daily_conversion_cap?: number | null;
  total_conversion_cap?: number | null;
  budget_minor?: number | null;
  attribution_window_seconds?: number;
  conversion_event: string;
  destination_url?: string | null;
  targeting_starts_at?: string | null;
  targeting_ends_at?: string | null;
  change_summary?: string | null;
}

export interface TargetingInput {
  dimension: TargetingDimension;
  value: string;
}

/** Fields a tenant may set when creating an offer (identity + access mode). */
export interface OfferInput {
  name: string;
  vertical?: string | null;
  description?: string | null;
  access_mode?: AccessMode;
}

/** Fields a tenant may change on an offer without creating a new version. */
export interface OfferPatch {
  name?: string;
  vertical?: string | null;
  description?: string | null;
  access_mode?: AccessMode;
}

const COLUMNS = `o.id, o.organization_id, o.advertiser_profile_id, o.status, o.access_mode, o.name,
  o.vertical, o.description, o.current_version_id, o.review_notes, o.submitted_at, o.approved_at,
  o.activated_at, o.archived_at, o.created_at, o.updated_at`;
const ORG_COLUMNS = `org.name AS organization_name, org.slug AS organization_slug, org.type AS organization_type`;

const VERSION_COLUMNS = `v.id, v.offer_id, v.organization_id, v.version_number, v.payout_type, v.currency,
  v.advertiser_payout_minor, v.affiliate_commission_minor, v.network_margin_minor, v.revshare_percent_bps,
  v.daily_conversion_cap, v.total_conversion_cap, v.budget_minor, v.attribution_window_seconds,
  v.conversion_event, v.destination_url, v.targeting_starts_at, v.targeting_ends_at, v.change_summary,
  v.created_by_user_id, v.created_at`;

/**
 * Advertiser-side fields that are redacted from every affiliate-facing
 * marketplace projection (PRD §29 "Do not expose confidential advertiser
 * data"). Kept here as the single documented list so the service's allow-list
 * mappers and the leakage tests agree on what "confidential" means.
 */
export const AFFILIATE_CONFIDENTIAL_FIELDS = [
  "advertiser_payout_minor",
  "network_margin_minor",
  "budget_minor",
] as const;

export class OfferRepository {
  constructor(private readonly db: D1Database) {}

  // ---- tenant path (TenantId + scopedQuery) --------------------------------

  async listByTenant(tenantId: TenantId, page: PageRequest): Promise<Page<OfferRow>> {
    const binds: unknown[] = [];
    let cursorSql = "";
    if (page.cursor) {
      cursorSql = " AND (o.created_at < ? OR (o.created_at = ? AND o.id < ?))";
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM offers o
        WHERE o.organization_id = ?${cursorSql}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<OfferRow>();
    return slicePage(res.results, page.limit);
  }

  findById(tenantId: TenantId, offerId: string): Promise<OfferRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM offers o WHERE o.organization_id = ? AND o.id = ?`,
      tenantId,
      offerId,
    ).first<OfferRow>();
  }

  /** Insert the offer plus its first transition and audit rows, atomically. */
  async insert(
    tenantId: TenantId,
    input: { id: string; advertiser_profile_id: string; status: OfferStatus } & OfferInput,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO offers (organization_id, id, advertiser_profile_id, status, access_mode, name, vertical, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tenantId,
          input.id,
          input.advertiser_profile_id,
          input.status,
          input.access_mode ?? "PUBLIC",
          input.name,
          input.vertical ?? null,
          input.description ?? null,
        ),
      ...extra,
    ]);
  }

  /**
   * Update identity fields only (never status, never versioned economics).
   * An UPDATE cannot put `organization_id = ?` before the SET binds, so this
   * statement is prepared directly — the WHERE clause still binds the branded
   * `TenantId` (never a client value), matching `advertisers`/`affiliates`.
   */
  async updateFields(tenantId: TenantId, offerId: string, patch: OfferPatch, extra: D1PreparedStatement[]): Promise<void> {
    const keys = (["name", "vertical", "description", "access_mode"] as const).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE offers
              SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
            WHERE organization_id = ? AND id = ?`,
        )
        .bind(...keys.map((k) => patch[k] ?? null), nowIso(), tenantId, offerId),
      ...extra,
    ]);
  }

  // ---- versions (immutable — INSERT only) ----------------------------------

  async listVersions(tenantId: TenantId, offerId: string): Promise<OfferVersionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${VERSION_COLUMNS} FROM offer_versions v
        WHERE v.organization_id = ? AND v.offer_id = ?
        ORDER BY v.version_number ASC`,
      tenantId,
      offerId,
    ).all<OfferVersionRow>();
    return res.results;
  }

  findVersion(tenantId: TenantId, versionId: string): Promise<OfferVersionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${VERSION_COLUMNS} FROM offer_versions v WHERE v.organization_id = ? AND v.id = ?`,
      tenantId,
      versionId,
    ).first<OfferVersionRow>();
  }

  /**
   * The offer's current version row, resolved through `current_version_id`.
   * Prepared directly: the subquery inside the predicate means
   * `organization_id = ?` is not the statement's first placeholder, so it
   * cannot go through `scopedQuery`. The branded `TenantId` is still bound.
   */
  currentVersion(tenantId: TenantId, offerId: string): Promise<OfferVersionRow | null> {
    return this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM offer_versions v
          WHERE v.organization_id = ?
            AND v.id = (SELECT current_version_id FROM offers WHERE organization_id = ? AND id = ?)`,
      )
      .bind(tenantId, tenantId, offerId)
      .first<OfferVersionRow>();
  }

  /**
   * Insert an immutable version, its targeting rows, and — when
   * `updateCurrentPointer` is set — move the offer's `current_version_id`
   * pointer to it: one atomic batch. `versionNumber` is computed by the
   * service from the offer's existing versions; the UNIQUE
   * (offer_id, version_number) constraint is the collision guard. The
   * pointer UPDATE is omitted for the version created together with the
   * offer row (`insert`), which does not exist inside the same batch.
   */
  async insertVersion(
    tenantId: TenantId,
    input: { id: string; offer_id: string; version_number: number; created_by_user_id: string | null } & OfferVersionInput,
    targeting: Array<{ id: string } & TargetingInput>,
    extra: D1PreparedStatement[],
    updateCurrentPointer = true,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO offer_versions
             (organization_id, id, offer_id, version_number, payout_type, currency, advertiser_payout_minor,
              affiliate_commission_minor, network_margin_minor, revshare_percent_bps, daily_conversion_cap,
              total_conversion_cap, budget_minor, attribution_window_seconds, conversion_event, destination_url,
              targeting_starts_at, targeting_ends_at, change_summary, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tenantId,
          input.id,
          input.offer_id,
          input.version_number,
          input.payout_type,
          input.currency,
          input.advertiser_payout_minor,
          input.affiliate_commission_minor,
          input.network_margin_minor ?? 0,
          input.revshare_percent_bps ?? null,
          input.daily_conversion_cap ?? null,
          input.total_conversion_cap ?? null,
          input.budget_minor ?? null,
          input.attribution_window_seconds ?? 2592000,
          input.conversion_event,
          input.destination_url ?? null,
          input.targeting_starts_at ?? null,
          input.targeting_ends_at ?? null,
          input.change_summary ?? null,
          input.created_by_user_id,
        ),
      ...targeting.map((t) =>
        this.db
          .prepare(
            `INSERT INTO offer_version_targeting (organization_id, id, offer_version_id, offer_id, dimension, value)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(tenantId, t.id, input.id, input.offer_id, t.dimension, t.value),
      ),
    ];
    if (updateCurrentPointer) {
      statements.push(
        this.db
          .prepare(`UPDATE offers SET current_version_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
          .bind(input.id, nowIso(), tenantId, input.offer_id),
      );
    }
    statements.push(...extra);
    await this.db.batch(statements);
  }

  async listTargeting(tenantId: TenantId, versionId: string): Promise<OfferTargetingRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM offer_version_targeting WHERE organization_id = ? AND offer_version_id = ? ORDER BY dimension ASC, value ASC`,
      tenantId,
      versionId,
    ).all<OfferTargetingRow>();
    return res.results;
  }

  // ---- lifecycle writes ----------------------------------------------------

  /**
   * Persist an accepted transition: UPDATE status (+ timestamps), INSERT the
   * append-only `offer_status_transitions` row, plus caller-supplied audit
   * statements — one atomic batch. Scoped by BOTH offer id and organization id
   * so a stale id can never touch another tenant's row.
   */
  async applyTransition(
    offer: { id: string; organization_id: string },
    input: {
      from: OfferStatus;
      to: OfferStatus;
      actor_user_id: string | null;
      actor_kind: ActorKind;
      reason: string | null;
      request_id: string | null;
      review_notes?: string | null;
    },
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const now = nowIso();
    const stamps: string[] = [];
    if (input.to === "SUBMITTED") stamps.push("submitted_at = ?");
    if (input.to === "APPROVED") stamps.push("approved_at = ?");
    if (input.to === "LIVE") stamps.push("activated_at = ?");
    if (input.to === "ARCHIVED") stamps.push("archived_at = ?");
    const stampBinds = stamps.map(() => now);
    const notesSql = input.review_notes === undefined ? "" : ", review_notes = ?";
    const notesBind = input.review_notes === undefined ? [] : [input.review_notes];

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE offers
              SET status = ?, updated_at = ?${stamps.length ? ", " + stamps.join(", ") : ""}${notesSql}
            WHERE id = ? AND organization_id = ? AND status = ?`,
        )
        .bind(input.to, now, ...stampBinds, ...notesBind, offer.id, offer.organization_id, input.from),
      this.db
        .prepare(
          `INSERT INTO offer_status_transitions
             (id, offer_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          offer.id,
          offer.organization_id,
          input.from,
          input.to,
          input.actor_user_id,
          input.actor_kind,
          input.reason,
          input.request_id,
        ),
      ...extra,
    ]);
  }

  /** Statement for the very first transition row, for batching with `insert`. */
  initialTransitionStatement(input: {
    offer_id: string;
    organization_id: string;
    to: OfferStatus;
    actor_user_id: string | null;
    actor_kind: ActorKind;
    request_id: string | null;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO offer_status_transitions
           (id, offer_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), input.offer_id, input.organization_id, input.to, input.actor_user_id, input.actor_kind, input.request_id);
  }

  async listTransitionsByTenant(tenantId: TenantId, offerId: string): Promise<OfferTransitionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM offer_status_transitions
        WHERE organization_id = ? AND offer_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      tenantId,
      offerId,
    ).all<OfferTransitionRow>();
    return res.results;
  }

  // ---- access grants (PRD §25, §92) — tenant path ---------------------------

  async listAccessGrants(tenantId: TenantId, offerId: string): Promise<AffiliateOfferAccessRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM affiliate_offer_access WHERE organization_id = ? AND offer_id = ? ORDER BY created_at DESC`,
      tenantId,
      offerId,
    ).all<AffiliateOfferAccessRow>();
    return res.results;
  }

  findAccessGrant(tenantId: TenantId, offerId: string, affiliateOrgId: string): Promise<AffiliateOfferAccessRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM affiliate_offer_access WHERE organization_id = ? AND offer_id = ? AND affiliate_organization_id = ?`,
      tenantId,
      offerId,
      affiliateOrgId,
    ).first<AffiliateOfferAccessRow>();
  }

  /** Insert or update the grant for (offer, affiliate org) — one row per pair. */
  async upsertAccessGrant(
    tenantId: TenantId,
    offerId: string,
    input: { id: string; affiliate_organization_id: string; status: AccessGrantStatus; reason: string | null; actor_user_id: string | null },
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const now = nowIso();
    const decided = input.status === "APPROVED" || input.status === "REJECTED" || input.status === "REVOKED";
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO affiliate_offer_access
             (organization_id, id, offer_id, affiliate_organization_id, status, reason, requested_at, decided_at, decided_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (offer_id, affiliate_organization_id) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             decided_at = excluded.decided_at,
             decided_by_user_id = excluded.decided_by_user_id,
             updated_at = ?
           WHERE affiliate_offer_access.organization_id = excluded.organization_id`,
        )
        .bind(
          tenantId,
          input.id,
          offerId,
          input.affiliate_organization_id,
          input.status,
          input.reason,
          now,
          decided ? now : null,
          decided ? input.actor_user_id : null,
          now,
        ),
      ...extra,
    ]);
  }

  // ---- platform path (offers.approve only) ---------------------------------

  findAnyById(offerId: string): Promise<OfferWithOrgRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS}
           FROM offers o JOIN organizations org ON org.id = o.organization_id
          WHERE o.id = ?`,
      )
      .bind(offerId)
      .first<OfferWithOrgRow>();
  }

  /** Cursor-paginated list across tenants, optional status filter (PRD §127). */
  async listAll(page: PageRequest, filter: { status?: OfferStatus }): Promise<Page<OfferWithOrgRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("o.status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(o.created_at < ? OR (o.created_at = ? AND o.id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS}
           FROM offers o JOIN organizations org ON org.id = o.organization_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ?`,
      )
      .bind(...binds, page.limit + 1)
      .all<OfferWithOrgRow>();
    return slicePage(res.results, page.limit);
  }

  async listTransitionsAny(offerId: string): Promise<OfferTransitionRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM offer_status_transitions WHERE offer_id = ? ORDER BY created_at ASC, rowid ASC`)
      .bind(offerId)
      .all<OfferTransitionRow>();
    return res.results;
  }

  findVersionAny(versionId: string): Promise<OfferVersionRow | null> {
    return this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM offer_versions v WHERE v.id = ?`)
      .bind(versionId)
      .first<OfferVersionRow>();
  }

  async listVersionsAny(offerId: string): Promise<OfferVersionRow[]> {
    const res = await this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM offer_versions v WHERE v.offer_id = ? ORDER BY v.version_number ASC`)
      .bind(offerId)
      .all<OfferVersionRow>();
    return res.results;
  }

  async listTargetingAny(versionId: string): Promise<OfferTargetingRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM offer_version_targeting WHERE offer_version_id = ? ORDER BY dimension ASC, value ASC`)
      .bind(versionId)
      .all<OfferTargetingRow>();
    return res.results;
  }

  // ---- marketplace (PRD §29) — cross-tenant, affiliate-facing --------------

  /**
   * Marketplace search. Runs across ALL tenants because the marketplace is
   * inherently cross-tenant; confidentiality is enforced by the WHERE clause
   * (only marketplace-visible statuses) plus the `visibility` parameter which
   * names the requesting affiliate organization. Row shaping (field
   * redaction) is the service's job.
   *
   * Visibility rule, per access mode (PRD §25):
   *   PUBLIC               → visible to everyone
   *   APPLICATION_REQUIRED → listed to everyone (confidential detail gated)
   *   INVITE_ONLY          → only when an INVITED/APPROVED grant exists
   *   PRIVATE              → only when an APPROVED grant exists
   *   AFFILIATE_SPECIFIC   → only when an APPROVED grant exists
   *
   * `affiliateOrganizationId` is the CALLER's affiliate organization id, taken
   * from the resolved tenant context — never from the client (PRD §94).
   */
  async searchMarketplace(
    page: PageRequest,
    filter: {
      affiliate_organization_id: string | null;
      vertical?: string;
      country?: string;
      payout_type?: PayoutType;
      device?: string;
      traffic_source?: string;
      access_mode?: AccessMode;
    },
  ): Promise<Page<OfferWithMarketplaceRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];

    // Only offers the marketplace may ever surface.
    where.push("o.status IN ('LIVE','PAUSED','CAP_REACHED','BUDGET_EXHAUSTED')");

    // Access-mode gate. A NULL affiliate org (an org with no affiliate profile)
    // still sees PUBLIC / APPLICATION_REQUIRED offers but never restricted ones.
    const affParam = filter.affiliate_organization_id;
    where.push(
      `(
         o.access_mode IN ('PUBLIC','APPLICATION_REQUIRED')
         OR EXISTS (
              SELECT 1 FROM affiliate_offer_access g
               WHERE g.offer_id = o.id
                 AND g.affiliate_organization_id = ?
                 AND (
                      (o.access_mode = 'INVITE_ONLY' AND g.status IN ('INVITED','APPROVED'))
                   OR (o.access_mode IN ('PRIVATE','AFFILIATE_SPECIFIC') AND g.status = 'APPROVED')
                 )
            )
       )`,
    );
    binds.push(affParam);

    // Filters run against the CURRENT immutable version's economics/targeting.
    const versionFilter: string[] = [];
    const versionBinds: unknown[] = [];
    if (filter.payout_type) {
      versionFilter.push("cv.payout_type = ?");
      versionBinds.push(filter.payout_type);
    }
    if (filter.vertical) {
      where.push("o.vertical = ?");
      binds.push(filter.vertical);
    }
    if (filter.access_mode) {
      where.push("o.access_mode = ?");
      binds.push(filter.access_mode);
    }
    for (const [dimension, value] of [
      ["COUNTRY", filter.country],
      ["DEVICE", filter.device],
      ["TRAFFIC_SOURCE", filter.traffic_source],
    ] as const) {
      if (!value) continue;
      versionFilter.push(
        `(NOT EXISTS (SELECT 1 FROM offer_version_targeting t0 WHERE t0.offer_version_id = cv.id AND t0.dimension = ?)
          OR EXISTS (SELECT 1 FROM offer_version_targeting t1 WHERE t1.offer_version_id = cv.id AND t1.dimension = ? AND t1.value = ?))`,
      );
      versionBinds.push(dimension, dimension, value);
    }

    if (page.cursor) {
      where.push("(o.created_at < ? OR (o.created_at = ? AND o.id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }

    const res = await this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS},
                cv.id AS version_id, cv.version_number, cv.payout_type, cv.currency,
                cv.affiliate_commission_minor, cv.revshare_percent_bps,
                cv.daily_conversion_cap, cv.total_conversion_cap,
                cv.attribution_window_seconds, cv.conversion_event, cv.destination_url,
                cv.targeting_starts_at, cv.targeting_ends_at
           FROM offers o
           JOIN organizations org ON org.id = o.organization_id
           JOIN offer_versions cv ON cv.id = o.current_version_id
          WHERE ${where.join(" AND ")}${versionFilter.length ? " AND " + versionFilter.join(" AND ") : ""}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ?`,
      )
      .bind(...binds, ...versionBinds, page.limit + 1)
      .all<OfferWithMarketplaceRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * Marketplace detail lookup for ONE offer, enforcing the same visibility
   * rule as `searchMarketplace` so a direct id can never bypass it (PRD §99
   * IDOR, §116). Returns null for a hidden/absent offer — the route maps null
   * to 404 so the existence of a private offer is not disclosed.
   */
  findMarketplaceOffer(offerId: string, affiliateOrganizationId: string | null): Promise<OfferWithMarketplaceRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS},
                cv.id AS version_id, cv.version_number, cv.payout_type, cv.currency,
                cv.affiliate_commission_minor, cv.revshare_percent_bps,
                cv.daily_conversion_cap, cv.total_conversion_cap,
                cv.attribution_window_seconds, cv.conversion_event, cv.destination_url,
                cv.targeting_starts_at, cv.targeting_ends_at
           FROM offers o
           JOIN organizations org ON org.id = o.organization_id
           JOIN offer_versions cv ON cv.id = o.current_version_id
          WHERE o.id = ?
            AND o.status IN ('LIVE','PAUSED','CAP_REACHED','BUDGET_EXHAUSTED')
            AND (
                 o.access_mode IN ('PUBLIC','APPLICATION_REQUIRED')
                 OR EXISTS (
                      SELECT 1 FROM affiliate_offer_access g
                       WHERE g.offer_id = o.id
                         AND g.affiliate_organization_id = ?
                         AND (
                              (o.access_mode = 'INVITE_ONLY' AND g.status IN ('INVITED','APPROVED'))
                           OR (o.access_mode IN ('PRIVATE','AFFILIATE_SPECIFIC') AND g.status = 'APPROVED')
                         )
                    )
                )`,
      )
      .bind(offerId, affiliateOrganizationId)
      .first<OfferWithMarketplaceRow>();
  }

  /** The caller's own grant row for an offer, if any (drives the detail view state). */
  findMyAccessGrant(offerId: string, affiliateOrganizationId: string): Promise<AffiliateOfferAccessRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM affiliate_offer_access WHERE offer_id = ? AND affiliate_organization_id = ?`,
      )
      .bind(offerId, affiliateOrganizationId)
      .first<AffiliateOfferAccessRow>();
  }

  /**
   * Affiliate-side access application (PRD §92). Creates or refreshes the
   * REQUESTED grant that links the CALLING affiliate organization to a
   * restricted offer it wishes to promote. Unlike `upsertAccessGrant` (the
   * advertiser/owner path), the row's `organization_id` is the OFFER OWNER's
   * org — passed in from the marketplace lookup, never from the client — while
   * `affiliate_organization_id` is the caller. A re-application after a
   * REJECTED/REVOKED decision moves the row back to REQUESTED and clears the
   * prior decision so the advertiser sees a fresh request. An already-APPROVED
   * grant is left untouched by the `WHERE` guard.
   */
  async requestAccess(
    input: { id: string; offer_id: string; owner_organization_id: string; affiliate_organization_id: string },
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO affiliate_offer_access
             (id, offer_id, organization_id, affiliate_organization_id, status, reason, requested_at)
           VALUES (?, ?, ?, ?, 'REQUESTED', NULL, ?)
           ON CONFLICT (offer_id, affiliate_organization_id) DO UPDATE SET
             status = 'REQUESTED',
             reason = NULL,
             requested_at = ?,
             decided_at = NULL,
             decided_by_user_id = NULL,
             updated_at = ?
           WHERE affiliate_offer_access.status IN ('REJECTED','REVOKED')`,
        )
        .bind(input.id, input.offer_id, input.owner_organization_id, input.affiliate_organization_id, now, now, now),
      ...extra,
    ]);
  }

  /**
   * Minimal cross-tenant organization lookup used only to validate the target
   * of an advertiser-issued access grant (the affiliate org must exist, be
   * ACTIVE and be an AFFILIATE/PARTNER). Reads identity columns only — never
   * anything tenant-confidential.
   */
  findOrganization(orgId: string): Promise<{ id: string; type: string; status: string } | null> {
    return this.db
      .prepare(`SELECT id, type, status FROM organizations WHERE id = ?`)
      .bind(orgId)
      .first<{ id: string; type: string; status: string }>();
  }
}

/** Marketplace projection: the current version's affiliate-safe columns. */
export interface OfferWithMarketplaceRow extends OfferWithOrgRow {
  version_id: string;
  version_number: number;
  payout_type: PayoutType;
  currency: string;
  affiliate_commission_minor: number;
  revshare_percent_bps: number | null;
  daily_conversion_cap: number | null;
  total_conversion_cap: number | null;
  attribution_window_seconds: number;
  conversion_event: string;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
}
