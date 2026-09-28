/**
 * Phase 3 Unit 2 — public click redirect (PRD §31–§34, §42, §46, §107, §130).
 *
 * The ONE hot path with a latency target (p95 < 100 ms). Per click:
 *
 *   tracking link  /t/:code
 *     validate code shape → ONE D1 read (link + fresh offer facts + caps)
 *     → offerRoutability → cap check (CapLedger) → ONE clicks INSERT → 302
 *
 *   SmartLink      /s/:code
 *     validate → smartlink row → candidate pool (+ targeting) → engine
 *     route() → cap check on the pick, failover() on denial → INSERT → 302
 *
 * Everything else is deferred through `defer` (ctx.waitUntil in prod). A
 * deferred failure NEVER affects the response — every deferred task is
 * wrapped so a rejection is swallowed after `onDeferredError` (log hook).
 *
 * Security / privacy:
 *   - unauthenticated; unknown, inactive and ineligible codes all answer the
 *     same generic NOT_FOUND (the internal `reason` is for tests/logs only);
 *   - nothing client-supplied selects a tenant: the affiliate org, profile
 *     and advertiser org all come from the D1 row resolved by `code`;
 *   - sub-IDs are sanitised and BAD ONES ARE DROPPED SILENTLY (a bad sub-ID
 *     must never cost the click, §130);
 *   - coarse signals only; `ip_hash`/`user_agent_hash` are salted with the
 *     `CLICK_SIGNAL_SALT` secret and stay NULL without it (Unit 2 part 1).
 *
 * Caps (Unit 4): offer versions carry conversion caps + budget (0007). A
 * click never increments those, but an offer whose conversion cap / budget is
 * exhausted must not receive traffic (§42) — so the redirect asks the ledger
 * for the CONVERSION status and denies when exhausted. Click caps, when a
 * version defines them, are reserved atomically. Ledger infrastructure
 * failure fails CLOSED (503) for capped offers only; uncapped offers never
 * touch the ledger.
 */
import type { OfferRoutingFacts } from "./eligibility";
import { offerRoutability } from "./eligibility";
import { generateClickId, isTrackingCode, mergeSubIds, normalizeTrackingCode, sanitizeSubIds, type SubIdKey, type SubIds } from "./ids";
import {
  capLimitsFromVersion,
  hasClickCaps,
  hasConversionCaps,
  type CapCounter,
  type CapEvent,
  type CapLimits,
  type ReserveRequest,
  type CapDecision,
} from "./caps";
import type {
  ClickInsert,
  ClickSignals,
  OfferCapColumns,
  ResolvedSmartLinkRow,
  ResolvedTrackingLinkRow,
  SmartLinkCandidateRow,
  TargetingRuleRow,
} from "./repository";
import { clickSignals, requestSignalsFromHeaders } from "./signals";
import {
  failover,
  route,
  type ClickContext,
  type RoutingDecision,
  type SmartLinkCandidate,
  type SmartLinkDefinition,
  type TargetingRule,
} from "./smartlink-engine";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The slice of `TrackingRepository` the redirect needs (fakeable in unit tests). */
export interface RedirectReads {
  findActiveByCode(code: string): Promise<ResolvedTrackingLinkRow | null>;
  findActiveSmartLinkByCode(code: string): Promise<ResolvedSmartLinkRow | null>;
  listSmartLinkCandidates(smartlinkId: string, affiliateOrganizationId: string): Promise<SmartLinkCandidateRow[]>;
  listTargetingForVersions(versionIds: readonly string[]): Promise<TargetingRuleRow[]>;
  insertClick(c: ClickInsert): Promise<void>;
}

/**
 * `CapLedger` plus the optional `organizationId` on `status` that
 * `DurableCapLedger` accepts (a never-seen object must be bound to its offer
 * before it can answer). `MemoryCapLedger` (4 params) satisfies it too.
 */
export interface RedirectCapLedger {
  reserve(req: ReserveRequest): Promise<CapDecision>;
  status(offerId: string, limits: CapLimits, kind: CapEvent["kind"], now?: Date, organizationId?: string): Promise<CapCounter[]>;
}

