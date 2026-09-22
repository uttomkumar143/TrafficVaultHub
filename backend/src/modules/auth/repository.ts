/**
 * Auth persistence over D1 (tables from migrations 0001 + 0002).
 * Pure data access — no policy decisions here. All timestamps are UTC ISO
 * strings; ids are application-generated UUIDs (crypto.randomUUID).
 */
import { nowIso } from "../../lib/time";
import type { AuthEventType, TokenPurpose } from "./constants";

export interface UserRow {
  id: string;
  email: string;
  email_verified_at: string | null;
  display_name: string | null;
  status: "ACTIVE" | "RESTRICTED" | "SUSPENDED" | "TERMINATED";
  timezone: string;
  locale: string;
  last_login_at: string | null;
  mfa_enabled: number;
  created_at: string;
  deleted_at: string | null;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuthTokenRow {
  id: string;
  user_id: string;
  purpose: TokenPurpose;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface RequestMeta {
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
}

const USER_COLUMNS =
  "id, email, email_verified_at, display_name, status, timezone, locale, last_login_at, mfa_enabled, created_at, deleted_at";

export class AuthRepository {
  constructor(private readonly db: D1Database) {}

  // ---- users ---------------------------------------------------------------

  findUserByEmail(email: string): Promise<UserRow | null> {
    return this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL`)
      .bind(email)
      .first<UserRow>();
  }

  findUserById(id: string): Promise<UserRow | null> {
    return this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`)
      .bind(id)
      .first<UserRow>();
  }

  /** Creates the user and its credential atomically. */
  async createUserWithCredential(input: {
    email: string;
    display_name: string | null;
    password_hash: string;
  }): Promise<string> {
    const userId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare("INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)")
        .bind(userId, input.email, input.display_name),
      this.db
        .prepare("INSERT INTO user_credentials (id, user_id, password_hash) VALUES (?, ?, ?)")
        .bind(credentialId, userId, input.password_hash),
    ]);
    return userId;
  }

  async markEmailVerified(userId: string): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        "UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?",
      )
      .bind(now, now, userId)
      .run();
  }

  async touchLastLogin(userId: string): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, userId)
      .run();
  }

  // ---- credentials ---------------------------------------------------------

  findCredentialByUserId(userId: string): Promise<CredentialRow | null> {
    return this.db
      .prepare(
        "SELECT id, user_id, password_hash, failed_attempts, locked_until FROM user_credentials WHERE user_id = ?",
      )
      .bind(userId)
      .first<CredentialRow>();
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const now = nowIso();
    await this.db
      .prepare(
        `UPDATE user_credentials
            SET password_hash = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE user_id = ?`,
      )
      .bind(passwordHash, now, now, userId)
      .run();
  }

  async recordFailedAttempt(userId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE user_credentials SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE user_id = ?",
      )
      .bind(nowIso(), userId)
      .run();
  }

  async resetFailedAttempts(userId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE user_credentials SET failed_attempts = 0, updated_at = ? WHERE user_id = ? AND failed_attempts <> 0",
      )
      .bind(nowIso(), userId)
      .run();
  }

  // ---- sessions ------------------------------------------------------------

  async createSession(input: {
    user_id: string;
    token_hash: string;
    expires_at: string;
    meta: RequestMeta;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.user_id, input.token_hash, input.expires_at, input.meta.ip_address, input.meta.user_agent)
      .run();
    return id;
  }

  findSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.db
      .prepare(
        `SELECT id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, revoked_reason, ip_address, user_agent
           FROM sessions WHERE token_hash = ?`,
      )
      .bind(tokenHash)
      .first<SessionRow>();
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(nowIso(), sessionId)
      .run();
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(nowIso(), reason, sessionId)
      .run();
  }

  async revokeAllSessionsForUser(userId: string, reason: string): Promise<number> {
    const res = await this.db
      .prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(nowIso(), reason, userId)
      .run();
    return res.meta.changes ?? 0;
  }

  // ---- session & device management (Unit 2) --------------------------------
  // Every query below is scoped by `user_id` so a caller can never read or
  // mutate another principal's sessions, whatever session id it supplies.

  /** Active = not revoked and not yet expired. Most recently used first. */
  async listActiveSessions(userId: string): Promise<SessionRow[]> {
    const res = await this.db
      .prepare(
        `SELECT id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, revoked_reason, ip_address, user_agent
           FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC, created_at DESC`,
      )
      .bind(userId, nowIso())
      .all<SessionRow>();
    return res.results;
  }

  /**
   * Revoke one session that belongs to `userId`. Returns true only if an
   * active session matched — an unknown, foreign, already-revoked or expired
   * id all yield false so the caller can answer "not found" uniformly.
   */
  async revokeOwnedSession(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const now = nowIso();
    const res = await this.db
      .prepare(
        `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(now, reason, sessionId, userId, now)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  /**
   * Revoke every active session of `userId` except `currentSessionId`.
   * Idempotent. Returns the ids that were revoked (for the audit trail); the
   * SELECT and UPDATE share one predicate and run in a single D1 batch
   * (transaction), so the returned ids are exactly the rows updated.
   */
  async revokeOtherSessions(userId: string, currentSessionId: string, reason: string): Promise<string[]> {
    const now = nowIso();
    const predicate = "user_id = ? AND id <> ? AND revoked_at IS NULL AND expires_at > ?";
    const [selected] = await this.db.batch<{ id: string }>([
      this.db.prepare(`SELECT id FROM sessions WHERE ${predicate}`).bind(userId, currentSessionId, now),
      this.db
        .prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE ${predicate}`)
        .bind(now, reason, userId, currentSessionId, now),
    ]);
    return (selected?.results ?? []).map((r) => r.id);
  }

  // ---- one-time tokens -----------------------------------------------------

  /** Issues a token and invalidates prior unconsumed tokens of the same purpose. */
  async createAuthToken(input: {
    user_id: string;
    purpose: TokenPurpose;
    token_hash: string;
    expires_at: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL",
        )
        .bind(now, input.user_id, input.purpose),
      this.db
        .prepare(
          "INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id, input.user_id, input.purpose, input.token_hash, input.expires_at),
    ]);
    return id;
  }

  findAuthToken(tokenHash: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
    return this.db
      .prepare(
        "SELECT id, user_id, purpose, token_hash, expires_at, consumed_at FROM auth_tokens WHERE token_hash = ? AND purpose = ?",
      )
      .bind(tokenHash, purpose)
      .first<AuthTokenRow>();
  }

  /**
   * Atomically consume a token. Returns true only if this call transitioned
   * it from unconsumed → consumed (so a concurrent replay loses).
   */
  async consumeAuthToken(tokenId: string): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .bind(nowIso(), tokenId)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  // ---- login monitoring ----------------------------------------------------

  async recordAuthEvent(input: {
    user_id: string | null;
    event_type: AuthEventType;
    session_id?: string | null;
    meta: RequestMeta;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auth_events (id, user_id, event_type, session_id, ip_address, user_agent, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.user_id,
        input.event_type,
        input.session_id ?? null,
        input.meta.ip_address,
        input.meta.user_agent,
        input.meta.request_id,
      )
      .run();
  }
}
