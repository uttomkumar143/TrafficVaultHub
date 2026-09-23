import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requestMeta, USER_AGENT_MAX_LENGTH } from "./request-meta";

/** Run `requestMeta` inside a real Hono context for the given headers. */
async function capture(headers: Record<string, string>) {
  const app = new Hono();
  app.get("/", (c) => c.json(requestMeta(c)));
  const res = await app.request("/", { headers });
  return (await res.json()) as { ip_address: string | null; user_agent: string | null; request_id: string | null };
}

describe("requestMeta (shared audit metadata helper)", () => {
  it("reads client ip, user agent and request id from Cloudflare headers", async () => {
    const m = await capture({ "cf-connecting-ip": "203.0.113.9", "user-agent": "UA/1.0", "cf-ray": "abc123-SIN" });
    expect(m).toEqual({ ip_address: "203.0.113.9", user_agent: "UA/1.0", request_id: "abc123-SIN" });
  });

  it("yields nulls (never undefined / never a spoofable fallback) when headers are absent", async () => {
    expect(await capture({})).toEqual({ ip_address: null, user_agent: null, request_id: null });
  });

  it("bounds the stored user agent length", async () => {
    const m = await capture({ "user-agent": "x".repeat(USER_AGENT_MAX_LENGTH + 100) });
    expect(m.user_agent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });

  it("does not consult client-controlled forwarding headers for the ip", async () => {
    // Only the edge-set `cf-connecting-ip` is trusted; `x-forwarded-for` is ignored.
    const m = await capture({ "x-forwarded-for": "10.0.0.1" });
    expect(m.ip_address).toBeNull();
  });
});
