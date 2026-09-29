/**
 * Fraud risk engine — Phase 4 Unit 6 (PRD §41–§43, §115).
 *
 * PURE and DETERMINISTIC: same facts → same signals, score and level. No I/O,
 * no clock, no randomness. Callers (the fraud service, the validation
 * pipeline) pre-fetch facts and pass them in.
 *
 * Principles
 * ----------
 *   - A score is EVIDENCE, never proof. Every signal carries the concrete
 *     evidence that fired it so a reviewer can verify or dismiss it. The
 *     engine never decides; the case workflow does.
 *   - Missing data → the signal is ABSENT (not fired, not guessed). An
 *     assessment over empty facts is LOW / 0 with zero signals.
 *   - Thresholds and weights are versioned (`RULE_VERSION`) and stored with
 *     each assessment so historical scores stay explainable after tuning.
 *
 * Signals (six families, each 0..1 weights summed → clamp 0..100):
 *   VELOCITY               conversions/clicks per affiliate in the window
 *   DUPLICATE_PATTERN      repeated transaction / external ids / same IP+UA
 *   CLICK_TO_CONVERSION    conversion too soon after click (or before it)
 *   GEO_MISMATCH           click country ≠ conversion country / restricted geo
 *   TRAFFIC_SOURCE_ANOMALY missing or disallowed referrer, abnormal CR
 *   AUTOMATION             bot/headless UA, missing UA, identical UA fan-out
 */

export const RULE_VERSION = "fraud-rules-v1";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type SignalCode =
  | "VELOCITY_CONVERSIONS"
  | "VELOCITY_CLICKS"
  | "DUPLICATE_TRANSACTION_ID"
  | "DUPLICATE_EXTERNAL_ID"
  | "DUPLICATE_FINGERPRINT"
  | "CLICK_TO_CONVERSION_TOO_FAST"
  | "CONVERSION_BEFORE_CLICK"
  | "GEO_MISMATCH"
  | "GEO_RESTRICTED"
  | "REFERRER_MISSING"
  | "REFERRER_DISALLOWED"
  | "CONVERSION_RATE_ANOMALY"
  | "USER_AGENT_MISSING"
  | "USER_AGENT_AUTOMATION"
  | "USER_AGENT_FANOUT";

export interface RiskSignal {
  code: SignalCode;
  /** Contribution to the 0-100 score (already weighted). */
  weight: number;
  /** Concrete, reviewer-verifiable facts that fired this signal. */
  evidence: Record<string, string | number | boolean | null>;
}

export interface RiskAssessment {
  rule_version: typeof RULE_VERSION;
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
}

/** All fields optional: absent facts never fire signals. */
export interface RiskFacts {
  velocity?: {
    window_seconds: number;
    conversions_in_window?: number;
    clicks_in_window?: number;
  };
  duplicates?: {
    same_transaction_id_count?: number;
    same_external_id_count?: number;
    /** Conversions in the window sharing this click's IP + user agent. */
    same_fingerprint_count?: number;
  };
  timing?: {
    clicked_at?: string;
    occurred_at?: string;
  };
  geo?: {
    click_country?: string | null;
    conversion_country?: string | null;
    restricted_countries?: readonly string[];
  };
  traffic_source?: {
    referrer?: string | null;
    allowed_referrer_hosts?: readonly string[];
    /** Affiliate's conversion rate in the window, basis points (int). */
    conversion_rate_bps?: number;
    /** Offer-wide baseline conversion rate, basis points (int). */
    baseline_conversion_rate_bps?: number;
  };
  automation?: {
    user_agent?: string | null;
    /** Distinct clicks in the window that share exactly this user agent. */
    same_user_agent_click_count?: number;
  };
}

/** Versioned thresholds — change → bump RULE_VERSION. */
export const THRESHOLDS = {
  velocity: { conversions_per_hour: 20, clicks_per_hour: 1000 },
  duplicates: { fingerprint_count: 3 },
  timing: { too_fast_seconds: 5 },
  traffic_source: { rate_multiplier_bps: 50_000 /* 5× baseline */, min_baseline_bps: 10 },
  automation: { same_user_agent_clicks: 50 },
  levels: { medium: 25, high: 50, critical: 75 },
} as const;

