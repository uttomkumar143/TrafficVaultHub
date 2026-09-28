/**
 * Cap counter snapshots (Phase 3 Unit 4; PRD §44, §45, §107).
 *
 * The Durable Object (`workers/coordinator-object.ts` via `cap-object.ts`)
 * owns the LIVE count for an offer. This module is the persistence edge in
 * both directions:
 *
 *   * DO storage  — `CapSnapshot` is the JSON shape written to the DO's own
 *                   transactional storage on every reserve (durable across
 *                   eviction, no D1 round-trip on the hot path).
 *   * D1          — `CapStore` flushes the counters to `offer_cap_counters`
 *                   (migration 0008) on the DO alarm, so reporting, the
 *                   eligibility cache (Unit 5) and the SmartLink engine (Unit 6)
 *                   can read exhaustion without talking to the DO, and so a
 *                   brand-new DO can rebuild its state if its storage is empty.
 *
 * Columns used are EXACTLY those of `offer_cap_counters` in 0008:
 *   id, offer_id, organization_id, cap_type, period_key, currency, limit_value,
 *   current_value, exhausted_at, last_flushed_at, created_at, updated_at
 * with `UNIQUE (offer_id, cap_type, period_key)` as the upsert key.
 *
 * `current_value` is written with GREATEST-wins semantics (`MAX(excluded,
 * current)`): a counter only ever grows within a period, so a late flush from
 * an older snapshot can never roll a persisted count backwards.
 */
import type { CapCounter, CapType } from "./caps";
import { CAP_TYPES } from "./caps";

/** Schema version of the JSON blob kept in DO storage; bump on shape change. */
export const CAP_SNAPSHOT_VERSION = 1 as const;

/** Persisted DO state for ONE offer. */
export interface CapSnapshot {
  v: typeof CAP_SNAPSHOT_VERSION;
  offer_id: string;
  organization_id: string;
  counters: CapCounter[];
}

/** Validate an untrusted blob read back from storage; `null` if it is not a usable snapshot. */
export function parseCapSnapshot(raw: unknown): CapSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["v"] !== CAP_SNAPSHOT_VERSION) return null;
  if (typeof o["offer_id"] !== "string" || typeof o["organization_id"] !== "string") return null;
  if (!Array.isArray(o["counters"])) return null;
  const counters: CapCounter[] = [];
  for (const c of o["counters"]) {
    const parsed = parseCounter(c);
    if (!parsed) return null;
    counters.push(parsed);
  }
  return { v: CAP_SNAPSHOT_VERSION, offer_id: o["offer_id"], organization_id: o["organization_id"], counters };
}

function isCapType(v: unknown): v is CapType {
  return typeof v === "string" && (CAP_TYPES as readonly string[]).includes(v);
}

function parseCounter(raw: unknown): CapCounter | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isCapType(c["cap_type"])) return null;
  if (typeof c["period_key"] !== "string" || c["period_key"].length === 0) return null;
  const limit = c["limit_value"];
  if (!(limit === null || (Number.isSafeInteger(limit) && (limit as number) >= 0))) return null;
  const cur = c["current_value"];
  if (!Number.isSafeInteger(cur) || (cur as number) < 0) return null;
  const currency = c["currency"];
  if (!(currency === null || (typeof currency === "string" && currency.length === 3))) return null;
  const ex = c["exhausted_at"];
  if (!(ex === null || typeof ex === "string")) return null;
  return {
    cap_type: c["cap_type"],
    period_key: c["period_key"],
    limit_value: limit as number | null,
    current_value: cur as number,
    currency: currency as string | null,
    exhausted_at: ex as string | null,
  };
}

/** Row shape of `offer_cap_counters` as read back from D1. */
export interface CapCounterRow extends CapCounter {
  id: string;
  offer_id: string;
  organization_id: string;
  last_flushed_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * D1 side of the snapshot. Deliberately tiny: one upsert per counter, one
 * read per offer. Never called on the redirect hot path — only from the DO
 * alarm (flush) and the DO cold start (rebuild when its storage is empty).
 */
export class CapStore {
  constructor(private readonly db: D1Database) {}

  /** Build the upsert for one counter without executing it (so the DO can batch). */
  upsertStatement(offerId: string, organizationId: string, c: CapCounter, flushedAt: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO offer_cap_counters
           (id, offer_id, organization_id, cap_type, period_key, currency, limit_value, current_value,
            exhausted_at, last_flushed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (offer_id, cap_type, period_key) DO UPDATE SET
           currency        = excluded.currency,
           limit_value     = excluded.limit_value,
           current_value   = MAX(excluded.current_value, offer_cap_counters.current_value),
           exhausted_at    = COALESCE(offer_cap_counters.exhausted_at, excluded.exhausted_at),
           last_flushed_at = excluded.last_flushed_at,
           updated_at      = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        offerId,
        organizationId,
        c.cap_type,
        c.period_key,
        c.currency,
        c.limit_value,
        c.current_value,
        c.exhausted_at,
        flushedAt,
        flushedAt,
        flushedAt,
      );
  }

  /** Flush every counter of a snapshot in ONE D1 batch (all-or-nothing). */
  async flush(snapshot: CapSnapshot, flushedAt: string): Promise<void> {
    if (snapshot.counters.length === 0) return;
    await this.db.batch(
      snapshot.counters.map((c) => this.upsertStatement(snapshot.offer_id, snapshot.organization_id, c, flushedAt)),
    );
  }

  /** All persisted counters for an offer (cold-start rebuild; reporting). */
  async load(offerId: string): Promise<CapCounterRow[]> {
    const res = await this.db
      .prepare(
        `SELECT id, offer_id, organization_id, cap_type, period_key, currency, limit_value, current_value,
                exhausted_at, last_flushed_at, created_at, updated_at
           FROM offer_cap_counters
          WHERE offer_id = ?
          ORDER BY cap_type, period_key`,
      )
      .bind(offerId)
      .all<CapCounterRow>();
    return res.results;
  }
}
