/**
 * Auth flows (ADR-001): signup → email verification → login → session;
 * logout; forgot/reset password. Policy lives here; SQL lives in the
 * repository; crypto lives in password.ts / tokens.ts.
 *
 * Error codes (uniform envelope, PRD §72):
 *   EMAIL_ALREADY_REGISTERED 409 · INVALID_CREDENTIALS 401 ·
 *   EMAIL_NOT_VERIFIED 403 · ACCOUNT_INACTIVE 403 · INVALID_TOKEN 400 ·
 *   UNAUTHENTICATED 401
 */
import { AppError } from "../../lib/errors";
import { isExpired, plusSecondsIso } from "../../lib/time";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  EMAIL_VERIFICATION_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
} from "./constants";
import type { EmailSender } from "./email";
import { getMfaStatus, type MfaStatus } from "./mfa";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import type { AuthRepository, RequestMeta, SessionRow, UserRow } from "./repository";
import { hashSecret, issueOneTimeToken, issueSessionSecret } from "./tokens";

export interface AuthServiceOptions {
  sessionTtlSeconds?: number;
  /** When true, raw one-time tokens are echoed in responses (development only). */
  exposeDebugTokens?: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
  status: UserRow["status"];
  timezone: string;
  locale: string;
  last_login_at: string | null;
  created_at: string;
  mfa: MfaStatus;
}

export interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface AuthenticatedContext {
  user: PublicUser;
  session: SessionInfo;
}

export class AuthService {
  private readonly sessionTtlSeconds: number;
  private readonly exposeDebugTokens: boolean;

  constructor(
    private readonly repo: AuthRepository,
    private readonly email: EmailSender,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.exposeDebugTokens = options.exposeDebugTokens ?? false;
  }

  // ---- signup & verification ----------------------------------------------