export interface RedirectServiceDeps {
  reads: RedirectReads;
  ledger: RedirectCapLedger;
  /** Called (deferred) when an offer's cap/budget is found exhausted — Unit 5 invalidation hook. */
  onCapExhausted?: (offerId: string) => Promise<void>;
  /** Deferred-task sink: `ctx.waitUntil` in prod; tests collect the promises. */
  defer?: (task: Promise<void>) => void;
  /** Log hook for swallowed deferred failures (never throws through). */
  onDeferredError?: (err: unknown) => void;
  clock?: () => Date;
  random?: () => number;
  newClickId?: () => string;
  /** `CLICK_SIGNAL_SALT` secret; absent → no IP / UA hashes are written. */
  signalSalt?: string | null;
}

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export interface RedirectRequest {
  /** Raw `:code` path parameter (case-insensitive). */
  code: string;
  /** Query string parameters (sub1..sub5 are honoured; everything else ignored). */
  query: Record<string, string | undefined>;
  /** Header lookup (lower-case names). */
  header: (name: string) => string | null | undefined;
  request_id: string | null;
}

/** Why a request did not redirect. Internal only — the HTTP answer is a bare 404. */
export const REDIRECT_DENIAL_REASONS = [
  "INVALID_CODE",
  "LINK_NOT_FOUND",
  "SMARTLINK_NOT_FOUND",
  "OFFER_INELIGIBLE",
  "CAP_EXHAUSTED",
  "BUDGET_EXHAUSTED",
  "NO_ELIGIBLE_OFFER",
] as const;
export type RedirectDenialReason = (typeof REDIRECT_DENIAL_REASONS)[number];

export type RedirectResult =
  | {
      kind: "REDIRECT";
      location: string;
      /** Null when a SmartLink fell back to its `fallback_url` (no offer → no click row). */
      click_id: string | null;
      decision_reason_code: string;
    }
  | { kind: "NOT_FOUND"; reason: RedirectDenialReason };

/** Infrastructure failure on a capped offer — fail closed, generic 503 upstream. */
export class CapLedgerUnavailableError extends Error {
  constructor(cause: unknown) {
    super("cap ledger unavailable", { cause });
    this.name = "CapLedgerUnavailableError";
  }
}

/** Bounded failover: the pool is small; never loop past it. */
export const MAX_FAILOVER_ATTEMPTS = 25;

// ---------------------------------------------------------------------------
// Destination URL — macros + click_id hand-off (PRD §32)
// ---------------------------------------------------------------------------

export const DESTINATION_MACROS = ["click_id", "offer_id", "sub1", "sub2", "sub3", "sub4", "sub5"] as const;
export type DestinationMacro = (typeof DESTINATION_MACROS)[number];

/**
 * Expand `{macro}` placeholders in the version's destination URL. When the
 * advertiser did not place `{click_id}` anywhere, `click_id` is appended as
 * a query parameter so every landing page still receives it (the advertiser
 * needs it for the S2S postback, Unit 7). Values are URL-encoded; an
 * unresolvable macro expands to the empty string, never leaks its braces.
 */
