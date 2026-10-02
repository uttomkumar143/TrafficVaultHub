/**
 * Phase 6 Unit 3 — cursor pagination on the three previously unbounded lists
 * (PRD §71/§127: never a full table in memory; LIMIT n+1 in SQL).
 *
 *   GET /organizations/:orgId/ledger/reserves   → { items, next_cursor }
 *   GET /organizations/:orgId/billing/alerts    → { items, next_cursor }
 *   GET /organizations/:orgId/members           → { members, next_cursor }  (additive, `members` key kept)
 *
 * For each: walking pages yields every row exactly once, newest first,
 * `next_cursor` is null on the last page, bad `limit` → 400 VALIDATION_ERROR,
 * garbage `cursor` → 400 INVALID_CURSOR, and a non-member gets 404 from
 * requireOrg (tenant isolation is by path, before any permission check).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestHarness, json } from "./fixtures";

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

type ItemsPage<T> = { items: T[]; next_cursor: string | null };
type MembersPage<T> = { members: T[]; next_cursor: string | null };

/** Deterministic, strictly increasing ISO timestamps (ms apart). */
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();

async function walk<T extends { id: string }>(token: string, path: string, key: "items" | "members", limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await h.as(token, "GET", url);
    expect(res.status, url).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const rows = body[key] as T[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(limit);
    ids.push(...rows.map((r) => r.id));
    cursor = body.next_cursor as string | null;
    pages += 1;
    if (pages > 50) throw new Error("pagination did not terminate");
  } while (cursor);
  return { ids, pages };
}

async function expectBadInputs(token: string, path: string, outsiderToken: string) {
  for (const bad of ["0", "-1", "101", "abc", "1.5"]) {
    const res = await h.as(token, "GET", `${path}?limit=${bad}`);
    expect(res.status, `limit=${bad}`).toBe(400);
    expect(await h.errorCode(res)).toBe("VALIDATION_ERROR");
  }
  const badCursor = await h.as(token, "GET", `${path}?cursor=not-a-cursor`);
  expect(badCursor.status).toBe(400);
  expect(await h.errorCode(badCursor)).toBe("INVALID_CURSOR");

  // Non-member → requireOrg 404 (path-scoped tenancy, PRD §116).
  const outsider = await h.as(outsiderToken, "GET", path);
  expect(outsider.status).toBe(404);
  expect(await h.errorCode(outsider)).toBe("ORGANIZATION_NOT_FOUND");
}

describe("cursor pagination — GET /ledger/reserves", () => {
  it("pages newest-first with LIMIT in SQL, every reserve exactly once, filters compose with the cursor", async () => {
    const owner = await h.user("aff@example.com");
    const orgId = await h.org(owner, "AFFILIATE", "Aff");
    const outsider = await h.user("outsider@example.com");

    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await h.db
        .prepare(
          `INSERT INTO reserves (id, organization_id, reserve_type, currency, amount_minor, status, reason_code, actor_type, created_at)
           VALUES (?, ?, 'RISK', ?, 100, 'ACTIVE', 'FRAUD_REVIEW', 'PLATFORM', ?)`,
        )
        .bind(id, orgId, i % 2 === 0 ? "USD" : "EUR", at(i))
        .run();
    }
    const path = `/organizations/${orgId}/ledger/reserves`;

    const first = await json<ItemsPage<{ id: string; created_at: string }>>(await h.as(owner, "GET", `${path}?limit=3`));
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).not.toBeNull();
    expect(first.items.map((r) => r.id)).toEqual([ids[6], ids[5], ids[4]]); // newest first

    const all = await walk(owner, path, "items", 3);
    expect(all.pages).toBe(3);
    expect(all.ids).toEqual([...ids].reverse());
    expect(new Set(all.ids).size).toBe(7);

    // Default limit (25) returns everything with no cursor.
    const dflt = await json<ItemsPage<{ id: string }>>(await h.as(owner, "GET", path));
    expect(dflt.items).toHaveLength(7);
    expect(dflt.next_cursor).toBeNull();

    // Filter + cursor compose: only USD (indices 0,2,4,6) across two pages.
    const usd = await walk(owner, `${path}?currency=USD`, "items", 3);
    expect(usd.ids).toEqual([ids[6], ids[4], ids[2], ids[0]]);

    await expectBadInputs(owner, path, outsider);
  });
});

