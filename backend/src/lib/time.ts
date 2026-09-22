/**
 * UTC time helpers (PRD §15). All persisted timestamps are ISO-8601 UTC
 * strings with millisecond precision, matching the SQL defaults in the
 * migrations (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`).
 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function plusSecondsIso(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** True when `iso` is strictly in the past relative to `now`. */
export function isExpired(iso: string, now: Date = new Date()): boolean {
  return new Date(iso).getTime() <= now.getTime();
}
