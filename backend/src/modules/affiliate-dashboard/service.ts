/**
 * Affiliate dashboard — service (Phase 7 Unit 2).
 *
 * Guard order on every call (all synchronous, BEFORE any async work):
 *   1. `hasPermission(tenant, key)`   → 403 FORBIDDEN
 *   2. tenant org type === AFFILIATE  → 404 NOT_FOUND (no enumeration of
 *                                       what other org kinds would see)
 *
 * Output is built from explicit allow-list projections; repository rows are
 * never spread into the response, so advertiser economics
 * (advertiser_payout_minor / platform_margin_minor / network_margin_minor)
 * and click identity (ip_hash / user_agent_hash) cannot leak.
 *
 * Money: INTEGER minor units + ISO currency, grouped per currency. No
 * cross-currency totals exist in the response by design.
 */
import { AppError } from "../../lib/errors";
import { encodeCursor, type Page, type PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { trackingPathFor } from "../tracking/service";
import type { AffiliateDashboardRepository, DateRange, LinkRow, OfferRow } from "./repository";

/** Default look-back when `from`/`to` are omitted. */
export const DEFAULT_RANGE_DAYS = 30;
/** Hard upper bound on the window so aggregates stay bounded. */
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

export interface MoneyByCurrency {
  currency: string;
  total_minor: number;
  count: number;
}

export interface EarningsByCurrency extends MoneyByCurrency {
  by_lifecycle_status: Record<string, { total_minor: number; count: number }>;
}

export interface OverviewView {
  range: DateRange;
  clicks: { total: number };
  conversions: { total: number; by_lifecycle_status: Record<string, number> };
  /** Per currency from conversions.commission_amount_minor (APPROVED and later). */
  earnings: EarningsByCurrency[];
  payouts: {
    /** REQUESTED / ELIGIBILITY_CHECK / UNDER_REVIEW — not yet approved. */
    pending: MoneyByCurrency[];
    /** APPROVED / PROCESSING — approved, not yet paid. */
    approved: MoneyByCurrency[];
    paid: MoneyByCurrency[];
  };
  /** Metrics with no backend yet are declared explicitly, never faked. */
  epc: { available: false };
  conversion_rate: { available: false };
}

export interface OfferView {
  id: string;
  name: string;
  vertical: string | null;
  description: string | null;
  access_mode: string;
  status: string;
  access_status: string | null;
  economics: {
    payout_type: string | null;
    currency: string | null;
    affiliate_commission_minor: number | null;
    revshare_percent_bps: number | null;
    conversion_event: string | null;
  } | null;
  created_at: string;
}

export interface LinkView {
  id: string;
  offer_id: string;
  offer_name: string | null;
  traffic_source_id: string | null;
  code: string;
  tracking_path: string;
  name: string | null;
  creative_id: string | null;
  status: string;
  click_count: number;
  created_at: string;
}

const PENDING_PAYOUT = new Set(["REQUESTED", "ELIGIBILITY_CHECK", "UNDER_REVIEW"]);
const APPROVED_PAYOUT = new Set(["APPROVED", "PROCESSING"]);

export class AffiliateDashboardService {
  constructor(private readonly repo: AffiliateDashboardRepository) {}

  private guard(tenant: TenantContext, key: "tracking.read" | "offers.read"): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", "Missing permission");
    if (tenant.organization.type !== "AFFILIATE") throw new AppError(404, "NOT_FOUND", "Not found");
  }

  /** Parse + bound the date window. Invalid → 400; window clamped to MAX_RANGE_DAYS. */
  static parseRange(from: string | undefined, to: string | undefined, now = new Date()): DateRange {
    const toDate = to === undefined ? now : parseIso(to, "to");
    const fromDate = from === undefined ? new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * DAY_MS) : parseIso(from, "from");
    if (fromDate.getTime() > toDate.getTime()) throw new AppError(400, "VALIDATION_ERROR", "`from` must not be after `to`");
    if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new AppError(400, "VALIDATION_ERROR", `Date range must not exceed ${MAX_RANGE_DAYS} days`);
    }
    return { from: fromDate.toISOString(), to: toDate.toISOString() };
  }

  async overview(tenant: TenantContext, range: DateRange): Promise<OverviewView> {
    this.guard(tenant, "tracking.read");
    const tenantId = tenantIdOf(tenant);
    const [clicks, convRows, earnRows, payoutRows] = await Promise.all([
      this.repo.countClicks(tenantId, range),
      this.repo.countConversionsByLifecycle(tenantId, range),
      this.repo.sumEarningsByCurrencyAndLifecycle(tenantId, range),
      this.repo.sumPayoutsByCurrencyAndStatus(tenantId),
    ]);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of convRows) {
      byStatus[r.status] = Number(r.count);
      total += Number(r.count);
    }

    const earnings = new Map<string, EarningsByCurrency>();
    for (const r of earnRows) {
      const cur = r.currency.toUpperCase();
      const e = earnings.get(cur) ?? { currency: cur, total_minor: 0, count: 0, by_lifecycle_status: {} };
      e.total_minor += Number(r.total_minor);
      e.count += Number(r.count);
      e.by_lifecycle_status[r.status] = { total_minor: Number(r.total_minor), count: Number(r.count) };
      earnings.set(cur, e);
    }

    const pending = new Map<string, MoneyByCurrency>();
    const approved = new Map<string, MoneyByCurrency>();
    const paid = new Map<string, MoneyByCurrency>();
    for (const r of payoutRows) {
      const bucket = PENDING_PAYOUT.has(r.status) ? pending : APPROVED_PAYOUT.has(r.status) ? approved : r.status === "PAID" ? paid : null;
      if (!bucket) continue; // FAILED / CANCELLED are not balances
      const cur = r.currency.toUpperCase();
      const m = bucket.get(cur) ?? { currency: cur, total_minor: 0, count: 0 };
      m.total_minor += Number(r.total_minor);
      m.count += Number(r.count);
      bucket.set(cur, m);
    }

    return {
      range,
      clicks: { total: Number(clicks) },
      conversions: { total, by_lifecycle_status: byStatus },
      earnings: [...earnings.values()],
      payouts: { pending: [...pending.values()], approved: [...approved.values()], paid: [...paid.values()] },
      epc: { available: false },
      conversion_rate: { available: false },
    };
  }

  async listOffers(tenant: TenantContext, page: PageRequest): Promise<Page<OfferView>> {
    this.guard(tenant, "offers.read");
    const rows = await this.repo.listOffers(tenantIdOf(tenant), page.cursor, page.limit + 1);
    return paginate(rows, page.limit, projectOffer);
  }

  async listLinks(tenant: TenantContext, page: PageRequest): Promise<Page<LinkView>> {
    this.guard(tenant, "tracking.read");
    const rows = await this.repo.listLinks(tenantIdOf(tenant), page.cursor, page.limit + 1);
    return paginate(rows, page.limit, projectLink);
  }
}