const WEIGHTS: Record<SignalCode, number> = {
  VELOCITY_CONVERSIONS: 20,
  VELOCITY_CLICKS: 10,
  DUPLICATE_TRANSACTION_ID: 30,
  DUPLICATE_EXTERNAL_ID: 20,
  DUPLICATE_FINGERPRINT: 20,
  CLICK_TO_CONVERSION_TOO_FAST: 25,
  CONVERSION_BEFORE_CLICK: 40,
  GEO_MISMATCH: 20,
  GEO_RESTRICTED: 30,
  REFERRER_MISSING: 5,
  REFERRER_DISALLOWED: 25,
  CONVERSION_RATE_ANOMALY: 25,
  USER_AGENT_MISSING: 10,
  USER_AGENT_AUTOMATION: 35,
  USER_AGENT_FANOUT: 20,
};

// Automation tokens: "bot" is matched with a TRAILING boundary (Googlebot/2.1, Bingbot;) so "robotics" does not
// false-positive; the others with a LEADING boundary so compound names like "HeadlessChrome" still fire.
const AUTOMATION_UA =
  /(?:[a-z](bot)(?![a-z]))|(?:(?:^|[^a-z])(crawler|spider|headless|phantomjs|selenium|puppeteer|playwright|curl|wget|python-requests|scrapy|httpclient))/i;

