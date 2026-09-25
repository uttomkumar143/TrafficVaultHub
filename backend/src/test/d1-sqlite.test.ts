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
      "advertiser_profiles",
      "advertiser_status_transitions",
      "affiliate_profiles",
      "affiliate_status_transitions",
      "affiliate_traffic_sources",
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

  it("applies 0004: permission catalogue (PRD §10) and role grants", async () => {
    db = createTestD1();
    const perms = await db.prepare("SELECT key FROM permissions ORDER BY key").all<{ key: string }>();
    expect(perms.results.map((p) => p.key)).toEqual([
      "advertisers.manage",
      "advertisers.read",
      "advertisers.review",
      "affiliates.manage",
      "affiliates.read",
      "affiliates.review",
      "audit.read",
      "compliance.read",
      "compliance.resolve",
      "conversions.approve",
      "conversions.read",
      "conversions.reject",
      "fraud.read",
      "fraud.review",
      "ledger.adjust",
      "ledger.read",
      "members.manage",
      "members.read",
      "offers.approve",
      "offers.create",
      "offers.pause",
      "offers.read",
      "offers.update",
      "organizations.read",
      "organizations.update",
      "payouts.approve",
      "payouts.read",
      "payouts.release",
      "payouts.review",
    ]);

    const grants = await db
      .prepare(
        `SELECT r.key AS role, p.key AS permission
           FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
          ORDER BY r.key, p.key`,
      )
      .all<{ role: string; permission: string }>();
    const byRole = new Map<string, string[]>();
    for (const g of grants.results) byRole.set(g.role, [...(byRole.get(g.role) ?? []), g.permission]);

    // Every system role has at least one grant; SUPER_ADMIN has all.
    expect([...byRole.keys()].sort()).toHaveLength(14);
    expect(byRole.get("SUPER_ADMIN")).toEqual(perms.results.map((p) => p.key));

    // Owner roles hold the management keys; VIEWER holds only read keys.
    for (const owner of ["ADVERTISER_OWNER", "AFFILIATE_OWNER"]) {
      expect(byRole.get(owner)).toEqual(expect.arrayContaining(["organizations.update", "members.manage"]));
    }
    expect(byRole.get("VIEWER")).toEqual([
      "advertisers.read",
      "affiliates.read",
      "conversions.read",
      "members.read",
      "offers.read",
      "organizations.read",
    ]);

    // 0005: tenant advertiser roles manage their own profile; only platform roles review.
    expect(byRole.get("ADVERTISER_OWNER")).toEqual(expect.arrayContaining(["advertisers.read", "advertisers.manage"]));
    expect(byRole.get("AFFILIATE_OWNER")).not.toEqual(expect.arrayContaining(["advertisers.manage"]));

    // 0006: affiliate tenant roles manage their own profile; advertiser roles hold no affiliates.* key.
    expect(byRole.get("AFFILIATE_OWNER")).toEqual(expect.arrayContaining(["affiliates.read", "affiliates.manage"]));
    expect(byRole.get("AFFILIATE_MANAGER")).toEqual(expect.arrayContaining(["affiliates.read", "affiliates.manage"]));
    expect(byRole.get("AFFILIATE_USER")).toEqual(expect.arrayContaining(["affiliates.read"]));
    expect(byRole.get("AFFILIATE_USER")).not.toEqual(expect.arrayContaining(["affiliates.manage"]));
    expect(byRole.get("ADVERTISER_OWNER")!.filter((k) => k.startsWith("affiliates."))).toEqual([]);
    expect(byRole.get("OPERATIONS_ADMIN")).toEqual(expect.arrayContaining(["affiliates.review"]));

    // Network-only powers never reach tenant roles (PRD §11 separation of duties).
    const networkOnly = [
      "offers.approve",
      "ledger.adjust",
      "payouts.approve",
      "payouts.release",
      "compliance.resolve",
      "fraud.review",
      "advertisers.review",
      "affiliates.review",
    ];
    for (const [role, keys] of byRole) {
      if (["SUPER_ADMIN", "OPERATIONS_ADMIN", "FINANCE_MANAGER", "COMPLIANCE_MANAGER"].includes(role)) continue;
      expect(keys.filter((k) => networkOnly.includes(k)), role).toEqual([]);
    }
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