export function buildDestination(template: string, values: Record<DestinationMacro, string | null>): string {
  let sawClickId = false;
  const expanded = template.replace(/\{([a-z0-9_]+)\}/gi, (whole, name: string) => {
    const key = name.toLowerCase() as DestinationMacro;
    if (!(DESTINATION_MACROS as readonly string[]).includes(key)) return whole;
    if (key === "click_id") sawClickId = true;
    return encodeURIComponent(values[key] ?? "");
  });
  if (sawClickId || values.click_id === null) return expanded;
  try {
    const u = new URL(expanded);
    u.searchParams.set("click_id", values.click_id);
    return u.toString();
  } catch {
    // Not an absolute URL (should not happen — versions validate it); append conservatively.
    const sep = expanded.includes("?") ? "&" : "?";
    return `${expanded}${sep}click_id=${encodeURIComponent(values.click_id)}`;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RedirectService {
  private readonly reads: RedirectReads;
  private readonly ledger: RedirectCapLedger;
  private readonly onCapExhausted: (offerId: string) => Promise<void>;
  private readonly defer: (task: Promise<void>) => void;
  private readonly onDeferredError: (err: unknown) => void;
  private readonly clock: () => Date;
  private readonly random: () => number;
  private readonly newClickId: () => string;
  private readonly signalSalt: string | null;

  constructor(deps: RedirectServiceDeps) {
    this.reads = deps.reads;
    this.ledger = deps.ledger;
    this.onCapExhausted = deps.onCapExhausted ?? (async () => {});
    this.defer = deps.defer ?? ((task) => void task);
    this.onDeferredError = deps.onDeferredError ?? (() => {});
    this.clock = deps.clock ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.newClickId = deps.newClickId ?? generateClickId;
    this.signalSalt = deps.signalSalt ?? null;
  }

  // ---- /t/:code — tracking link ---------------------------------------------

  async redirectTrackingLink(req: RedirectRequest): Promise<RedirectResult> {
    if (!isTrackingCode(req.code)) return { kind: "NOT_FOUND", reason: "INVALID_CODE" };
    const row = await this.reads.findActiveByCode(normalizeTrackingCode(req.code));
    if (!row) return { kind: "NOT_FOUND", reason: "LINK_NOT_FOUND" };

    const now = this.clock();
    const routability = offerRoutability(factsOf(row), now);
    if (!routability.eligible) return { kind: "NOT_FOUND", reason: "OFFER_INELIGIBLE" };
    // Narrowed by routability: LIVE offers always have a current version + destination.
    const versionId = row.offer_version_id as string;
    const destination = row.offer_destination_url as string;

    const cap = await this.checkCaps(row.offer_id, row.offer_organization_id, capLimitsOf(row), now);
    if (cap !== "OK") return { kind: "NOT_FOUND", reason: cap };

    const subs = mergeSubIds(defaultSubsOf(row), querySubs(req.query));
    const clickId = this.newClickId();
    const signals = this.signalsOf(req);
    const location = buildDestination(destination, macroValues(clickId, row.offer_id, subs));

    await this.reads.insertClick({
      id: clickId,
      organization_id: row.organization_id,
      affiliate_profile_id: row.affiliate_profile_id,
      tracking_link_id: row.id,
      smartlink_id: null,
      offer_id: row.offer_id,
      offer_version_id: versionId,
      offer_organization_id: row.offer_organization_id,
      traffic_source_id: row.traffic_source_id,
      creative_id: row.creative_id,
      subs,
      routing_mode: null,
      routing_algorithm_version: null,
      decision_reason_code: "TRACKING_LINK",
      failover_from_offer_id: null,
      destination_url: location,
      request_id: req.request_id,
      ...signals,
    });
    return { kind: "REDIRECT", location, click_id: clickId, decision_reason_code: "TRACKING_LINK" };
  }

  // ---- /s/:code — SmartLink -------------------------------------------------

  async redirectSmartLink(req: RedirectRequest): Promise<RedirectResult> {
    if (!isTrackingCode(req.code)) return { kind: "NOT_FOUND", reason: "INVALID_CODE" };
    const link = await this.reads.findActiveSmartLinkByCode(normalizeTrackingCode(req.code));
    if (!link) return { kind: "NOT_FOUND", reason: "SMARTLINK_NOT_FOUND" };

    const now = this.clock();
    const rows = await this.reads.listSmartLinkCandidates(link.id, link.organization_id);
    const versionIds = rows.map((r) => r.offer_version_id).filter((v): v is string => v !== null);
    const targeting = await this.reads.listTargetingForVersions(versionIds);
    const candidates = rows.map((r) => candidateOf(r, targeting));
    const capsByOffer = new Map(rows.map((r) => [r.offer_id, { limits: capLimitsOf(r), org: r.offer_organization_id }]));

    const signals = this.signalsOf(req);
    const ctx: ClickContext = {
      country_code: signals.country_code,
      region_code: signals.region_code,
      device_type: signals.device_type,
      os_family: signals.os_family,
      browser_family: signals.browser_family,
      language: signals.language,
      traffic_source_id: link.traffic_source_id,
      now,
    };
    const def: SmartLinkDefinition = {
      smartlink_id: link.id,
      routing_mode: link.routing_mode,
      status: link.status,
      fallback_url: link.fallback_url,
    };
    const options = { random: this.random };

    // Route; if the pick is cap/budget-exhausted at the ledger, fail over with
    // the FULL pool re-evaluated and that offer excluded (§46). Bounded.
    let decision: RoutingDecision = route(def, candidates, ctx, options);
    let failed: string | null = null;
    for (let attempt = 0; attempt < MAX_FAILOVER_ATTEMPTS; attempt++) {
      if (failed !== null) {
        decision = failover(def, candidates, ctx, failed, options);
        failed = null;
      }
      if (decision.outcome !== "OFFER") break;
      const pickedId = decision.offer_id;
      const caps = capsByOffer.get(pickedId);
      const cap = caps ? await this.checkCaps(pickedId, caps.org, caps.limits, now) : "OK";
      if (cap === "OK") break;
      // Mark the candidate so a re-route explains the rejection, then try again.
      const c = candidates.find((x) => x.offer_id === pickedId);
      if (c) {
        if (cap === "BUDGET_EXHAUSTED") c.budget_exhausted = true;
        else c.cap_exhausted = true;
      }
      failed = pickedId;
    }
    if (failed !== null) {
      // Attempts exhausted with the last pick still denied — never route to it.
      return { kind: "NOT_FOUND", reason: "NO_ELIGIBLE_OFFER" };
    }

    if (decision.outcome === "NO_ELIGIBLE_OFFER") return { kind: "NOT_FOUND", reason: "NO_ELIGIBLE_OFFER" };
    if (decision.outcome === "FALLBACK_URL") {
      // No offer was routed → nothing to attribute → no click row (clicks.offer_id is NOT NULL).
      return { kind: "REDIRECT", location: decision.destination_url, click_id: null, decision_reason_code: decision.decision_reason_code };
    }

    const subs = querySubs(req.query);
    const clickId = this.newClickId();
    const location = buildDestination(decision.destination_url, macroValues(clickId, decision.offer_id, subs));
    await this.reads.insertClick({
      id: clickId,
      organization_id: link.organization_id,
      affiliate_profile_id: link.affiliate_profile_id,
      tracking_link_id: null,
      smartlink_id: link.id,
      offer_id: decision.offer_id,
      offer_version_id: decision.offer_version_id,
      offer_organization_id: decision.offer_organization_id,
      traffic_source_id: link.traffic_source_id,
      creative_id: null,
      subs,
      routing_mode: decision.routing_mode,
      routing_algorithm_version: decision.algorithm_version,
      decision_reason_code: decision.decision_reason_code,
      failover_from_offer_id: decision.failover_from_offer_id,
      destination_url: location,
      request_id: req.request_id,
      ...signals,
    });
    return { kind: "REDIRECT", location, click_id: clickId, decision_reason_code: decision.decision_reason_code };
  }

  // ---- internals --------------------------------------------------------------

  /**
   * Cap gate for one offer. Click caps → atomic reserve; conversion caps /
   * budget → read-only exhaustion probe (a click never spends them). Uncapped
   * offers skip the ledger entirely. Exhaustion schedules the Unit 5
   * invalidation (deferred). Ledger failure → CapLedgerUnavailableError.
   */
  private async checkCaps(
    offerId: string,
    offerOrganizationId: string,
    limits: CapLimits,
    now: Date,
  ): Promise<"OK" | "CAP_EXHAUSTED" | "BUDGET_EXHAUSTED"> {
    try {
      if (hasClickCaps(limits)) {
        const d = await this.ledger.reserve({ offer_id: offerId, organization_id: offerOrganizationId, limits, event: { kind: "CLICK" }, now });
        if (!d.allowed) {
          this.deferInvalidate(offerId);
          return "CAP_EXHAUSTED";
        }
        if (d.newly_exhausted.length > 0) this.deferInvalidate(offerId);
      }
      if (hasConversionCaps(limits)) {
        const counters = await this.ledger.status(offerId, limits, "CONVERSION", now, offerOrganizationId);
        const hit = counters.find((c) => c.limit_value !== null && c.current_value >= c.limit_value);
        if (hit) {
          this.deferInvalidate(offerId);
          return hit.cap_type === "BUDGET" ? "BUDGET_EXHAUSTED" : "CAP_EXHAUSTED";
        }
      }
      return "OK";
    } catch (e) {
      if (e instanceof CapLedgerUnavailableError) throw e;
      throw new CapLedgerUnavailableError(e);
    }
  }

  private deferInvalidate(offerId: string): void {
    this.deferSafe(() => this.onCapExhausted(offerId));
  }

  /** Run `task` off the response path; a rejection is reported, never rethrown. */
  private deferSafe(task: () => Promise<void>): void {
    let p: Promise<void>;
    try {
      p = task();
    } catch (e) {
      p = Promise.reject(e);
    }
    this.defer(
      p.catch((e: unknown) => {
        try {
          this.onDeferredError(e);
        } catch {
          // a failing log hook must not surface either
        }
      }),
    );
  }

  private signalsOf(req: RedirectRequest): ClickSignals {
    return clickSignals(requestSignalsFromHeaders(req.header), this.signalSalt);
  }
}

// ---------------------------------------------------------------------------
// Row → domain mappers (no client input involved)
// ---------------------------------------------------------------------------

function factsOf(r: {
  offer_status: ResolvedTrackingLinkRow["offer_status"];
  offer_access_mode: ResolvedTrackingLinkRow["offer_access_mode"];
  offer_version_id: string | null;
  offer_destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  grant_status: ResolvedTrackingLinkRow["grant_status"];
}): OfferRoutingFacts {
  return {
    status: r.offer_status,
    access_mode: r.offer_access_mode,
    current_version_id: r.offer_version_id,
    destination_url: r.offer_destination_url,
    targeting_starts_at: r.targeting_starts_at,
    targeting_ends_at: r.targeting_ends_at,
    grant_status: r.grant_status,
  };
}

function capLimitsOf(r: OfferCapColumns): CapLimits {
  return capLimitsFromVersion({
    daily_conversion_cap: r.daily_conversion_cap,
    total_conversion_cap: r.total_conversion_cap,
    budget_minor: r.budget_minor,
    currency: r.offer_currency ?? "",
  });
}

function candidateOf(r: SmartLinkCandidateRow, targeting: readonly TargetingRuleRow[]): SmartLinkCandidate {
  const rules: TargetingRule[] = r.offer_version_id
    ? targeting.filter((t) => t.offer_version_id === r.offer_version_id).map((t) => ({ dimension: t.dimension, value: t.value }))
    : [];
  return {
    offer_id: r.offer_id,
    offer_organization_id: r.offer_organization_id,
    weight: r.weight,
    priority: r.priority,
    enabled: r.enabled === 1,
    facts: factsOf(r),
    targeting: rules,
  };
}

function defaultSubsOf(r: ResolvedTrackingLinkRow): SubIds {
  return { sub1: r.default_sub1, sub2: r.default_sub2, sub3: r.default_sub3, sub4: r.default_sub4, sub5: r.default_sub5 };
}

/** Sub-IDs from the query string; rejected slots are dropped silently (§130). */
function querySubs(q: Record<string, string | undefined>): SubIds {
  return sanitizeSubIds({ sub1: q.sub1, sub2: q.sub2, sub3: q.sub3, sub4: q.sub4, sub5: q.sub5 }).values;
}

function macroValues(clickId: string, offerId: string, subs: SubIds): Record<DestinationMacro, string | null> {
  const out: Record<DestinationMacro, string | null> = {
    click_id: clickId,
    offer_id: offerId,
    sub1: null,
    sub2: null,
    sub3: null,
    sub4: null,
    sub5: null,
  };
  for (const k of Object.keys(subs) as SubIdKey[]) out[k] = subs[k];
  return out;
}
