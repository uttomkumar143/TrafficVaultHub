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
      "audit_logs",
      "auth_events",
      "auth_tokens",
      "organization_members",
      "organizations",
      "permissions",
      "role_org_types",
      "role_permissions",
      "roles",
      "sessions",
      "user_credentials",
      "users",
    ]);
  });

  it("applies 0003: role catalogue (PRD §9), is_owner flag and role_org_types", async () => {
    db = createTestD1();
    const roles = await db
      .prepare("SELECT key, is_owner FROM roles WHERE organization_id IS NULL AND is_system = 1 ORDER BY key")
      .all<{ key: string; is_owner: number }>();
    expect(roles.results.map((r) => r.key)).toEqual([
      "ADVERTISER_ADMIN",
      "ADVERTISER_OWNER",
      "AFFILIATE_MANAGER",
      "AFFILIATE_OWNER",
      "AFFILIATE_USER",
      "ANALYST",
      "BILLING_MANAGER",
      "CAMPAIGN_MANAGER",
      "COMPLIANCE_MANAGER",
      "FINANCE_MANAGER",
      "OPERATIONS_ADMIN",
      "SUPER_ADMIN",
      "SUPPORT_AGENT",
      "VIEWER",
    ]);
    expect(roles.results.filter((r) => r.is_owner === 1).map((r) => r.key)).toEqual([
      "ADVERTISER_OWNER",
      "AFFILIATE_OWNER",
      "SUPER_ADMIN",
    ]);

    // Exactly one owner role per organization type.
    const owners = await db
      .prepare(
        `SELECT t.org_type, COUNT(*) AS n
           FROM role_org_types t JOIN roles r ON r.id = t.role_id
          WHERE r.is_owner = 1 GROUP BY t.org_type ORDER BY t.org_type`,
      )
      .all<{ org_type: string; n: number }>();
    expect(owners.results).toEqual([
      { org_type: "ADVERTISER", n: 1 },
      { org_type: "AFFILIATE", n: 1 },
      { org_type: "AGENCY", n: 1 },
      { org_type: "PARTNER", n: 1 },
      { org_type: "PLATFORM", n: 1 },
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
