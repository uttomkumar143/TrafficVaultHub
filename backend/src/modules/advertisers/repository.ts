/**
 * Advertiser persistence over D1 (migration 0005; PRD §16, §17, §92, §94).
 * Pure data access — lifecycle policy lives in `state-machine.ts` / `service.ts`.
 *
 * Two access paths, deliberately separate:
 *   * Tenant path — takes a `TenantId` (only obtainable from the caller's
 *     resolved membership) and runs through `scopedQuery`, so every statement
 *     is provably bound to `organization_id = ?` first.
 *   * Platform path — `*Any*` methods used ONLY by the review service behind
 *     `advertisers.review` (a platform permission). They address profiles by
 *     id across tenants; the service never exposes them to tenant routes.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { nowIso } from "../../lib/time";
import type { ActorKind, AdvertiserStatus } from "./state-machine";

export interface AdvertiserProfileRow {
  id: string;
  organization_id: string;
  status: AdvertiserStatus;
  company_name: string;
  website_url: string | null;
  business_category: string | null;
  legal_name: string | null;
  registration_number: string | null;
  tax_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_contact_email: string | null;
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row joined with the owning organization's display fields (platform lists). */
export interface AdvertiserProfileWithOrgRow extends AdvertiserProfileRow {
  organization_name: string;
  organization_slug: string;
  organization_type: string;
}

export interface AdvertiserTransitionRow {
  id: string;
  advertiser_profile_id: string;
  organization_id: string;
  from_status: AdvertiserStatus | null;
  to_status: AdvertiserStatus;
  actor_user_id: string | null;
  actor_kind: ActorKind;
  reason: string | null;
  request_id: string | null;
  created_at: string;
}

/** Onboarding fields a tenant may write (PRD §17). `company_name` is required at create. */
export const ADVERTISER_PROFILE_FIELDS = [
  "company_name",
  "website_url",
  "business_category",
  "legal_name",
  "registration_number",
  "tax_id",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country_code",
  "contact_name",
  "contact_email",
  "contact_phone",
  "billing_contact_email",
] as const;
export type AdvertiserProfileField = (typeof ADVERTISER_PROFILE_FIELDS)[number];
export type AdvertiserProfileInput = { company_name: string } & Partial<Record<AdvertiserProfileField, string | null>>;

const COLUMNS = `p.id, p.organization_id, p.status, p.company_name, p.website_url, p.business_category,
  p.legal_name, p.registration_number, p.tax_id, p.address_line1, p.address_line2, p.city, p.region,
  p.postal_code, p.country_code, p.contact_name, p.contact_email, p.contact_phone, p.billing_contact_email,
  p.review_notes, p.submitted_at, p.approved_at, p.activated_at, p.archived_at, p.created_at, p.updated_at`;
const ORG_COLUMNS = `o.name AS organization_name, o.slug AS organization_slug, o.type AS organization_type`;

export class AdvertiserRepository {
  constructor(private readonly db: D1Database) {}

  // ---- tenant path (TenantId + scopedQuery) --------------------------------

