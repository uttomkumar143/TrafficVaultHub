/**
 * Cap protection — pure core (Phase 3 Unit 4; PRD §30, §44, §45, §107).
 *
 * No I/O. Everything an offer's cap counters need to decide "may this click /
 * conversion happen?" is a deterministic function of (state, limits, event,
 * now). The Durable Object (`workers/coordinator-object.ts`) and the in-memory
 * test ledger (`MemoryCapLedger`) both call `reserve()` — the DO adds
 * single-writer atomicity + durability, nothing else.
 *
 * Cap types (mirror `offer_cap_counters.cap_type` CHECK in migration 0008):
 *   DAILY_CLICK / MONTHLY_CLICK / TOTAL_CLICK          — counted per click
 *   DAILY_CONVERSION / MONTHLY_CONVERSION / TOTAL_CONVERSION — counted per conversion
 *   BUDGET                                             — integer MINOR UNITS spent per conversion
 *
 * Period keys (mirror the migration): 'YYYY-MM-DD' (UTC) for DAILY_*,
 * 'YYYY-MM' for MONTHLY_*, 'TOTAL' for TOTAL_* and BUDGET. A counter is
 * addressed by (cap_type, period_key); a new period simply starts at 0.
 *
 * Semantics:
 *   * `limit === null`  → uncapped: the counter is still incremented (for
 *                          reporting) but can never deny.
 *   * `limit === 0`     → nothing is allowed.
 *   * Allowed iff `current + amount <= limit` for EVERY applicable cap.
 *   * Check-and-increment is ATOMIC: all applicable caps are checked first;
 *     on denial nothing is incremented; on success all are incremented.
 *   * A cap whose counter reaches its limit on this increment is reported in
 *     `newly_exhausted` so the caller can invalidate the eligibility cache
 *     (Unit 5) — exactly once.
 *   * Money is integer minor units + a 3-letter currency. A budget reserve
 *     with a non-integer / negative amount or a currency that does not match
 *     the counter's currency is DENIED (fail closed), never coerced.
 */

export const CAP_TYPES = [
  "DAILY_CLICK",
  "DAILY_CONVERSION",
  "MONTHLY_CLICK",
  "MONTHLY_CONVERSION",
  "TOTAL_CLICK",
  "TOTAL_CONVERSION",
  "BUDGET",
] as const;
export type CapType = (typeof CAP_TYPES)[number];

export const CLICK_CAP_TYPES: readonly CapType[] = ["DAILY_CLICK", "MONTHLY_CLICK", "TOTAL_CLICK"];
export const CONVERSION_CAP_TYPES: readonly CapType[] = ["DAILY_CONVERSION", "MONTHLY_CONVERSION", "TOTAL_CONVERSION", "BUDGET"];

/** Cap limits in effect for an offer. `null` = uncapped. Counts are integers; budget is integer minor units. */
export interface CapLimits {
  daily_click_cap: number | null;
  monthly_click_cap: number | null;
  total_click_cap: number | null;
  daily_conversion_cap: number | null;
  monthly_conversion_cap: number | null;
  total_conversion_cap: number | null;
  budget_minor: number | null;
  /** Required when `budget_minor` is set; the currency every budget reserve must present. */
  currency: string | null;
}

export const UNCAPPED: CapLimits = {
  daily_click_cap: null,
  monthly_click_cap: null,
  total_click_cap: null,
  daily_conversion_cap: null,
  monthly_conversion_cap: null,
  total_conversion_cap: null,
  budget_minor: null,
  currency: null,
};

/**
 * Build limits from an offer version row (migration 0007 has daily/total
 * conversion caps + budget; click and monthly caps are not offer fields yet
 * and stay uncapped). Any non-integer / negative value is treated as a
 * configuration error → uncapped is NOT assumed; the cap is set to 0 (deny)
 * so a corrupt row can never silently over-deliver.
 */
export function capLimitsFromVersion(v: {
  daily_conversion_cap: number | null;
  total_conversion_cap: number | null;
  budget_minor: number | null;
  currency: string;
}): CapLimits {
  return {
    ...UNCAPPED,
    daily_conversion_cap: sanitizeLimit(v.daily_conversion_cap),
    total_conversion_cap: sanitizeLimit(v.total_conversion_cap),
    budget_minor: sanitizeLimit(v.budget_minor),
    currency: v.budget_minor === null ? null : v.currency.toUpperCase(),
  };
}

