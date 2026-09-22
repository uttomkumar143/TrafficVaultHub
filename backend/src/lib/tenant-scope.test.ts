/**
 * Phase 1 Unit 5 — tenant-scoping helper.
 * Proves the helper refuses SQL that could leak across tenants and binds the
 * tenant id from the resolved TenantContext (never a client value).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TenantContext } from "../middleware/require-org";
import { createTestD1, type TestD1 } from "../test/d1-sqlite";
import { UnscopedQueryError, assertScopedSql, scopedQuery, tenantIdOf } from "./tenant-scope";

const tenant = (organizationId: string): TenantContext => ({
  organization: { id: organizationId, type: "ADVERTISER", name: "Acme", slug: "acme", status: "ACTIVE" },
  membership: { id: "m1", joined_at: null },
  role: { id: "r1", key: "ADVERTISER_OWNER", is_owner: true },
  permissions: new Set(["organizations.read"]),
});

describe("assertScopedSql", () => {
  it("accepts statements whose FIRST placeholder is an organization_id predicate", () => {
    for (const sql of [
      "SELECT * FROM offers WHERE organization_id = ? AND id = ?",
      "SELECT o.id FROM offers o WHERE o.organization_id = ? ORDER BY o.created_at",
      "select * from offers where ORGANIZATION_ID=? and status = ?",
      `UPDATE offers SET name = ?, updated_at = ?
         WHERE organization_id = ? AND id = ?`.replace("SET name = ?, updated_at = ?", "SET name = 'x'"),
      "DELETE FROM offer_creatives WHERE organization_id = ? AND id = ?",
    ]) {
      expect(() => assertScopedSql(sql), sql).not.toThrow();
    }
  });

  it("rejects statements with no organization_id predicate", () => {
    for (const sql of [
      "SELECT * FROM offers WHERE id = ?",
      "SELECT * FROM offers",
      "UPDATE offers SET status = 'PAUSED' WHERE id = ?",
      "DELETE FROM offers WHERE id = ?",
      // Predicate present but not a bind placeholder — a literal id is not tenant-derived.
      "SELECT * FROM offers WHERE organization_id = 'abc' AND id = ?",
      // Similar-looking column names must not satisfy the check.
      "SELECT * FROM offers WHERE advertiser_organization_ids = ? AND id = ?",
    ]) {
      expect(() => assertScopedSql(sql), sql).toThrow(UnscopedQueryError);
    }
  });

  it("rejects statements where another placeholder precedes the organization_id predicate", () => {
    // Binding the tenant id first would land it on `id`, not `organization_id`.
    expect(() => assertScopedSql("SELECT * FROM offers WHERE id = ? AND organization_id = ?")).toThrow(
      UnscopedQueryError,
    );
    expect(() =>
      assertScopedSql("UPDATE offers SET name = ? WHERE organization_id = ? AND id = ?"),
    ).toThrow(UnscopedQueryError);
  });

  it("does not echo the full statement beyond a short summary in the error", () => {
    const long = `SELECT * FROM offers WHERE id = ? ${"-- padding ".repeat(50)}`;
    try {
      assertScopedSql(long);
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UnscopedQueryError);
      expect((e as Error).message.length).toBeLessThan(220);
    }
  });
});

describe("scopedQuery against the real schema", () => {
  let db: TestD1;
  afterEach(() => db.close());

  it("binds the tenant id first and only returns the tenant's rows", async () => {
    db = createTestD1();
    // audit_logs is the only organization_id-owned table today; use it as the fixture.
    await db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com')").run();
    await db.prepare("INSERT INTO organizations (id, type, name, slug) VALUES ('orgA', 'ADVERTISER', 'A', 'a')").run();
    await db.prepare("INSERT INTO organizations (id, type, name, slug) VALUES ('orgB', 'ADVERTISER', 'B', 'b')").run();
    await db
      .prepare(
        `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, target_type, target_id)
         VALUES ('l1','orgA','u1','x.created','x','1'), ('l2','orgB','u1','x.created','x','2'), ('l3','orgA','u1','x.updated','x','1')`,
      )
      .run();

    const tid = tenantIdOf(tenant("orgA"));
    const rows = await scopedQuery(
      db,
      "SELECT id FROM audit_logs WHERE organization_id = ? AND action = ? ORDER BY id",
      tid,
      "x.created",
    ).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(["l1"]);

    const all = await scopedQuery(db, "SELECT id FROM audit_logs WHERE organization_id = ? ORDER BY id", tid).all<{
      id: string;
    }>();
    expect(all.results.map((r) => r.id)).toEqual(["l1", "l3"]);

    // A row id that belongs to the other tenant is invisible under this tenant.
    const foreign = await scopedQuery(
      db,
      "SELECT id FROM audit_logs WHERE organization_id = ? AND id = ?",
      tid,
      "l2",
    ).first<{ id: string }>();
    expect(foreign).toBeNull();
  });

  it("throws before touching the database when the SQL is unscoped", () => {
    db = createTestD1();
    const tid = tenantIdOf(tenant("orgA"));
    expect(() => scopedQuery(db, "SELECT id FROM audit_logs WHERE id = ?", tid, "l1")).toThrow(UnscopedQueryError);
  });
});

describe("tenantIdOf", () => {
  it("is the only way to obtain a TenantId (type-level guard)", () => {
    const tid = tenantIdOf(tenant("orgA"));
    expect(tid).toBe("orgA");
    // @ts-expect-error — a raw string (e.g. from a request body) is not a TenantId.
    const bad: import("./tenant-scope").TenantId = "orgB";
    void bad;
  });
});