  findByTenant(tenantId: TenantId): Promise<AdvertiserProfileRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${COLUMNS} FROM advertiser_profiles p WHERE p.organization_id = ?`,
      tenantId,
    ).first<AdvertiserProfileRow>();
  }

  /** Insert the profile plus its first transition (NULL → status) and audit rows, atomically. */
  async insert(
    tenantId: TenantId,
    input: { id: string; status: AdvertiserStatus } & AdvertiserProfileInput,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const values = ADVERTISER_PROFILE_FIELDS.map((f) => (f === "company_name" ? input.company_name : input[f] ?? null));
    // INSERTs have no WHERE predicate for scopedQuery to check; the branded
    // TenantId is bound as the owner column directly.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO advertiser_profiles (organization_id, id, status, ${ADVERTISER_PROFILE_FIELDS.join(", ")})
           VALUES (?, ?, ?, ${ADVERTISER_PROFILE_FIELDS.map(() => "?").join(", ")})`,
        )
        .bind(tenantId, input.id, input.status, ...values),
      ...extra,
    ]);
  }

  /**
   * Update the supplied onboarding fields only (partial); never touches
   * `status`. An UPDATE cannot put `organization_id = ?` before the SET binds,
   * so this statement is prepared directly — the WHERE clause still binds the
   * branded `TenantId` (never a client value) and is covered by the
   * tenant-isolation suite.
   */
  async updateFields(
    tenantId: TenantId,
    patch: Partial<Record<AdvertiserProfileField, string | null>>,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    const keys = ADVERTISER_PROFILE_FIELDS.filter((f) => patch[f] !== undefined);
    if (keys.length === 0) return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE advertiser_profiles
              SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
            WHERE organization_id = ? AND status <> 'TERMINATED'`,
        )
        .bind(...keys.map((k) => patch[k] ?? null), nowIso(), tenantId),
      ...extra,
    ]);
  }

  // ---- shared: lifecycle writes (used by both paths through the service) ---

  /**
   * Persist an accepted transition: UPDATE status (+ timestamps), INSERT the
   * append-only `advertiser_status_transitions` row, plus caller-supplied
   * audit statements — one atomic batch. Scoped by BOTH profile id and
   * organization id so a stale id can never touch another tenant's row.
   */
  async applyTransition(
    profile: { id: string; organization_id: string },
    input: {
      from: AdvertiserStatus;
      to: AdvertiserStatus;
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
    if (input.to === "BUSINESS_REVIEW") stamps.push("submitted_at = ?");
    if (input.to === "APPROVED") stamps.push("approved_at = ?");
    if (input.to === "ACTIVE") stamps.push("activated_at = ?");
    if (input.to === "TERMINATED") stamps.push("archived_at = ?");
    const stampBinds = stamps.map(() => now);
    const notesSql = input.review_notes === undefined ? "" : ", review_notes = ?";
    const notesBind = input.review_notes === undefined ? [] : [input.review_notes];

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE advertiser_profiles
              SET status = ?, updated_at = ?${stamps.length ? ", " + stamps.join(", ") : ""}${notesSql}
            WHERE id = ? AND organization_id = ? AND status = ?`,
        )
        .bind(input.to, now, ...stampBinds, ...notesBind, profile.id, profile.organization_id, input.from),
      this.db
        .prepare(
          `INSERT INTO advertiser_status_transitions
             (id, advertiser_profile_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
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
    to: AdvertiserStatus;
    actor_user_id: string | null;
    actor_kind: ActorKind;
    request_id: string | null;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO advertiser_status_transitions
           (id, advertiser_profile_id, organization_id, from_status, to_status, actor_user_id, actor_kind, reason, request_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
      )
      .bind(crypto.randomUUID(), input.profile_id, input.organization_id, input.to, input.actor_user_id, input.actor_kind, input.request_id);
  }

  /** Transition history for one profile, oldest first. Tenant path. */
  async listTransitionsByTenant(tenantId: TenantId): Promise<AdvertiserTransitionRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM advertiser_status_transitions WHERE organization_id = ? ORDER BY created_at ASC, rowid ASC`,
      tenantId,
    ).all<AdvertiserTransitionRow>();
    return res.results;
  }

  // ---- platform path (advertisers.review only) ------------------------------

  findAnyById(profileId: string): Promise<AdvertiserProfileWithOrgRow | null> {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, ${ORG_COLUMNS}
           FROM advertiser_profiles p JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ?`,
      )
      .bind(profileId)
      .first<AdvertiserProfileWithOrgRow>();
  }

  /** Cursor-paginated list across tenants, optional status filter (PRD §127). */
  async listAll(page: PageRequest, filter: { status?: AdvertiserStatus }): Promise<Page<AdvertiserProfileWithOrgRow>> {
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
           FROM advertiser_profiles p JOIN organizations o ON o.id = p.organization_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT ?`,
      )
      .bind(...binds, page.limit + 1)
      .all<AdvertiserProfileWithOrgRow>();
    return slicePage(res.results, page.limit);
  }

  async listTransitionsAny(profileId: string): Promise<AdvertiserTransitionRow[]> {
    const res = await this.db
      .prepare(
        `SELECT * FROM advertiser_status_transitions WHERE advertiser_profile_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .bind(profileId)
      .all<AdvertiserTransitionRow>();
    return res.results;
  }
}
