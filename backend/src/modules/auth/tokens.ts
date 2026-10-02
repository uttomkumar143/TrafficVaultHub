/**
 * Opaque secret generation for sessions and one-time tokens (ADR-001 §2–§3).
 * The raw value goes to the client once; only `SHA-256(raw)` is persisted.
 */
import { ONE_TIME_TOKEN_BYTES, SESSION_SECRET_BYTES, SESSION_TOKEN_PREFIX } from "./constants";
import { randomBytes, sha256Hex, toBase64Url } from "./crypto-utils";

export interface IssuedSecret {
  /** Raw value handed to the client. Never persisted, never logged. */
  raw: string;
  /** Hex SHA-256 digest stored in the database. */
  hash: string;
}

export async function issueSessionSecret(): Promise<IssuedSecret> {
  const raw = SESSION_TOKEN_PREFIX + toBase64Url(randomBytes(SESSION_SECRET_BYTES));
  return { raw, hash: await sha256Hex(raw) };
}

export async function issueOneTimeToken(): Promise<IssuedSecret> {
  const raw = toBase64Url(randomBytes(ONE_TIME_TOKEN_BYTES));
  return { raw, hash: await sha256Hex(raw) };
}

/** Digest a client-presented secret for lookup. */
export function hashSecret(raw: string): Promise<string> {
  return sha256Hex(raw);
}

/**
 * Extract a bearer session secret from an Authorization header.
 * Returns null when the header is absent or not in the expected shape.
 */
/** Credential kinds a bearer header may carry (Phase 6 Unit 4). */
export type BearerKind = "session" | "api_key";

/** Public prefix of API keys (`modules/api-keys/service.ts` mints them). */
export const API_KEY_TOKEN_PREFIX = "tvh_k_";

/**
 * Classify a bearer token by prefix WITHOUT validating it. Returns null when
 * the header is absent, not Bearer, or the token has an unknown prefix — the
 * caller must treat all three identically (401) so prefixes cannot be probed.
 */
export function extractBearerToken(authorization: string | undefined): { kind: BearerKind; raw: string } | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1] ?? "";
  if (token.startsWith(SESSION_TOKEN_PREFIX)) return { kind: "session", raw: token };
  if (token.startsWith(API_KEY_TOKEN_PREFIX)) return { kind: "api_key", raw: token };
  return null;
}

export function extractBearerSession(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1] ?? "";
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  return token;
}
