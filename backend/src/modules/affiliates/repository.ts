/**
 * Affiliate persistence over D1 (migration 0006; PRD §19, §20, §21, §27, §92,
 * §94). Pure data access — lifecycle policy lives in `state-machine.ts` /
 * `service.ts`. Mirrors `modules/advertisers/repository.ts`.
 *
 * Two access paths, deliberately separate:
 *   * Tenant path — takes a `TenantId` (only obtainable from the caller's
 *     resolved membership) and runs through `scopedQuery`, so every statement
 *     is provably bound to `organization_id = ?` first.
 *   * Platform path — `*Any*` methods used ONLY by the review service behind
 *     `affiliates.review` (a platform permission). They address profiles by
 *     id across tenants; the service never exposes them to tenant routes.
 *
 * Traffic-source declarations (PRD §27) are tenant-owned rows keyed by
 * (profile, source_type); they are part of the application the reviewer sees.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { nowIso } from "../../lib/time";
import type { AcquisitionChannel, ActorKind, AffiliateStatus, TrafficSourceType } from "./state-machine";

export interface AffiliateProfileRow {
  id: string;
  organization_id: string;
  status: AffiliateStatus;
  display_name: string;
  legal_name: string | null;
  website_url: string | null;
  app_url: string | null;
  promotional_methods: string | null;
  audience_description: string | null;
  monthly_traffic_estimate: number | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  messaging_handle: string | null;
  acquisition_channel: AcquisitionChannel;
  referral_code: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row joined with the owning organization's display fields (platform lists). */
export interface AffiliateProfileWithOrgRow extends AffiliateProfileRow {
  organization_name: string;
  organization_slug: string;
  organization_type: string;
}

export interface AffiliateTransitionRow {
  id: string;
  affiliate_profile_id: string;
  organization_id: string;
  from_status: AffiliateStatus | null;
  to_status: AffiliateStatus;
  actor_user_id: string | null;
  actor_kind: ActorKind;
  reason: string | null;
  request_id: string | null;
  created_at: string;
}

export interface AffiliateTrafficSourceRow {
  id: string;
  affiliate_profile_id: string;
  organization_id: string;
  source_type: TrafficSourceType;
  description: string | null;
  url: string | null;
  estimated_monthly_volume: number | null;
  created_at: string;
  updated_at: string;
}

/** Text application fields a tenant may write (PRD §21). `display_name` is required at create. */
export const AFFILIATE_TEXT_FIELDS = [
  "display_name",
  "legal_name",
  "website_url",
  "app_url",
  "promotional_methods",
  "audience_description",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country_code",
  "contact_name",
  "contact_email",
  "contact_phone",
  "messaging_handle",
  "referral_code",
] as const;
export type AffiliateTextField = (typeof AFFILIATE_TEXT_FIELDS)[number];

/** All writable application fields (text + the integer estimate + the §20 channel). */
export const AFFILIATE_PROFILE_FIELDS = [...AFFILIATE_TEXT_FIELDS, "monthly_traffic_estimate", "acquisition_channel"] as const;
export type AffiliateProfileField = (typeof AFFILIATE_PROFILE_FIELDS)[number];

export type AffiliateProfilePatch = Partial<Record<AffiliateTextField, string | null>> & {
  monthly_traffic_estimate?: number | null;
  acquisition_channel?: AcquisitionChannel;
};
export type AffiliateProfileInput = { display_name: string } & AffiliateProfilePatch;

export interface TrafficSourceInput {
  source_type: TrafficSourceType;
  description?: string | null;
  url?: string | null;
  estimated_monthly_volume?: number | null;
}

const COLUMNS = `p.id, p.organization_id, p.status, p.display_name, p.legal_name, p.website_url, p.app_url,
  p.promotional_methods, p.audience_description, p.monthly_traffic_estimate, p.address_line1, p.address_line2,
  p.city, p.region, p.postal_code, p.country_code, p.contact_name, p.contact_email, p.contact_phone,
  p.messaging_handle, p.acquisition_channel, p.referral_code, p.review_notes, p.submitted_at, p.approved_at,
  p.activated_at, p.archived_at, p.created_at, p.updated_at`;
