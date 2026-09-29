/**
 * Phase 4 Unit 10b — fraud cases / assessments / actions over HTTP against
 * the real migrations 0001–0009 (PRD §41–§44, §115). The world is built
 * through real routes (advertiser → LIVE offer → active affiliate → tracking
 * link → click → signed postback) so the conversion referenced by the tests is
 * a genuine PENDING intake row.
 *
 * `/organizations/:orgId/fraud` resolves the tenant from the caller's
 * membership in `:orgId`, so the actor is PLATFORM only when `:orgId` is the
 * platform organization itself. Every seeded tenant role holds at most
 * fraud.read, so tenant callers are stopped by the route gate (403 FORBIDDEN)
 * before the service's PLATFORM_ONLY check can run; the service-level
 * PLATFORM_ONLY / fraud.manage rules are covered by modules/fraud/service.test.ts.
 *
 * Covers:
 *   - RBAC: advertiser owner (fraud.read) and VIEWER get 403 on every write,
 *     nothing written; reads need fraud.read;
 *   - tenant isolation: a platform-tenant case is 404 for a foreign tenant on
 *     read AND write; a non-member gets 404 on the platform org; an org whose
 *     role holds no fraud.* permission is stopped at the gate (403); malformed
 *     and random ids → 404; no rows written;
 *   - case flow open → assign → note → transition with a full event history,
 *     reason rules (400) and invalid edges (409);
 *   - an assessment (even one that opens a case) never changes a conversion's
 *     lifecycle_status and writes no status history;
 *   - actions: advertiser org 403 with no action row; platform PAYOUT_HOLD
 *     writes an ACTIVE conversion_holds row sourced from the case; CLOSED
 *     cases accept no action (409);
 *   - no HTTP path under /fraud reaches LEDGER_POSTED / EARNED /
 *     PAYOUT_ELIGIBLE / PAID: no such routes exist (404), the strict schemas
 *     reject smuggled lifecycle fields (400), and the conversion row and its
 *     history stay untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { POSTBACK_HEADERS, signPostback } from "../modules/tracking/postback-auth";
import { POSTBACK_PATH } from "../routes/attribution";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));

const V1 = {
  payout_type: "CPA",
  currency: "usd",
  advertiser_payout_minor: 5000,
  affiliate_commission_minor: 4000,
  network_margin_minor: 1000,
  attribution_window_seconds: 2592000,
  conversion_event: "signup",
  destination_url: "https://track.example/click?src=tvh",
};

const COMPLETE_AFFILIATE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

const HIGH_RISK_FACTS = {
  velocity: { window_seconds: 3600, conversions_in_window: 500, clicks_in_window: 600 },
  duplicates: { same_transaction_id_count: 5, same_fingerprint_count: 9 },
  timing: { clicked_at: "2026-03-15T11:00:00.000Z", occurred_at: "2026-03-15T11:00:00.500Z" },
  automation: { user_agent: "HeadlessChrome/120", same_user_agent_click_count: 300 },
};

interface Offer {
  id: string;
  status: string;
}
interface FraudCase {
  id: string;
  status: string;
  severity: string;
  reason_code: string;
  reviewer_user_id: string | null;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
}
interface CaseEvent {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  reason_code: string | null;
  note: string | null;
}
interface CaseDetail {
  case: FraudCase;
  events: CaseEvent[];
  actions: Array<{ id: string; action_type: string; reason_code: string }>;
  assessment: { id: string } | null;
}
interface Assessment {
  id: string;
  subject_type: string;
  subject_id: string;
  level: string;
  score: number;
}

let h: TestHarness;

beforeEach(() => {
  h = new TestHarness();
  h.env.POSTBACK_SECRET_KEY = MASTER;
});
afterEach(() => h.close());

async function platform(email = "rev@network.example") {
  const token = await h.user(email);
  const orgId = await h.platformOrg(email, "SUPER_ADMIN");
  const userId = (h.db.sqlite.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email) as { id: string }).id;
  return { token, orgId, userId };
}

async function advertiser(email = "adv@acme.example", name = "Acme Ads") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "ADVERTISER", name);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: name })).status).toBe(201);
  return { owner, orgId };
}

async function activeAffiliate(plat: { token: string; orgId: string }, email = "aff@traffic.example", name = "Traffic Co") {
  const owner = await h.user(email);
  const orgId = await h.org(owner, "AFFILIATE", name);
  const created = await json<{ profile: { id: string } }>(
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { ...COMPLETE_AFFILIATE, display_name: name }),
  );
  expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {})).status).toBeLessThan(300);
  expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(200);
  for (const to of ["APPROVED", "ACTIVE"]) {
    const res = await h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/affiliates/${created.profile.id}/transition`, { to });
    expect(res.status, to).toBe(200);
  }
  return { owner, orgId, profileId: created.profile.id };
}

async function toLive(owner: string, advOrg: string, plat: { token: string; orgId: string }): Promise<Offer> {
  const created = await json<{ offer: Offer }>(
    await h.as(owner, "POST", `/organizations/${advOrg}/offers`, { name: "Public CPA", version: V1 }),
  );
  const id = created.offer.id;
  expect((await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/submit`)).status).toBe(200);
  const review = (to: string) => h.as(plat.token, "POST", `/organizations/${plat.orgId}/platform/offers/${id}/transition`, { to });
  expect((await review("UNDER_REVIEW")).status).toBe(200);
  expect((await review("APPROVED")).status).toBe(200);
  const live = await h.as(owner, "POST", `/organizations/${advOrg}/offers/${id}/transition`, { to: "LIVE" });
  expect(live.status).toBe(200);
  return (await json<{ offer: Offer }>(live)).offer;
}

async function postback(adv: { owner: string; orgId: string }, body: Record<string, unknown>): Promise<Response> {
  const res = await h.as(adv.owner, "POST", `/organizations/${adv.orgId}/postback-secrets`, { label: "prod" });
  expect(res.status).toBe(201);
  const { secret } = await json<{ secret: { id: string; secret: string } }>(res);
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${crypto.randomUUID()}`;
  const signature = await signPostback(secret.secret, { method: "POST", path: POSTBACK_PATH, timestamp, nonce, body: raw });
  return await h.app.request(
    POSTBACK_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [POSTBACK_HEADERS.timestamp]: String(timestamp),
        [POSTBACK_HEADERS.nonce]: nonce,
        [POSTBACK_HEADERS.keyId]: secret.id,
        [POSTBACK_HEADERS.signature]: signature,
      },
      body: raw,
    },
    h.env,
  );
}

/** Platform org, advertiser with a LIVE offer, active affiliate, one real click and one PENDING conversion. */
async function world() {
  const plat = await platform();
  const adv = await advertiser();
  const offer = await toLive(adv.owner, adv.orgId, plat);
  const aff = await activeAffiliate(plat);
  const linkRes = await h.as(aff.owner, "POST", `/organizations/${aff.orgId}/tracking-links`, { offer_id: offer.id, name: "Newsletter" });
  expect(linkRes.status).toBe(201);
  const { tracking_link: link } = await json<{ tracking_link: { tracking_path: string } }>(linkRes);
  const hit = await h.app.request(link.tracking_path, { method: "GET", redirect: "manual" }, h.env);
  expect(hit.status).toBe(302);
  const clickId = new URL(hit.headers.get("location")!).searchParams.get("click_id")!;
  const pb = await postback(adv, {
    offer_id: offer.id,
    external_conversion_id: "ext-1",
    click_id: clickId,
    conversion_event: "signup",
    occurred_at: new Date().toISOString(),
    sale_amount_minor: 1999,
    currency: "USD",
  });
  expect(pb.status).toBe(200);
  const out = await json<{ conversion_id: string; decision: string }>(pb);
  expect(out.decision).toBe("ATTRIBUTED");
  return { plat, adv, offer, aff, conversionId: out.conversion_id };
}