function sanitizeLimit(n: number | null): number | null {
  if (n === null || n === undefined) return null;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** True when at least one CLICK cap is configured — the redirect may skip the ledger otherwise. */
export function hasClickCaps(l: CapLimits): boolean {
  return l.daily_click_cap !== null || l.monthly_click_cap !== null || l.total_click_cap !== null;
}

/** True when at least one CONVERSION or BUDGET cap is configured. */
export function hasConversionCaps(l: CapLimits): boolean {
  return (
    l.daily_conversion_cap !== null ||
    l.monthly_conversion_cap !== null ||
    l.total_conversion_cap !== null ||
    l.budget_minor !== null
  );
}

export function limitFor(l: CapLimits, t: CapType): number | null {
  switch (t) {
    case "DAILY_CLICK":
      return l.daily_click_cap;
    case "MONTHLY_CLICK":
      return l.monthly_click_cap;
    case "TOTAL_CLICK":
      return l.total_click_cap;
    case "DAILY_CONVERSION":
      return l.daily_conversion_cap;
    case "MONTHLY_CONVERSION":
      return l.monthly_conversion_cap;
    case "TOTAL_CONVERSION":
      return l.total_conversion_cap;
    case "BUDGET":
      return l.budget_minor;
  }
}

// ---- periods ------------------------------------------------------------------

/** UTC period key for a cap type at `now` (mirrors migration 0008's documented shape). */
export function periodKeyFor(t: CapType, now: Date): string {
  const iso = now.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  switch (t) {
    case "DAILY_CLICK":
    case "DAILY_CONVERSION":
      return iso.slice(0, 10);
    case "MONTHLY_CLICK":
    case "MONTHLY_CONVERSION":
      return iso.slice(0, 7);
    case "TOTAL_CLICK":
    case "TOTAL_CONVERSION":
    case "BUDGET":
      return "TOTAL";
  }
}

export function counterKey(t: CapType, periodKey: string): string {
  return `${t}:${periodKey}`;
}

// ---- state ------------------------------------------------------------------

export interface CapCounter {
  cap_type: CapType;
  period_key: string;
  /** Limit copied in when the period opened (or refreshed on the next reserve). */
  limit_value: number | null;
  current_value: number;
  /** Only for BUDGET. */
  currency: string | null;
  exhausted_at: string | null;
}

/** Mutable in-memory state for ONE offer: counters keyed by `counterKey`. */
export type CapState = Map<string, CapCounter>;

export function emptyCapState(): CapState {
  return new Map();
}

/** Rebuild state from persisted rows (the DO does this on cold start). */
export function capStateFromRows(rows: readonly CapCounter[]): CapState {
  const s = emptyCapState();
  for (const r of rows) s.set(counterKey(r.cap_type, r.period_key), { ...r });
  return s;
}

// ---- events & decisions --------------------------------------------------------

export type CapEvent =
  | { kind: "CLICK" }
  | { kind: "CONVERSION"; amount_minor: number; currency: string };

export const CAP_DENIAL_REASONS = ["CAP_EXHAUSTED", "BUDGET_EXHAUSTED", "INVALID_AMOUNT", "CURRENCY_MISMATCH"] as const;
export type CapDenialReason = (typeof CAP_DENIAL_REASONS)[number];

export type CapDecision =
  | {
      allowed: true;
      /** Counters touched by this reserve, after increment. */
      counters: CapCounter[];
      /** Caps that hit their limit on THIS increment (invalidate the cache once). */
      newly_exhausted: CapType[];
    }
  | {
      allowed: false;
      reason: CapDenialReason;
      /** The first cap that denied (fixed order: DAILY, MONTHLY, TOTAL, BUDGET). */
      cap_type: CapType | null;
      /** Counters as they stand (nothing was incremented). */
      counters: CapCounter[];
    };

function applicableTypes(e: CapEvent): readonly CapType[] {
  return e.kind === "CLICK" ? CLICK_CAP_TYPES : CONVERSION_CAP_TYPES;
}

function amountFor(e: CapEvent, t: CapType): number {
  return t === "BUDGET" && e.kind === "CONVERSION" ? e.amount_minor : 1;
}

/** Get-or-open the counter for (type, now), refreshing the limit from `limits`. */
function counterFor(state: CapState, limits: CapLimits, t: CapType, now: Date): CapCounter {
  const pk = periodKeyFor(t, now);
  const key = counterKey(t, pk);
  let c = state.get(key);
  const limit = limitFor(limits, t);
  if (!c) {
    c = {
      cap_type: t,
      period_key: pk,
      limit_value: limit,
      current_value: 0,
      currency: t === "BUDGET" ? limits.currency : null,
      exhausted_at: null,
    };
    state.set(key, c);
  } else if (c.limit_value !== limit) {
    // The offer version changed its cap mid-period: the new limit applies
    // from now on. Un-exhaust if the limit was raised above the count.
    c.limit_value = limit;
    if (limit === null || c.current_value < limit) c.exhausted_at = null;
  }
  return c;
}

/**
 * Atomic check-and-increment. Pure apart from mutating `state` on success.
 * The caller supplies `now` so periods and `exhausted_at` are deterministic.
 */
export function reserve(state: CapState, limits: CapLimits, event: CapEvent, now: Date): CapDecision {
  const types = applicableTypes(event);

  // Money validation FIRST — a malformed amount never touches a counter.
  if (event.kind === "CONVERSION") {
    if (!Number.isSafeInteger(event.amount_minor) || event.amount_minor < 0) {
      return { allowed: false, reason: "INVALID_AMOUNT", cap_type: "BUDGET", counters: snapshot(state, types, now, limits) };
    }
  }

  // Phase 1 — check every applicable cap; deny on the first breach, touch nothing.
  const touched: CapCounter[] = [];
  for (const t of types) {
    const c = counterFor(state, limits, t, now);
    touched.push(c);
    if (t === "BUDGET" && event.kind === "CONVERSION" && c.limit_value !== null) {
      const want = event.currency.toUpperCase();
      if (!c.currency || c.currency !== want) {
        return { allowed: false, reason: "CURRENCY_MISMATCH", cap_type: "BUDGET", counters: touched.map(clone) };
      }
    }
    if (c.limit_value !== null && c.current_value + amountFor(event, t) > c.limit_value) {
      // A zero-amount budget reserve can never breach; anything else here is exhaustion.
      if (c.exhausted_at === null && c.current_value >= c.limit_value) c.exhausted_at = now.toISOString();
      return {
        allowed: false,
        reason: t === "BUDGET" ? "BUDGET_EXHAUSTED" : "CAP_EXHAUSTED",
        cap_type: t,
        counters: touched.map(clone),
      };
    }
  }

  // Phase 2 — increment all; record which caps hit their limit right now.
  const newly: CapType[] = [];
  for (const c of touched) {
    c.current_value += amountFor(event, c.cap_type);
    if (c.limit_value !== null && c.current_value >= c.limit_value && c.exhausted_at === null) {
      c.exhausted_at = now.toISOString();
      newly.push(c.cap_type);
    }
  }
  return { allowed: true, counters: touched.map(clone), newly_exhausted: newly };
}

/** Read-only view of the applicable counters for an event kind (no increments, no period creation persisted). */
export function status(state: CapState, limits: CapLimits, kind: CapEvent["kind"], now: Date): CapCounter[] {
  const types = kind === "CLICK" ? CLICK_CAP_TYPES : CONVERSION_CAP_TYPES;
  return snapshot(state, types, now, limits);
}

/** True when ANY applicable cap for `kind` is currently exhausted (used by eligibility, Unit 5/6). */
export function isExhausted(state: CapState, limits: CapLimits, kind: CapEvent["kind"], now: Date): boolean {
  return status(state, limits, kind, now).some((c) => c.limit_value !== null && c.current_value >= c.limit_value);
}

/** Drop counters from closed periods (TOTAL never closes). Returns the removed counters for a final flush. */
export function pruneClosedPeriods(state: CapState, now: Date): CapCounter[] {
  const removed: CapCounter[] = [];
  for (const [key, c] of state) {
    if (c.period_key !== "TOTAL" && c.period_key !== periodKeyFor(c.cap_type, now)) {
      removed.push(c);
      state.delete(key);
    }
  }
  return removed;
}

function snapshot(state: CapState, types: readonly CapType[], now: Date, limits: CapLimits): CapCounter[] {
  return types.map((t) => {
    const existing = state.get(counterKey(t, periodKeyFor(t, now)));
    return existing
      ? clone(existing)
      : {
          cap_type: t,
          period_key: periodKeyFor(t, now),
          limit_value: limitFor(limits, t),
          current_value: 0,
          currency: t === "BUDGET" ? limits.currency : null,
          exhausted_at: null,
        };
  });
}

function clone(c: CapCounter): CapCounter {
  return { ...c };
}

// ---- port -----------------------------------------------------------------------

/** What a ledger reserve needs; `now` is optional so production uses the wall clock. */
export interface ReserveRequest {
  offer_id: string;
  /** Advertiser org that owns the offer — persisted on the snapshot row. */
  organization_id: string;
  limits: CapLimits;
  event: CapEvent;
  now?: Date;
}

/**
 * The cap ledger port. `reserve` is the atomic check-and-increment; it MUST
 * be linearizable per offer (the DO guarantees this; the memory ledger is
 * single-threaded by construction). Infrastructure failure throws — the
 * caller decides fail-open/closed (the redirect fails CLOSED for capped
 * offers: a DO outage must not over-deliver an advertiser's budget).
 */
export interface CapLedger {
  reserve(req: ReserveRequest): Promise<CapDecision>;
  status(offerId: string, limits: CapLimits, kind: CapEvent["kind"], now?: Date): Promise<CapCounter[]>;
}

/** In-memory ledger for tests and for the pure engine; one state per offer. */
export class MemoryCapLedger implements CapLedger {
  private readonly states = new Map<string, CapState>();

  private stateFor(offerId: string): CapState {
    let s = this.states.get(offerId);
    if (!s) {
      s = emptyCapState();
      this.states.set(offerId, s);
    }
    return s;
  }

  async reserve(req: ReserveRequest): Promise<CapDecision> {
    return reserve(this.stateFor(req.offer_id), req.limits, req.event, req.now ?? new Date());
  }

  async status(offerId: string, limits: CapLimits, kind: CapEvent["kind"], now: Date = new Date()): Promise<CapCounter[]> {
    return status(this.stateFor(offerId), limits, kind, now);
  }

  /** Test hook: seed a counter (e.g. to simulate a rebuilt DO). */
  seed(offerId: string, rows: readonly CapCounter[]): void {
    this.states.set(offerId, capStateFromRows(rows));
  }
}
