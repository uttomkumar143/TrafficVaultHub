/**
 * Password hashing (ADR-001 §1).
 *
 * All cryptography is delegated to audited primitives:
 *   - key derivation: `scryptAsync` from @noble/hashes
 *   - randomness:     Web Crypto `crypto.getRandomValues`
 * Nothing here is a custom protocol. The stored string is self-describing:
 *   $scrypt$N=16384,r=8,p=1$<salt-b64url>$<hash-b64url>
 * so parameters can be raised later and old rows re-hashed on next login.
 */
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { SCRYPT_PARAMS, SCRYPT_SALT_BYTES } from "./constants";
import { fromBase64Url, randomBytes, toBase64Url, constantTimeEqual } from "./crypto-utils";

const ALGORITHM = "scrypt";

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const { N, r, p, dkLen } = SCRYPT_PARAMS;
  const derived = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, dkLen });
  return `$${ALGORITHM}$N=${N},r=${r},p=${p}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/**
 * Verify `password` against a stored hash string. Returns false (never throws)
 * for malformed stored values so a corrupt row cannot bypass authentication.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const derived = await scryptAsync(password.normalize("NFKC"), parsed.salt, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    dkLen: parsed.hash.length,
  });
  return constantTimeEqual(derived, parsed.hash);
}

/** True when the stored hash uses weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.N < SCRYPT_PARAMS.N ||
    parsed.r < SCRYPT_PARAMS.r ||
    parsed.p < SCRYPT_PARAMS.p ||
    parsed.hash.length < SCRYPT_PARAMS.dkLen
  );
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  // ["", "scrypt", "N=..,r=..,p=..", salt, hash]
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== ALGORITHM) return null;
  const params: Record<string, number> = {};
  for (const kv of (parts[2] ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (!k || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    params[k] = n;
  }
  const { N, r, p } = params;
  if (N === undefined || r === undefined || p === undefined) return null;
  try {
    const salt = fromBase64Url(parts[3] ?? "");
    const hash = fromBase64Url(parts[4] ?? "");
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}
