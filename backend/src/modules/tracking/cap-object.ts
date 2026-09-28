/**
 * CapObjectCore — the brain of the cap Durable Object (Phase 3 Unit 4;
 * PRD §44, §45, §107). Runtime-agnostic: it talks to storage through the tiny
 * `CapObjectStorage` port so the same code runs inside a real Durable Object
 * (`workers/coordinator-object.ts`) and in plain vitest with `MemoryCapStorage`.
 *
 * ONE core instance == ONE offer. The DO id is derived from the offer id
 * (`idFromName(offer_id)`), so every reserve for an offer lands on the same
 * single-threaded object — that is what makes check-and-increment atomic
 * across all edge locations.
 *
 * Atomicity contract (the reason this file exists):
 *   `reserve()` performs the cap check AND the increment in ONE synchronous
 *   critical section — `caps.reserve()` on the in-memory state — with NO
 *   `await` between reading a counter and bumping it. Concurrent callers are
 *   therefore serialised by the JS event loop even before the DO's own
 *   input-gate; `Promise.all` of N reserves can never over-admit. The
 *   storage write that follows is awaited AFTER the decision is final; DO
 *   output-gates hold the response until the write is durable, so an
 *   admitted reserve is never lost on eviction.
 *
 * Lifecycle:
 *   load()           — lazily rebuild in-memory state from storage on first
 *                      use (cold start / after eviction). Idempotent.
 *   bindMeta()       — remember (offer_id, organization_id) so the snapshot is
 *                      self-describing; a request for a DIFFERENT offer_id on
 *                      an already-bound object is rejected (defence against a
 *                      mis-derived DO id silently mixing two offers' counters).
 *   reserve()        — atomic check+increment, persists the snapshot, arms the
 *                      flush alarm.
 *   status()         — read-only counters (no persistence).
 *   flush()          — alarm handler body: prune closed periods, write the
 *                      snapshot to D1 via `CapStore`, re-arm if state remains.
 */
import { CapStore, parseCapSnapshot, type CapSnapshot, CAP_SNAPSHOT_VERSION } from "./cap-store";
import {
  capStateFromRows,
  emptyCapState,
  pruneClosedPeriods,
  reserve as reserveCore,
  status as statusCore,
  type CapCounter,
  type CapDecision,
  type CapEvent,
  type CapLimits,
  type CapState,
} from "./caps";

/** Storage key for the snapshot blob inside the DO's transactional storage. */
export const SNAPSHOT_KEY = "cap:snapshot:v1";

/** Default delay before the counters are flushed to D1 (batching many reserves into one write). */
export const DEFAULT_FLUSH_DELAY_MS = 5_000;

/**
 * The subset of `DurableObjectStorage` the core needs. Kept minimal so a
 * 20-line in-memory fake is a faithful test double.
 */
export interface CapObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Thrown when a request names a different offer than the one this object is bound to. */
export class CapObjectMismatchError extends Error {
  constructor(
    readonly bound: string,
    readonly requested: string,
  ) {
    super("cap object is bound to a different offer");
    this.name = "CapObjectMismatchError";
  }
}

export interface CapObjectCoreOptions {
  /** Optional D1 store for the alarm flush. Absent → the alarm only prunes (tests, or D1-less dev). */
  store?: CapStore | null;
  flushDelayMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export interface CapObjectStatus {
  offer_id: string | null;
  organization_id: string | null;
  counters: CapCounter[];
}

export class CapObjectCore {
  private state: CapState = emptyCapState();
  private offerId: string | null = null;
  private organizationId: string | null = null;
  private loaded: Promise<void> | null = null;
  /** True when the in-memory state has changes not yet flushed to D1. */
  private dirty = false;
  private readonly store: CapStore | null;
  private readonly flushDelayMs: number;
  private readonly clock: () => Date;

  constructor(
    private readonly storage: CapObjectStorage,
    options: CapObjectCoreOptions = {},
  ) {
    this.store = options.store ?? null;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.clock = options.now ?? (() => new Date());
  }

  // ---- lifecycle -----------------------------------------------------------------

  /** Rebuild state from storage exactly once per in-memory lifetime. */
  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.doLoad();
    return this.loaded;
  }

  private async doLoad(): Promise<void> {
    const raw = await this.storage.get(SNAPSHOT_KEY);
    const snap = parseCapSnapshot(raw);
    if (snap) {
      this.offerId = snap.offer_id;
      this.organizationId = snap.organization_id;
      this.state = capStateFromRows(snap.counters);
      return;
    }
    if (raw !== undefined) {
      // Corrupt blob: drop it rather than trust it. Counters restart from the
      // D1 snapshot (if any) on the next bindMeta, which is the persisted truth.
      await this.storage.delete(SNAPSHOT_KEY);
    }
  }