const ORG_COLUMNS = `o.name AS organization_name, o.slug AS organization_slug, o.type AS organization_type`;

export class AffiliateRepository {
  constructor(private readonly db: D1Database) {}

  // ---- tenant path (TenantId + scopedQuery) --------------------------------

  findByTenant(tenantId: TenantId): Promise<AffiliateProfileRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM affiliate_profiles p WHERE p.organization_id = ?`,
      tenantId,
    ).first<AffiliateProfileRow>();
  }

  /** Insert the profile plus its first transition (NULL → status) and audit rows, atomically. */
  async insert(
    tenantId: TenantId,
    input: { id: string; status: AffiliateStatus } & AffiliateProfileInput,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const values = AFFILIATE_PROFILE_FIELDS.map((f) => {
      if (f === "display_name") return input.display_name;
      if (f === "acquisition_channel") return input.acquisition_channel ?? "DIRECT";
      return input[f] ?? null;
    });
    // INSERTs have no WHERE predicate for scopedQuery to check; the branded
    // TenantId is bound as the owner column directly.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO affiliate_profiles (organization_id, id, status, ${AFFILIATE_PROFILE_FIELDS.join(", ")})
           VALUES (?, ?, ?, ${AFFILIATE_PROFILE_FIELDS.map(() => "?").join(", ")})`,
        )
        .bind(tenantId, input.id, input.status, ...values),
      ...extra,
    ]);
  }

  /**
   * Update the supplied application fields only (partial); never touches
   * `status`. WHERE binds the branded `TenantId` (never a client value).
   */
  async updateFields(tenantId: TenantId, patch: AffiliateProfilePatch, extra: D1PreparedStatement[]): Promise<void> {
    const keys = AFFILIATE_PROFILE_FIELDS.filter((f) => patch[f] !== undefined);
    if (keys.length === 0) return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE affiliate_profiles
              SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
            WHERE organization_id = ? AND status <> 'TERMINATED'`,
        )
        .bind(...keys.map((k) => patch[k] ?? null), nowIso(), tenantId),
      ...extra,
    ]);
  }

  // ---- traffic sources (PRD §27) — tenant path ------------------------------

  async listTrafficSources(tenantId: TenantId): Promise<AffiliateTrafficSourceRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM affiliate_traffic_sources WHERE organization_id = ? ORDER BY source_type ASC`,
      tenantId,
    ).all<AffiliateTrafficSourceRow>();
    return res.results;
  }

  findTrafficSource(tenantId: TenantId, sourceType: TrafficSourceType): Promise<AffiliateTrafficSourceRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM affiliate_traffic_sources WHERE organization_id = ? AND source_type = ?`,
      tenantId,
      sourceType,
    ).first<AffiliateTrafficSourceRow>();
  }

  /** Insert or update the declaration for (profile, source_type) — one row per type. */
  async upsertTrafficSource(
    tenantId: TenantId,
    profileId: string,
    input: { id: string } & TrafficSourceInput,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO affiliate_traffic_sources
             (organization_id, id, affiliate_profile_id, source_type, description, url, estimated_monthly_volume)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (affiliate_profile_id, source_type) DO UPDATE SET
             description = excluded.description,
             url = excluded.url,
             estimated_monthly_volume = excluded.estimated_monthly_volume,
             updated_at = ?
           WHERE affiliate_traffic_sources.organization_id = excluded.organization_id`,
        )
        .bind(
          tenantId,
          input.id,
          profileId,
          input.source_type,
          input.description ?? null,
          input.url ?? null,
          input.estimated_monthly_volume ?? null,
          nowIso(),
        ),
      ...extra,
    ]);
  }

  /** Physical delete of a declaration (not a business record — the audit log keeps history). */
  async deleteTrafficSource(tenantId: TenantId, sourceType: TrafficSourceType, extra: D1PreparedStatement[]): Promise<void> {
    await this.db.batch([
      scopedQuery(
        this.db,
        `DELETE FROM affiliate_traffic_sources WHERE organization_id = ? AND source_type = ?`,
        tenantId,
        sourceType,
      ),
      ...extra,
    ]);
  }

  // ---- shared: lifecycle writes (used by both paths through the service) ---

  /**
   * Persist an accepted transition: UPDATE status (+ timestamps), INSERT the
   * append-only `affiliate_status_transitions` row, plus caller-supplied
   * audit statements — one atomic batch. Scoped by BOTH profile id and
   * organization id so a stale id can never touch another tenant's row.
   */
  async applyTransition(
    profile: { id: string; organization_id: string },
    input: {
      from: AffiliateStatus;
      to: AffiliateStatus;
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
    if (input.to === "UNDER_REVIEW") stamps.push("submitted_at = ?");
    if (input.to === "APPROVED") stamps.push("approved_at = ?");
    if (input.to === "ACTIVE") stamps.push("activated_at = ?");
    if (input.to === "TERMINATED") stamps.push("archived_at = ?");
    const stampBinds = stamps.map(() => now);
    const notesSql = input.review_notes === undefined ? "" : ", review_notes = ?";
    const notesBind = input.review_notes === undefined ? [] : [input.review_notes];

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE affiliate_profiles
              SET status = ?, updated_at = ?${stamps.length ? ", " + stamps.join(", ") : ""}${notesSql}
            WHERE id = ? AND organization_id = ? AND status = ?`,
        )
        .bind(input.to, now, ...stampBinds, ...notesBind, profile.id, profile.organization_id, input.from),
      this.db
        .prepare(
          `INSERT INTO affiliate_status_transitions
             (id, affiliate_profile_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          profile.id,
          profile.organization_id,
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

  /** Statement for the very first transition row (NULL → initial), for batching with `insert`. */
  initialTransitionStatement(input: {
    profile_id: string;
    organization_id: string;
    to: AffiliateStatus;
    actor_user_id: string | null;
    actor_kind: ActorKind;
    request_id: string | null;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO affiliate_status_transitions
           (id, affiliate_profile_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), input.profile_id, input.organization_id, input.to, input.actor_user_id, input.actor_kind, input.request_id);
  }

  /** Transition history for one profile, oldest first. Tenant path. */
  async listTransitionsByTenant(tenantId: TenantId): Promise<AffiliateTransitionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM affiliate_status_transitions WHERE organization_id = ? ORDER BY created_at ASC, rowid ASC`,
      tenantId,
    ).all<AffiliateTransitionRow>();
    return res.results;
  }

  // ---- platform path (affiliates.review only) -------------------------------

  findAnyById(profileId: string): Promise<AffiliateProfileWithOrgRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS}
           FROM affiliate_profiles p JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ?`,
      )
      .bind(profileId)
      .first<AffiliateProfileWithOrgRow>();
  }

  /** Cursor-paginated list across tenants, optional status filter (PRD §127). */
  async listAll(page: PageRequest, filter: { status?: AffiliateStatus }): Promise<Page<AffiliateProfileWithOrgRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("p.status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS}
           FROM affiliate_profiles p JOIN organizations o ON o.id = p.organization_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT ?`,
      )
      .bind(...binds, page.limit + 1)
      .all<AffiliateProfileWithOrgRow>();
    return slicePage(res.results, page.limit);
  }

  async listTransitionsAny(profileId: string): Promise<AffiliateTransitionRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM affiliate_status_transitions WHERE affiliate_profile_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .bind(profileId)
      .all<AffiliateTransitionRow>();
    return res.results;
  }

  /** Declared traffic sources of any profile (reviewer's view of the application, PRD §21). */
  async listTrafficSourcesAny(profileId: string): Promise<AffiliateTrafficSourceRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM affiliate_traffic_sources WHERE affiliate_profile_id = ? ORDER BY source_type ASC`)
      .bind(profileId)
      .all<AffiliateTrafficSourceRow>();
    return res.results;
  }
}
