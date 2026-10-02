/**
 * API-key module — policy layer (Phase 6 Unit 3; PRD §73, §115, §116). SQL
 * lives in `repository.ts`; this class decides WHO may do WHAT and keeps the
 * state machine honest BEFORE the 0012 triggers see the statement, so illegal
 * transitions surface as clean 409s rather than raw SQLite aborts.
 *
 * Secret handling (PRD §115 "secret never returned to frontend"):
 *   * A key is `<prefix>.<secret>`: `tvh_k_` + 10 base64url chars (public,
 *     indexable, UNIQUE) and 32 CSPRNG bytes base64url (private).
 *   * Only SHA-256(full key) is stored (`key_hash`); the last 4 chars are
 *     kept as `secret_hint` for display. The full key is returned exactly
 *     ONCE — from `create` / `rotate` — and never logged or audited.
 *   * `list` / `get` return `PublicApiKey`, built from a projection that
 *     cannot contain the hash.
 *
 * State machine (mirrors `trg_api_keys_legal_transition`):
 *   ACTIVE  → ROTATED | REVOKED | EXPIRED
 *   ROTATED → REVOKED | EXPIRED
 *   REVOKED, EXPIRED are terminal.
 * Expiry is read-time: `expires_at` is a column, there is no scheduler in
 * the schema, so any read/authenticate that observes a past `expires_at`
 * on a live row flips it to EXPIRED first.
 *
 * Error codes: API_KEY_NOT_FOUND 404 · API_KEY_NOT_ACTIVE 409 ·
 *   API_KEY_FINAL 409 · FORBIDDEN 403 · VALIDATION_ERROR 400
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf } from "../../lib/tenant-scope";
import { isExpired, nowIso } from "../../lib/time";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import { randomBytes, sha256Hex, toBase64Url } from "../auth/crypto-utils";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { PermissionKey } from "../rbac/permissions";
import { API_KEY_STATUSES, type ApiKeyInsert, type ApiKeyRepository, type ApiKeyRow, type ApiKeyStatus } from "./repository";

/** Public prefix that lets logs / support identify a key without the secret. */
export const API_KEY_PREFIX = "tvh_k_";
const PREFIX_RANDOM_CHARS = 10; // → key_prefix length 16 (CHECK: 8..16)
const SECRET_BYTES = 32;
/** Rotating keeps the predecessor usable for this long so clients can switch. */
export const ROTATION_GRACE_SECONDS = 24 * 3600;
export const NAME_MAX_LENGTH = 120;
export const SCOPE_MAX_COUNT = 50;
const SCOPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(:[a-z_]+)?$/;

export interface PublicApiKey {
  id: string;
  organization_id: string;
  created_by_user_id: string | null;
  name: string;
  key_prefix: string;
  secret_hint: string;
  scopes: string[];
  status: ApiKeyStatus;
  expires_at: string | null;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
  rotated_to_key_id: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Returned ONLY by create / rotate. */
export interface IssuedApiKey extends PublicApiKey {
  /** The full `<prefix>.<secret>` value. Shown once; never stored. */
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
  expires_at?: string | null;
}

/** Result of authenticating a presented key (no secret material). */
export interface ApiKeyPrincipal {
  key_id: string;
  organization_id: string;
  /** The user the key acts on behalf of (its creator); null once that user row is gone. */
  created_by_user_id: string | null;
  scopes: string[];
  status: Extract<ApiKeyStatus, "ACTIVE" | "ROTATED">;
  expires_at: string | null;
  key_prefix: string;
}

export function isApiKeyStatus(value: string): value is ApiKeyStatus {
  return (API_KEY_STATUSES as readonly string[]).includes(value);
}

export class ApiKeyService {
  private readonly audit: AuditRepository;

  constructor(
    private readonly repo: ApiKeyRepository,
    db: D1Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.audit = new AuditRepository(db);
  }

  // ---- reads (`api_keys.read`) -----------------------------------------------

