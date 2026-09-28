/**
 * S2S postback authentication (Phase 3 Unit 7; PRD §74-style signing, §115
 * "invalid signature rejected" / "replay rejected"). Pure crypto + parsing
 * over Web Crypto — no D1. The nonce UNIQUE insert (the actual replay gate)
 * and the secret lookup live in the attribution repository; this module
 * decides everything that can be decided from the request alone.
 *
 * Signing scheme (documented for advertisers):
 *   headers  X-TVH-Timestamp  — unix seconds (integer) when the request was signed
 *            X-TVH-Nonce      — 16–128 chars [A-Za-z0-9_-], unique per request
 *            X-TVH-Key-Id     — id of the advertiser_postback_secrets row
 *            X-TVH-Signature  — lowercase hex HMAC-SHA-256 over the canonical string
 *   canonical string = METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 *
 * Verification:
 *   * every header present and well-formed, else SIGNATURE_MALFORMED;
 *   * |now − timestamp| ≤ tolerance (default 300 s), else TIMESTAMP_SKEW —
 *     checked BEFORE the HMAC so an expired request never costs a key load;
 *   * HMAC compared with `constantTimeEqual` over the raw bytes (never `===`
 *     on strings), else SIGNATURE_INVALID.
 *
 * Secret vault (`advertiser_postback_secrets.secret_ciphertext`): the signing
 * secret is generated here (32 random bytes, base64url) and stored AES-256-GCM
 * wrapped under the Worker master key `POSTBACK_SECRET_KEY` (32 bytes,
 * base64url; `key_version` names which master key wrapped the row so rotation
 * is possible without re-wrapping everything at once). Ciphertext format:
 * `v1.<iv b64url>.<ciphertext+tag b64url>`. The plaintext secret is returned
 * ONCE at creation and is never logged, never selected by list/read routes.
 */
import { constantTimeEqual, fromBase64Url, randomBytes, sha256Hex, toBase64Url } from "../auth/crypto-utils";

export const POSTBACK_HEADERS = {
  timestamp: "x-tvh-timestamp",
  nonce: "x-tvh-nonce",
  keyId: "x-tvh-key-id",
  signature: "x-tvh-signature",
} as const;

/** Default accepted clock skew between signer and verifier (seconds). */
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export const NONCE_MIN_LENGTH = 16;
export const NONCE_MAX_LENGTH = 128;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PostbackAuthFailure = "SIGNATURE_MALFORMED" | "TIMESTAMP_SKEW" | "SIGNATURE_INVALID";

export interface PostbackSignatureHeaders {
  /** Unix seconds as signed. */
  timestamp: number;
  nonce: string;
  key_id: string;
  /** Lowercase hex, 64 chars. */
  signature: string;
}

export type ParsedHeaders = { ok: true; headers: PostbackSignatureHeaders } | { ok: false; failure: PostbackAuthFailure };

/**
 * Parse + shape-check the four signature headers. Rejects anything that is not
 * exactly the documented format so the verifier never has to reason about
 * casing, whitespace or encodings.
 */
export function parsePostbackHeaders(get: (name: string) => string | undefined | null): ParsedHeaders {
  const rawTs = get(POSTBACK_HEADERS.timestamp)?.trim();
  const nonce = get(POSTBACK_HEADERS.nonce)?.trim();
  const keyId = get(POSTBACK_HEADERS.keyId)?.trim();
  const signature = get(POSTBACK_HEADERS.signature)?.trim().toLowerCase();
  if (!rawTs || !nonce || !keyId || !signature) return { ok: false, failure: "SIGNATURE_MALFORMED" };
  if (!/^\d{1,12}$/.test(rawTs)) return { ok: false, failure: "SIGNATURE_MALFORMED" };
  if (nonce.length < NONCE_MIN_LENGTH || nonce.length > NONCE_MAX_LENGTH || !NONCE_PATTERN.test(nonce)) {
    return { ok: false, failure: "SIGNATURE_MALFORMED" };
  }
  if (!UUID_PATTERN.test(keyId)) return { ok: false, failure: "SIGNATURE_MALFORMED" };
  if (!HEX_SIGNATURE_PATTERN.test(signature)) return { ok: false, failure: "SIGNATURE_MALFORMED" };
  return { ok: true, headers: { timestamp: Number(rawTs), nonce, key_id: keyId.toLowerCase(), signature } };
}