  async signup(
    input: { email: string; password: string; display_name?: string | null },
    meta: RequestMeta,
  ): Promise<{ user: PublicUser; debug?: { verification_token: string } }> {
    const email = normalizeEmail(input.email);
    if (await this.repo.findUserByEmail(email)) {
      throw new AppError(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const userId = await this.repo.createUserWithCredential({
      email,
      display_name: input.display_name?.trim() || null,
      password_hash: passwordHash,
    });
    await this.repo.recordAuthEvent({ user_id: userId, event_type: "SIGNUP", meta });

    const token = await this.issueVerificationEmail(userId, email);
    const user = await this.mustGetUser(userId);
    return this.withDebug({ user: toPublicUser(user) }, { verification_token: token });
  }

  /** Re-send verification. Always 202 — never reveals whether the email exists. */
  async resendVerification(rawEmail: string): Promise<{ debug?: { verification_token: string } }> {
    const user = await this.repo.findUserByEmail(normalizeEmail(rawEmail));
    if (!user || user.email_verified_at || user.status !== "ACTIVE") return {};
    const token = await this.issueVerificationEmail(user.id, user.email);
    return this.withDebug({}, { verification_token: token });
  }

  async verifyEmail(rawToken: string, meta: RequestMeta): Promise<{ user: PublicUser }> {
    const row = await this.repo.findAuthToken(await hashSecret(rawToken), "EMAIL_VERIFICATION");
    if (!row || row.consumed_at || isExpired(row.expires_at)) {
      throw new AppError(400, "INVALID_TOKEN", "Verification link is invalid or has expired");
    }
    if (!(await this.repo.consumeAuthToken(row.id))) {
      throw new AppError(400, "INVALID_TOKEN", "Verification link is invalid or has expired");
    }
    await this.repo.markEmailVerified(row.user_id);
    await this.repo.recordAuthEvent({ user_id: row.user_id, event_type: "EMAIL_VERIFIED", meta });
    return { user: toPublicUser(await this.mustGetUser(row.user_id)) };
  }

  // ---- login / logout ------------------------------------------------------

  async login(
    input: { email: string; password: string },
    meta: RequestMeta,
  ): Promise<{ token: string; expires_at: string; user: PublicUser; session: SessionInfo }> {
    const invalid = () =>
      new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");

    const user = await this.repo.findUserByEmail(normalizeEmail(input.email));
    if (!user) {
      await this.repo.recordAuthEvent({ user_id: null, event_type: "LOGIN_FAILED", meta });
      throw invalid();
    }

    const credential = await this.repo.findCredentialByUserId(user.id);
    const ok = credential ? await verifyPassword(input.password, credential.password_hash) : false;
    if (!ok) {
      await this.repo.recordFailedAttempt(user.id);
      await this.repo.recordAuthEvent({ user_id: user.id, event_type: "LOGIN_FAILED", meta });
      throw invalid();
    }

    // Only after the password is proven do we disclose account state.
    if (user.status !== "ACTIVE") {
      await this.repo.recordAuthEvent({ user_id: user.id, event_type: "LOGIN_FAILED", meta });
      throw new AppError(403, "ACCOUNT_INACTIVE", "This account is not active");
    }
    if (!user.email_verified_at) {
      await this.repo.recordAuthEvent({ user_id: user.id, event_type: "LOGIN_FAILED", meta });
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Please verify your email address before signing in");
    }

    // MFA hook: `users.mfa_enabled` is recorded but a challenge cannot be
    // performed yet (ADR-001 §5). We do NOT fake-pass; login proceeds on the
    // password factor only and the response reports MFA as unavailable.

    if (credential && needsRehash(credential.password_hash)) {
      await this.repo.updatePasswordHash(user.id, await hashPassword(input.password));
    }
    await this.repo.resetFailedAttempts(user.id);

    const secret = await issueSessionSecret();
    const expiresAt = plusSecondsIso(this.sessionTtlSeconds);
    const sessionId = await this.repo.createSession({
      user_id: user.id,
      token_hash: secret.hash,
      expires_at: expiresAt,
      meta,
    });
    await this.repo.touchLastLogin(user.id);
    await this.repo.recordAuthEvent({
      user_id: user.id,
      event_type: "LOGIN_SUCCEEDED",
      session_id: sessionId,
      meta,
    });

    const fresh = await this.mustGetUser(user.id);
    const session = await this.repo.findSessionByTokenHash(secret.hash);
    if (!session) throw new Error("session vanished after insert");
    return { token: secret.raw, expires_at: expiresAt, user: toPublicUser(fresh), session: toSessionInfo(session) };
  }

  /**
   * Resolve a bearer secret to an authenticated user + session, or null.
   * Rejects revoked and expired sessions and inactive users. Slides
   * `last_seen_at` on success.
   */
  async authenticate(rawToken: string): Promise<AuthenticatedContext | null> {
    const session = await this.repo.findSessionByTokenHash(await hashSecret(rawToken));
    if (!session || session.revoked_at || isExpired(session.expires_at)) return null;
    const user = await this.repo.findUserById(session.user_id);
    if (!user || user.status !== "ACTIVE") return null;
    await this.repo.touchSession(session.id);
    return { user: toPublicUser(user), session: toSessionInfo(session) };
  }

  async logout(ctx: AuthenticatedContext, meta: RequestMeta): Promise<void> {
    await this.repo.revokeSession(ctx.session.id, "LOGOUT");
    await this.repo.recordAuthEvent({
      user_id: ctx.user.id,
      event_type: "LOGOUT",
      session_id: ctx.session.id,
      meta,
    });
  }

  // ---- password reset ------------------------------------------------------

  /** Always resolves — response is identical whether or not the email exists. */
  async forgotPassword(rawEmail: string, meta: RequestMeta): Promise<{ debug?: { reset_token: string } }> {
    const user = await this.repo.findUserByEmail(normalizeEmail(rawEmail));
    if (!user || user.status !== "ACTIVE") return {};

    const token = await issueOneTimeToken();
    await this.repo.createAuthToken({
      user_id: user.id,
      purpose: "PASSWORD_RESET",
      token_hash: token.hash,
      expires_at: plusSecondsIso(PASSWORD_RESET_TTL_SECONDS),
    });
    await this.repo.recordAuthEvent({ user_id: user.id, event_type: "PASSWORD_RESET_REQUESTED", meta });
    await this.email.send({ kind: "PASSWORD_RESET", to: user.email, token: token.raw });
    return this.withDebug({}, { reset_token: token.raw });
  }

  async resetPassword(input: { token: string; password: string }, meta: RequestMeta): Promise<void> {
    const row = await this.repo.findAuthToken(await hashSecret(input.token), "PASSWORD_RESET");
    if (!row || row.consumed_at || isExpired(row.expires_at)) {
      throw new AppError(400, "INVALID_TOKEN", "Reset link is invalid or has expired");
    }
    if (!(await this.repo.consumeAuthToken(row.id))) {
      throw new AppError(400, "INVALID_TOKEN", "Reset link is invalid or has expired");
    }
    await this.repo.updatePasswordHash(row.user_id, await hashPassword(input.password));
    // A reset proves email control; treat it as verification too.
    await this.repo.markEmailVerified(row.user_id);
    await this.repo.revokeAllSessionsForUser(row.user_id, "PASSWORD_RESET");
    await this.repo.recordAuthEvent({ user_id: row.user_id, event_type: "PASSWORD_RESET_COMPLETED", meta });
  }

  // ---- helpers -------------------------------------------------------------

  private async issueVerificationEmail(userId: string, email: string): Promise<string> {
    const token = await issueOneTimeToken();
    await this.repo.createAuthToken({
      user_id: userId,
      purpose: "EMAIL_VERIFICATION",
      token_hash: token.hash,
      expires_at: plusSecondsIso(EMAIL_VERIFICATION_TTL_SECONDS),
    });
    await this.email.send({ kind: "EMAIL_VERIFICATION", to: email, token: token.raw });
    return token.raw;
  }

  private async mustGetUser(id: string): Promise<UserRow> {
    const user = await this.repo.findUserById(id);
    if (!user) throw new Error(`user ${id} not found after write`);
    return user;
  }

  private withDebug<T extends object, D extends object>(body: T, debug: D): T & { debug?: D } {
    return this.exposeDebugTokens ? { ...body, debug } : body;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    email_verified: u.email_verified_at !== null,
    status: u.status,
    timezone: u.timezone,
    locale: u.locale,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
    mfa: getMfaStatus(u),
  };
}

function toSessionInfo(s: SessionRow): SessionInfo {
  return { id: s.id, created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at };
}
