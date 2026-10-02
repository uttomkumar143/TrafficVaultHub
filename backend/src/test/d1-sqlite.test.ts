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
      "advertiser_billing_profiles",
      "advertiser_funding_events",
      "advertiser_postback_secrets",
      "advertiser_profiles",
      "advertiser_status_transitions",
      "affiliate_offer_access",
      "affiliate_profiles",
      "affiliate_status_transitions",
      "affiliate_traffic_sources",
      "api_keys",
      "appeal_decisions",
      "appeals",
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
      "dispute_decisions",
      "dispute_evidence",
      "disputes",
      "financial_adjustment_history",
      "financial_adjustments",
      "financial_processing_errors",
      "fraud_actions",
      "fraud_assessments",
      "fraud_case_events",
      "fraud_cases",
      "funding_alerts",
      "journal_entries",
      "ledger_accounts",
      "ledger_entries",
      "notification_preferences",
      "notifications",
      "offer_cap_counters",
      "offer_status_transitions",
      "offer_version_targeting",
      "offer_versions",
      "offers",
      "organization_members",
      "organizations",
      "payout_attempts",
      "payout_methods",
      "payout_status_history",
      "payouts",
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
      "support_agent_tenant_access",
      "support_ticket_events",
      "support_ticket_messages",
      "support_tickets",
      "tracking_links",
      "user_credentials",
      "users",
      "webhook_deliveries",
      "webhook_delivery_attempts",
      "webhook_events",
      "webhook_subscriptions",
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
      "api_keys.manage",
      "api_keys.read",
      "appeals.create",
      "appeals.manage",
      "appeals.read",
      "attribution.manage",
      "attribution.read",
      "audit.read",
      "billing.manage",
      "billing.read",
      "compliance.manage",
      "compliance.read",
      "compliance.resolve",
      "conversions.approve",
      "conversions.read",
      "conversions.reject",
      "conversions.reverse",
      "disputes.create",
      "disputes.manage",
      "disputes.read",
      "fraud.manage",
      "fraud.read",
      "fraud.review",
      "ledger.adjust",
      "ledger.approve",
      "ledger.read",
      "ledger.reserve",
      "members.manage",
      "members.read",
      "notifications.read",
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
      "payouts.request",
      "payouts.review",
      "reconciliation.manage",
      "reconciliation.read",
      "support.create",
      "support.manage",
      "support.read",
      "tracking.manage",
      "tracking.read",
      "webhooks.manage",
      "webhooks.read",
      "webhooks.replay",
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
      "appeals.read",
      "attribution.read",
      "conversions.read",
      "disputes.read",
      "members.read",
      "notifications.read",
      "offers.read",
      "organizations.read",
      "support.read",
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
    // 0011: billing management is a finance power; advertiser tenants only READ their funding position;
    // affiliates may REQUEST a payout of their own balance but never review/approve/release one.
    for (const role of ["SUPER_ADMIN", "OPERATIONS_ADMIN", "FINANCE_MANAGER"]) {
      expect(byRole.get(role), role).toEqual(expect.arrayContaining(["billing.read", "billing.manage", "payouts.request"]));
    }
    for (const role of ["ADVERTISER_OWNER", "ADVERTISER_ADMIN", "BILLING_MANAGER"]) {
      expect(byRole.get(role)!.filter((k) => k.startsWith("billing.")), role).toEqual(["billing.read"]);
      expect(byRole.get(role)!.filter((k) => k.startsWith("payouts.")), role).toEqual([]);
    }
    for (const role of ["AFFILIATE_OWNER", "AFFILIATE_MANAGER"]) {
      expect(byRole.get(role)!.filter((k) => k.startsWith("payouts.")).sort(), role).toEqual(["payouts.read", "payouts.request"]);
      expect(byRole.get(role)!.filter((k) => k.startsWith("billing.")), role).toEqual([]);
    }
    expect(byRole.get("AFFILIATE_USER")!.filter((k) => k === "payouts.request")).toEqual([]);
    expect(byRole.get("COMPLIANCE_MANAGER")!.filter((k) => k.startsWith("billing."))).toEqual([]);
    // 0012: replay / decide / agent-manage are platform powers; tenant owners self-serve keys, webhooks,
    // tickets, disputes and appeals; every tenant role reads its own notifications; VIEWER never manages.
    for (const role of ["SUPER_ADMIN", "OPERATIONS_ADMIN"]) {
      expect(byRole.get(role), role).toEqual(
        expect.arrayContaining(["webhooks.replay", "support.manage", "disputes.manage", "appeals.manage"]),
      );
    }
    expect(byRole.get("SUPPORT_AGENT")).toEqual(expect.arrayContaining(["support.read", "support.manage"]));
    expect(byRole.get("SUPPORT_AGENT")!.filter((k) => ["disputes.manage", "appeals.manage", "webhooks.replay"].includes(k))).toEqual([]);
    expect(byRole.get("COMPLIANCE_MANAGER")).toEqual(expect.arrayContaining(["appeals.manage", "disputes.manage"]));
    expect(byRole.get("FINANCE_MANAGER")).toEqual(expect.arrayContaining(["disputes.manage"]));
    expect(byRole.get("FINANCE_MANAGER")!.filter((k) => k === "appeals.manage")).toEqual([]);
    for (const role of ["ADVERTISER_OWNER", "AFFILIATE_OWNER"]) {
      expect(byRole.get(role), role).toEqual(
        expect.arrayContaining([
          "api_keys.manage",
          "webhooks.manage",
          "support.create",
          "disputes.create",
          "appeals.create",
          "notifications.read",
        ]),
      );
    }
    for (const role of ["CAMPAIGN_MANAGER", "BILLING_MANAGER", "AFFILIATE_USER"]) {
      expect(byRole.get(role)!.filter((k) => k === "api_keys.manage" || k === "webhooks.manage"), role).toEqual([]);
      expect(byRole.get(role), role).toEqual(expect.arrayContaining(["api_keys.read", "support.create", "notifications.read"]));
    }
    expect(byRole.get("VIEWER")!.filter((k) => k.startsWith("api_keys.") || k.startsWith("webhooks.") || k.endsWith(".create"))).toEqual([]);
    expect(byRole.get("VIEWER")).toEqual(expect.arrayContaining(["notifications.read"]));
    for (const [role, keys] of byRole) expect(keys, role).toContain("notifications.read");

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
      "billing.manage",
      "webhooks.replay",
      "support.manage",
      "disputes.manage",
      "appeals.manage",
    ];
    for (const [role, keys] of byRole) {
      if (["SUPER_ADMIN", "OPERATIONS_ADMIN", "FINANCE_MANAGER", "COMPLIANCE_MANAGER", "SUPPORT_AGENT"].includes(role)) continue;
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

  it("applies 0011: billing profiles stay consistent, funding events/alerts/payout history are append-only, payouts are idempotent and final (PRD §62, §65, §66, §114)", async () => {
    db = createTestD1();
    const run = (sql: string) => db.prepare(sql).run();
    db.sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('u-req', 'req@example.com'), ('u-app', 'app@example.com');
      INSERT INTO organizations (id, type, name, slug) VALUES ('org-adv', 'ADVERTISER', 'Adv', 'adv'), ('org-aff', 'AFFILIATE', 'Aff', 'aff'),
        ('org-aff2', 'AFFILIATE', 'Aff2', 'aff2');
      INSERT INTO advertiser_profiles (id, organization_id, status, company_name) VALUES ('ap1', 'org-adv', 'ACTIVE', 'Adv Co');
      INSERT INTO affiliate_profiles (id, organization_id, status, display_name) VALUES ('afp1', 'org-aff', 'ACTIVE', 'Aff'),
        ('afp2', 'org-aff2', 'ACTIVE', 'Aff2');
    `);
    // billing profile: available_credit is derived-consistent; PREPAID has no credit limit; POSTPAID needs terms
    const profile = (id: string, org: string, ap: string, model: string, limit: number, used: number, avail: number, terms: string) =>
      run(
        `INSERT INTO advertiser_billing_profiles (id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor, available_credit_minor, payment_terms_days)
         VALUES ('${id}', '${org}', '${ap}', '${model}', 'USD', ${limit}, ${used}, ${avail}, ${terms})`,
      );
    await expect(profile("bp-bad", "org-adv", "ap1", "CREDIT", 10000, 2000, 9000, "NULL")).rejects.toThrow(/CHECK/);
    await expect(profile("bp-bad", "org-adv", "ap1", "PREPAID", 10000, 0, 10000, "NULL")).rejects.toThrow(/CHECK/);
    await expect(profile("bp-bad", "org-adv", "ap1", "POSTPAID", 10000, 0, 10000, "NULL")).rejects.toThrow(/CHECK/);
    await profile("bp1", "org-adv", "ap1", "CREDIT", 10000, 2000, 8000, "NULL");
    await expect(run("UPDATE advertiser_billing_profiles SET used_credit_minor = 5000 WHERE id = 'bp1'")).rejects.toThrow(/CHECK/);
    await run("UPDATE advertiser_billing_profiles SET used_credit_minor = 5000, available_credit_minor = 5000 WHERE id = 'bp1'");
    await expect(run("UPDATE advertiser_billing_profiles SET currency = 'EUR' WHERE id = 'bp1'")).rejects.toThrow(/BILLING_PROFILE_IMMUTABLE/);
    await expect(run("UPDATE advertiser_billing_profiles SET funding_protection_active = 1 WHERE id = 'bp1'")).rejects.toThrow(/CHECK/);
    await expect(run("DELETE FROM advertiser_billing_profiles WHERE id = 'bp1'")).rejects.toThrow(/BILLING_PROFILE_IMMUTABLE/);
    // funding events: profile currency only; deposits need an amount; append-only
    const fe = (id: string, type: string, amount: string, cur: string) =>
      run(
        `INSERT INTO advertiser_funding_events (id, billing_profile_id, organization_id, event_type, amount_minor, currency, actor_type)
         VALUES ('${id}', 'bp1', 'org-adv', '${type}', ${amount}, '${cur}', 'PLATFORM')`,
      );
    await expect(fe("fe-eur", "DEPOSIT", "100", "EUR")).rejects.toThrow(/FUNDING_EVENT_CURRENCY_MISMATCH/);
    await expect(fe("fe-noamt", "DEPOSIT", "NULL", "USD")).rejects.toThrow(/CHECK/);
    await fe("fe1", "DEPOSIT", "100", "USD");
    await expect(run("UPDATE advertiser_funding_events SET amount_minor = 1 WHERE id = 'fe1'")).rejects.toThrow(/FUNDING_EVENTS_APPEND_ONLY/);
    await expect(run("DELETE FROM advertiser_funding_events WHERE id = 'fe1'")).rejects.toThrow(/FUNDING_EVENTS_APPEND_ONLY/);
    // funding alerts: one per (audience, dedupe_key) — the idempotency of the §62 trigger; only ack is mutable
    const alert = (id: string, audience: string) =>
      run(
        `INSERT INTO funding_alerts (id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload)
         VALUES ('${id}', 'org-adv', 'bp1', '${audience}', 'INSUFFICIENT_CAPACITY', 'CRITICAL', 'cap:bp1:1', '{}')`,
      );
    await alert("al-adv", "ADVERTISER");
    await alert("al-ops", "OPERATIONS");
    await expect(alert("al-dup", "ADVERTISER")).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE funding_alerts SET payload = '{\"x\":1}' WHERE id = 'al-adv'")).rejects.toThrow(/FUNDING_ALERT_IMMUTABLE/);
    await expect(run("UPDATE funding_alerts SET acknowledged_at = 'x' WHERE id = 'al-adv'")).rejects.toThrow(/CHECK/);
    await run("UPDATE funding_alerts SET acknowledged_at = 'x', acknowledged_by_user_id = 'u-app' WHERE id = 'al-adv'");
    await expect(run("DELETE FROM funding_alerts WHERE id = 'al-adv'")).rejects.toThrow(/FUNDING_ALERT_IMMUTABLE/);
    // payout methods: default must be VERIFIED and unique per org; token/currency frozen
    db.sqlite.exec(`
      INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, status, verified_at, is_default)
        VALUES ('pm1', 'org-aff', 'afp1', 'BANK_TRANSFER', 'stub', 'tok-1', 'Bank ••1234', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z', 1),
               ('pm-eur', 'org-aff', 'afp1', 'PAYPAL', 'stub', 'tok-2', 'PayPal', 'EUR', 'VERIFIED', '2026-01-01T00:00:00.000Z', 0),
               ('pm-other', 'org-aff2', 'afp2', 'WISE', 'stub', 'tok-3', 'Wise', 'USD', 'VERIFIED', '2026-01-01T00:00:00.000Z', 0);
    `);
    await expect(
      run(
        `INSERT INTO payout_methods (id, organization_id, affiliate_profile_id, method_type, provider, provider_token, display_label, currency, is_default)
         VALUES ('pm-pending-default', 'org-aff', 'afp1', 'PAYPAL', 'stub', 'tok-9', 'x', 'USD', 1)`,
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(run("UPDATE payout_methods SET is_default = 1 WHERE id = 'pm-eur'")).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE payout_methods SET provider_token = 'tok-x' WHERE id = 'pm1'")).rejects.toThrow(/PAYOUT_METHOD_IMMUTABLE/);
    await expect(run("DELETE FROM payout_methods WHERE id = 'pm-eur'")).rejects.toThrow(/PAYOUT_METHOD_IMMUTABLE/);
    // payouts: method guard (org + currency), unique idempotency key, frozen money, legal edges, final states, approver != requester
    const payout = (id: string, org: string, pm: string, cur: string, key: string) =>
      run(
        `INSERT INTO payouts (id, organization_id, payout_method_id, amount_minor, currency, idempotency_key, requested_by_user_id, requested_actor_type)
         VALUES ('${id}', '${org}', '${pm}', 5000, '${cur}', '${key}', 'u-req', 'TENANT')`,
      );
    await expect(payout("p-nomethod", "org-aff", "pm-nope", "USD", "k0")).rejects.toThrow(/PAYOUT_METHOD_MISSING/);
    await expect(payout("p-xorg", "org-aff", "pm-other", "USD", "k0")).rejects.toThrow(/PAYOUT_METHOD_ORG_MISMATCH/);
    await expect(payout("p-xcur", "org-aff", "pm-eur", "USD", "k0")).rejects.toThrow(/PAYOUT_METHOD_CURRENCY_MISMATCH/);
    await payout("p1", "org-aff", "pm1", "USD", "payout:org-aff:2026-03");
    await expect(payout("p-dup", "org-aff", "pm1", "USD", "payout:org-aff:2026-03")).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE payouts SET amount_minor = 1 WHERE id = 'p1'")).rejects.toThrow(/PAYOUT_IMMUTABLE/);
    await expect(run("UPDATE payouts SET status = 'PAID', paid_at = 'x' WHERE id = 'p1'")).rejects.toThrow(/PAYOUT_ILLEGAL_TRANSITION|CHECK/);
    await run("UPDATE payouts SET status = 'ELIGIBILITY_CHECK' WHERE id = 'p1'");
    await run("UPDATE payouts SET status = 'UNDER_REVIEW' WHERE id = 'p1'");
    await expect(run("UPDATE payouts SET status = 'APPROVED', approved_by_user_id = 'u-req', approved_at = 'x' WHERE id = 'p1'")).rejects.toThrow(
      /CHECK/,
    );
    await expect(run("UPDATE payouts SET status = 'APPROVED' WHERE id = 'p1'")).rejects.toThrow(/CHECK/);
    await run("UPDATE payouts SET status = 'APPROVED', approved_by_user_id = 'u-app', approved_at = 'x' WHERE id = 'p1'");
    await run("UPDATE payouts SET status = 'PROCESSING', provider = 'stub', provider_reference = 'ref-1' WHERE id = 'p1'");
    await expect(run("UPDATE payouts SET provider_reference = 'ref-2' WHERE id = 'p1'")).rejects.toThrow(/PAYOUT_PROVIDER_REFERENCE_IMMUTABLE/);
    await run("UPDATE payouts SET status = 'FAILED', failure_code = 'PROVIDER_TIMEOUT' WHERE id = 'p1'");
    await run("UPDATE payouts SET status = 'PROCESSING' WHERE id = 'p1'");
    // same provider reference can never belong to a second payout
    await payout("p2", "org-aff", "pm1", "USD", "payout:org-aff:2026-04");
    await run("UPDATE payouts SET status = 'ELIGIBILITY_CHECK' WHERE id = 'p2'");
    await run("UPDATE payouts SET status = 'UNDER_REVIEW' WHERE id = 'p2'");
    await run("UPDATE payouts SET status = 'APPROVED', approved_by_user_id = 'u-app', approved_at = 'x' WHERE id = 'p2'");
    await expect(run("UPDATE payouts SET status = 'PROCESSING', provider = 'stub', provider_reference = 'ref-1' WHERE id = 'p2'")).rejects.toThrow(
      /UNIQUE/,
    );
    await run("UPDATE payouts SET status = 'CANCELLED', cancelled_at = 'x' WHERE id = 'p2'");
    // a terminal row refuses every status change (both the FINAL and the edge trigger guard it) and every other update
    await expect(run("UPDATE payouts SET status = 'APPROVED' WHERE id = 'p2'")).rejects.toThrow(/PAYOUT_FINAL|PAYOUT_ILLEGAL_TRANSITION/);
    await expect(run("UPDATE payouts SET cancel_reason = 'late edit' WHERE id = 'p2'")).rejects.toThrow(/PAYOUT_FINAL/);
    await run("UPDATE payouts SET status = 'PAID', paid_at = 'x' WHERE id = 'p1'");
    await expect(run("UPDATE payouts SET status = 'PROCESSING', paid_at = NULL WHERE id = 'p1'")).rejects.toThrow(
      /PAYOUT_FINAL|PAYOUT_ILLEGAL_TRANSITION/,
    );
    await expect(run("UPDATE payouts SET updated_at = 'y' WHERE id = 'p1'")).rejects.toThrow(/PAYOUT_FINAL/);
    await expect(run("DELETE FROM payouts WHERE id = 'p2'")).rejects.toThrow(/PAYOUT_IMMUTABLE/);
    // history + attempts: append-only; attempt must carry the payout's exact money
    db.sqlite.exec(`
      INSERT INTO payout_status_history (id, payout_id, organization_id, from_status, to_status, actor_type)
        VALUES ('ph1', 'p1', 'org-aff', NULL, 'REQUESTED', 'TENANT');
      INSERT INTO payout_attempts (id, payout_id, organization_id, attempt_number, provider, provider_idempotency_key, provider_reference, amount_minor, currency, outcome, actor_type)
        VALUES ('pa1', 'p1', 'org-aff', 1, 'stub', 'p1', 'ref-1', 5000, 'USD', 'SUCCEEDED', 'SYSTEM');
    `);
    await expect(run("UPDATE payout_status_history SET to_status = 'PAID' WHERE id = 'ph1'")).rejects.toThrow(/PAYOUT_STATUS_HISTORY_APPEND_ONLY/);
    await expect(run("DELETE FROM payout_status_history WHERE id = 'ph1'")).rejects.toThrow(/PAYOUT_STATUS_HISTORY_APPEND_ONLY/);
    await expect(run("UPDATE payout_attempts SET outcome = 'FAILED' WHERE id = 'pa1'")).rejects.toThrow(/PAYOUT_ATTEMPTS_APPEND_ONLY/);
    await expect(run("DELETE FROM payout_attempts WHERE id = 'pa1'")).rejects.toThrow(/PAYOUT_ATTEMPTS_APPEND_ONLY/);
    const attempt = (id: string, n: number, amount: number, cur: string, org = "org-aff") =>
      run(
        `INSERT INTO payout_attempts (id, payout_id, organization_id, attempt_number, provider, provider_idempotency_key, amount_minor, currency, outcome, error_code, actor_type)
         VALUES ('${id}', 'p1', '${org}', ${n}, 'stub', 'p1', ${amount}, '${cur}', 'FAILED', 'E', 'SYSTEM')`,
      );
    await expect(attempt("pa-dupn", 1, 5000, "USD")).rejects.toThrow(/UNIQUE/);
    await expect(attempt("pa-amt", 2, 4999, "USD")).rejects.toThrow(/PAYOUT_ATTEMPT_MONEY_MISMATCH/);
    await expect(attempt("pa-cur", 2, 5000, "EUR")).rejects.toThrow(/PAYOUT_ATTEMPT_MONEY_MISMATCH/);
    await expect(attempt("pa-org", 2, 5000, "USD", "org-aff2")).rejects.toThrow(/PAYOUT_ATTEMPT_ORG_MISMATCH/);
    await attempt("pa2", 2, 5000, "USD");
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

  it("applies 0012: api keys / webhooks / notifications / support / disputes / appeals are state-machine- and tenant-guarded at the database (PRD §73–§76, §80–§83)", async () => {
    db = createTestD1();
    const run = (sql: string) => db.prepare(sql).run();
    db.sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com'), ('u-op', 'op@example.com');
      INSERT INTO organizations (id, type, name, slug) VALUES ('org-a', 'AFFILIATE', 'A', 'a'), ('org-b', 'ADVERTISER', 'B', 'b');
    `);
    // api_keys: hash is 64 hex, status/revoked_at consistent, terminal + legal transitions, never deleted
    const hash = "a".repeat(64);
    await expect(
      run(`INSERT INTO api_keys (id, organization_id, name, key_prefix, key_hash, secret_hint) VALUES ('k0', 'org-a', 'k', 'tvh_pfx1', 'short', 'abcd')`),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO api_keys (id, organization_id, name, key_prefix, key_hash, secret_hint) VALUES ('k1', 'org-a', 'k', 'tvh_pfx1', '${hash}', 'abcd')`);
    await expect(run("UPDATE api_keys SET status = 'REVOKED' WHERE id = 'k1'")).rejects.toThrow(/CHECK/);
    await expect(run(`UPDATE api_keys SET key_hash = '${"b".repeat(64)}' WHERE id = 'k1'`)).rejects.toThrow(/API_KEY_IMMUTABLE/);
    await run("UPDATE api_keys SET status = 'REVOKED', revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = 'k1'");
    await expect(run("UPDATE api_keys SET status = 'ACTIVE', revoked_at = NULL WHERE id = 'k1'")).rejects.toThrow(/API_KEY_FINAL/);
    await expect(run("DELETE FROM api_keys WHERE id = 'k1'")).rejects.toThrow(/API_KEY_IMMUTABLE/);

    // webhooks: https only; one delivery per (subscription, event); cross-tenant delivery rejected; DELIVERED final; replay re-queues RETRY/DEAD_LETTER only
    await expect(
      run(`INSERT INTO webhook_subscriptions (id, organization_id, url, secret_ciphertext, key_version, secret_hint) VALUES ('s0', 'org-a', 'http://x', 'v1.a.b', 'k:v1', 'abcd')`),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO webhook_subscriptions (id, organization_id, url, secret_ciphertext, key_version, secret_hint) VALUES ('s1', 'org-a', 'https://x.example/hook', 'v1.a.b', 'k:v1', 'abcd')`);
    await run(`INSERT INTO webhook_events (id, organization_id, event_type, payload, idempotency_key, occurred_at) VALUES ('e1', 'org-a', 'payout_status_changed', '{"payout_id":"p1"}', 'payout:p1:PAID', '2026-01-01T00:00:00.000Z')`);
    await run(`INSERT INTO webhook_events (id, organization_id, event_type, payload, idempotency_key, occurred_at) VALUES ('e-b', 'org-b', 'offer_status_changed', '{}', 'offer:o1:PAUSED', '2026-01-01T00:00:00.000Z')`);
    await expect(
      run(`INSERT INTO webhook_events (id, organization_id, event_type, payload, idempotency_key, occurred_at) VALUES ('e1-dup', 'org-a', 'payout_status_changed', '{}', 'payout:p1:PAID', '2026-01-01T00:00:00.000Z')`),
    ).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE webhook_events SET payload = '{}' WHERE id = 'e1'")).rejects.toThrow(/WEBHOOK_EVENTS_APPEND_ONLY/);
    await run(`INSERT INTO webhook_deliveries (id, organization_id, subscription_id, event_id) VALUES ('d1', 'org-a', 's1', 'e1')`);
    await expect(run(`INSERT INTO webhook_deliveries (id, organization_id, subscription_id, event_id) VALUES ('d1-dup', 'org-a', 's1', 'e1')`)).rejects.toThrow(/UNIQUE/);
    await expect(run(`INSERT INTO webhook_deliveries (id, organization_id, subscription_id, event_id) VALUES ('d-x', 'org-a', 's1', 'e-b')`)).rejects.toThrow(
      /WEBHOOK_DELIVERY_EVENT_ORG_MISMATCH/,
    );
    await expect(run("UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = '2026-01-01T00:00:00.000Z' WHERE id = 'd1'")).rejects.toThrow(
      /WEBHOOK_DELIVERY_ILLEGAL_TRANSITION/,
    );
    await expect(run("UPDATE webhook_deliveries SET status = 'QUEUED' WHERE id = 'd1'")).resolves.toBeDefined(); // no-op same status
    await run("UPDATE webhook_deliveries SET status = 'DELIVERING' WHERE id = 'd1'");
    await run("UPDATE webhook_deliveries SET status = 'RETRY', attempt_count = 1 WHERE id = 'd1'");
    await run("UPDATE webhook_deliveries SET status = 'DEAD_LETTER', dead_lettered_at = '2026-01-01T00:00:00.000Z' WHERE id = 'd1'");
    await run("UPDATE webhook_deliveries SET status = 'QUEUED', replay_count = 1 WHERE id = 'd1'"); // operator replay
    await run("UPDATE webhook_deliveries SET status = 'DELIVERING' WHERE id = 'd1'");
    await run("UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = '2026-01-01T00:00:01.000Z' WHERE id = 'd1'");
    await expect(run("UPDATE webhook_deliveries SET status = 'QUEUED' WHERE id = 'd1'")).rejects.toThrow(/WEBHOOK_DELIVERY_FINAL/);
    await expect(run("DELETE FROM webhook_deliveries WHERE id = 'd1'")).rejects.toThrow(/WEBHOOK_DELIVERY_IMMUTABLE/);
    await run(`INSERT INTO webhook_delivery_attempts (id, delivery_id, attempt_number, signed_at, started_at, outcome) VALUES ('a1', 'd1', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'HTTP_ERROR')`);
    await expect(run("UPDATE webhook_delivery_attempts SET outcome = 'SUCCESS' WHERE id = 'a1'")).rejects.toThrow(/WEBHOOK_DELIVERY_ATTEMPTS_APPEND_ONLY/);

    // notifications: dedupe_key unique; security-critical IN_APP preferences cannot be disabled
    await run(`INSERT INTO notifications (id, organization_id, user_id, event_type, channel, title, body, dedupe_key) VALUES ('n1', 'org-a', 'u1', 'security_event', 'IN_APP', 'New login', 'body', 'sec:1:IN_APP:u1')`);
    await expect(
      run(`INSERT INTO notifications (id, organization_id, user_id, event_type, channel, title, body, dedupe_key) VALUES ('n2', 'org-a', 'u1', 'security_event', 'IN_APP', 'New login', 'body', 'sec:1:IN_APP:u1')`),
    ).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE notifications SET title = 'x' WHERE id = 'n1'")).rejects.toThrow(/NOTIFICATION_IMMUTABLE/);
    await expect(run("DELETE FROM notifications WHERE id = 'n1'")).rejects.toThrow(/NOTIFICATION_IMMUTABLE/);
    await expect(
      run(`INSERT INTO notification_preferences (id, user_id, organization_id, event_type, channel, enabled) VALUES ('p0', 'u1', 'org-a', 'security_event', 'IN_APP', 0)`),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO notification_preferences (id, user_id, organization_id, event_type, channel, enabled) VALUES ('p1', 'u1', 'org-a', 'security_event', 'EMAIL', 0)`);
    await run(`INSERT INTO notification_preferences (id, user_id, organization_id, event_type, channel, enabled) VALUES ('p2', 'u1', 'org-a', 'offer_status_changed', 'IN_APP', 0)`);

    // support tickets: PRD §81 chain; CLOSED terminal; internal notes never by requester; events/messages append-only
    await run(`INSERT INTO support_tickets (id, organization_id, created_by_user_id, category, subject) VALUES ('t1', 'org-a', 'u1', 'PAYOUT', 'Where is my payout')`);
    await expect(run("UPDATE support_tickets SET status = 'RESOLVED' WHERE id = 't1'")).rejects.toThrow(/SUPPORT_TICKET_ILLEGAL_TRANSITION/);
    for (const s of ["IN_PROGRESS", "WAITING_FOR_USER", "IN_PROGRESS", "WAITING_INTERNAL", "RESOLVED"]) {
      await run(`UPDATE support_tickets SET status = '${s}' WHERE id = 't1'`);
    }
    await expect(run("UPDATE support_tickets SET status = 'CLOSED' WHERE id = 't1'")).rejects.toThrow(/CHECK/);
    await run("UPDATE support_tickets SET status = 'CLOSED', closed_at = '2026-01-01T00:00:00.000Z' WHERE id = 't1'");
    await expect(run("UPDATE support_tickets SET priority = 'HIGH' WHERE id = 't1'")).rejects.toThrow(/SUPPORT_TICKET_FINAL/);
    await expect(run("DELETE FROM support_tickets WHERE id = 't1'")).rejects.toThrow(/SUPPORT_TICKET_IMMUTABLE/);
    await expect(run(`INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_type, body, is_internal) VALUES ('m0', 't1', 'u1', 'REQUESTER', 'hi', 1)`)).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_type, body, is_internal) VALUES ('m1', 't1', 'u-op', 'AGENT', 'internal note', 1)`);
    await expect(run("DELETE FROM support_ticket_messages WHERE id = 'm1'")).rejects.toThrow(/SUPPORT_TICKET_MESSAGES_APPEND_ONLY/);
    await run(`INSERT INTO support_ticket_events (id, ticket_id, event_type, from_status, to_status, actor_user_id) VALUES ('ev1', 't1', 'STATUS_CHANGED', 'RESOLVED', 'CLOSED', 'u-op')`);
    await expect(run("UPDATE support_ticket_events SET reason = 'x' WHERE id = 'ev1'")).rejects.toThrow(/SUPPORT_TICKET_EVENTS_APPEND_ONLY/);

    // disputes: money needs currency (integer minor); one open per subject; decision complete + once; evidence only while open
    await expect(
      run(`INSERT INTO disputes (id, organization_id, raised_by_user_id, category, subject_type, subject_id, title, description, disputed_amount_minor) VALUES ('ds0', 'org-a', 'u1', 'COMMISSION', 'conversion', 'c1', 'Wrong payout', 'desc', 1500)`),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO disputes (id, organization_id, raised_by_user_id, category, subject_type, subject_id, title, description, disputed_amount_minor, currency) VALUES ('ds1', 'org-a', 'u1', 'COMMISSION', 'conversion', 'c1', 'Wrong payout', 'desc', 1500, 'USD')`);
    await expect(
      run(`INSERT INTO disputes (id, organization_id, raised_by_user_id, category, subject_type, subject_id, title, description) VALUES ('ds1-dup', 'org-a', 'u1', 'CONVERSION', 'conversion', 'c1', 'again', 'desc')`),
    ).rejects.toThrow(/UNIQUE/);
    await run(`INSERT INTO dispute_evidence (id, dispute_id, submitted_by_user_id, submitter_side, kind, content) VALUES ('dev1', 'ds1', 'u1', 'TENANT', 'TEXT', 'see click log')`);
    await expect(run("UPDATE disputes SET disputed_amount_minor = 1 WHERE id = 'ds1'")).rejects.toThrow(/DISPUTE_IMMUTABLE/);
    await expect(run("UPDATE disputes SET status = 'DECIDED', decided_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ds1'")).rejects.toThrow(/DISPUTE_ILLEGAL_TRANSITION/);
    await run("UPDATE disputes SET status = 'UNDER_REVIEW' WHERE id = 'ds1'");
    await expect(
      run(`INSERT INTO dispute_decisions (id, dispute_id, decision, reason, evidence, actor_user_id, decided_at) VALUES ('dd0', 'ds1', 'UPHELD', '', '[]', 'u-op', '2026-01-01T00:00:00.000Z')`),
    ).rejects.toThrow(/CHECK/);
    await run(`INSERT INTO dispute_decisions (id, dispute_id, decision, reason, evidence, actor_user_id, decided_at) VALUES ('dd1', 'ds1', 'UPHELD', 'click log confirms', '["dev1"]', 'u-op', '2026-01-01T00:00:00.000Z')`);
    await expect(
      run(`INSERT INTO dispute_decisions (id, dispute_id, decision, reason, evidence, actor_user_id, decided_at) VALUES ('dd2', 'ds1', 'REJECTED', 'again', '[]', 'u-op', '2026-01-01T00:00:00.000Z')`),
    ).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE dispute_decisions SET decision = 'REJECTED' WHERE id = 'dd1'")).rejects.toThrow(/DISPUTE_DECISIONS_APPEND_ONLY/);
    await run("UPDATE disputes SET status = 'DECIDED', decided_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ds1'");
    await expect(run(`INSERT INTO dispute_evidence (id, dispute_id, submitted_by_user_id, submitter_side, kind, content) VALUES ('dev2', 'ds1', 'u1', 'TENANT', 'TEXT', 'late')`)).rejects.toThrow(/DISPUTE_NOT_OPEN/);
    await expect(run("UPDATE disputes SET assigned_to_user_id = 'u-op' WHERE id = 'ds1'")).rejects.toThrow(/DISPUTE_FINAL/);
    await expect(run("DELETE FROM dispute_evidence WHERE id = 'dev1'")).rejects.toThrow(/DISPUTE_EVIDENCE_APPEND_ONLY/);

    // appeals: one open per subject; decision once with actor+reason; terminal
    await run(`INSERT INTO appeals (id, organization_id, submitted_by_user_id, appeal_type, subject_type, subject_id, grounds) VALUES ('ap1', 'org-a', 'u1', 'PAYOUT_HOLD', 'payout', 'p1', 'hold is wrong')`);
    await expect(
      run(`INSERT INTO appeals (id, organization_id, submitted_by_user_id, appeal_type, subject_type, subject_id, grounds) VALUES ('ap1-dup', 'org-a', 'u1', 'PAYOUT_HOLD', 'payout', 'p1', 'again')`),
    ).rejects.toThrow(/UNIQUE/);
    await expect(run("UPDATE appeals SET grounds = 'x' WHERE id = 'ap1'")).rejects.toThrow(/APPEAL_IMMUTABLE/);
    await run("UPDATE appeals SET status = 'UNDER_REVIEW' WHERE id = 'ap1'");
    await run(`INSERT INTO appeal_decisions (id, appeal_id, outcome, reason, actor_user_id, decided_at) VALUES ('ad1', 'ap1', 'ACCEPTED', 'hold released', 'u-op', '2026-01-01T00:00:00.000Z')`);
    await expect(run(`INSERT INTO appeal_decisions (id, appeal_id, outcome, reason, actor_user_id, decided_at) VALUES ('ad2', 'ap1', 'REJECTED', 'x', 'u-op', '2026-01-01T00:00:00.000Z')`)).rejects.toThrow(/UNIQUE/);
    await expect(run("DELETE FROM appeal_decisions WHERE id = 'ad1'")).rejects.toThrow(/APPEAL_DECISIONS_APPEND_ONLY/);
    await run("UPDATE appeals SET status = 'DECIDED', decided_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ap1'");
    await expect(run("UPDATE appeals SET status = 'UNDER_REVIEW', decided_at = NULL WHERE id = 'ap1'")).rejects.toThrow(/APPEAL_FINAL/);
    await expect(run("DELETE FROM appeals WHERE id = 'ap1'")).rejects.toThrow(/APPEAL_IMMUTABLE/);
  });
});
