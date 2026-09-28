/**
 * Offer eligibility cache (Phase 3 Unit 5; PRD §45, §46, §107, §129).
 *
 * Purpose: the public redirect (Unit 2) and the SmartLink engine (Units 3/6)
 * evaluate `offerRoutability` for one or many offers per click. This module
 * keeps the MINIMAL routing facts (`OfferRoutingFacts` minus the per-affiliate
 * grant) in KV so the hot path can skip the D1 join on a hit, and keeps the
 * per-(offer, affiliate) grant status under a second key.
 *
 * Correctness model — "a stale entry must NEVER serve an inactive offer":
 *   1. Only ROUTABLE offers are ever stored. `put` with facts that are not
 *      eligible right now is a delete, not a write. Negative results are never
 *      cached — a miss always falls through to D1, the truth.
 *   2. `get` re-evaluates `offerRoutability` on the cached facts at READ time
 *      (so a cached targeting window that has since closed is a miss), checks
 *      the entry's own `cached_at + ttl` (independent of KV's expiration,
 *      which is only a backstop), and strictly parses the blob. Anything
 *      doubtful → miss. A KV transport error → miss. `get` never throws.
 *   3. Invalidation is SYNCHRONOUS (awaited) and is called by `OfferService`
 *      BEFORE and AFTER the D1 write of any change that can affect routing
 *      (see `OfferService` for the trigger list). If the pre-write delete
 *      fails, the write does not happen (fail closed: D1 and cache stay
 *      consistent). If the post-write delete fails, the caller surfaces an
 *      error — it never reports success while the cache may be stale — and
 *      the entry still dies at `ttl`.
 *   4. The TTL is SHORT (default 60 s) and is a backstop only; invalidation is
 *      the mechanism.
 *
 * Pure module: no D1, no Workers types beyond the structural `KvPort`, which
 * `KVNamespace` satisfies directly. `MemoryKv` is the test double (clock +
 * failure injection).
 */
import type { AccessGrantStatus, AccessMode, OfferStatus } from "../offers/state-machine";
import { isAccessGrantStatus, isAccessMode, isOfferStatus } from "../offers/state-machine";
import { offerRoutability, type OfferRoutingFacts } from "./eligibility";

/** Structural subset of `KVNamespace` used here (string values only). */
export interface KvPort {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ELIGIBILITY_CACHE_VERSION = 1 as const;
/** Backstop TTL. KV enforces a 60 s minimum on `expirationTtl`. */
export const DEFAULT_ELIGIBILITY_TTL_SECONDS = 60;
export const KV_MIN_TTL_SECONDS = 60;

export const OFFER_KEY_PREFIX = "elig:offer:";
export const GRANT_KEY_PREFIX = "elig:grant:";

export function offerCacheKey(offerId: string): string {
  return `${OFFER_KEY_PREFIX}${offerId}`;
}
export function grantCacheKey(offerId: string, affiliateOrganizationId: string): string {
  return `${GRANT_KEY_PREFIX}${offerId}:${affiliateOrganizationId}`;
}

/** Offer-level routing facts (everything in `OfferRoutingFacts` except the caller-specific grant). */
export interface CachedOfferFacts {
  offer_id: string;
  /** Advertiser organization that owns the offer (for click fan-out; never trusted from a client). */
  organization_id: string;
  status: OfferStatus;
  access_mode: AccessMode;
  current_version_id: string | null;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  /** Revision marker of the offer row (its `updated_at`) at the time of caching. */
  epoch: string;
}

interface OfferEntry extends CachedOfferFacts {
  v: typeof ELIGIBILITY_CACHE_VERSION;
  cached_at: string;
}

interface GrantEntry {
  v: typeof ELIGIBILITY_CACHE_VERSION;
  offer_id: string;
  affiliate_organization_id: string;
  /** null = no grant row exists (a valid, cacheable fact for PUBLIC offers). */
  grant_status: AccessGrantStatus | null;
  cached_at: string;
}

export interface EligibilityCacheOptions {
  /** Entry lifetime in seconds (also the KV backstop, clamped to KV's minimum). Default 60. */
  ttlSeconds?: number;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Thrown by `invalidate*` when KV refused the delete — the caller MUST fail closed. */
export class EligibilityCacheError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EligibilityCacheError";
  }
}