  async list(tenant: TenantContext, page: PageRequest, status?: string): Promise<Page<PublicApiKey>> {
    this.ensurePermission(tenant, "api_keys.read");
    let filter: ApiKeyStatus | undefined;
    if (status !== undefined && status !== "") {
      if (!isApiKeyStatus(status)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: status");
      filter = status;
    }
    const result = await this.repo.list(tenantIdOf(tenant), page, { status: filter });
    const items: PublicApiKey[] = [];
    for (const row of result.items) items.push(toPublic(await this.settleExpiry(tenant, row)));
    return { items, next_cursor: result.next_cursor };
  }

  async get(tenant: TenantContext, keyId: string): Promise<PublicApiKey> {
    this.ensurePermission(tenant, "api_keys.read");
    const row = await this.requireKey(tenant, keyId);
    return toPublic(await this.settleExpiry(tenant, row));
  }

  // ---- writes (`api_keys.manage`) --------------------------------------------

  async create(ctx: AuthenticatedContext, tenant: TenantContext, input: CreateApiKeyInput, meta: RequestMeta): Promise<IssuedApiKey> {
    this.ensurePermission(tenant, "api_keys.manage");
    const name = parseName(input.name);
    const scopes = parseScopes(input.scopes);
    const expiresAt = this.parseExpiry(input.expires_at);
    const minted = await this.mint({ name, scopes, expires_at: expiresAt, created_by_user_id: ctx.user.id, rotated_from_key_id: null });
    const tid = tenantIdOf(tenant);
    await this.repo.insert(tid, minted.insert, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "api_keys.created",
        target_type: "api_key",
        target_id: minted.insert.id,
        metadata: { name, key_prefix: minted.insert.key_prefix, secret_hint: minted.insert.secret_hint, scopes, expires_at: expiresAt },
        meta,
      }),
    ]);
    const row = await this.repo.findById(tid, minted.insert.id);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "API key was not persisted");
    return { ...toPublic(row), key: minted.key };
  }

  /**
   * ACTIVE → ROTATED: mints a successor (same name/scopes/expiry, fresh
   * secret) and keeps the old key usable for `ROTATION_GRACE_SECONDS` (its
   * `expires_at` is capped at now + grace; read-time expiry then settles it
   * to EXPIRED). Returns the SUCCESSOR with its key shown once.
   */
  async rotate(ctx: AuthenticatedContext, tenant: TenantContext, keyId: string, meta: RequestMeta): Promise<IssuedApiKey> {
    this.ensurePermission(tenant, "api_keys.manage");
    const tid = tenantIdOf(tenant);
    const old = await this.settleExpiry(tenant, await this.requireKey(tenant, keyId));
    this.assertTransition(old, "ROTATED");
    const minted = await this.mint({
      name: old.name,
      scopes: JSON.parse(old.scopes) as string[],
      expires_at: old.expires_at,
      created_by_user_id: ctx.user.id,
      rotated_from_key_id: old.id,
    });
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const graceUntil = new Date(nowDate.getTime() + ROTATION_GRACE_SECONDS * 1000).toISOString();
    const ok = await this.repo.rotate(tid, old.id, minted.insert, now, graceUntil, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "api_keys.rotated",
        target_type: "api_key",
        target_id: minted.insert.id,
        metadata: { previous_key_id: old.id, previous_grace_until: graceUntil, key_prefix: minted.insert.key_prefix, secret_hint: minted.insert.secret_hint },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "API_KEY_NOT_ACTIVE", "Only an ACTIVE key can be rotated");
    const row = await this.repo.findById(tid, minted.insert.id);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "API key was not persisted");
    return { ...toPublic(row), key: minted.key };
  }

  /** ACTIVE|ROTATED → REVOKED (terminal). */
  async revoke(ctx: AuthenticatedContext, tenant: TenantContext, keyId: string, meta: RequestMeta): Promise<PublicApiKey> {
    this.ensurePermission(tenant, "api_keys.manage");
    const tid = tenantIdOf(tenant);
    const existing = await this.settleExpiry(tenant, await this.requireKey(tenant, keyId));
    this.assertTransition(existing, "REVOKED");
    const now = this.clock().toISOString();
    const ok = await this.repo.revoke(tid, existing.id, ctx.user.id, now, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "api_keys.revoked",
        target_type: "api_key",
        target_id: existing.id,
        metadata: { previous_status: existing.status, key_prefix: existing.key_prefix },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "API_KEY_FINAL", "The key is already in a terminal state");
    const row = await this.repo.findById(tid, existing.id);
    if (!row) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
    return toPublic(row);
  }

  // ---- authentication (no session; the key is the credential) ---------------

  /**
   * Resolve a presented `<prefix>.<secret>` to its principal, or null. Shape
   * is checked first so a malformed value never costs a hash + lookup; the
   * hash of the FULL key is compared by the UNIQUE index (equality on a
   * 256-bit digest leaks nothing useful through timing). Expired rows are
   * settled to EXPIRED on the way; terminal rows are refused. On success the
   * row's `last_used_at` is touched.
   */
  async authenticate(presented: string | null | undefined): Promise<ApiKeyPrincipal | null> {
    if (!presented || !isWellFormedKey(presented)) return null;
    const row = await this.repo.findByHash(await sha256Hex(presented));
    if (!row) return null;
    if (row.status === "REVOKED" || row.status === "EXPIRED") return null;
    const now = this.clock();
    if (row.expires_at && isExpired(row.expires_at, now)) {
      await this.repo.expireById(row.id, now.toISOString());
      return null;
    }
    await this.repo.touchLastUsed(row.id, now.toISOString());
    return {
      key_id: row.id,
      organization_id: row.organization_id,
      created_by_user_id: row.created_by_user_id,
      scopes: JSON.parse(row.scopes) as string[],
      status: row.status,
      expires_at: row.expires_at,
      key_prefix: row.key_prefix,
    };
  }

  // ---- internals ---------------------------------------------------------------

  private ensurePermission(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `Missing required permission: ${key}`);
  }

  private async requireKey(tenant: TenantContext, keyId: string): Promise<ApiKeyRow> {
    const row = await this.repo.findById(tenantIdOf(tenant), keyId);
    if (!row) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
    return row;
  }

  /** Read-time expiry: a live row whose `expires_at` has passed becomes EXPIRED. */
  private async settleExpiry(tenant: TenantContext, row: ApiKeyRow): Promise<ApiKeyRow> {
    if (row.status !== "ACTIVE" && row.status !== "ROTATED") return row;
    if (!row.expires_at || !isExpired(row.expires_at, this.clock())) return row;
    const tid = tenantIdOf(tenant);
    await this.repo.expire(tid, row.id, this.clock().toISOString());
    return (await this.repo.findById(tid, row.id)) ?? row;
  }

  /** Service-level mirror of `trg_api_keys_legal_transition` → clean 409s. */
  private assertTransition(row: ApiKeyRow, to: "ROTATED" | "REVOKED"): void {
    if (row.status === "REVOKED" || row.status === "EXPIRED") {
      throw new AppError(409, "API_KEY_FINAL", `The key is ${row.status} and can no longer change`);
    }
    if (to === "ROTATED" && row.status !== "ACTIVE") {
      throw new AppError(409, "API_KEY_NOT_ACTIVE", `Only an ACTIVE key can be rotated (current: ${row.status})`);
    }
  }

  private parseExpiry(raw: string | null | undefined): string | null {
    if (raw === undefined || raw === null) return null;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: expires_at");
    if (t <= this.clock().getTime()) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: expires_at must be in the future");
    return new Date(t).toISOString();
  }

  private async mint(input: {
    name: string;
    scopes: string[];
    expires_at: string | null;
    created_by_user_id: string | null;
    rotated_from_key_id: string | null;
  }): Promise<{ key: string; insert: ApiKeyInsert }> {
    const prefix = API_KEY_PREFIX + toBase64Url(randomBytes(8)).slice(0, PREFIX_RANDOM_CHARS);
    const secret = toBase64Url(randomBytes(SECRET_BYTES));
    const key = `${prefix}.${secret}`;
    return {
      key,
      insert: {
        id: crypto.randomUUID(),
        created_by_user_id: input.created_by_user_id,
        name: input.name,
        key_prefix: prefix,
        key_hash: await sha256Hex(key),
        secret_hint: secret.slice(-4),
        scopes: JSON.stringify(input.scopes),
        expires_at: input.expires_at,
        rotated_from_key_id: input.rotated_from_key_id,
      },
    };
  }
}

