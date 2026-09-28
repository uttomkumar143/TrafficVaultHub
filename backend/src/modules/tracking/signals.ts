/**
 * Coarse request signals for a click (Phase 3 Unit 2; PRD §34 "privacy-
 * preserving tracking": no raw IP, no fingerprinting — a lighter signal
 * whenever it will do).
 *
 * Pure module. Turns the handful of request headers the redirect endpoint
 * sees into the `ClickSignals` columns of `clicks` (migration 0008):
 *
 *   country_code / region_code — Cloudflare's edge geo headers (`cf-ipcountry`,
 *                                `cf-region-code`), upper-cased, validated.
 *   device_type / os_family / browser_family — a deliberately COARSE
 *                                user-agent classification (family names
 *                                only, never versions/builds — a version string
 *                                is a fingerprint ingredient).
 *   language                   — first tag of `accept-language`, ≤ 16 chars.
 *   referrer_host              — host of the `referer` URL, never the path/query.
 *   ip_hash / user_agent_hash  — `hashSignal` with the `CLICK_SIGNAL_SALT`
 *                                secret. WITHOUT a salt nothing is hashed
 *                                (null): an unsalted hash of an IPv4 address is
 *                                reversible by brute force, so it is never
 *                                written.
 */
import type { ClickSignals, DeviceType } from "./repository";
import { hashSignal } from "./ids";

/** The request facts the parser needs; the handler maps `Request` headers onto it. */
export interface RequestSignals {
  ip: string | null;
  user_agent: string | null;
  accept_language: string | null;
  referer: string | null;
  country: string | null;
  region: string | null;
}

/** Header names, in one place (all lower-case: Hono/Fetch normalise). */
export const SIGNAL_HEADERS = {
  ip: "cf-connecting-ip",
  user_agent: "user-agent",
  accept_language: "accept-language",
  referer: "referer",
  country: "cf-ipcountry",
  region: "cf-region-code",
} as const;

export function requestSignalsFromHeaders(get: (name: string) => string | null | undefined): RequestSignals {
  const h = (n: string): string | null => {
    const v = get(n);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    ip: h(SIGNAL_HEADERS.ip),
    user_agent: h(SIGNAL_HEADERS.user_agent),
    accept_language: h(SIGNAL_HEADERS.accept_language),
    referer: h(SIGNAL_HEADERS.referer),
    country: h(SIGNAL_HEADERS.country),
    region: h(SIGNAL_HEADERS.region),
  };
}

const COUNTRY = /^[A-Z]{2}$/;
/** Cloudflare sends ISO-3166-2 region codes; keep only a short alphanumeric token. */
const REGION = /^[A-Z0-9-]{1,10}$/;
const LANGUAGE_MAX = 16;

export function coarseCountry(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  // Cloudflare uses "XX" (unknown) and "T1" (Tor) — neither is a country.
  if (!COUNTRY.test(v) || v === "XX" || v === "T1") return null;
  return v;
}

export function coarseRegion(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  return REGION.test(v) ? v : null;
}

/** First language tag of an Accept-Language header, lower-cased, bounded. */
export function coarseLanguage(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (first.length === 0 || first.length > LANGUAGE_MAX) return null;
  return /^[a-z0-9-]+$/.test(first) ? first : null;
}

/** Host only (lower-case, no port, no path). Invalid / missing → null. */
export function referrerHost(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface UserAgentFamilies {
  device_type: DeviceType | null;
  os_family: string | null;
  browser_family: string | null;
}

/**
 * Coarse UA classification. Family names only; order matters (e.g. "iPad"
 * before "Mobile", Edge before Chrome, Chrome before Safari). Unknown → OTHER
 * device with null families; missing UA → all null.
 */
export function classifyUserAgent(ua: string | null): UserAgentFamilies {
  if (!ua) return { device_type: null, os_family: null, browser_family: null };
  const s = ua.toLowerCase();

  let device_type: DeviceType;
  if (/smart-tv|smarttv|appletv|googletv|hbbtv|netcast|roku|tizen.*tv|web0s|bravia/.test(s)) device_type = "TV";
  else if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/.test(s)) device_type = "TABLET";
  else if (/mobile|iphone|ipod|android|windows phone|blackberry|opera mini/.test(s)) device_type = "MOBILE";
  else if (/windows nt|macintosh|mac os x|x11|linux|cros/.test(s)) device_type = "DESKTOP";
  else device_type = "OTHER";

  let os_family: string | null = null;
  if (/windows phone/.test(s)) os_family = "Windows Phone";
  else if (/windows nt/.test(s)) os_family = "Windows";
  else if (/iphone|ipad|ipod/.test(s)) os_family = "iOS";
  else if (/mac os x|macintosh/.test(s)) os_family = "macOS";
  else if (/android/.test(s)) os_family = "Android";
  else if (/cros/.test(s)) os_family = "ChromeOS";
  else if (/linux|x11/.test(s)) os_family = "Linux";

  let browser_family: string | null = null;
  if (/edg(e|a|ios)?\//.test(s)) browser_family = "Edge";
  else if (/opr\/|opera/.test(s)) browser_family = "Opera";
  else if (/samsungbrowser/.test(s)) browser_family = "Samsung Internet";
  else if (/firefox|fxios/.test(s)) browser_family = "Firefox";
  else if (/chrome|crios|chromium/.test(s)) browser_family = "Chrome";
  else if (/safari/.test(s)) browser_family = "Safari";

  return { device_type, os_family, browser_family };
}

/**
 * Everything the click row stores about the request. `salt` is the
 * `CLICK_SIGNAL_SALT` secret; null/empty → `ip_hash`/`user_agent_hash` stay null.
 */
export function clickSignals(req: RequestSignals, salt: string | null | undefined): ClickSignals {
  const ua = classifyUserAgent(req.user_agent);
  const hash = (v: string | null): string | null => (salt ? hashSignal(v, salt) : null);
  return {
    country_code: coarseCountry(req.country),
    region_code: coarseRegion(req.region),
    device_type: ua.device_type,
    os_family: ua.os_family,
    browser_family: ua.browser_family,
    language: coarseLanguage(req.accept_language),
    ip_hash: hash(req.ip),
    user_agent_hash: hash(req.user_agent),
    referrer_host: referrerHost(req.referer),
  };
}
