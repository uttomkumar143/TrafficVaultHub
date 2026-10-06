/**
 * Affiliate dashboard — read-only repository (Phase 7 Unit 1).
 *
 * Every statement is scoped by the affiliate's OWN organization id as the
 * FIRST placeholder — via `scopedQuery` where the column is `organization_id`,
 * and via `affiliateScoped` (same first-bind rule, asserted) where the fact
 * table names the affiliate as `affiliate_organization_id` (conversions,
 * affiliate_offer_access). Aggregates are computed in SQL via
 * COUNT/SUM over a bounded date range; rows are never loaded into memory to
 * be summed in JS. Money is grouped PER CURRENCY — there is no cross-currency
 * arithmetic anywhere in this module.
 *
 * Column allow-lists are explicit so advertiser economics
 * (`advertiser_payout_minor`, `platform_margin_minor`, `network_margin_minor`)
 * and raw click identity (`ip_hash`, `user_agent_hash`) can never be
 * projected by accident.
 */
import { UnscopedQueryError, scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { MAX_PAGE_SIZE, type Cursor } from "../../lib/pagination";

export interface DateRange {
  /** Inclusive ISO-8601 UTC lower bound. */
  from: string;
  /** Exclusive ISO-8601 UTC upper bound. */
  to: string;
}

export interface CountByStatusRow {
  status: string;
  count: number;
}

export interface MoneyByCurrencyRow {
  currency: string;
  total_minor: number;
  count: number;
}

export interface MoneyByCurrencyAndStatusRow extends MoneyByCurrencyRow {
  status: string;
}

export interface OfferRow {
  id: string;
  offer_id: string;
  name: string;
  vertical: string | null;
  description: string | null;
  access_mode: string;
  offer_status: string;
  access_status: string | null;
  payout_type: string | null;
  currency: string | null;
  affiliate_commission_minor: number | null;
  revshare_percent_bps: number | null;
  conversion_event: string | null;
  created_at: string;
}

export interface LinkRow {
  id: string;
  offer_id: string;
  offer_name: string | null;
  traffic_source_id: string | null;
  code: string;
  name: string | null;
  creative_id: string | null;
  status: string;
  created_at: string;
  click_count: number;
}

const AFFILIATE_SCOPE = /\b(?:[a-z_][a-z0-9_]*\.)?affiliate_organization_id\s*=\s*\?/i;

/** Like `scopedQuery`, but the tenant predicate is `affiliate_organization_id = ?` (must be the first `?`). */
function affiliateScoped(db: D1Database, sql: string, tenantId: TenantId, ...params: unknown[]): D1PreparedStatement {
  const m = AFFILIATE_SCOPE.exec(sql);
  if (!m) throw new UnscopedQueryError(sql);
  if (sql.indexOf("?") !== m.index + m[0].lastIndexOf("?")) throw new UnscopedQueryError(sql);
  return db.prepare(sql).bind(tenantId, ...params);
}

export class AffiliateDashboardRepository {
  constructor(private readonly db: D1Database) {}

  /** Clicks on the affiliate's own links inside the range (COUNT only). */
  async countClicks(tenantId: TenantId, range: DateRange): Promise<number> {
    const row = await scopedQuery(
      this.db,
      `SELECT COUNT(*) AS n FROM clicks
        WHERE organization_id = ? AND clicked_at >= ? AND clicked_at < ?`,
      tenantId,
      range.from,
      range.to,
    ).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Conversions attributed to this affiliate, grouped by lifecycle_status. */
  async countConversionsByLifecycle(tenantId: TenantId, range: DateRange): Promise<CountByStatusRow[]> {
    const { results } = await affiliateScoped(
      this.db,
      `SELECT lifecycle_status AS status, COUNT(*) AS count FROM conversions
        WHERE affiliate_organization_id = ? AND occurred_at >= ? AND occurred_at < ?
        GROUP BY lifecycle_status ORDER BY lifecycle_status`,
      tenantId,
      range.from,
      range.to,
    ).all<CountByStatusRow>();
    return results;
  }

  /**
   * Earnings per currency, split by lifecycle_status, from
   * `conversions.commission_amount_minor` (set once at APPROVED — the
   * authority per 0009). Only rows that carry a commission are included.
   */
  async sumEarningsByCurrencyAndLifecycle(tenantId: TenantId, range: DateRange): Promise<MoneyByCurrencyAndStatusRow[]> {
    const { results } = await affiliateScoped(
      this.db,
      `SELECT commission_currency AS currency, lifecycle_status AS status,
              SUM(commission_amount_minor) AS total_minor, COUNT(*) AS count
         FROM conversions
        WHERE affiliate_organization_id = ? AND occurred_at >= ? AND occurred_at < ?
          AND commission_amount_minor IS NOT NULL AND commission_currency IS NOT NULL
        GROUP BY commission_currency, lifecycle_status
        ORDER BY commission_currency, lifecycle_status`,
      tenantId,
      range.from,
      range.to,
    ).all<MoneyByCurrencyAndStatusRow>();
    return results;
  }

  /** Payouts owned by this affiliate org, grouped by (currency, status). Not date-bounded: open payouts are a balance, not a flow. */
  async sumPayoutsByCurrencyAndStatus(tenantId: TenantId): Promise<MoneyByCurrencyAndStatusRow[]> {
    const { results } = await scopedQuery(
      this.db,
      `SELECT currency, status, SUM(amount_minor) AS total_minor, COUNT(*) AS count
         FROM payouts
        WHERE organization_id = ?
        GROUP BY currency, status
        ORDER BY currency, status`,
      tenantId,
    ).all<MoneyByCurrencyAndStatusRow>();
    return results;
  }

  /**
   * Offers this affiliate may promote: LIVE PUBLIC offers, plus any offer
   * where the affiliate holds an APPROVED access row. Projection is an explicit
   * allow-list of the current version's affiliate-facing economics only.
   * Keyset-paginated by (created_at, id) of the offer; `limit` must already be
   * `page.limit + 1` so the caller can detect a next page.
   */
  async listOffers(tenantId: TenantId, cursor: Cursor | null, limit: number): Promise<OfferRow[]> {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE + 1);
    const { results } = await affiliateScoped(
      this.db,
      `SELECT o.id AS id, o.id AS offer_id, o.name, o.vertical, o.description, o.access_mode,
              o.status AS offer_status, a.status AS access_status,
              v.payout_type, v.currency, v.affiliate_commission_minor, v.revshare_percent_bps,
              v.conversion_event, o.created_at
         FROM offers o
         LEFT JOIN affiliate_offer_access a
                ON a.offer_id = o.id AND a.affiliate_organization_id = ?
         LEFT JOIN offer_versions v ON v.id = o.current_version_id
        WHERE o.status = 'LIVE'
          AND (o.access_mode = 'PUBLIC' OR a.status = 'APPROVED')
          AND (? IS NULL OR (o.created_at < ?) OR (o.created_at = ? AND o.id < ?))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ?`,
      tenantId,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.id ?? null,
      safeLimit,
    ).all<OfferRow>();
    return results;
  }

  /**
   * The affiliate's own tracking links with a per-link click COUNT (correlated
   * subquery, scoped twice: link org AND click org). Keyset-paginated.
   */
  async listLinks(tenantId: TenantId, cursor: Cursor | null, limit: number): Promise<LinkRow[]> {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE + 1);
    const { results } = await scopedQuery(
      this.db,
      `SELECT l.id, l.offer_id, o.name AS offer_name, l.traffic_source_id, l.code, l.name, l.creative_id,
              l.status, l.created_at,
              (SELECT COUNT(*) FROM clicks c
                WHERE c.tracking_link_id = l.id AND c.organization_id = l.organization_id) AS click_count
         FROM tracking_links l
         LEFT JOIN offers o ON o.id = l.offer_id
        WHERE l.organization_id = ?
          AND (? IS NULL OR (l.created_at < ?) OR (l.created_at = ? AND l.id < ?))
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?`,
      tenantId,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.created_at ?? null,
      cursor?.id ?? null,
      safeLimit,
    ).all<LinkRow>();
    return results;
  }
}
