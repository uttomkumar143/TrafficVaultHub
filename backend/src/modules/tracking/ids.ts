/**
 * Tracking identifiers & privacy-conscious sub-ID handling (Phase 3 Unit 1;
 * PRD §32 Click ID, §33 Tracking IDs, §34 Privacy-preserving tracking).
 *
 * Pure module — no I/O, no D1. Everything here is deterministic given the
 * platform CSPRNG (`crypto.randomUUID` / `crypto.getRandomValues`), which the
 * Workers runtime and Node both provide.
 *
 *   * `generateClickId()`  — the globally unique `click_id` (PRD §32). A v4
 *                            UUID: 122 random bits, collision-resistant across
 *                            every edge location without coordination. It IS
 *                            `clicks.id`; it is handed to the advertiser and
 *                            comes back on the postback (Unit 7).
 *   * `generateTrackingCode()` — the short public identifier the redirect
 *                            endpoint resolves (`/t/:code`, Unit 2). Crockford
 *                            base32 (no I/L/O/U — unambiguous when read aloud
 *                            or copied) from the CSPRNG; 12 chars = 60 bits.
 *                            Uniqueness is enforced by `tracking_links.code
 *                            UNIQUE`; the service retries on collision.
 *   * `sanitizeSubIds()`   — PRD §34: sub1–sub5 are opaque affiliate-supplied
 *                            strings. We trim, strip control characters,
 *                            bound them (≤ 255, matching the CHECK), reject
 *                            anything that LOOKS like personal data an
 *                            affiliate should never be passing through a
 *                            tracking link (an email address), and never
 *                            derive anything from them.
 *   * `hashSignal()`       — salted SHA-256 for `ip_hash` / `user_agent_hash`
 *                            (§34: the raw IP is never stored). Used by Unit 2.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Upper bound for a sub-ID value; mirrors `clicks.subN CHECK (length <= 255)`. */
export const SUB_ID_MAX_LENGTH = 255;

/** The five sub-ID slots of PRD §32, in order. */
export const SUB_ID_KEYS = ["sub1", "sub2", "sub3", "sub4", "sub5"] as const;
export type SubIdKey = (typeof SUB_ID_KEYS)[number];

/** Sub-IDs as stored: every slot present, `null` when not supplied. */
export type SubIds = Record<SubIdKey, string | null>;

/** Public tracking-code alphabet — Crockford base32 (no I, L, O, U). */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TRACKING_CODE_LENGTH = 12;
/** Mirrors `tracking_links.code CHECK (length(code) BETWEEN 6 AND 32)`. */
const TRACKING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6,32}$/;

/** Globally unique click id (PRD §32). */
export function generateClickId(): string {
  return crypto.randomUUID();
}

/**
 * Random public tracking code. `length` defaults to 12 (60 bits of entropy);
 * the caller must still treat a UNIQUE violation as "retry", never as an error
 * surfaced to the client.
 */
export function generateTrackingCode(length: number = TRACKING_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < 6 || length > 32) {
    throw new RangeError("tracking code length must be an integer between 6 and 32");
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

/**
 * True when `raw` has the shape of a code we mint (used by the public endpoint
 * to reject junk before any lookup — the cheapest possible early exit).
 * Accepts lower-case input; callers normalise with `normalizeTrackingCode`.
 */
export function isTrackingCode(raw: string): boolean {
  return TRACKING_CODE_PATTERN.test(raw.toUpperCase());
}

/** Upper-case the code so `/t/abc…` and `/t/ABC…` resolve to the same row. */
export function normalizeTrackingCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// ---- sub-IDs (PRD §32, §34) --------------------------------------------------

export type SubIdRejection = { key: SubIdKey; reason: "TOO_LONG" | "PERSONAL_DATA" | "INVALID_TYPE" };

export interface SanitizedSubIds {
  values: SubIds;
  /** Slots that were dropped and why. Empty when everything was accepted. */
  rejected: SubIdRejection[];
}

// Control characters (C0 + DEL) are never meaningful in a sub-ID and can break
// downstream log/CSV consumers; they are stripped rather than rejected.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Email-shaped values are the one class of personal data affiliates are
 * known to pass through sub-IDs by mistake (PRD §34: "no unnecessary personal
 * data"). Detection is deliberately simple — a local part, an `@`, a dotted
 * domain — so it never needs the value to be *valid*, only email-*shaped*.
 */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise affiliate-supplied sub-IDs into the five stored slots.
 *
 *   * Non-string values (numbers, objects) are rejected (INVALID_TYPE).
 *   * Values are trimmed and stripped of control characters; empty → null.
 *   * Values longer than 255 chars are rejected (TOO_LONG) — never silently
 *     truncated, because a truncated sub-ID is a wrong sub-ID.
 *   * Email-shaped values are rejected (PERSONAL_DATA).
 *
 * The caller decides whether a rejection is a 400 (management API, Unit 1) or
 * a silent drop (public redirect, Unit 2 — a bad sub-ID must never cost the
 * click, PRD §130).
 */
export function sanitizeSubIds(input: Partial<Record<SubIdKey, unknown>> | null | undefined): SanitizedSubIds {
  const values: SubIds = { sub1: null, sub2: null, sub3: null, sub4: null, sub5: null };
  const rejected: SubIdRejection[] = [];
  if (!input) return { values, rejected };
  for (const key of SUB_ID_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      rejected.push({ key, reason: "INVALID_TYPE" });
      continue;
    }
    const cleaned = raw.replace(CONTROL_CHARS, "").trim();
    if (cleaned.length === 0) continue;
    if (cleaned.length > SUB_ID_MAX_LENGTH) {
      rejected.push({ key, reason: "TOO_LONG" });
      continue;
    }
    if (EMAIL_SHAPED.test(cleaned)) {
      rejected.push({ key, reason: "PERSONAL_DATA" });
      continue;
    }
    values[key] = cleaned;
  }
  return { values, rejected };
}

/** Overlay click-time sub-IDs on the link's declared defaults (PRD §32 "unless overridden"). */
export function mergeSubIds(defaults: SubIds, overrides: SubIds): SubIds {
  const out: SubIds = { ...defaults };
  for (const key of SUB_ID_KEYS) {
    if (overrides[key] !== null) out[key] = overrides[key];
  }
  return out;
}

// ---- coarse-signal hashing (PRD §34) -----------------------------------------

/**
 * Salted SHA-256 of a request signal (IP, user agent). The salt is a Worker
 * secret; without it the hash cannot be brute-forced back to an IPv4 address.
 * Returns null for a missing signal so the column stays NULL, not a hash of "".
 */
export function hashSignal(value: string | null | undefined, salt: string): string | null {
  if (!value) return null;
  return bytesToHex(sha256(new TextEncoder().encode(`${salt}\u0000${value}`)));
}