/** Sign up `email`, seat it in `orgId` as VIEWER, return its session token. */
async function viewerToken(ownerToken: string, orgId: string, email: string): Promise<string> {
  await h.user(email);
  await h.addMember(ownerToken, orgId, email, "VIEWER");
  return (await json<{ token: string }>(await h.api("POST", "/auth/login", {}, { email, password: PASSWORD }))).token;
}

function lifecycleOf(id: string): string {
  const row = h.db.sqlite.prepare("SELECT lifecycle_status FROM conversions WHERE id = ?").get(id) as { lifecycle_status: string };
  return row.lifecycle_status;
}

function count(table: string): number {
  return (h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const fraud = (orgId: string) => `/organizations/${orgId}/fraud`;

const OPEN_BODY = { severity: "HIGH", reason_code: "VELOCITY_SPIKE", summary: "500 conversions in an hour" };

async function openPlatformCase(plat: { token: string; orgId: string }, affiliateId: string): Promise<FraudCase> {
  const res = await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { ...OPEN_BODY, affiliate_organization_id: affiliateId });
  expect(res.status).toBe(201);
  return (await json<{ case: FraudCase }>(res)).case;
}

describe("fraud routes", () => {
  it("RBAC: advertiser owner (fraud.read) and VIEWER get 403 on every write and nothing is written; reads need fraud.read", async () => {
    const { adv, aff, conversionId } = await world();
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");
    const before = { cases: count("fraud_cases"), assessments: count("fraud_assessments"), holds: count("conversion_holds") };

    // Advertiser owner holds fraud.read: list is allowed and empty, every write is 403 FORBIDDEN at the route gate.
    const list = await h.as(adv.owner, "GET", `${fraud(adv.orgId)}/cases`);
    expect(list.status).toBe(200);
    expect((await json<{ items: FraudCase[] }>(list)).items).toEqual([]);

    const writes: Array<[string, unknown]> = [
      [`${fraud(adv.orgId)}/cases`, { ...OPEN_BODY, conversion_id: conversionId }],
      [`${fraud(adv.orgId)}/cases/${RANDOM_ID}/assign`, { reviewer_user_id: null }],
      [`${fraud(adv.orgId)}/cases/${RANDOM_ID}/actions`, { action_type: "MONITOR", reason_code: "WATCH" }],
      [`${fraud(adv.orgId)}/assessments`, { subject_type: "CONVERSION", subject_id: conversionId, facts: HIGH_RISK_FACTS }],
    ];
    for (const [path, body] of writes) {
      const res = await h.as(adv.owner, "POST", path, body);
      expect(res.status, `owner ${path}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
    // VIEWER lacks fraud.read too: every fraud route is 403 (route gate) — including notes/transition gated by fraud.read.
    for (const [method, path, body] of [
      ["GET", `${fraud(adv.orgId)}/cases`, undefined],
      ["GET", `${fraud(adv.orgId)}/cases/${RANDOM_ID}`, undefined],
      ["GET", `${fraud(adv.orgId)}/assessments/AFFILIATE/${aff.orgId}`, undefined],
      ["POST", `${fraud(adv.orgId)}/cases`, OPEN_BODY],
      ["POST", `${fraud(adv.orgId)}/cases/${RANDOM_ID}/notes`, { note: "hi" }],
      ["POST", `${fraud(adv.orgId)}/cases/${RANDOM_ID}/transition`, { to: "UNDER_REVIEW" }],
      ["POST", `${fraud(adv.orgId)}/cases/${RANDOM_ID}/actions`, { action_type: "MONITOR", reason_code: "WATCH" }],
      ["POST", `${fraud(adv.orgId)}/assessments`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: {} }],
    ] as Array<[string, string, unknown]>) {
      const res = await h.as(viewer, method, path, body);
      expect(res.status, `viewer ${method} ${path}`).toBe(403);
    }
    expect(count("fraud_cases")).toBe(before.cases);
    expect(count("fraud_assessments")).toBe(before.assessments);
    expect(count("conversion_holds")).toBe(before.holds);
    expect(count("fraud_actions")).toBe(0);
    expect(lifecycleOf(conversionId)).toBe("PENDING");
  });

  it("tenant isolation: platform-tenant case is 404 for a foreign tenant on read and write; non-member 404; malformed/random ids 404; nothing written", async () => {
    const { plat, adv, aff } = await world();
    const opened = await openPlatformCase(plat, aff.orgId);
    const beforeEvents = count("fraud_case_events");
    const beforeAudit = count("audit_logs");

    // The advertiser holds fraud.read in its own org: the case exists but belongs to another tenant → 404, never 403.
    const foreign = await h.as(adv.owner, "GET", `${fraud(adv.orgId)}/cases/${opened.id}`);
    expect(foreign.status).toBe(404);
    expect(await h.errorCode(foreign)).toBe("NOT_FOUND");
    expect((await h.as(adv.owner, "POST", `${fraud(adv.orgId)}/cases/${opened.id}/notes`, { note: "peeking" })).status).toBe(404);
    expect((await h.as(adv.owner, "POST", `${fraud(adv.orgId)}/cases/${opened.id}/transition`, { to: "APPEALED", note: "x" })).status).toBe(
      404,
    );
    // Listing the advertiser tenant never shows the platform case.
    const list = await json<{ items: FraudCase[] }>(await h.as(adv.owner, "GET", `${fraud(adv.orgId)}/cases`));
    expect(list.items).toEqual([]);
    // The advertiser is not a member of the platform org → the org itself is 404 (no enumeration).
    const nonMember = await h.as(adv.owner, "GET", `${fraud(plat.orgId)}/cases/${opened.id}`);
    expect(nonMember.status).toBe(404);
    expect(await h.errorCode(nonMember)).toBe("ORGANIZATION_NOT_FOUND");
    // AFFILIATE_OWNER holds no fraud.* permission at all: the route gate stops it (403) before any lookup.
    expect((await h.as(aff.owner, "GET", `${fraud(aff.orgId)}/cases/${opened.id}`)).status).toBe(403);

    // Malformed and random ids → 404 for the platform reviewer too (no oracle), on read and every write.
    for (const id of ["not-a-uuid", RANDOM_ID, "1", "00000000-0000-0000-0000-000000000000"]) {
      expect((await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases/${id}`)).status, `get ${id}`).toBe(404);
      expect(
        (await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases/${id}/assign`, { reviewer_user_id: null })).status,
        `assign ${id}`,
      ).toBe(404);
      expect((await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases/${id}/notes`, { note: "n" })).status, `note ${id}`).toBe(404);
      expect(
        (await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases/${id}/transition`, { to: "UNDER_REVIEW" })).status,
        `move ${id}`,
      ).toBe(404);
      expect(
        (await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases/${id}/actions`, { action_type: "MONITOR", reason_code: "WATCH" }))
          .status,
        `action ${id}`,
      ).toBe(404);
    }
    // Unknown subject type / empty subject → 404; list filters are validated → 400.
    expect((await h.as(plat.token, "GET", `${fraud(plat.orgId)}/assessments/BOGUS/${aff.orgId}`)).status).toBe(404);
    expect((await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases?status=WHATEVER`)).status).toBe(400);
    expect((await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases?affiliate_organization_id=nope`)).status).toBe(400);
    expect((await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases?conversion_id=nope`)).status).toBe(400);
    // A case referencing a conversion of another tenant cannot be opened from the platform tenant.
    const { conversionId } = { conversionId: (h.db.sqlite.prepare("SELECT id FROM conversions LIMIT 1").get() as { id: string }).id };
    expect((await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { ...OPEN_BODY, conversion_id: conversionId })).status).toBe(404);

    expect(count("fraud_cases")).toBe(1);
    expect(count("fraud_case_events")).toBe(beforeEvents);
    expect(count("fraud_actions")).toBe(0);
    expect(count("audit_logs")).toBe(beforeAudit);
  });

  it("case flow: open → assign → note → UNDER_REVIEW → CONFIRMED → CLOSED with full event history; reason rules 400; invalid edges 409", async () => {
    const { plat, aff } = await world();
    const auditBefore = count("audit_logs");
    const opened = await openPlatformCase(plat, aff.orgId);
    expect(opened.status).toBe("OPEN");
    expect(opened.severity).toBe("HIGH");
    expect(opened.affiliate_organization_id).toBe(aff.orgId);
    const base = `${fraud(plat.orgId)}/cases/${opened.id}`;

    // Strict bodies: unknown/invalid fields → 400 before the service runs.
    expect((await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { ...OPEN_BODY, status: "CONFIRMED" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { severity: "EXTREME", reason_code: "X" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { severity: "LOW" })).status).toBe(400);
    const badReason = await h.as(plat.token, "POST", `${fraud(plat.orgId)}/cases`, { severity: "LOW", reason_code: "lower case" });
    expect(badReason.status).toBe(400);
    expect(await h.errorCode(badReason)).toBe("INVALID_REASON_CODE");

    // Assign, note.
    const assigned = await h.as(plat.token, "POST", `${base}/assign`, { reviewer_user_id: plat.userId });
    expect(assigned.status).toBe(200);
    expect((await json<{ case: FraudCase }>(assigned)).case.reviewer_user_id).toBe(plat.userId);
    expect((await h.as(plat.token, "POST", `${base}/assign`, {})).status).toBe(400);
    const noted = await h.as(plat.token, "POST", `${base}/notes`, { note: "Traffic pattern matches a known bot farm." });
    expect(noted.status).toBe(201);
    expect((await h.as(plat.token, "POST", `${base}/notes`, { note: "" })).status).toBe(400);

    // Invalid edges from OPEN: CLOSED / CONFIRMED / APPEALED → 409 INVALID_CASE_TRANSITION; unknown status → 400.
    for (const to of ["CLOSED", "CONFIRMED", "APPEALED", "OPEN"]) {
      const res = await h.as(plat.token, "POST", `${base}/transition`, { to, reason_code: "X" });
      expect(res.status, to).toBe(409);
      expect(await h.errorCode(res)).toBe("INVALID_CASE_TRANSITION");
    }
    expect((await h.as(plat.token, "POST", `${base}/transition`, { to: "SETTLED" })).status).toBe(400);

    // OPEN → UNDER_REVIEW (reason optional) → CONFIRMED (reason required) → CLOSED.
    const review = await h.as(plat.token, "POST", `${base}/transition`, { to: "UNDER_REVIEW" });
    expect(review.status).toBe(200);
    expect((await json<{ case: FraudCase }>(review)).case.status).toBe("UNDER_REVIEW");
    const noReason = await h.as(plat.token, "POST", `${base}/transition`, { to: "CONFIRMED" });
    expect(noReason.status).toBe(400);
    expect(await h.errorCode(noReason)).toBe("REASON_REQUIRED");
    const confirmed = await h.as(plat.token, "POST", `${base}/transition`, {
      to: "CONFIRMED",
      reason_code: "BOT_TRAFFIC",
      note: "confirmed",
    });
    expect(confirmed.status).toBe(200);
    expect((await json<{ case: FraudCase }>(confirmed)).case.status).toBe("CONFIRMED");
    // The appeal edge requires a note (NOTE_REQUIRED) — checked before any write.
    const appeal = await h.as(plat.token, "POST", `${base}/transition`, { to: "APPEALED" });
    expect(appeal.status).toBe(400);
    expect(await h.errorCode(appeal)).toBe("NOTE_REQUIRED");
    const closed = await h.as(plat.token, "POST", `${base}/transition`, { to: "CLOSED" });
    expect(closed.status).toBe(200);
    expect((await h.as(plat.token, "POST", `${base}/transition`, { to: "UNDER_REVIEW" })).status).toBe(409);

    // Detail: case, ordered events, no actions, no assessment.
    const detail = await json<CaseDetail>(await h.as(plat.token, "GET", base));
    expect(detail.case.status).toBe("CLOSED");
    expect(detail.actions).toEqual([]);
    expect(detail.assessment).toBeNull();
    expect(detail.events.map((e) => e.event_type)).toEqual([
      "OPENED",
      "ASSIGNED",
      "NOTE_ADDED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
      "CLOSED",
    ]);
    expect(detail.events.map((e) => e.to_status)).toEqual(["OPEN", null, null, "UNDER_REVIEW", "CONFIRMED", "CLOSED"]);
    expect(detail.events.every((e) => e.actor_type === "PLATFORM")).toBe(true);
    expect(detail.events[4]?.reason_code).toBe("BOT_TRAFFIC");
    expect(detail.events[2]?.note).toBe("Traffic pattern matches a known bot farm.");

    // List with status filter and cursor shape.
    const list = await json<{ items: FraudCase[]; next_cursor: string | null }>(
      await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases?status=CLOSED`),
    );
    expect(list.items.map((c) => c.id)).toEqual([opened.id]);
    expect(list.next_cursor).toBeNull();
    expect((await json<{ items: FraudCase[] }>(await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases?status=OPEN`))).items).toEqual([]);

    expect(count("fraud_case_events")).toBe(6);
    expect(count("audit_logs")).toBeGreaterThan(auditBefore + 4);
  });

  it("assessment: records score + signals, optionally opens a case, and NEVER changes a conversion's lifecycle_status", async () => {
    const { plat, adv, aff, conversionId } = await world();
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);

    // Smuggled lifecycle fields and unknown facts are rejected by the strict schema.
    const smuggled = await h.as(plat.token, "POST", `${fraud(plat.orgId)}/assessments`, {
      subject_type: "AFFILIATE",
      subject_id: aff.orgId,
      facts: HIGH_RISK_FACTS,
      lifecycle_status: "REJECTED",
    });
    expect(smuggled.status).toBe(400);
    expect(
      (
        await h.as(plat.token, "POST", `${fraud(plat.orgId)}/assessments`, {
          subject_type: "AFFILIATE",
          subject_id: aff.orgId,
          facts: { magic: 1 },
        })
      ).status,
    ).toBe(400);
    // Facts are evidence: a CONVERSION subject must resolve inside this tenant → the advertiser's conversion is 404 here.
    expect(
      (
        await h.as(plat.token, "POST", `${fraud(plat.orgId)}/assessments`, {
          subject_type: "CONVERSION",
          subject_id: conversionId,
          facts: HIGH_RISK_FACTS,
        })
      ).status,
    ).toBe(404);

    // Low risk: no case even with a threshold.
    const low = await h.as(plat.token, "POST", `${fraud(plat.orgId)}/assessments`, {
      subject_type: "AFFILIATE",
      subject_id: aff.orgId,
      facts: { velocity: { window_seconds: 3600, conversions_in_window: 1, clicks_in_window: 100 } },
      open_case_at_or_above: "HIGH",
    });
    expect(low.status).toBe(201);
    const lowOut = await json<{ assessment: Assessment; risk: { level: string }; case: FraudCase | null }>(low);
    expect(lowOut.case).toBeNull();
    expect(["LOW", "MEDIUM"]).toContain(lowOut.risk.level);

    // High risk with threshold: assessment + case in one step; the case points at the assessment.
    const high = await h.as(plat.token, "POST", `${fraud(plat.orgId)}/assessments`, {
      subject_type: "AFFILIATE",
      subject_id: aff.orgId,
      facts: HIGH_RISK_FACTS,
      open_case_at_or_above: "HIGH",
      case_reason_code: "AUTO_HIGH_RISK",
    });
    expect(high.status).toBe(201);
    const highOut = await json<{ assessment: Assessment; risk: { level: string; score: number }; case: FraudCase | null }>(high);
    expect(["HIGH", "CRITICAL"]).toContain(highOut.risk.level);
    expect(highOut.case).not.toBeNull();
    expect(highOut.case?.reason_code).toBe("AUTO_HIGH_RISK");
    expect(highOut.case?.status).toBe("OPEN");
    const detail = await json<CaseDetail>(await h.as(plat.token, "GET", `${fraud(plat.orgId)}/cases/${highOut.case!.id}`));
    expect(detail.assessment?.id).toBe(highOut.assessment.id);

    // Read back by subject; a foreign tenant holding fraud.read sees nothing; the affiliate itself has no fraud.* permission (403).
    const items = (
      await json<{ items: Assessment[] }>(await h.as(plat.token, "GET", `${fraud(plat.orgId)}/assessments/AFFILIATE/${aff.orgId}`))
    ).items;
    expect(items.map((a) => a.id).sort()).toEqual([lowOut.assessment.id, highOut.assessment.id].sort());
    expect(
      (await json<{ items: Assessment[] }>(await h.as(adv.owner, "GET", `${fraud(adv.orgId)}/assessments/AFFILIATE/${aff.orgId}`))).items,
    ).toEqual([]);
    expect((await h.as(aff.owner, "GET", `${fraud(aff.orgId)}/assessments/AFFILIATE/${aff.orgId}`)).status).toBe(403);

    // DoD: a score is evidence, never a verdict.
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);
    expect(count("conversion_holds")).toBe(0);
    expect(count("fraud_assessments")).toBe(2);
    expect(count("fraud_cases")).toBe(1);
  });

  it("actions: tenant orgs 403 with no action row; platform PAYOUT_HOLD writes an ACTIVE hold sourced from the case; CLOSED case 409; no /fraud path reaches ledger states", async () => {
    const { plat, adv, aff, conversionId } = await world();
    const opened = await openPlatformCase(plat, aff.orgId);
    const base = `${fraud(plat.orgId)}/cases/${opened.id}`;

    // Advertiser org: the route gate (fraud.review) stops the owner before the service's PLATFORM_ONLY check; no action row.
    const advAction = await h.as(adv.owner, "POST", `${fraud(adv.orgId)}/cases/${opened.id}/actions`, {
      action_type: "PAYOUT_HOLD",
      reason_code: "X",
    });
    expect(advAction.status).toBe(403);
    expect(await h.errorCode(advAction)).toBe("FORBIDDEN");
    expect(count("fraud_actions")).toBe(0);

    // Strict body: unknown action type / missing reason / smuggled lifecycle field → 400.
    expect((await h.as(plat.token, "POST", `${base}/actions`, { action_type: "BAN_FOREVER", reason_code: "X" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/actions`, { action_type: "MONITOR" })).status).toBe(400);
    expect(
      (await h.as(plat.token, "POST", `${base}/actions`, { action_type: "MONITOR", reason_code: "X", lifecycle_status: "PAID" })).status,
    ).toBe(400);
    // CONVERSION_HOLD needs a conversion; the advertiser's conversion is not in this tenant → 404, no hold.
    expect((await h.as(plat.token, "POST", `${base}/actions`, { action_type: "CONVERSION_HOLD", reason_code: "SUSPECT" })).status).toBe(
      400,
    );
    expect(
      (
        await h.as(plat.token, "POST", `${base}/actions`, {
          action_type: "CONVERSION_HOLD",
          reason_code: "SUSPECT",
          conversion_id: conversionId,
        })
      ).status,
    ).toBe(404);
    expect(count("conversion_holds")).toBe(0);

    // MONITOR: action row, no hold.
    const monitor = await h.as(plat.token, "POST", `${base}/actions`, { action_type: "MONITOR", reason_code: "WATCH" });
    expect(monitor.status).toBe(201);
    expect((await json<{ action: { action_type: string }; hold_id: string | null }>(monitor)).hold_id).toBeNull();

    // PAYOUT_HOLD (fraud.manage, SUPER_ADMIN holds it): affiliate-scoped ACTIVE hold written in the same step, sourced from the case.
    const hold = await h.as(plat.token, "POST", `${base}/actions`, {
      action_type: "PAYOUT_HOLD",
      reason_code: "SUSPECT_FARM",
      note: "hold payouts",
    });
    expect(hold.status).toBe(201);
    const holdOut = await json<{ action: { id: string; action_type: string }; hold_id: string | null }>(hold);
    expect(holdOut.action.action_type).toBe("PAYOUT_HOLD");
    expect(holdOut.hold_id).not.toBeNull();
    const holdRow = h.db.sqlite
      .prepare(
        "SELECT organization_id, hold_type, status, source_type, source_id, affiliate_organization_id, conversion_id FROM conversion_holds WHERE id = ?",
      )
      .get(holdOut.hold_id) as Record<string, string | null>;
    expect(holdRow).toMatchObject({
      organization_id: plat.orgId,
      hold_type: "PAYOUT_HOLD",
      status: "ACTIVE",
      source_type: "FRAUD_CASE",
      source_id: opened.id,
      affiliate_organization_id: aff.orgId,
      conversion_id: null,
    });
    const detail = await json<CaseDetail>(await h.as(plat.token, "GET", base));
    expect(detail.actions.map((a) => a.action_type)).toEqual(["MONITOR", "PAYOUT_HOLD"]);
    expect(detail.events.filter((e) => e.event_type === "ACTION_TAKEN")).toHaveLength(2);

    // No action on a CLOSED case.
    expect((await h.as(plat.token, "POST", `${base}/transition`, { to: "UNDER_REVIEW" })).status).toBe(200);
    expect((await h.as(plat.token, "POST", `${base}/transition`, { to: "DISMISSED", reason_code: "FALSE_POSITIVE" })).status).toBe(200);
    expect((await h.as(plat.token, "POST", `${base}/transition`, { to: "CLOSED" })).status).toBe(200);
    const closedAction = await h.as(plat.token, "POST", `${base}/actions`, { action_type: "MONITOR", reason_code: "X" });
    expect(closedAction.status).toBe(409);
    expect(await h.errorCode(closedAction)).toBe("CASE_CLOSED");
    expect(count("fraud_actions")).toBe(2);

    // DoD: no HTTP path under /fraud reaches an internal ledger state.
    for (const to of ["LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"]) {
      for (const orgId of [plat.orgId, adv.orgId]) {
        const token = orgId === plat.orgId ? plat.token : adv.owner;
        for (const path of [
          `${fraud(orgId)}/conversions/${conversionId}/transition`,
          `${fraud(orgId)}/conversions/${conversionId}/${to.toLowerCase().replace("_", "-")}`,
          `${fraud(orgId)}/cases/${opened.id}/${to.toLowerCase().replace("_", "-")}`,
          `${fraud(orgId)}/cases/${opened.id}/conversion`,
        ]) {
          expect((await h.as(token, "POST", path, { to })).status, `${path} → ${to}`).toBe(404);
        }
      }
      // A case transition or action body smuggling a conversion state is rejected by the strict schema (never a valid case status).
      expect((await h.as(plat.token, "POST", `${base}/transition`, { to })).status, `case → ${to}`).toBe(400);
      expect(
        (await h.as(plat.token, "POST", `${base}/actions`, { action_type: "MONITOR", reason_code: "X", to })).status,
        `action to=${to}`,
      ).toBe(400);
    }
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);
  });
});
