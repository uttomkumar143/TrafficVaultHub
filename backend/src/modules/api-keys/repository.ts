/**
 * API-key persistence over D1 (migration 0012 `api_keys`; PRD §73, §115,
 * §116). Pure data access — the state-machine policy (what may rotate, what
 * may be revoked) lives in `service.ts`; the triggers in 0012 are the last
 * line of defence, never the first.
 *
 * Security invariants enforced HERE, at the SQL level:
 *   * `key_hash` is selected by exactly ONE method — `findActiveByHash` —
 *     and only to compare against the SHA-256 of a presented secret. No list
 *     / get projection includes it (`PUBLIC_COLUMNS`), so a leak would have
 *     to be written on purpose.
 *   * Every tenant READ goes through `scopedQuery`, binding the caller's
 *     resolved `TenantId` as the first parameter (`organization_id = ?`).
 *     Writes (INSERT / UPDATE … SET … WHERE organization_id = ?) cannot put
 *     that predicate first, so — exactly like `attribution-repository.ts` —
 *     they bind the `TenantId` explicitly at the `organization_id` position
 *     and are guarded by the `TenantId` brand at the type level.
 *   * Rows are never deleted (trigger `trg_api_keys_no_delete`); revoke /
 *     rotate / expire are status updates.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";

export const API_KEY_STATUSES = ["ACTIVE", "ROTATED", "REVOKED", "EXPIRED"] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Projection shared by every read path. `key_hash` is deliberately absent. */
export interface ApiKeyRow {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  name: string;
  key_prefix: string;
  secret_hint: string;
  /** JSON array text as stored. */
  scopes: string;
  status: ApiKeyStatus;
  expires_at: string | null;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
  rotated_to_key_id: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyInsert {
  id: string;
  created_by_user_id: string | null;
  name: string;
  key_prefix: string;
  /** Hex SHA-256 of the full secret (64 chars). */
  key_hash: string;
  secret_hint: string;
  /** JSON array text. */
  scopes: string;
  expires_at: string | null;
  rotated_from_key_id: string | null;
}

const PUBLIC_COLUMNS = [
  "id",
  "organization_id",
  "created_by_user_id",
  "name",
  "key_prefix",
  "secret_hint",
  "scopes",
  "status",
  "expires_at",
  "last_used_at",
  "rotated_from_key_id",
  "rotated_to_key_id",
  "revoked_at",
  "revoked_by_user_id",
  "created_at",
  "updated_at",
].join(", ");

export class ApiKeyRepository {
  constructor(private readonly db: D1Database) {}

  /** INSERT statement (for batching with the audit row). */
  insertStatement(tenantId: TenantId, input: ApiKeyInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO api_keys
           (organization_id, id, created_by_user_id, name, key_prefix, key_hash, secret_hint, scopes, status, expires_at, rotated_from_key_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .bind(
        tenantId,
        input.id,
        input.created_by_user_id,
        input.name,
        input.key_prefix,
        input.key_hash,
        input.secret_hint,
        input.scopes,
        input.expires_at,
        input.rotated_from_key_id,
      );
  }

  async insert(tenantId: TenantId, input: ApiKeyInsert, extra: D1PreparedStatement[] = []): Promise<void> {
    await this.db.batch([this.insertStatement(tenantId, input), ...extra]);
  }

  findById(tenantId: TenantId, id: string): Promise<ApiKeyRow | null> {
    return scopedQuery(this.db, `SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE organization_id = ? AND id = ?`, tenantId, id).first<ApiKeyRow>();
  }

  /** Cursor-paginated, optional status filter (PRD §127). Never full-table. */
  async list(tenantId: TenantId, page: PageRequest, filter: { status?: ApiKeyStatus } = {}): Promise<Page<ApiKeyRow>> {
    const where = ["organization_id = ?"];
    const binds: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT ${PUBLIC_COLUMNS} FROM api_keys
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ApiKeyRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * ACTIVE → ROTATED: links the old row to its successor and caps the old
   * row's `expires_at` at `graceUntil` (an earlier existing expiry wins). The
   * successor INSERT is passed in so both land in one batch (plus the audit
   * row). The WHERE guard re-checks ACTIVE so a concurrent revoke cannot be
   * undone; `changes` tells the service whether the transition happened.
   */
  async rotate(
    tenantId: TenantId,
    oldId: string,
    successor: ApiKeyInsert,
    now: string,
    graceUntil: string,
    extra: D1PreparedStatement[] = [],
  ): Promise<boolean> {
    const results = await this.db.batch([
      this.insertStatement(tenantId, successor),
      this.db
        .prepare(
          `UPDATE api_keys
              SET status = 'ROTATED', rotated_to_key_id = ?, updated_at = ?,
                  expires_at = CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN expires_at ELSE ? END
            WHERE organization_id = ? AND id = ? AND status = 'ACTIVE'`,
        )
        .bind(successor.id, now, graceUntil, graceUntil, tenantId, oldId),
      ...extra,
    ]);
    return (results[1]?.meta?.changes ?? 0) > 0;
  }

  /**
   * ACTIVE|ROTATED → REVOKED (terminal). Returns false when no row was eligible.
   *
   * 0012 CHECK `(status = 'ROTATED') = (rotated_to_key_id IS NOT NULL)`: a
   * ROTATED row may only leave ROTATED if its forward link is cleared in the
   * same statement. The chain is not lost — the successor's
   * `rotated_from_key_id` is frozen by `trg_api_keys_frozen` and still points
   * back at this row. Same rule in `expire` / `expireById`.
   */
  async revoke(tenantId: TenantId, id: string, revokedByUserId: string | null, now: string, extra: D1PreparedStatement[] = []): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE api_keys SET status = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, rotated_to_key_id = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('ACTIVE','ROTATED')`,
        )
        .bind(now, revokedByUserId, now, tenantId, id),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /**
   * ACTIVE|ROTATED → EXPIRED once `expires_at` has passed. Read-time expiry:
   * the service calls this when it observes a stale `expires_at`, so the
   * stored status converges without a scheduler (none is supported by the
   * schema or the hosted runtime).
   */
  async expire(tenantId: TenantId, id: string, now: string, extra: D1PreparedStatement[] = []): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE api_keys SET status = 'EXPIRED', rotated_to_key_id = NULL, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('ACTIVE','ROTATED')
              AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .bind(now, tenantId, id, now),
      ...extra,
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  // ---- authentication path (no tenant yet — the key IS the tenant claim) --

  /**
   * The ONLY statement that reads `key_hash`, and it reads it only as a WHERE
   * predicate: the row returned still carries the public projection. Used by
   * `ApiKeyService.authenticate` after hashing the presented secret. Status
   * and expiry are re-checked by the caller.
   */
  findByHash(keyHash: string): Promise<ApiKeyRow | null> {
    return this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE key_hash = ?`).bind(keyHash).first<ApiKeyRow>();
  }

  /**
   * Tenant-less expiry used by `authenticate` (the key row itself names the
   * organization; there is no caller tenant). Same guard as `expire`.
   */
  async expireById(id: string, now: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE api_keys SET status = 'EXPIRED', rotated_to_key_id = NULL, updated_at = ?
          WHERE id = ? AND status IN ('ACTIVE','ROTATED') AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .bind(now, id, now)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Best-effort `last_used_at` touch — never on a terminal row (trigger would abort). */
  async touchLastUsed(id: string, now: string): Promise<void> {
    await this.db
      .prepare(`UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ? AND status IN ('ACTIVE','ROTATED')`)
      .bind(now, now, id)
      .run();
  }
}
