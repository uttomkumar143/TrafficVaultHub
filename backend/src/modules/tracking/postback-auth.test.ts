import { describe, expect, it } from "vitest";
import { toBase64Url } from "../auth/crypto-utils";
import {
  canonicalString,
  generatePostbackSecret,
  isTimestampFresh,
  nonceExpiresAt,
  parsePostbackHeaders,
  PostbackVaultError,
  secretHint,
  signPostback,
  unwrapPostbackSecret,
  verifyPostbackSignature,
  wrapPostbackSecret,
} from "./postback-auth";

const KEY_ID = "0b8a1a4e-9d1a-4b4e-8c2b-8f7f8d3a1c2d";
const NONCE = "nonce-0123456789abcdef";
const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));

const headers = (over: Record<string, string | undefined> = {}) => {
  const h: Record<string, string | undefined> = {
    "x-tvh-timestamp": "1772366400",
    "x-tvh-nonce": NONCE,
    "x-tvh-key-id": KEY_ID,
    "x-tvh-signature": "ab".repeat(32),
    ...over,
  };
  return (name: string) => h[name];
};

describe("parsePostbackHeaders", () => {
  it("accepts the documented shape and normalizes case", () => {
    const r = parsePostbackHeaders(headers({ "x-tvh-signature": "AB".repeat(32), "x-tvh-key-id": KEY_ID.toUpperCase() }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.headers.timestamp).toBe(1772366400);
      expect(r.headers.nonce).toBe(NONCE);
      expect(r.headers.key_id).toBe(KEY_ID);
      expect(r.headers.signature).toBe("ab".repeat(32));
    }
  });

  it.each([
    ["missing timestamp", { "x-tvh-timestamp": undefined }],
    ["non-integer timestamp", { "x-tvh-timestamp": "1772366400.5" }],
    ["negative timestamp", { "x-tvh-timestamp": "-5" }],
    ["short nonce", { "x-tvh-nonce": "short" }],
    ["long nonce", { "x-tvh-nonce": "n".repeat(129) }],
    ["nonce with bad chars", { "x-tvh-nonce": "nonce 0123456789 abcdef" }],
    ["non-uuid key id", { "x-tvh-key-id": "key-1" }],
    ["short signature", { "x-tvh-signature": "abcd" }],
    ["non-hex signature", { "x-tvh-signature": "zz".repeat(32) }],
    ["missing signature", { "x-tvh-signature": undefined }],
  ])("rejects %s as SIGNATURE_MALFORMED", (_label, over) => {
    expect(parsePostbackHeaders(headers(over))).toEqual({ ok: false, failure: "SIGNATURE_MALFORMED" });
  });
});

describe("timestamp skew", () => {
  it("accepts within ±tolerance (inclusive), rejects outside", () => {
    expect(isTimestampFresh(1000, 1300)).toBe(true);
    expect(isTimestampFresh(1000, 1301)).toBe(false);
    expect(isTimestampFresh(1300, 1000)).toBe(true);
    expect(isTimestampFresh(1301, 1000)).toBe(false);
    expect(isTimestampFresh(1000, 1061, 60)).toBe(false);
  });

  it("nonceExpiresAt = signed timestamp + tolerance", () => {
    expect(nonceExpiresAt(1772366400)).toBe("2026-03-01T12:05:00.000Z");
    expect(nonceExpiresAt(1772366400, 60)).toBe("2026-03-01T12:01:00.000Z");
  });
});

describe("HMAC-SHA-256 signing / verification", () => {
  const input = { method: "post", path: "/postback/acme", timestamp: 1772366400, nonce: NONCE, body: '{"a":1}' };

  it("canonical string is METHOD\\nPATH\\nTS\\nNONCE\\nsha256(body)", async () => {
    const s = await canonicalString(input);
    const lines = s.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("POST");
    expect(lines[1]).toBe("/postback/acme");
    expect(lines[2]).toBe("1772366400");
    expect(lines[3]).toBe(NONCE);
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a signature produced with the same secret and rejects any change to secret, body, path, nonce or timestamp", async () => {
    const secret = generatePostbackSecret();
    const sig = await signPostback(secret, input);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPostbackSignature(secret, input, sig)).toBe(true);
    expect(await verifyPostbackSignature(secret + "x", input, sig)).toBe(false);
    expect(await verifyPostbackSignature(secret, { ...input, body: '{"a":2}' }, sig)).toBe(false);
    expect(await verifyPostbackSignature(secret, { ...input, path: "/postback/other" }, sig)).toBe(false);
    expect(await verifyPostbackSignature(secret, { ...input, nonce: NONCE + "1" }, sig)).toBe(false);
    expect(await verifyPostbackSignature(secret, { ...input, timestamp: input.timestamp + 1 }, sig)).toBe(false);
  });

  it("rejects a malformed presented signature without throwing (and still computes the HMAC)", async () => {
    const secret = generatePostbackSecret();
    expect(await verifyPostbackSignature(secret, input, "nope")).toBe(false);
    expect(await verifyPostbackSignature(secret, input, "")).toBe(false);
    const sig = await signPostback(secret, input);
    // one flipped nibble
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifyPostbackSignature(secret, input, flipped)).toBe(false);
  });
});

describe("secret vault (AES-256-GCM)", () => {
  it("generates 32-byte base64url secrets with a 4-char hint", () => {
    const s = generatePostbackSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretHint(s)).toBe(s.slice(-4));
    expect(generatePostbackSecret()).not.toBe(s);
  });

  it("wraps and unwraps under the master key; ciphertext never contains the plaintext and differs per call (random IV)", async () => {
    const secret = generatePostbackSecret();
    const ct1 = await wrapPostbackSecret(MASTER, secret);
    const ct2 = await wrapPostbackSecret(MASTER, secret);
    expect(ct1.startsWith("v1.")).toBe(true);
    expect(ct1).not.toBe(ct2);
    expect(ct1).not.toContain(secret);
    expect(await unwrapPostbackSecret(MASTER, ct1)).toBe(secret);
    expect(await unwrapPostbackSecret(MASTER, ct2)).toBe(secret);
  });

  it("fails closed: missing / wrong-length / wrong master key, tampered ciphertext, unknown format", async () => {
    const secret = generatePostbackSecret();
    const ct = await wrapPostbackSecret(MASTER, secret);
    await expect(wrapPostbackSecret(undefined, secret)).rejects.toBeInstanceOf(PostbackVaultError);
    await expect(wrapPostbackSecret(toBase64Url(new Uint8Array(16)), secret)).rejects.toBeInstanceOf(PostbackVaultError);
    await expect(wrapPostbackSecret("not base64url!!", secret)).rejects.toBeInstanceOf(PostbackVaultError);
    const otherKey = toBase64Url(new Uint8Array(32).fill(9));
    await expect(unwrapPostbackSecret(otherKey, ct)).rejects.toBeInstanceOf(PostbackVaultError);
    const parts = ct.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${(parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1)}`;
    await expect(unwrapPostbackSecret(MASTER, tampered)).rejects.toBeInstanceOf(PostbackVaultError);
    await expect(unwrapPostbackSecret(MASTER, "v9.abc.def")).rejects.toBeInstanceOf(PostbackVaultError);
    await expect(unwrapPostbackSecret(MASTER, "garbage")).rejects.toBeInstanceOf(PostbackVaultError);
  });
});
