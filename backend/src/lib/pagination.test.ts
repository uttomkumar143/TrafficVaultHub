import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  parsePageRequest,
  slicePage,
} from "./pagination";

const ID = "11111111-1111-4111-8111-111111111111";

describe("cursor pagination (PRD §127)", () => {
  it("round-trips a cursor through an opaque base64url string", () => {
    const c = { created_at: "2026-09-23T10:00:00.000Z", id: ID };
    const enc = encodeCursor(c);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(enc)).toEqual(c);
  });

  it("rejects garbage, non-base64url and structurally wrong cursors with 400 INVALID_CURSOR", () => {
    for (const bad of ["not base64!", "%%%", btoa("[1,2]"), btoa(JSON.stringify({ created_at: "x", id: "no" }))]) {
      try {
        decodeCursor(bad.replace(/=+$/, ""));
        expect.unreachable("should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).status).toBe(400);
        expect((e as AppError).code).toBe("INVALID_CURSOR");
      }
    }
  });

  it("parses limit with default and hard maximum; rejects out-of-range values", () => {
    const q = (vals: Record<string, string>) => (k: string) => vals[k];
    expect(parsePageRequest(q({}))).toEqual({ limit: DEFAULT_PAGE_SIZE, cursor: null });
    expect(parsePageRequest(q({ limit: "10" })).limit).toBe(10);
    expect(parsePageRequest(q({ limit: String(MAX_PAGE_SIZE) })).limit).toBe(MAX_PAGE_SIZE);
    for (const bad of ["0", "-1", "1.5", "abc", String(MAX_PAGE_SIZE + 1)]) {
      expect(() => parsePageRequest(q({ limit: bad }))).toThrowError(/limit/);
    }
    const cursor = encodeCursor({ created_at: "2026-01-01T00:00:00.000Z", id: ID });
    expect(parsePageRequest(q({ cursor })).cursor).toEqual({ created_at: "2026-01-01T00:00:00.000Z", id: ID });
  });

  it("slicePage returns exactly `limit` items and a next_cursor only when more rows exist", () => {
    const rows = [1, 2, 3, 4].map((i) => ({ id: ID.replace(/1/g, String(i)), created_at: `2026-01-0${i}T00:00:00.000Z` }));
    const full = slicePage(rows, 3);
    expect(full.items).toHaveLength(3);
    expect(full.next_cursor).not.toBeNull();
    expect(decodeCursor(full.next_cursor!)).toEqual({ created_at: rows[2].created_at, id: rows[2].id });

    const last = slicePage(rows.slice(0, 2), 3);
    expect(last.items).toHaveLength(2);
    expect(last.next_cursor).toBeNull();
  });
});
