import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { constantTimeEqual, fromBase64Url, sha256Hex, toBase64Url } from "./crypto-utils";
import { extractBearerSession, issueOneTimeToken, issueSessionSecret } from "./tokens";
import { beginMfaChallenge, getMfaStatus, verifyMfaChallenge } from "./mfa";
import { redactEmail } from "./email";
import { AppError } from "../../lib/errors";

describe("password hashing (scrypt via @noble/hashes)", () => {
  it("produces a self-describing hash that verifies and is salted", async () => {
    const h1 = await hashPassword("correct horse battery");
    const h2 = await hashPassword("correct horse battery");
    expect(h1).toMatch(/^\$scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(h1).not.toBe(h2); // random salt
    await expect(verifyPassword("correct horse battery", h1)).resolves.toBe(true);
    await expect(verifyPassword("correct horse battery", h2)).resolves.toBe(true);
    await expect(verifyPassword("wrong", h1)).resolves.toBe(false);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    await expect(verifyPassword("x", "")).resolves.toBe(false);
    await expect(verifyPassword("x", "$bcrypt$abc")).resolves.toBe(false);
    await expect(verifyPassword("x", "$scrypt$N=16384,r=8$aa$bb")).resolves.toBe(false);
    await expect(verifyPassword("x", "$scrypt$N=16384,r=8,p=1$!!$bb")).resolves.toBe(false);
  });

  it("flags weaker parameters for rehash", async () => {
    const current = await hashPassword("pw");
    expect(needsRehash(current)).toBe(false);
    const weak = current.replace("N=16384", "N=1024");
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });
});

describe("crypto utils", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const enc = toBase64Url(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(enc))).toEqual(Array.from(bytes));
    expect(() => fromBase64Url("not base64!")).toThrow();
  });

  it("sha256Hex matches a known vector", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("constantTimeEqual compares content and length", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("opaque secrets", () => {
  it("issues prefixed session secrets whose hash is a sha256 of the raw value", async () => {
    const s = await issueSessionSecret();
    expect(s.raw.startsWith("tvh_s_")).toBe(true);
    expect(s.hash).toBe(await sha256Hex(s.raw));
    const t = await issueOneTimeToken();
    expect(t.raw).not.toContain("tvh_s_");
    expect(t.hash).toHaveLength(64);
  });

  it("extracts only well-formed bearer session tokens", () => {
    expect(extractBearerSession(undefined)).toBeNull();
    expect(extractBearerSession("Basic abc")).toBeNull();
    expect(extractBearerSession("Bearer not-a-session")).toBeNull();
    expect(extractBearerSession("Bearer tvh_s_abc")).toBe("tvh_s_abc");
    expect(extractBearerSession("bearer  tvh_s_abc ")).toBe("tvh_s_abc");
  });
});

describe("MFA stub", () => {
  it("never reports availability and never passes a challenge", () => {
    expect(getMfaStatus({ mfa_enabled: 0 })).toEqual({
      enabled: false,
      available: false,
      reason: "NOT_IMPLEMENTED",
    });
    expect(getMfaStatus({ mfa_enabled: 1 }).enabled).toBe(true);
    expect(() => beginMfaChallenge("u1")).toThrow(AppError);
    expect(() => verifyMfaChallenge("u1", "000000")).toThrow(AppError);
    try {
      verifyMfaChallenge("u1", "000000");
    } catch (e) {
      expect((e as AppError).status).toBe(501);
      expect((e as AppError).code).toBe("NOT_IMPLEMENTED");
    }
  });
});

describe("email redaction", () => {
  it("hides the local part", () => {
    expect(redactEmail("alice@example.com")).toBe("a***@example.com");
    expect(redactEmail("a@x.io")).toBe("***");
  });
});