export function levelFor(score: number): RiskLevel {
  if (score >= THRESHOLDS.levels.critical) return "CRITICAL";
  if (score >= THRESHOLDS.levels.high) return "HIGH";
  if (score >= THRESHOLDS.levels.medium) return "MEDIUM";
  return "LOW";
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function parseIso(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function signal(code: SignalCode, evidence: RiskSignal["evidence"]): RiskSignal {
  return { code, weight: WEIGHTS[code], evidence };
}

export function assessRisk(facts: RiskFacts): RiskAssessment {
  const signals: RiskSignal[] = [];

  // ---- velocity ----------------------------------------------------------
  const v = facts.velocity;
  if (v && isInt(v.window_seconds) && v.window_seconds > 0) {
    const hours = v.window_seconds / 3600;
    if (isInt(v.conversions_in_window)) {
      const perHour = v.conversions_in_window / hours;
      if (perHour > THRESHOLDS.velocity.conversions_per_hour) {
        signals.push(
          signal("VELOCITY_CONVERSIONS", {
            conversions_in_window: v.conversions_in_window,
            window_seconds: v.window_seconds,
            per_hour: Math.round(perHour),
            threshold_per_hour: THRESHOLDS.velocity.conversions_per_hour,
          }),
        );
      }
    }
    if (isInt(v.clicks_in_window)) {
      const perHour = v.clicks_in_window / hours;
      if (perHour > THRESHOLDS.velocity.clicks_per_hour) {
        signals.push(
          signal("VELOCITY_CLICKS", {
            clicks_in_window: v.clicks_in_window,
            window_seconds: v.window_seconds,
            per_hour: Math.round(perHour),
            threshold_per_hour: THRESHOLDS.velocity.clicks_per_hour,
          }),
        );
      }
    }
  }

  // ---- duplicate patterns -------------------------------------------------
  const d = facts.duplicates;
  if (d) {
    if (isInt(d.same_transaction_id_count) && d.same_transaction_id_count > 1) {
      signals.push(signal("DUPLICATE_TRANSACTION_ID", { same_transaction_id_count: d.same_transaction_id_count }));
    }
    if (isInt(d.same_external_id_count) && d.same_external_id_count > 1) {
      signals.push(signal("DUPLICATE_EXTERNAL_ID", { same_external_id_count: d.same_external_id_count }));
    }
    if (isInt(d.same_fingerprint_count) && d.same_fingerprint_count >= THRESHOLDS.duplicates.fingerprint_count) {
      signals.push(
        signal("DUPLICATE_FINGERPRINT", {
          same_fingerprint_count: d.same_fingerprint_count,
          threshold: THRESHOLDS.duplicates.fingerprint_count,
        }),
      );
    }
  }

  // ---- click → conversion timing ------------------------------------------
  const clickedAt = parseIso(facts.timing?.clicked_at);
  const occurredAt = parseIso(facts.timing?.occurred_at);
  if (clickedAt !== null && occurredAt !== null) {
    const deltaSeconds = Math.floor((occurredAt - clickedAt) / 1000);
    if (deltaSeconds < 0) {
      signals.push(
        signal("CONVERSION_BEFORE_CLICK", {
          clicked_at: facts.timing?.clicked_at ?? null,
          occurred_at: facts.timing?.occurred_at ?? null,
          delta_seconds: deltaSeconds,
        }),
      );
    } else if (deltaSeconds < THRESHOLDS.timing.too_fast_seconds) {
      signals.push(
        signal("CLICK_TO_CONVERSION_TOO_FAST", {
          delta_seconds: deltaSeconds,
          threshold_seconds: THRESHOLDS.timing.too_fast_seconds,
        }),
      );
    }
  }

  // ---- geo ----------------------------------------------------------------
  const g = facts.geo;
  if (g) {
    const click = g.click_country ? g.click_country.toUpperCase() : null;
    const conv = g.conversion_country ? g.conversion_country.toUpperCase() : null;
    if (click && conv && click !== conv) {
      signals.push(signal("GEO_MISMATCH", { click_country: click, conversion_country: conv }));
    }
    if (g.restricted_countries && g.restricted_countries.length > 0) {
      const restricted = g.restricted_countries.map((c) => c.toUpperCase());
      const hit = [click, conv].find((c) => c !== null && restricted.includes(c));
      if (hit) signals.push(signal("GEO_RESTRICTED", { country: hit, restricted_countries: restricted.join(",") }));
    }
  }

  // ---- traffic source -----------------------------------------------------
  const t = facts.traffic_source;
  if (t) {
    if (t.referrer === null || t.referrer === "") {
      signals.push(signal("REFERRER_MISSING", { referrer: null }));
    } else if (typeof t.referrer === "string" && t.allowed_referrer_hosts && t.allowed_referrer_hosts.length > 0) {
      const host = hostOf(t.referrer);
      const allowed = t.allowed_referrer_hosts.map((h) => h.toLowerCase());
      const ok = host !== null && allowed.some((a) => host === a || host.endsWith("." + a));
      if (!ok) signals.push(signal("REFERRER_DISALLOWED", { referrer_host: host, allowed_hosts: allowed.join(",") }));
    }
    if (
      isInt(t.conversion_rate_bps) &&
      isInt(t.baseline_conversion_rate_bps) &&
      t.baseline_conversion_rate_bps >= THRESHOLDS.traffic_source.min_baseline_bps
    ) {
      // ratio in bps: 10_000 = 1×
      const ratioBps = Math.floor((t.conversion_rate_bps * 10_000) / t.baseline_conversion_rate_bps);
      if (ratioBps > THRESHOLDS.traffic_source.rate_multiplier_bps) {
        signals.push(
          signal("CONVERSION_RATE_ANOMALY", {
            conversion_rate_bps: t.conversion_rate_bps,
            baseline_conversion_rate_bps: t.baseline_conversion_rate_bps,
            ratio_bps: ratioBps,
            threshold_ratio_bps: THRESHOLDS.traffic_source.rate_multiplier_bps,
          }),
        );
      }
    }
  }

  // ---- automation indicators ---------------------------------------------
  const a = facts.automation;
  if (a) {
    if (a.user_agent === null || a.user_agent === "") {
      signals.push(signal("USER_AGENT_MISSING", { user_agent: null }));
    } else if (typeof a.user_agent === "string" && AUTOMATION_UA.test(a.user_agent)) {
      const m = AUTOMATION_UA.exec(a.user_agent);
      signals.push(
        signal("USER_AGENT_AUTOMATION", {
          matched_token: (m?.[1] ?? m?.[2])?.toLowerCase() ?? null,
          user_agent: a.user_agent.slice(0, 200),
        }),
      );
    }
    if (isInt(a.same_user_agent_click_count) && a.same_user_agent_click_count >= THRESHOLDS.automation.same_user_agent_clicks) {
      signals.push(
        signal("USER_AGENT_FANOUT", {
          same_user_agent_click_count: a.same_user_agent_click_count,
          threshold: THRESHOLDS.automation.same_user_agent_clicks,
        }),
      );
    }
  }

  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { rule_version: RULE_VERSION, score, level: levelFor(score), signals };
}