/** Compose a full `OfferRoutingFacts` from cached offer facts + a grant status. */
export function toRoutingFacts(offer: CachedOfferFacts, grant: AccessGrantStatus | null): OfferRoutingFacts {
  return {
    status: offer.status,
    access_mode: offer.access_mode,
    current_version_id: offer.current_version_id,
    destination_url: offer.destination_url,
    targeting_starts_at: offer.targeting_starts_at,
    targeting_ends_at: offer.targeting_ends_at,
    grant_status: grant,
  };
}

/**
 * True when the OFFER-level facts alone would route (grant ignored). Used to
 * decide whether an entry may be stored / served at all.
 */
function offerLevelRoutable(facts: CachedOfferFacts, now: Date): boolean {
  // PUBLIC needs no grant; for every other mode assume APPROVED here — the
  // grant is checked separately by the caller with `getGrant` or D1.
  const r = offerRoutability(toRoutingFacts(facts, "APPROVED"), now);
  return r.eligible;
}

export class EligibilityCache {
  private readonly ttlMs: number;
  private readonly kvTtl: number;
  private readonly now: () => Date;

  constructor(
    private readonly kv: KvPort,
    options: EligibilityCacheOptions = {},
  ) {
    const ttl = options.ttlSeconds ?? DEFAULT_ELIGIBILITY_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("ttlSeconds must be a positive integer");
    this.ttlMs = ttl * 1000;
    this.kvTtl = Math.max(KV_MIN_TTL_SECONDS, ttl);
    this.now = options.now ?? (() => new Date());
  }

  // ---- offer facts ------------------------------------------------------------

  /**
   * Cached offer facts, or null on miss / expired / not-routable / malformed /
   * transport error. Never throws; never returns an entry whose offer would
   * not route right now.
   */
  async getOffer(offerId: string): Promise<CachedOfferFacts | null> {
    let raw: string | null;
    try {
      raw = await this.kv.get(offerCacheKey(offerId));
    } catch {
      return null;
    }
    if (raw === null) return null;
    const entry = parseOfferEntry(raw);
    if (!entry || entry.offer_id !== offerId) return null;
    const now = this.now();
    if (this.isExpired(entry.cached_at, now)) return null;
    if (!offerLevelRoutable(entry, now)) return null;
    const { v: _v, cached_at: _c, ...facts } = entry;
    return facts;
  }

  /**
   * Store offer facts if — and only if — the offer routes right now. Facts
   * that do not route DELETE any existing entry instead (never cache a
   * negative). Write failures are swallowed: the cache is an accelerator and
   * a failed write only costs a D1 read; correctness never depends on `put`.
   */
  async putOffer(facts: CachedOfferFacts): Promise<void> {
    const now = this.now();
    try {
      if (!offerLevelRoutable(facts, now)) {
        await this.kv.delete(offerCacheKey(facts.offer_id));
        return;
      }
      const entry: OfferEntry = { v: ELIGIBILITY_CACHE_VERSION, ...facts, cached_at: now.toISOString() };
      await this.kv.put(offerCacheKey(facts.offer_id), JSON.stringify(entry), { expirationTtl: this.kvTtl });
    } catch {
      // accelerator only — see doc comment
    }
  }

  /** Synchronous invalidation of an offer's facts. Throws `EligibilityCacheError` on failure (caller fails closed). */
  async invalidateOffer(offerId: string): Promise<void> {
    try {
      await this.kv.delete(offerCacheKey(offerId));
    } catch (e) {
      throw new EligibilityCacheError(`eligibility cache invalidation failed for offer ${offerId}`, e);
    }
  }

  // ---- grant status -------------------------------------------------------------

  /**
   * Cached grant status for (offer, affiliate org). Returns `undefined` on
   * miss (caller must read D1) and `{ grant_status }` on hit — `null` inside
   * is a real cached fact ("no grant row"). Never throws.
   */
  async getGrant(offerId: string, affiliateOrganizationId: string): Promise<{ grant_status: AccessGrantStatus | null } | undefined> {
    let raw: string | null;
    try {
      raw = await this.kv.get(grantCacheKey(offerId, affiliateOrganizationId));
    } catch {
      return undefined;
    }
    if (raw === null) return undefined;
    const entry = parseGrantEntry(raw);
    if (!entry || entry.offer_id !== offerId || entry.affiliate_organization_id !== affiliateOrganizationId) return undefined;
    if (this.isExpired(entry.cached_at, this.now())) return undefined;
    return { grant_status: entry.grant_status };
  }