/** True when the signed timestamp is within ±tolerance of `nowSeconds`. */
export function isTimestampFresh(
  timestamp: number,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  return Math.abs(nowSeconds - timestamp) <= toleranceSeconds;
}

export interface CanonicalInput {
  method: string;
  /** Path only (no host, no query). */
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

/** The exact string both sides sign. */
export async function canonicalString(input: CanonicalInput): Promise<string> {
  return [input.method.toUpperCase(), input.path, String(input.timestamp), input.nonce, await sha256Hex(input.body)].join("\n");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Lowercase-hex HMAC-SHA-256 of the canonical string under `secret` (what the advertiser's SDK computes). */
export async function signPostback(secret: string, input: CanonicalInput): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(await canonicalString(input)));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Constant-time check of a presented signature against the expected HMAC.
 * Always computes the HMAC (no early return on shape) so timing does not leak
 * whether the secret was even consulted.
 */
export async function verifyPostbackSignature(secret: string, input: CanonicalInput, presentedHex: string): Promise<boolean> {
  const expected = await signPostback(secret, input);
  if (!HEX_SIGNATURE_PATTERN.test(presentedHex)) return false;
  return constantTimeEqual(hexToBytes(expected), hexToBytes(presentedHex));
}

/**
 * Nonce expiry for `postback_nonces.expires_at`: the signed timestamp plus the
 * tolerance window — after that the timestamp check alone rejects the request,
 * so the row may be purged.
 */
export function nonceExpiresAt(timestamp: number, toleranceSeconds: number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS): string {
  return new Date((timestamp + toleranceSeconds) * 1000).toISOString();
}

// ---- secret vault (AES-256-GCM under the Worker master key) -----------------

export const SECRET_CIPHERTEXT_VERSION = "v1";
/** `key_version` recorded on rows wrapped with the current master key binding. */
export const CURRENT_KEY_VERSION = "POSTBACK_SECRET_KEY:v1";
const MASTER_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

/** Thrown when the master key binding is absent or not exactly 32 base64url bytes. */
export class PostbackVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostbackVaultError";
  }
}

/** Fresh signing secret: 32 CSPRNG bytes, base64url (43 chars). */
export function generatePostbackSecret(): string {
  return toBase64Url(randomBytes(32));
}

/** Last 4 characters — the only part of a secret that is ever shown again. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}

async function masterKey(materialB64: string | undefined, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (!materialB64) throw new PostbackVaultError("POSTBACK_SECRET_KEY is not configured");
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(materialB64.trim());
  } catch {
    throw new PostbackVaultError("POSTBACK_SECRET_KEY is not valid base64url");
  }
  if (raw.length !== MASTER_KEY_BYTES) throw new PostbackVaultError("POSTBACK_SECRET_KEY must be exactly 32 bytes");
  return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [usage]);
}

/** AES-256-GCM wrap → `v1.<iv>.<ct>` (base64url parts). */
export async function wrapPostbackSecret(masterKeyB64: string | undefined, secret: string): Promise<string> {
  const key = await masterKey(masterKeyB64, "encrypt");
  const iv = randomBytes(GCM_IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(secret));
  return `${SECRET_CIPHERTEXT_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Inverse of `wrapPostbackSecret`; throws `PostbackVaultError` on a bad key or tampered ciphertext. */
export async function unwrapPostbackSecret(masterKeyB64: string | undefined, ciphertext: string): Promise<string> {
  const parts = ciphertext.split(".");
  if (parts.length !== 3 || parts[0] !== SECRET_CIPHERTEXT_VERSION) throw new PostbackVaultError("unsupported ciphertext format");
  const key = await masterKey(masterKeyB64, "decrypt");
  try {
    const iv = fromBase64Url(parts[1] ?? "");
    const ct = fromBase64Url(parts[2] ?? "");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    throw new PostbackVaultError("postback secret could not be unwrapped");
  }
}
