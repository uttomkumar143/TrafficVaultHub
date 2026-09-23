import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "@/lib/api";
import {
  __resetSessionStoreForTests,
  getSessionToken,
  setSessionToken,
  subscribeSessionToken,
} from "@/lib/session-store";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiRequest", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetSessionStoreForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSessionStoreForTests();
  });

  it("sends JSON bodies to /api/v1 and parses the JSON response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await apiRequest<{ ok: boolean }>("/auth/login", {
      method: "POST",
      body: { email: "a@b.co", password: "x" },
      auth: false,
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.co", password: "x" }));
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBeUndefined();
  });

  it("attaches the bearer session token when one is stored", async () => {
    setSessionToken("tvh_s_test_token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: {} }));

    await apiRequest("/auth/me");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tvh_s_test_token");
  });

  it("returns undefined for 204 responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiRequest("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("throws ApiError carrying the PRD §72 envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password", request_id: "ray-1" } },
        401,
      ),
    );

    const err: ApiError = await apiRequest<never>("/auth/login", { method: "POST", body: {}, auth: false }).catch(
      (e: unknown) => e as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("INVALID_CREDENTIALS");
    expect(err.message).toBe("Invalid email or password");
    expect(err.requestId).toBe("ray-1");
    // A failed *unauthenticated* login never had a token, so nothing to clear.
    expect(getSessionToken()).toBeNull();
  });

  it("falls back to HTTP_<status> when the body is not an envelope", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gateway down", { status: 502 }));
    const err: ApiError = await apiRequest<never>("/auth/me").catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("HTTP_502");
    expect(err.status).toBe(502);
  });

  it("clears the stored session and notifies subscribers on 401 for an authenticated call", async () => {
    setSessionToken("tvh_s_expired");
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeSessionToken((t) => seen.push(t));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired", request_id: null } }, 401),
    );

    await expect(apiRequest("/auth/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(getSessionToken()).toBeNull();
    expect(seen).toEqual([null]);
    unsubscribe();
  });

  it("keeps the session on non-401 failures", async () => {
    setSessionToken("tvh_s_ok");
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "FORBIDDEN", message: "no", request_id: null } }, 403),
    );
    await expect(apiRequest("/organizations/x")).rejects.toMatchObject({ status: 403 });
    expect(getSessionToken()).toBe("tvh_s_ok");
  });
});

describe("session store", () => {
  beforeEach(() => __resetSessionStoreForTests());
  afterEach(() => __resetSessionStoreForTests());

  it("mirrors the token into sessionStorage and restores it after a memory reset", () => {
    setSessionToken("tvh_s_persist");
    expect(window.sessionStorage.getItem("tvh.session")).toBe("tvh_s_persist");

    // Simulate a reload: forget the in-memory copy only.
    __resetSessionStoreForTests();
    window.sessionStorage.setItem("tvh.session", "tvh_s_persist");
    expect(getSessionToken()).toBe("tvh_s_persist");
  });

  it("never touches localStorage", () => {
    setSessionToken("tvh_s_local");
    expect(window.localStorage.getItem("tvh.session")).toBeNull();
  });
});