  /** Store a grant status. Write failures are swallowed (accelerator only). */
  async putGrant(offerId: string, affiliateOrganizationId: string, grant: AccessGrantStatus | null): Promise<void> {
    const entry: GrantEntry = {
      v: ELIGIBILITY_CACHE_VERSION,
      offer_id: offerId,
      affiliate_organization_id: affiliateOrganizationId,
      grant_status: grant,
      cached_at: this.now().toISOString(),
    };
    try {
      await this.kv.put(grantCacheKey(offerId, affiliateOrganizationId), JSON.stringify(entry), { expirationTtl: this.kvTtl });
    } catch {
      // accelerator only
    }
  }

  /** Synchronous invalidation of one (offer, affiliate org) grant. Throws `EligibilityCacheError` on failure. */
  async invalidateGrant(offerId: string, affiliateOrganizationId: string): Promise<void> {
    try {
      await this.kv.delete(grantCacheKey(offerId, affiliateOrganizationId));
    } catch (e) {
      throw new EligibilityCacheError(`eligibility cache invalidation failed for grant ${offerId}/${affiliateOrganizationId}`, e);
    }
  }

  private isExpired(cachedAt: string, now: Date): boolean {
    const t = Date.parse(cachedAt);
    if (!Number.isFinite(t)) return true;
    return now.getTime() - t >= this.ttlMs;
  }
}

// ---- strict parsers (no zod on the hot path; a hand-rolled allow-list) -------

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function parseOfferEntry(raw: string): OfferEntry | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const o = j as Record<string, unknown>;
  if (o.v !== ELIGIBILITY_CACHE_VERSION) return null;
  if (typeof o.offer_id !== "string" || o.offer_id.length === 0) return null;
  if (typeof o.organization_id !== "string" || o.organization_id.length === 0) return null;
  if (typeof o.status !== "string" || !isOfferStatus(o.status)) return null;
  if (typeof o.access_mode !== "string" || !isAccessMode(o.access_mode)) return null;
  if (!isNullableString(o.current_version_id)) return null;
  if (!isNullableString(o.destination_url)) return null;
  if (!isNullableString(o.targeting_starts_at)) return null;
  if (!isNullableString(o.targeting_ends_at)) return null;
  if (typeof o.epoch !== "string") return null;
  if (typeof o.cached_at !== "string") return null;
  return {
    v: ELIGIBILITY_CACHE_VERSION,
    offer_id: o.offer_id,
    organization_id: o.organization_id,
    status: o.status,
    access_mode: o.access_mode,
    current_version_id: o.current_version_id,
    destination_url: o.destination_url,
    targeting_starts_at: o.targeting_starts_at,
    targeting_ends_at: o.targeting_ends_at,
    epoch: o.epoch,
    cached_at: o.cached_at,
  };
}

function parseGrantEntry(raw: string): GrantEntry | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const o = j as Record<string, unknown>;
  if (o.v !== ELIGIBILITY_CACHE_VERSION) return null;
  if (typeof o.offer_id !== "string" || typeof o.affiliate_organization_id !== "string") return null;
  if (!(o.grant_status === null || (typeof o.grant_status === "string" && isAccessGrantStatus(o.grant_status)))) return null;
  if (typeof o.cached_at !== "string") return null;
  return {
    v: ELIGIBILITY_CACHE_VERSION,
    offer_id: o.offer_id,
    affiliate_organization_id: o.affiliate_organization_id,
    grant_status: o.grant_status as AccessGrantStatus | null,
    cached_at: o.cached_at,
  };
}

// ---- test double ------------------------------------------------------------------

/**
 * In-memory `KvPort` with a controllable clock (honours `expirationTtl`) and
 * per-operation failure injection. Test-only.
 */
export class MemoryKv implements KvPort {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  /** When set, the named operations throw. */
  failing: { get?: boolean; put?: boolean; delete?: boolean } = {};
  readonly calls: { op: "get" | "put" | "delete"; key: string }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: "get", key });
    if (this.failing.get) throw new Error("kv get failed");
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && this.now().getTime() >= e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.calls.push({ op: "put", key });
    if (this.failing.put) throw new Error("kv put failed");
    const ttl = options?.expirationTtl;
    this.store.set(key, { value, expiresAt: ttl ? this.now().getTime() + ttl * 1000 : null });
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ op: "delete", key });
    if (this.failing.delete) throw new Error("kv delete failed");
    this.store.delete(key);
  }

  /** Raw peek for assertions (ignores expiry). */
  peek(key: string): string | null {
    return this.store.get(key)?.value ?? null;
  }
  /** Raw write for corrupt-blob tests. */
  poke(key: string, value: string): void {
    this.store.set(key, { value, expiresAt: null });
  }
  get size(): number {
    return this.store.size;
  }
}
