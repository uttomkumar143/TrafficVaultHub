/**
 * Display-only money helpers (PRD §25, §14).
 *
 * Amounts arrive from the server as integer minor units + a 3-letter
 * currency. This module ONLY formats them for humans; it never performs
 * arithmetic, never rounds a business value, and never produces a float
 * that is sent back to the server. The minor→major split is done with
 * integer division and string padding, not with `/ 100`.
 */

/** Minor-unit exponent per ISO 4217 currency (default 2). Extend as needed. */
const MINOR_DIGITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  IQD: 3,
  TND: 3,
  LYD: 3,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/**
 * `4000, "USD"` → `"USD 40.00"`; `1234567, "JPY"` → `"JPY 1,234,567"`.
 * Uses integer string manipulation only; safe for the full integer range the
 * server accepts (≤ 10^18 fits `Number.isSafeInteger` after zod validation).
 */
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isInteger(amountMinor)) return `${currency.toUpperCase()} —`;
  const digits = minorDigits(currency);
  const negative = amountMinor < 0;
  const abs = BigInt(Math.abs(amountMinor)).toString();
  let whole: string;
  let fraction: string;
  if (digits === 0) {
    whole = abs;
    fraction = "";
  } else {
    const padded = abs.padStart(digits + 1, "0");
    whole = padded.slice(0, padded.length - digits);
    fraction = padded.slice(padded.length - digits);
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency.toUpperCase()} ${grouped}${fraction ? "." + fraction : ""}`;
}

/** `2500` → `"25.00%"` (basis points → percent, string math only). */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps)) return "—";
  const padded = Math.abs(bps).toString().padStart(3, "0");
  const whole = padded.slice(0, padded.length - 2);
  const fraction = padded.slice(padded.length - 2);
  return `${bps < 0 ? "-" : ""}${whole}.${fraction}%`;
}

/**
 * Parse a user-typed major-unit string ("40", "40.5", "40.00") into integer
 * minor units WITHOUT floating point. Returns null when the input is not a
 * plain decimal number or has more fractional digits than the currency allows.
 */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  const match = /^(\d{1,15})(?:\.(\d{0,3}))?$/.exec(trimmed);
  if (!match) return null;
  const digits = minorDigits(currency);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  const minorString = whole + fraction.padEnd(digits, "0");
  const value = Number(minorString);
  return Number.isSafeInteger(value) ? value : null;
}

/** Inverse of `parseMajorToMinor` for pre-filling inputs (no float involved). */
export function minorToMajorString(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  const abs = Math.abs(amountMinor).toString().padStart(digits + 1, "0");
  if (digits === 0) return `${amountMinor < 0 ? "-" : ""}${abs}`;
  return `${amountMinor < 0 ? "-" : ""}${abs.slice(0, abs.length - digits)}.${abs.slice(abs.length - digits)}`;
}

/** `2592000` → `"30 days"`; falls back to hours/minutes/seconds. */
export function formatSeconds(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) return "—";
  if (seconds % 86_400 === 0) {
    const d = seconds / 86_400;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const h = seconds / 3_600;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}