describe("cursor pagination — GET /billing/alerts", () => {
  it("pages newest-first, every alert exactly once; other tenant's alerts never appear", async () => {
    const owner = await h.user("adv@example.com");
    const orgId = await h.org(owner, "ADVERTISER", "Acme");
    expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Acme" })).status).toBe(201);
    const prof = await h.db.prepare(`SELECT id FROM advertiser_profiles WHERE organization_id = ?`).bind(orgId).first<{ id: string }>();
    const bpId = crypto.randomUUID();
    await h.db
      .prepare(
        `INSERT INTO advertiser_billing_profiles (id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor, available_credit_minor, payment_terms_days)
         VALUES (?, ?, ?, 'CREDIT', 'USD', 1000, 0, 1000, NULL)`,
      )
      .bind(bpId, orgId, prof!.id)
      .run();

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await h.db
        .prepare(
          `INSERT INTO funding_alerts (id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload, created_at)
           VALUES (?, ?, ?, 'ADVERTISER', 'LOW_BALANCE', 'WARNING', ?, '{}', ?)`,
        )
        .bind(id, orgId, bpId, `k-${i}`, at(i))
        .run();
    }

    // A second advertiser with its own alert must never leak into the first tenant's pages.
    const other = await h.user("other@example.com");
    const otherOrg = await h.org(other, "ADVERTISER", "Other");
    expect((await h.as(other, "POST", `/organizations/${otherOrg}/advertiser`, { company_name: "Other" })).status).toBe(201);
    const otherProf = await h.db.prepare(`SELECT id FROM advertiser_profiles WHERE organization_id = ?`).bind(otherOrg).first<{ id: string }>();
    const otherBp = crypto.randomUUID();
    await h.db
      .prepare(
        `INSERT INTO advertiser_billing_profiles (id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor, available_credit_minor, payment_terms_days)
         VALUES (?, ?, ?, 'CREDIT', 'USD', 1000, 0, 1000, NULL)`,
      )
      .bind(otherBp, otherOrg, otherProf!.id)
      .run();
    const foreign = crypto.randomUUID();
    await h.db
      .prepare(
        `INSERT INTO funding_alerts (id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload, created_at)
         VALUES (?, ?, ?, 'ADVERTISER', 'LOW_BALANCE', 'WARNING', 'k-foreign', '{}', ?)`,
      )
      .bind(foreign, otherOrg, otherBp, at(99))
      .run();

    const path = `/organizations/${orgId}/billing/alerts`;
    const all = await walk(owner, path, "items", 2);
    expect(all.pages).toBe(3);
    expect(all.ids).toEqual([...ids].reverse());
    expect(all.ids).not.toContain(foreign);

    await expectBadInputs(owner, path, other);
  });
});

describe("cursor pagination — GET /:orgId/members", () => {
  it("keeps the `members` key, adds next_cursor, pages every active member exactly once", async () => {
    const alice = await h.user("alice@example.com");
    const orgId = await h.org(alice, "ADVERTISER", "Acme");
    const outsider = await h.user("outsider@example.com");

    const emails = ["b@example.com", "c@example.com", "d@example.com", "e@example.com"];
    const memberIds: string[] = [];
    for (const e of emails) {
      await h.user(e);
      memberIds.push(await h.addMember(alice, orgId, e, "VIEWER"));
    }
    // Make the sort key unambiguous (same-millisecond inserts would still be
    // ordered by the id tie-breaker, but explicit timestamps make the
    // expectation readable).
    const rows = await h.db.prepare(`SELECT id FROM organization_members WHERE organization_id = ? ORDER BY created_at ASC, id ASC`).bind(orgId).all<{ id: string }>();
    const ordered = rows.results.map((r) => r.id);
    for (let i = 0; i < ordered.length; i++) {
      await h.db.prepare(`UPDATE organization_members SET created_at = ? WHERE id = ?`).bind(at(i), ordered[i]).run();
    }

    const path = `/organizations/${orgId}/members`;
    const first = await json<MembersPage<{ id: string; user: { email: string } }>>(await h.as(alice, "GET", `${path}?limit=2`));
    expect(Object.keys(first).sort()).toEqual(["members", "next_cursor"]);
    expect(first.members).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/password|token_hash|tvh_s_/);

    const all = await walk(alice, path, "members", 2);
    expect(all.pages).toBe(3); // 5 active members (owner + 4) → 2,2,1
    expect(all.ids).toEqual([...ordered].reverse());
    expect(new Set(all.ids).size).toBe(5);

    // Removed members are excluded from every page.
    expect((await h.as(alice, "DELETE", `${path}/${memberIds[0]}`)).status).toBe(204);
    const afterRemove = await walk(alice, path, "members", 2);
    expect(afterRemove.ids).toHaveLength(4);
    expect(afterRemove.ids).not.toContain(memberIds[0]);

    await expectBadInputs(alice, path, outsider);
  });
});
