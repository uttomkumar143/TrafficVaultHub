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
      "advertiser_postback_secrets",
      "advertiser_profiles",
      "advertiser_status_transitions",
      "affiliate_offer_access",
      "affiliate_profiles",
      "affiliate_status_transitions",
      "affiliate_traffic_sources",
      "attribution_policies",
      "attributions",
      "audit_logs",
      "auth_events",
      "auth_tokens",
      "balance_snapshots",
      "clicks",
      "commissions",
      "compliance_case_events",
      "compliance_cases",
      "compliance_evaluations",
      "compliance_rules",
      "conversion_holds",
      "conversion_reversals",
      "conversion_status_history",
      "conversions",
      "financial_adjustment_history",
      "financial_adjustments",
      "financial_processing_errors",
      "fraud_actions",
      "fraud_assessments",
      "fraud_case_events",
      "fraud_cases",
      "journal_entries",
      "ledger_accounts",
      "ledger_entries",
      "offer_cap_counters",
      "offer_status_transitions",
      "offer_version_targeting",
      "offer_versions",
      "offers",
      "organization_members",
      "organizations",
      "permissions",
      "postback_nonces",
      "reconciliation_cases",
      "reconciliation_runs",
      "reserves",
      "role_org_types",
      "role_permissions",
      "roles",
      "sessions",
      "smartlink_offers",
      "smartlinks",
      "tracking_links",
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
    expect(roles.results.filter((r) => r.is_owner === 1).map((r) => r.key)).toEqual(["ADVERTISER_OWNER", "AFFILIATE_OWNER", "SUPER_ADMIN"]);

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
      "attribution.manage",
      "attribution.read",
      "audit.read",
      "compliance.manage",
      "compliance.read",
      "compliance.resolve",
      "conversions.approve",
      "conversions.read",
      "conversions.reject",
      "conversions.reverse",
      "fraud.manage",
      "fraud.read",
      "fraud.review",
      "ledger.adjust",
      "ledger.approve",
      "ledger.read",
      "ledger.reserve",
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
      "reconciliation.manage",
      "reconciliation.read",
      "tracking.manage",
      "tracking.read",
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
      "attribution.read",
      "conversions.read",
      "members.read",
      "offers.read",
      "organizations.read",
      "tracking.read",
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

    // 0008: affiliates own tracking links/SmartLinks; advertisers own attribution policy + postback secrets.
    expect(byRole.get("AFFILIATE_OWNER")).toEqual(expect.arrayContaining(["tracking.read", "tracking.manage", "attribution.read"]));
    expect(byRole.get("AFFILIATE_OWNER")).not.toEqual(expect.arrayContaining(["attribution.manage"]));
    expect(byRole.get("AFFILIATE_USER")).not.toEqual(expect.arrayContaining(["tracking.manage"]));
    expect(byRole.get("ADVERTISER_OWNER")).toEqual(expect.arrayContaining(["tracking.read", "attribution.read", "attribution.manage"]));
    expect(byRole.get("ADVERTISER_OWNER")).not.toEqual(expect.arrayContaining(["tracking.manage"]));
    expect(byRole.get("BILLING_MANAGER")).not.toEqual(expect.arrayContaining(["attribution.manage"]));

    // 0009: advertisers may reverse own conversions and read reconciliation; only platform roles manage fraud/compliance/reconciliation.
    expect(byRole.get("ADVERTISER_OWNER")).toEqual(expect.arrayContaining(["conversions.reverse", "reconciliation.read"]));
    expect(byRole.get("ADVERTISER_OWNER")).not.toEqual(expect.arrayContaining(["reconciliation.manage"]));
    expect(byRole.get("AFFILIATE_OWNER")!.filter((k) => k.startsWith("reconciliation.") || k === "conversions.reverse")).toEqual([]);
    expect(byRole.get("COMPLIANCE_MANAGER")).toEqual(expect.arrayContaining(["fraud.manage", "compliance.manage"]));
    expect(byRole.get("FINANCE_MANAGER")).toEqual(expect.arrayContaining(["conversions.reverse", "reconciliation.manage"]));
    // 0010: adjustment approval / reserves are finance powers; COMPLIANCE_MANAGER and tenant roles never hold them.
    for (const role of ["SUPER_ADMIN", "OPERATIONS_ADMIN", "FINANCE_MANAGER"]) {
      expect(byRole.get(role), role).toEqual(expect.arrayContaining(["ledger.approve", "ledger.reserve"]));
    }
    expect(byRole.get("COMPLIANCE_MANAGER")!.filter((k) => k === "ledger.approve" || k === "ledger.reserve")).toEqual([]);
    expect(byRole.get("ADVERTISER_OWNER")!.filter((k) => k.startsWith("ledger."))).toEqual(["ledger.read"]);
    expect(byRole.get("AFFILIATE_OWNER")!.filter((k) => k.startsWith("ledger."))).toEqual(["ledger.read"]);

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
      "fraud.manage",
      "compliance.manage",
      "reconciliation.manage",
      "ledger.approve",
      "ledger.reserve",
    ];
    for (const [role, keys] of byRole) {
      if (["SUPER_ADMIN", "OPERATIONS_ADMIN", "FINANCE_MANAGER", "COMPLIANCE_MANAGER"].includes(role)) continue;
      expect(
        keys.filter((k) => networkOnly.includes(k)),
        role,
      ).toEqual([]);
    }
  });

  it("applies 0010: ledger journal rows are append-only and closed/mismatched accounts refuse entries (PRD §57, §131)", async () => {
    db = createTestD1();
    db.sqlite.exec(`
      INSERT INTO organizations (id, type, name, slug) VALUES ('org-a', 'AFFILIATE', 'A', 'a');
      INSERT INTO ledger_accounts (id, organization_id, code, account_type, currency, name) VALUES
        ('acc-pay', 'org-a', 'AFFILIATE_PAYABLE', 'LIABILITY', 'USD', 'payable'),
        ('acc-rec', 'org-a', 'ADVERTISER_RECEIVABLE', 'ASSET', 'USD', 'receivable'),
        ('acc-eur', 'org-a', 'CASH', 'ASSET', 'EUR', 'cash eur'),
        ('acc-closed', 'org-a', 'PAYOUT_FEES', 'EXPENSE', 'USD', 'fees');
      UPDATE ledger_accounts SET status = 'CLOSED', closed_at = '2026-01-01T00:00:00.000Z' WHERE id = 'acc-closed';
      INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, idempotency_key, actor_type, posted_at)
        VALUES ('j1', 'org-a', 'CONVERSION_COMMISSION', 'USD', 4000, 'CONVERSION', 'c1', 'commission:c1', 'INTERNAL', '2026-03-15T12:00:00.000Z');
      INSERT INTO ledger_entries (id, journal_id, organization_id, account_id, entry_index, direction, amount_minor, currency)
        VALUES ('e1', 'j1', 'org-a', 'acc-rec', 0, 'DEBIT', 4000, 'USD'), ('e2', 'j1', 'org-a', 'acc-pay', 1, 'CREDIT', 4000, 'USD');
    `);
    const run = (sql: string) => db.prepare(sql).run();
    // append-only: UPDATE / DELETE on posted rows abort
    await expect(run("UPDATE journal_entries SET total_minor = 1 WHERE id = 'j1'")).rejects.toThrow(/JOURNAL_ENTRIES_APPEND_ONLY/);
    await expect(run("DELETE FROM journal_entries WHERE id = 'j1'")).rejects.toThrow(/JOURNAL_ENTRIES_APPEND_ONLY/);
    await expect(run("UPDATE ledger_entries SET amount_minor = 1 WHERE id = 'e1'")).rejects.toThrow(/LEDGER_ENTRIES_APPEND_ONLY/);
    await expect(run("DELETE FROM ledger_entries WHERE id = 'e1'")).rejects.toThrow(/LEDGER_ENTRIES_APPEND_ONLY/);
    // duplicate idempotency key can never post twice
    await expect(
      run(
        `INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, idempotency_key, actor_type, posted_at)
         VALUES ('j2', 'org-a', 'CONVERSION_COMMISSION', 'USD', 4000, 'CONVERSION', 'c1', 'commission:c1', 'INTERNAL', '2026-03-15T12:00:00.000Z')`,
      ),
    ).rejects.toThrow(/UNIQUE/);
    // legs: negative/zero amount, closed account, currency mismatch with account or journal
    const leg = (id: string, acc: string, amt: number, cur: string) =>
      run(
        `INSERT INTO ledger_entries (id, journal_id, organization_id, account_id, entry_index, direction, amount_minor, currency)
         VALUES ('${id}', 'j1', 'org-a', '${acc}', 9, 'DEBIT', ${amt}, '${cur}')`,
      );
    await expect(leg("e-neg", "acc-rec", -5, "USD")).rejects.toThrow(/CHECK/);
    await expect(leg("e-zero", "acc-rec", 0, "USD")).rejects.toThrow(/CHECK/);
    await expect(leg("e-closed", "acc-closed", 5, "USD")).rejects.toThrow(/LEDGER_ACCOUNT_NOT_OPEN/);
    await expect(leg("e-eur", "acc-eur", 5, "EUR")).rejects.toThrow(/LEDGER_ENTRY_JOURNAL_CURRENCY_MISMATCH/);
    await expect(leg("e-mix", "acc-eur", 5, "USD")).rejects.toThrow(/LEDGER_ENTRY_ACCOUNT_CURRENCY_MISMATCH/);
    await expect(leg("e-missing", "acc-nope", 5, "USD")).rejects.toThrow(/LEDGER_ACCOUNT_MISSING/);
    // accounts: closed account cannot reopen, frozen columns, no delete
    await expect(run("UPDATE ledger_accounts SET status = 'OPEN', closed_at = NULL WHERE id = 'acc-closed'")).rejects.toThrow(
      /LEDGER_ACCOUNT_CLOSED/,
    );
    await expect(run("UPDATE ledger_accounts SET currency = 'EUR' WHERE id = 'acc-pay'")).rejects.toThrow(/LEDGER_ACCOUNT_IMMUTABLE/);
    await expect(run("DELETE FROM ledger_accounts WHERE id = 'acc-eur'")).rejects.toThrow(/LEDGER_ACCOUNT_IMMUTABLE/);
    // compensating journal must match currency + total and only reverse once
    const rev = (id: string, cur: string, total: number) =>
      run(
        `INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, reverses_journal_id, idempotency_key, actor_type, posted_at)
         VALUES ('${id}', 'org-a', 'CONVERSION_REVERSAL', '${cur}', ${total}, 'CONVERSION_REVERSAL', 'r1', 'j1', 'reversal:${id}', 'INTERNAL', '2026-03-16T00:00:00.000Z')`,
      );
    await expect(rev("r-eur", "EUR", 4000)).rejects.toThrow(/JOURNAL_REVERSAL_CURRENCY_MISMATCH/);
    await expect(rev("r-total", "USD", 4001)).rejects.toThrow(/JOURNAL_REVERSAL_TOTAL_MISMATCH/);
    await rev("r-ok", "USD", 4000);
    await expect(rev("r-twice", "USD", 4000)).rejects.toThrow(/JOURNAL_ALREADY_REVERSED/);
    // a non-reversal journal type cannot carry reverses_journal_id and vice versa
    await expect(
      run(
        `INSERT INTO journal_entries (id, organization_id, journal_type, currency, total_minor, reference_type, reference_id, idempotency_key, actor_type, posted_at)
         VALUES ('j-bad', 'org-a', 'CONVERSION_REVERSAL', 'USD', 1, 'CONVERSION_REVERSAL', 'x', 'reversal:none', 'INTERNAL', '2026-03-16T00:00:00.000Z')`,
      ),
    ).rejects.toThrow(/CHECK/);
    // fail-safe + snapshot rows are append-only too
    db.sqlite.exec(`
      INSERT INTO financial_processing_errors (id, organization_id, operation, reference_type, reference_id, reason_code)
        VALUES ('fpe1', 'org-a', 'POST_CONVERSION_COMMISSION', 'CONVERSION', 'c9', 'COMMISSION_MISMATCH');
      INSERT INTO balance_snapshots (id, account_id, organization_id, currency, debit_total_minor, credit_total_minor, balance_minor, entry_count, as_of)
        VALUES ('bs1', 'acc-pay', 'org-a', 'USD', 0, 4000, 4000, 1, '2026-03-15T12:00:00.000Z');
    `);
    await expect(run("DELETE FROM financial_processing_errors WHERE id = 'fpe1'")).rejects.toThrow(/APPEND_ONLY/);
    await expect(run("UPDATE balance_snapshots SET balance_minor = 0 WHERE id = 'bs1'")).rejects.toThrow(/APPEND_ONLY/);
    await expect(
      run(
        `INSERT INTO balance_snapshots (id, account_id, organization_id, currency, debit_total_minor, credit_total_minor, balance_minor, entry_count, as_of)
         VALUES ('bs-bad', 'acc-pay', 'org-a', 'USD', 0, 4000, 1, 1, '2026-03-15T12:00:00.000Z')`,
      ),
    ).rejects.toThrow(/CHECK/);
    // financial_adjustments: approver must differ from requester; POSTED needs a journal
    db.sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('u-req', 'req@example.com'), ('u-app', 'app@example.com');
      INSERT INTO financial_adjustments (id, organization_id, account_id, counter_account_id, direction, amount_minor, currency, reason_code, reason_note,
        before_state, requested_by_user_id) VALUES ('adj1', 'org-a', 'acc-pay', 'acc-rec', 'CREDIT', 100, 'USD', 'BONUS', 'bonus', '{}', 'u-req');
    `);
    await expect(
      run("UPDATE financial_adjustments SET status = 'APPROVED', approved_by_user_id = 'u-req', approved_at = 'x' WHERE id = 'adj1'"),
    ).rejects.toThrow(/CHECK/);
    await expect(run("UPDATE financial_adjustments SET status = 'POSTED' WHERE id = 'adj1'")).rejects.toThrow(/CHECK/);
    await expect(run("UPDATE financial_adjustments SET amount_minor = 999 WHERE id = 'adj1'")).rejects.toThrow(
      /FINANCIAL_ADJUSTMENT_IMMUTABLE/,
    );
    await run("UPDATE financial_adjustments SET status = 'APPROVED', approved_by_user_id = 'u-app', approved_at = 'x' WHERE id = 'adj1'");
    await run("UPDATE financial_adjustments SET status = 'REJECTED', approved_by_user_id = NULL, approved_at = NULL WHERE id = 'adj1'");
    await expect(run("UPDATE financial_adjustments SET status = 'REQUESTED' WHERE id = 'adj1'")).rejects.toThrow(
      /FINANCIAL_ADJUSTMENT_FINAL/,
    );
    await expect(run("DELETE FROM financial_adjustments WHERE id = 'adj1'")).rejects.toThrow(/FINANCIAL_ADJUSTMENT_IMMUTABLE/);
    // reserves: released is final; money frozen
    db.sqlite.exec(`INSERT INTO reserves (id, organization_id, reserve_type, currency, amount_minor, reason_code, actor_type)
      VALUES ('res1', 'org-a', 'RISK', 'USD', 500, 'NEW_AFFILIATE', 'PLATFORM');`);
    await expect(run("UPDATE reserves SET amount_minor = 1 WHERE id = 'res1'")).rejects.toThrow(/RESERVE_IMMUTABLE/);
    await run("UPDATE reserves SET status = 'RELEASED', released_at = 'x' WHERE id = 'res1'");
    await expect(run("UPDATE reserves SET status = 'ACTIVE', released_at = NULL WHERE id = 'res1'")).rejects.toThrow(
      /RESERVE_ALREADY_RELEASED/,
    );
    await expect(run("DELETE FROM reserves WHERE id = 'res1'")).rejects.toThrow(/RESERVE_IMMUTABLE/);
  });

  it("supports bind/first/run and enforces schema constraints", async () => {
    db = createTestD1();
    const ins = await db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("u1", "a@example.com").run();
    expect(ins.meta.changes).toBe(1);

    const row = await db.prepare("SELECT email, mfa_enabled FROM users WHERE id = ?").bind("u1").first<{
      email: string;
      mfa_enabled: number;
    }>();
    expect(row).toEqual({ email: "a@example.com", mfa_enabled: 0 });

    // unique index on lower(email)
    await expect(db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("u2", "A@EXAMPLE.COM").run()).rejects.toThrow();
  });
});
