/**
 * Tenant-scoping helper (Phase 1 Unit 5; PRD §7, §94, §116).
 *
 * Every query that touches an `organization_id`-owned resource MUST bind the
 * organization id derived from the authenticated caller's membership
 * (`TenantContext.organization.id`, resolved by `requireOrg`) — never a value
 * taken from the request body, query string or headers.
 *
 * This module makes forgetting that rule a programming error instead of a
 * data leak:
 *
 *   * `TenantId` is a branded string. The only sanctioned way to obtain one is
 *     `tenantIdOf(tenant)`; repositories accept `TenantId`, so a raw string
 *     (e.g. from `c.req.json()`) fails typecheck.
 *   * `scopedQuery(db, sql, tenantId, ...params)` refuses (throws) SQL that has
 *     no `organization_id = ?` predicate, and binds the tenant id as the FIRST
 *     parameter so the predicate must come first in the statement — a
 *     consistent, reviewable pattern:
 *
 *       scopedQuery(db, `SELECT … FROM offers WHERE organization_id = ? AND id = ?`, tid, offerId).first()
 *
 * The check is intentionally a conservative textual one (it cannot prove SQL
 * semantics); it catches the common omission. Reviews and the cross-tenant
 * tests in `routes/tenant-isolation.test.ts` remain the authority.
 *
 * No business tables exist yet (Phase 2 introduces offers, profiles, …); this
 * helper is the contract they must adopt.
 */
import type { TenantContext } from "../middleware/require-org";

declare const tenantIdBrand: unique symbol;
/** An organization id that provably came from the caller's resolved membership. */
export type TenantId = string & { readonly [tenantIdBrand]: true };

/** The only constructor for `TenantId`. */
export function tenantIdOf(tenant: TenantContext): TenantId {
  return tenant.organization.id as TenantId;
}

export class UnscopedQueryError extends Error {
  constructor(sql: string) {
    super(`Refusing to run tenant query without an organization_id predicate: ${summarize(sql)}`);
    this.name = "UnscopedQueryError";
  }
}

/**
 * Matches `organization_id = ?` (optionally table-qualified, any whitespace,
 * any case). The predicate must be the FIRST bind placeholder in the SQL so
 * that the tenant id bound at position 1 lands on it.
 */
const SCOPE_PREDICATE = /\b(?:[a-z_][a-z0-9_]*\.)?organization_id\s*=\s*\?/i;

/** Throws `UnscopedQueryError` unless `sql` is scoped by `organization_id = ?` as its first placeholder. */
export function assertScopedSql(sql: string): void {
  const m = SCOPE_PREDICATE.exec(sql);
  if (!m) throw new UnscopedQueryError(sql);
  // The first `?` in the statement must be the one inside the predicate.
  const firstPlaceholder = sql.indexOf("?");
  const predicatePlaceholder = m.index + m[0].lastIndexOf("?");
  if (firstPlaceholder !== predicatePlaceholder) throw new UnscopedQueryError(sql);
}

/**
 * Prepare a tenant-scoped D1 statement. `tenantId` is bound first; `params`
 * follow in order. Throws synchronously if `sql` is not scoped.
 */
export function scopedQuery(
  db: D1Database,
  sql: string,
  tenantId: TenantId,
  ...params: unknown[]
): D1PreparedStatement {
  assertScopedSql(sql);
  return db.prepare(sql).bind(tenantId, ...params);
}

function summarize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 120);
}