  /**
   * Bind this object to an offer. First call fixes the identity; later calls
   * must agree. When the object has no state yet and a D1 store is present,
   * the persisted counters are pulled in so a brand-new DO does not restart
   * an exhausted offer at zero.
   */
  async bindMeta(offerId: string, organizationId: string): Promise<void> {
    await this.load();
    if (this.offerId !== null && this.offerId !== offerId) {
      throw new CapObjectMismatchError(this.offerId, offerId);
    }
    if (this.offerId === null) {
      this.offerId = offerId;
      this.organizationId = organizationId;
      if (this.store && this.state.size === 0) {
        const rows = await this.store.load(offerId);
        if (rows.length > 0) this.state = capStateFromRows(rows);
      }
      await this.storage.put(SNAPSHOT_KEY, this.snapshot());
    } else if (this.organizationId !== organizationId) {
      // Same offer, org changed (should not happen — offers never move orgs);
      // fail closed rather than write a snapshot under the wrong tenant.
      throw new CapObjectMismatchError(this.offerId, offerId);
    }
  }

  // ---- operations ---------------------------------------------------------------

  /**
   * Atomic check-and-increment. The decision is computed synchronously on the
   * in-memory state; only THEN is the snapshot persisted. Callers on the same
   * object are serialised, so no two reserves can both see `current < limit`
   * for the last slot.
   */
  async reserve(offerId: string, organizationId: string, limits: CapLimits, event: CapEvent, now?: Date): Promise<CapDecision> {
    await this.bindMeta(offerId, organizationId);
    // ---- critical section: no await from here until the decision exists ----
    const decision = reserveCore(this.state, limits, event, now ?? this.clock());
    // ---- end critical section ----
    if (decision.allowed) {
      this.dirty = true;
      await this.storage.put(SNAPSHOT_KEY, this.snapshot());
      await this.scheduleFlush();
    }
    return decision;
  }

  /** Read-only counters for an event kind. Never persists, never opens periods. */
  async status(offerId: string, organizationId: string, limits: CapLimits, kind: CapEvent["kind"], now?: Date): Promise<CapObjectStatus> {
    await this.bindMeta(offerId, organizationId);
    return {
      offer_id: this.offerId,
      organization_id: this.organizationId,
      counters: statusCore(this.state, limits, kind, now ?? this.clock()),
    };
  }

  /** Arm the flush alarm if none is pending. */
  async scheduleFlush(): Promise<void> {
    const pending = await this.storage.getAlarm();
    if (pending === null) await this.storage.setAlarm(this.clock().getTime() + this.flushDelayMs);
  }

  /**
   * Alarm body. Prunes closed periods (their final values are still flushed
   * this once), writes the snapshot to D1 when a store is bound, then re-arms
   * only if something is still dirty (a flush that failed keeps `dirty`).
   */
  async flush(now?: Date): Promise<{ flushed: number; pruned: number }> {
    await this.load();
    const at = now ?? this.clock();
    const pruned = pruneClosedPeriods(this.state, at);
    const toFlush: CapCounter[] = [...pruned, ...Array.from(this.state.values())];
    let flushed = 0;
    if (this.offerId !== null && this.organizationId !== null) {
      if (this.store && (this.dirty || pruned.length > 0)) {
        await this.store.flush(
          { v: CAP_SNAPSHOT_VERSION, offer_id: this.offerId, organization_id: this.organizationId, counters: toFlush },
          at.toISOString(),
        );
        flushed = toFlush.length;
      }
      this.dirty = false;
      await this.storage.put(SNAPSHOT_KEY, this.snapshot());
    }
    return { flushed, pruned: pruned.length };
  }

  // ---- helpers -----------------------------------------------------------------------

  private snapshot(): CapSnapshot {
    return {
      v: CAP_SNAPSHOT_VERSION,
      offer_id: this.offerId ?? "",
      organization_id: this.organizationId ?? "",
      counters: Array.from(this.state.values()).map((c) => ({ ...c })),
    };
  }
}

// ---- test double -------------------------------------------------------------------

/**
 * In-memory `CapObjectStorage`. Values are deep-copied through JSON on both
 * sides, exactly like real DO storage (structured clone), so a core can never
 * keep a live reference into "persisted" state.
 */
export class MemoryCapStorage implements CapObjectStorage {
  private readonly map = new Map<string, string>();
  private alarm: number | null = null;
  /** Test hook: number of `put` calls observed. */
  puts = 0;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.puts += 1;
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  /** Test hook: simulate the runtime firing the alarm (clears it before the handler runs, like the platform). */
  takeAlarm(): number | null {
    const a = this.alarm;
    this.alarm = null;
    return a;
  }

  /** Test hook: write raw (possibly corrupt) bytes. */
  putRaw(key: string, json: string): void {
    this.map.set(key, json);
  }
}
