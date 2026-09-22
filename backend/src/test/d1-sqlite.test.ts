import { afterEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "./d1-sqlite";

describe("test D1 shim", () => {
  let db: TestD1;
  afterEach(() => db?.close());

  it("applies every migration file and exposes the identity tables", async () => {
    db = createTestD1();
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual([
      "auth_events",
      "auth_tokens",
      "organization_members",
      "organizations",
      "permissions",
      "role_permissions",
      "roles",
      "sessions",
      "user_credentials",
      "users",
    ]);
  });

  it("supports bind/first/run and enforces schema constraints", async () => {
    db = createTestD1();
    const ins = await db
      .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
      .bind("u1", "a@example.com")
      .run();
    expect(ins.meta.changes).toBe(1);

    const row = await db.prepare("SELECT email, mfa_enabled FROM users WHERE id = ?").bind("u1").first<{
      email: string;
      mfa_enabled: number;
    }>();
    expect(row).toEqual({ email: "a@example.com", mfa_enabled: 0 });

    // unique index on lower(email)
    await expect(
      db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("u2", "A@EXAMPLE.COM").run(),
    ).rejects.toThrow();
  });
});
