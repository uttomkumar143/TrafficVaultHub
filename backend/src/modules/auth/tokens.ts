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
export function extractBearerSession(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1] ?? "";
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  return token;
}