// ---- pure helpers --------------------------------------------------------------

const KEY_SHAPE = /^tvh_k_[A-Za-z0-9_-]{2,10}\.[A-Za-z0-9_-]{43}$/;

/** Cheap shape check applied before any hashing. */
export function isWellFormedKey(value: string): boolean {
  return KEY_SHAPE.test(value);
}

function parseName(raw: unknown): string {
  if (typeof raw !== "string") throw new AppError(400, "VALIDATION_ERROR", "Invalid request: name");
  const name = raw.trim();
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: name");
  return name;
}

function parseScopes(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SCOPE_MAX_COUNT) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: scopes");
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || s.length > 64 || !SCOPE_PATTERN.test(s)) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: scopes");
    out.add(s);
  }
  return Array.from(out).sort();
}

function toPublic(row: ApiKeyRow): PublicApiKey {
  // Explicit field list — never spread the row, so a future column added to
  // the projection cannot leak by accident.
  return {
    id: row.id,
    organization_id: row.organization_id,
    created_by_user_id: row.created_by_user_id,
    name: row.name,
    key_prefix: row.key_prefix,
    secret_hint: row.secret_hint,
    scopes: JSON.parse(row.scopes) as string[],
    status: row.status,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    rotated_from_key_id: row.rotated_from_key_id,
    rotated_to_key_id: row.rotated_to_key_id,
    revoked_at: row.revoked_at,
    revoked_by_user_id: row.revoked_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
