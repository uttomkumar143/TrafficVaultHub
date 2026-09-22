import { describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("GET /api/v1/health", () => {
  it("returns HTTP 200 with { status: 'ok' }", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns the uniform 404 envelope for unknown routes", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