function parseIso(value: string, name: string): Date {
  const d = new Date(value);
  if (value.length > 40 || Number.isNaN(d.getTime())) throw new AppError(400, "VALIDATION_ERROR", `\`${name}\` must be an ISO-8601 date`);
  return d;
}

/** Keyset page over rows fetched with `limit + 1`; cursor from the LAST row of the page. */
function paginate<R extends { created_at: string; id: string }, V>(rows: R[], limit: number, project: (r: R) => V): Page<V> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(project),
    next_cursor: hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
  };
}

function projectOffer(r: OfferRow): OfferView {
  return {
    id: r.offer_id,
    name: r.name,
    vertical: r.vertical,
    description: r.description,
    access_mode: r.access_mode,
    status: r.offer_status,
    access_status: r.access_status,
    economics:
      r.payout_type === null
        ? null
        : {
            payout_type: r.payout_type,
            currency: r.currency ? r.currency.toUpperCase() : null,
            affiliate_commission_minor: r.affiliate_commission_minor === null ? null : Number(r.affiliate_commission_minor),
            revshare_percent_bps: r.revshare_percent_bps === null ? null : Number(r.revshare_percent_bps),
            conversion_event: r.conversion_event,
          },
    created_at: r.created_at,
  };
}

function projectLink(r: LinkRow): LinkView {
  return {
    id: r.id,
    offer_id: r.offer_id,
    offer_name: r.offer_name,
    traffic_source_id: r.traffic_source_id,
    code: r.code,
    tracking_path: trackingPathFor(r.code),
    name: r.name,
    creative_id: r.creative_id,
    status: r.status,
    click_count: Number(r.click_count),
    created_at: r.created_at,
  };
}
