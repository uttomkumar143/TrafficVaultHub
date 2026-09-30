/**
 * HTTP tests for routes/compliance.ts (Phase 4 Unit 10c) over the real app and
 * the real migrations 0001–0009 (PRD §45–§47, §115, §132). The world is built
 * through real routes: a platform org (SUPER_ADMIN holds every permission), an
 * advertiser with a LIVE offer, an ACTIVE affiliate, one real click and one
 * PENDING conversion delivered by a signed postback.
 *
 * Permission facts (migrations 0004/0009): tenant roles (ADVERTISER_OWNER,
 * AFFILIATE_OWNER, VIEWER) hold NO compliance.* permission → the route gate
 * answers 403 FORBIDDEN before the service runs. Only platform roles hold
 * compliance.read (ANALYST: read only) / compliance.resolve / compliance.manage
 * (SUPER_ADMIN, COMPLIANCE_MANAGER). The compliance world therefore lives in the
 * platform tenant; conversions live in the advertiser tenant, so a platform
 * evaluation or case naming that conversion is 404 (tenant isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toBase64Url } from "../modules/auth/crypto-utils";
import { POSTBACK_HEADERS, signPostback } from "../modules/tracking/postback-auth";
import { POSTBACK_PATH } from "../routes/attribution";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "./fixtures";

const MASTER = toBase64Url(new Uint8Array(32).map((_, i) => i * 7 + 1));
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

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

const GEO_RULE = {
  rule_key: "geo",
  severity: "BLOCKING",
  applies_to: "AFFILIATE",
  definition: { kind: "GEOGRAPHY", restricted_countries: ["KP"] },
  description: "No sanctioned geographies",
  platform_wide: true,
};

interface Offer {
  id: string;
  status: string;
}
interface Rule {
  id: string;
  organization_id: string | null;
  rule_key: string;
  version_number: number;
  is_current: number;
  severity: string;
}
interface ComplianceCase {
  id: string;
  status: string;
  severity: string;
  reason_code: string;
  hold_id: string | null;
  assignee_user_id: string | null;
  affiliate_organization_id: string | null;
  resolution: string | null;
  resolution_reason_code: string | null;
}
interface CaseEvent {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  reason_code: string | null;
  note: string | null;
}
interface Hold {
  id: string;
  hold_type: string;
  status: string;
  source_type: string;
  source_id: string | null;
  affiliate_organization_id: string | null;
  conversion_id: string | null;
}
interface CaseDetail {
  case: ComplianceCase;
  events: CaseEvent[];
  evaluation: { id: string; outcome: string } | null;
  rule: Rule | null;
  hold: Hold | null;
}
interface EvaluateOut {
  result: { outcome: string; blocking: boolean };
  evaluations: Array<{ id: string; outcome: string; reason_code: string; case_id: string | null }>;
  case: ComplianceCase | null;
  hold_id: string | null;
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

/** A second platform member seated as ANALYST: compliance.read only (no resolve/manage). */
async function analyst(email = "analyst@network.example"): Promise<string> {
  const token = await h.user(email);
  await h.platformOrg(email, "ANALYST");
  return token;
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

const TABLES = [
  "compliance_rules",
  "compliance_evaluations",
  "compliance_cases",
  "compliance_case_events",
  "conversion_holds",
  "audit_logs",
];
function snapshot(): Record<string, number> {
  return Object.fromEntries(TABLES.map((t) => [t, count(t)]));
}

const compliance = (orgId: string) => `/organizations/${orgId}/compliance`;

async function createRule(plat: { token: string; orgId: string }, body: Record<string, unknown> = GEO_RULE): Promise<Rule> {
  const res = await h.as(plat.token, "POST", `${compliance(plat.orgId)}/rules`, body);
  expect(res.status).toBe(201);
  return (await json<{ rule: Rule }>(res)).rule;
}

const OPEN_BODY = { subject_type: "AFFILIATE", severity: "WARNING", reason_code: "MANUAL_REVIEW", summary: "Spot check" };

async function openCase(plat: { token: string; orgId: string }, affiliateId: string): Promise<ComplianceCase> {
  const res = await h.as(plat.token, "POST", `${compliance(plat.orgId)}/cases`, { ...OPEN_BODY, subject_id: affiliateId });
  expect(res.status).toBe(201);
  return (await json<{ case: ComplianceCase }>(res)).case;
}

async function detail(plat: { token: string; orgId: string }, caseId: string): Promise<CaseDetail> {
  const res = await h.as(plat.token, "GET", `${compliance(plat.orgId)}/cases/${caseId}`);
  expect(res.status).toBe(200);
  return await json<CaseDetail>(res);
}

describe("compliance routes", () => {
  it("RBAC: tenant owners and VIEWER (no compliance.*) get 403 on every route; platform ANALYST (compliance.read) reads but cannot write; nothing written", async () => {
    const { plat, adv, aff, conversionId } = await world();
    const rule = await createRule(plat);
    const opened = await openCase(plat, aff.orgId);
    const viewer = await viewerToken(adv.owner, adv.orgId, "viewer@acme.example");
    const reader = await analyst();
    const before = snapshot();

    // Tenant roles hold no compliance.* permission: the gate answers 403 on reads and writes alike.
    for (const [token, orgId] of [
      [adv.owner, adv.orgId],
      [viewer, adv.orgId],
      [aff.owner, aff.orgId],
    ] as const) {
      const base = compliance(orgId);
      const calls: Array<[string, string, unknown?]> = [
        ["GET", `${base}/rules`],
        ["GET", `${base}/rules/${rule.id}`],
        ["GET", `${base}/rules/key/geo/versions`],
        ["POST", `${base}/rules`, GEO_RULE],
        ["POST", `${base}/evaluations`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: {} }],
        ["GET", `${base}/evaluations/AFFILIATE/${aff.orgId}`],
        ["GET", `${base}/cases`],
        ["GET", `${base}/cases/${opened.id}`],
        ["POST", `${base}/cases`, { ...OPEN_BODY, subject_id: aff.orgId }],
        ["POST", `${base}/cases/${opened.id}/assign`, { assignee_user_id: null }],
        ["POST", `${base}/cases/${opened.id}/notes`, { note: "hi" }],
        ["POST", `${base}/cases/${opened.id}/transition`, { to: "INVESTIGATING" }],
        ["POST", `${base}/cases/${opened.id}/resolve`, { resolution: "NO_ACTION", reason_code: "X" }],
      ];
      for (const [method, path, body] of calls) {
        const res = await h.as(token, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await h.errorCode(res)).toBe("FORBIDDEN");
      }
    }

    // Platform ANALYST: compliance.read only.
    const base = compliance(plat.orgId);
    expect((await h.as(reader, "GET", `${base}/rules`)).status).toBe(200);
    expect((await h.as(reader, "GET", `${base}/cases/${opened.id}`)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `${base}/rules`, GEO_RULE],
      ["POST", `${base}/evaluations`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: {} }],
      ["POST", `${base}/cases`, { ...OPEN_BODY, subject_id: aff.orgId }],
      ["POST", `${base}/cases/${opened.id}/assign`, { assignee_user_id: null }],
      ["POST", `${base}/cases/${opened.id}/resolve`, { resolution: "NO_ACTION", reason_code: "X" }],
    ] as Array<[string, string, unknown]>) {
      const res = await h.as(reader, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await h.errorCode(res)).toBe("FORBIDDEN");
    }
    // Transition passes the compliance.read gate but the service's edge needs compliance.resolve.
    const step = await h.as(reader, "POST", `${base}/cases/${opened.id}/transition`, { to: "INVESTIGATING" });
    expect(step.status).toBe(403);

    expect(snapshot()).toEqual(before);
    expect((await detail(plat, opened.id)).case.status).toBe("OPEN");
    expect(lifecycleOf(conversionId)).toBe("PENDING");
  });

  it("tenant isolation: non-member 404 ORGANIZATION_NOT_FOUND; advertiser conversion invisible to the platform tenant (404, nothing written); malformed/random ids 404; filters validated", async () => {
    const { plat, adv, aff, conversionId } = await world();
    await createRule(plat);
    const opened = await openCase(plat, aff.orgId);
    const before = snapshot();

    // Non-member on the platform org → 404 (never 403, no tenant oracle).
    const foreign = await h.as(adv.owner, "GET", `${compliance(plat.orgId)}/cases/${opened.id}`);
    expect(foreign.status).toBe(404);
    expect(await h.errorCode(foreign)).toBe("ORGANIZATION_NOT_FOUND");
    const foreignWrite = await h.as(aff.owner, "POST", `${compliance(plat.orgId)}/cases/${opened.id}/notes`, { note: "x" });
    expect(foreignWrite.status).toBe(404);
    expect(await h.errorCode(foreignWrite)).toBe("ORGANIZATION_NOT_FOUND");

    // The conversion belongs to the advertiser tenant: the platform tenant cannot evaluate or open a case against it.
    const base = compliance(plat.orgId);
    const evalForeign = await h.as(plat.token, "POST", `${base}/evaluations`, {
      subject_type: "CONVERSION",
      subject_id: conversionId,
      facts: { target_countries: ["GB"] },
    });
    expect(evalForeign.status).toBe(404);
    expect(await h.errorCode(evalForeign)).toBe("NOT_FOUND");
    const caseForeign = await h.as(plat.token, "POST", `${base}/cases`, {
      ...OPEN_BODY,
      subject_id: aff.orgId,
      conversion_id: conversionId,
    });
    expect(caseForeign.status).toBe(404);

    // Malformed / random ids → 404 on every id-bearing route.
    for (const id of ["not-a-uuid", RANDOM_ID, ZERO_ID]) {
      expect((await h.as(plat.token, "GET", `${base}/rules/${id}`)).status, id).toBe(404);
      expect((await h.as(plat.token, "GET", `${base}/cases/${id}`)).status, id).toBe(404);
      expect((await h.as(plat.token, "POST", `${base}/cases/${id}/assign`, { assignee_user_id: null })).status, id).toBe(404);
      expect((await h.as(plat.token, "POST", `${base}/cases/${id}/notes`, { note: "x" })).status, id).toBe(404);
      expect((await h.as(plat.token, "POST", `${base}/cases/${id}/transition`, { to: "INVESTIGATING" })).status, id).toBe(404);
      expect(
        (await h.as(plat.token, "POST", `${base}/cases/${id}/resolve`, { resolution: "NO_ACTION", reason_code: "X" })).status,
        id,
      ).toBe(404);
    }
    expect((await h.as(plat.token, "GET", `${base}/evaluations/UNKNOWN/${aff.orgId}`)).status).toBe(404);
    expect((await h.as(plat.token, "GET", `${base}/rules/key/nope/versions`)).status).toBe(200);
    expect((await json<{ items: unknown[] }>(await h.as(plat.token, "GET", `${base}/rules/key/nope/versions`))).items).toEqual([]);
    expect((await json<{ items: unknown[] }>(await h.as(plat.token, "GET", `${base}/evaluations/AFFILIATE/${RANDOM_ID}`))).items).toEqual(
      [],
    );

    // Query filters are validated.
    expect((await h.as(plat.token, "GET", `${base}/rules?applies_to=BOGUS`)).status).toBe(400);
    expect((await h.as(plat.token, "GET", `${base}/cases?status=BOGUS`)).status).toBe(400);
    expect((await h.as(plat.token, "GET", `${base}/cases?subject_type=BOGUS`)).status).toBe(400);
    expect((await h.as(plat.token, "GET", `${base}/cases?affiliate_organization_id=nope`)).status).toBe(400);

    expect(snapshot()).toEqual(before);
    expect(lifecycleOf(conversionId)).toBe("PENDING");
  });

  it("rules: versions are append-only over HTTP (old row kept, one current), invalid definition 400 INVALID_RULE_DEFINITION, strict body 400", async () => {
    const { plat } = await world();
    const base = compliance(plat.orgId);
    const rulesBefore = count("compliance_rules");

    const v1 = await createRule(plat);
    expect(v1.version_number).toBe(1);
    expect(v1.is_current).toBe(1);
    expect(v1.organization_id).toBeNull();

    const v2 = await createRule(plat, { ...GEO_RULE, definition: { kind: "GEOGRAPHY", restricted_countries: ["KP", "IR"] } });
    expect(v2.version_number).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    const versions = (await json<{ items: Rule[] }>(await h.as(plat.token, "GET", `${base}/rules/key/geo/versions`))).items;
    expect(versions.map((r) => r.version_number).sort()).toEqual([1, 2]);
    expect(versions.filter((r) => r.is_current === 1).map((r) => r.id)).toEqual([v2.id]);
    expect(count("compliance_rules")).toBe(rulesBefore + 2);

    const old = await json<{ rule: Rule }>(await h.as(plat.token, "GET", `${base}/rules/${v1.id}`));
    expect(old.rule.is_current).toBe(0);
    const current = (await json<{ items: Rule[] }>(await h.as(plat.token, "GET", `${base}/rules?applies_to=AFFILIATE`))).items;
    expect(current.map((r) => r.id)).toEqual([v2.id]);

    const snap = snapshot();
    const bad = await h.as(plat.token, "POST", `${base}/rules`, { ...GEO_RULE, definition: { kind: "GEOGRAPHY" } });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("INVALID_RULE_DEFINITION");
    expect((await h.as(plat.token, "POST", `${base}/rules`, { ...GEO_RULE, definition: { kind: "NOPE" } })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/rules`, { ...GEO_RULE, rule_key: "Bad Key!" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/rules`, { ...GEO_RULE, severity: "FATAL" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/rules`, { ...GEO_RULE, is_current: 1 })).status).toBe(400);
    expect(snapshot()).toEqual(snap);
  });

  it("evaluations: missing facts persist INSUFFICIENT_INFORMATION (never PASS) and a BLOCKING rule opens a case + COMPLIANCE_BLOCK hold; resolve(COMPLIANT) releases it, NON_COMPLIANT keeps it; lifecycle untouched", async () => {
    const { plat, aff, conversionId } = await world();
    const base = compliance(plat.orgId);
    const rule = await createRule(plat);

    // Unknown facts and smuggled lifecycle fields are refused by the strict schema.
    const snap = snapshot();
    expect(
      (await h.as(plat.token, "POST", `${base}/evaluations`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: { bogus: 1 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.as(plat.token, "POST", `${base}/evaluations`, {
          subject_type: "AFFILIATE",
          subject_id: aff.orgId,
          facts: {},
          lifecycle_status: "PAID",
        })
      ).status,
    ).toBe(400);
    expect(snapshot()).toEqual(snap);

    // No target_countries → INSUFFICIENT_INFORMATION; BLOCKING → case + hold in the same request.
    const res = await h.as(plat.token, "POST", `${base}/evaluations`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: {} });
    expect(res.status).toBe(201);
    const out = await json<EvaluateOut>(res);
    expect(out.result.outcome).toBe("INSUFFICIENT_INFORMATION");
    expect(out.result.blocking).toBe(true);
    expect(out.evaluations).toHaveLength(1);
    expect(out.evaluations[0]!.outcome).toBe("INSUFFICIENT_INFORMATION");
    expect(out.evaluations[0]!.reason_code).toBe("MISSING_REQUIRED_FACTS");
    expect(out.case).not.toBeNull();
    expect(out.hold_id).not.toBeNull();
    expect(out.case!.status).toBe("OPEN");
    expect(out.case!.severity).toBe("BLOCKING");
    expect(out.case!.hold_id).toBe(out.hold_id);
    expect(out.evaluations[0]!.case_id).toBe(out.case!.id);

    const persisted = h.db.sqlite
      .prepare("SELECT outcome, reason_code, case_id FROM compliance_evaluations WHERE id = ?")
      .get(out.evaluations[0]!.id) as {
      outcome: string;
      reason_code: string;
      case_id: string | null;
    };
    expect(persisted).toEqual({ outcome: "INSUFFICIENT_INFORMATION", reason_code: "MISSING_REQUIRED_FACTS", case_id: out.case!.id });

    const hold = h.db.sqlite.prepare("SELECT * FROM conversion_holds WHERE id = ?").get(out.hold_id) as unknown as Hold & {
      organization_id: string;
    };
    expect(hold.hold_type).toBe("COMPLIANCE_BLOCK");
    expect(hold.status).toBe("ACTIVE");
    expect(hold.source_type).toBe("COMPLIANCE_CASE");
    expect(hold.source_id).toBe(out.case!.id);
    expect(hold.affiliate_organization_id).toBe(aff.orgId);
    expect(hold.conversion_id).toBeNull();
    expect(hold.organization_id).toBe(plat.orgId);

    const d = await detail(plat, out.case!.id);
    expect(d.hold?.id).toBe(out.hold_id);
    expect(d.rule?.id).toBe(rule.id);
    expect(d.evaluation?.id).toBe(out.evaluations[0]!.id);
    expect(d.events.map((e) => e.event_type)).toEqual(["OPENED"]);

    // Subject read-back lists the persisted evaluation.
    const list = await json<{ items: Array<{ id: string; outcome: string }> }>(
      await h.as(plat.token, "GET", `${base}/evaluations/AFFILIATE/${aff.orgId}`),
    );
    expect(list.items.map((e) => e.id)).toEqual([out.evaluations[0]!.id]);

    // Full facts → PASS, no new case, no new hold.
    const casesBefore = count("compliance_cases");
    const holdsBefore = count("conversion_holds");
    const pass = await json<EvaluateOut>(
      await h.as(plat.token, "POST", `${base}/evaluations`, {
        subject_type: "AFFILIATE",
        subject_id: aff.orgId,
        facts: { target_countries: ["GB"] },
      }),
    );
    expect(pass.result.outcome).toBe("PASS");
    expect(pass.case).toBeNull();
    expect(pass.hold_id).toBeNull();
    expect(count("compliance_cases")).toBe(casesBefore);
    expect(count("conversion_holds")).toBe(holdsBefore);

    // Resolve is only legal from INVESTIGATING/ESCALATED; RESOLVED is refused on /transition.
    const caseId = out.case!.id;
    const early = await h.as(plat.token, "POST", `${base}/cases/${caseId}/resolve`, {
      resolution: "COMPLIANT",
      reason_code: "DOCS_RECEIVED",
    });
    expect(early.status).toBe(409);
    expect(await h.errorCode(early)).toBe("INVALID_CASE_TRANSITION");
    expect((await h.as(plat.token, "POST", `${base}/cases/${caseId}/transition`, { to: "RESOLVED" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/cases/${caseId}/transition`, { to: "INVESTIGATING" })).status).toBe(200);

    // COMPLIANT releases the case's hold in the same batch and audits the release.
    const auditBefore = count("audit_logs");
    const resolved = await h.as(plat.token, "POST", `${base}/cases/${caseId}/resolve`, {
      resolution: "COMPLIANT",
      reason_code: "DOCS_RECEIVED",
      note: "Geo list supplied",
    });
    expect(resolved.status).toBe(200);
    const after = await json<CaseDetail>(resolved);
    expect(after.case.status).toBe("RESOLVED");
    expect(after.case.resolution).toBe("COMPLIANT");
    expect(after.case.resolution_reason_code).toBe("DOCS_RECEIVED");
    expect(after.hold?.status).toBe("RELEASED");
    const released = h.db.sqlite.prepare("SELECT status, released_at FROM conversion_holds WHERE id = ?").get(out.hold_id) as {
      status: string;
      released_at: string | null;
    };
    expect(released.status).toBe("RELEASED");
    expect(released.released_at).not.toBeNull();
    const releaseAudit = h.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'conversion.hold.released' AND target_id = ?")
      .get(out.hold_id) as { n: number };
    expect(releaseAudit.n).toBe(1);
    expect(count("audit_logs")).toBe(auditBefore + 2);
    expect(after.events.map((e) => e.event_type)).toEqual(["OPENED", "STATUS_CHANGED", "RESOLVED"]);

    // A second blocking evaluation opens a fresh case + hold; NON_COMPLIANT keeps the hold ACTIVE.
    const second = await json<EvaluateOut>(
      await h.as(plat.token, "POST", `${base}/evaluations`, { subject_type: "AFFILIATE", subject_id: aff.orgId, facts: {} }),
    );
    expect(second.case).not.toBeNull();
    expect(second.case!.id).not.toBe(caseId);
    expect(second.hold_id).not.toBe(out.hold_id);
    expect((await h.as(plat.token, "POST", `${base}/cases/${second.case!.id}/transition`, { to: "INVESTIGATING" })).status).toBe(200);
    const kept = await json<CaseDetail>(
      await h.as(plat.token, "POST", `${base}/cases/${second.case!.id}/resolve`, {
        resolution: "NON_COMPLIANT",
        reason_code: "SANCTIONED_GEO",
      }),
    );
    expect(kept.case.status).toBe("RESOLVED");
    expect(kept.case.resolution).toBe("NON_COMPLIANT");
    expect(kept.hold?.status).toBe("ACTIVE");

    // Nothing on this face touches the conversion.
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);
  });

  it("case flow: open → assign → note → INVESTIGATING ⇄ WAITING_FOR_INFORMATION → ESCALATED → INVESTIGATING → RESOLVED → CLOSED with ordered events; reason/note rules; no HTTP path to ledger states", async () => {
    const { plat, adv, aff, conversionId } = await world();
    const base = compliance(plat.orgId);
    const auditBefore = count("audit_logs");

    // Strict open body.
    expect((await h.as(plat.token, "POST", `${base}/cases`, { ...OPEN_BODY, subject_id: aff.orgId, status: "RESOLVED" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/cases`, { ...OPEN_BODY, subject_id: aff.orgId, severity: "FATAL" })).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/cases`, { ...OPEN_BODY, subject_id: aff.orgId, reason_code: "" })).status).toBe(400);
    expect(count("compliance_cases")).toBe(0);

    const opened = await openCase(plat, aff.orgId);
    expect(opened.status).toBe("OPEN");
    expect(opened.severity).toBe("WARNING");
    expect(opened.hold_id).toBeNull();
    expect(opened.affiliate_organization_id).toBe(aff.orgId);
    expect(count("audit_logs")).toBe(auditBefore + 1);

    const assigned = await json<{ case: ComplianceCase }>(
      await h.as(plat.token, "POST", `${base}/cases/${opened.id}/assign`, { assignee_user_id: plat.userId }),
    );
    expect(assigned.case.assignee_user_id).toBe(plat.userId);
    expect(
      (await h.as(plat.token, "POST", `${base}/cases/${opened.id}/assign`, { assignee_user_id: RANDOM_ID })).status,
    ).toBeGreaterThanOrEqual(400);

    expect((await h.as(plat.token, "POST", `${base}/cases/${opened.id}/notes`, { note: "" })).status).toBe(400);
    const noted = await h.as(plat.token, "POST", `${base}/cases/${opened.id}/notes`, { note: "Checking traffic sources" });
    expect(noted.status).toBe(201);

    const transition = (to: string, extra: Record<string, unknown> = {}) =>
      h.as(plat.token, "POST", `${base}/cases/${opened.id}/transition`, { to, ...extra });

    // Invalid edges from OPEN.
    for (const to of ["WAITING_FOR_INFORMATION", "ESCALATED", "CLOSED"]) {
      const res = await transition(to);
      expect(res.status, to).toBe(409);
      expect(await h.errorCode(res)).toBe("INVALID_CASE_TRANSITION");
    }
    expect((await transition("BOGUS")).status).toBe(400);
    expect((await transition("INVESTIGATING", { lifecycle_status: "PAID" })).status).toBe(400);

    expect((await transition("INVESTIGATING")).status).toBe(200);
    const needNote = await transition("WAITING_FOR_INFORMATION");
    expect(needNote.status).toBe(400);
    expect(await h.errorCode(needNote)).toBe("NOTE_REQUIRED");
    expect((await transition("WAITING_FOR_INFORMATION", { note: "Please send your geo targeting" })).status).toBe(200);
    expect((await transition("INVESTIGATING", { note: "Received" })).status).toBe(200);
    const needReason = await transition("ESCALATED");
    expect(needReason.status).toBe(400);
    expect(await h.errorCode(needReason)).toBe("REASON_REQUIRED");
    expect((await transition("ESCALATED", { reason_code: "NEEDS_LEGAL" })).status).toBe(200);
    // ESCALATED → INVESTIGATING is PLATFORM + compliance.manage: SUPER_ADMIN holds it.
    expect((await transition("INVESTIGATING")).status).toBe(200);

    // RESOLVED only via /resolve.
    expect((await transition("RESOLVED")).status).toBe(400);
    expect((await h.as(plat.token, "POST", `${base}/cases/${opened.id}/resolve`, { resolution: "MAYBE", reason_code: "X" })).status).toBe(
      400,
    );
    expect((await h.as(plat.token, "POST", `${base}/cases/${opened.id}/resolve`, { resolution: "NO_ACTION" })).status).toBe(400);
    const resolved = await json<CaseDetail>(
      await h.as(plat.token, "POST", `${base}/cases/${opened.id}/resolve`, { resolution: "NO_ACTION", reason_code: "FALSE_POSITIVE" }),
    );
    expect(resolved.case.status).toBe("RESOLVED");
    expect(resolved.case.resolution).toBe("NO_ACTION");
    expect(resolved.hold).toBeNull();

    // RESOLVED → CLOSED (platform manage); nothing after CLOSED.
    expect((await transition("CLOSED")).status).toBe(200);
    const afterClosed = await transition("INVESTIGATING");
    expect(afterClosed.status).toBe(409);
    expect(await h.errorCode(afterClosed)).toBe("INVALID_CASE_TRANSITION");
    const resolveClosed = await h.as(plat.token, "POST", `${base}/cases/${opened.id}/resolve`, {
      resolution: "NO_ACTION",
      reason_code: "X",
    });
    expect(resolveClosed.status).toBe(409);

    const d = await detail(plat, opened.id);
    expect(d.case.status).toBe("CLOSED");
    expect(d.events.map((e) => e.event_type)).toEqual([
      "OPENED",
      "ASSIGNED",
      "NOTE_ADDED",
      "STATUS_CHANGED",
      "INFORMATION_REQUESTED",
      "INFORMATION_RECEIVED",
      "STATUS_CHANGED",
      "STATUS_CHANGED",
      "RESOLVED",
      "CLOSED",
    ]);
    expect(d.events.every((e) => e.actor_type === "PLATFORM")).toBe(true);
    expect(d.events.map((e) => e.to_status)).toEqual([
      "OPEN",
      null,
      null,
      "INVESTIGATING",
      "WAITING_FOR_INFORMATION",
      "INVESTIGATING",
      "ESCALATED",
      "INVESTIGATING",
      "RESOLVED",
      "CLOSED",
    ]);
    expect(d.events[6]!.reason_code).toBe("NEEDS_LEGAL");
    expect(d.events[4]!.note).toBe("Please send your geo targeting");

    const closedList = await json<{ items: ComplianceCase[] }>(await h.as(plat.token, "GET", `${base}/cases?status=CLOSED`));
    expect(closedList.items.map((c) => c.id)).toEqual([opened.id]);
    const openList = await json<{ items: ComplianceCase[] }>(await h.as(plat.token, "GET", `${base}/cases?status=OPEN`));
    expect(openList.items).toEqual([]);
    const byAffiliate = await json<{ items: ComplianceCase[] }>(
      await h.as(plat.token, "GET", `${base}/cases?affiliate_organization_id=${aff.orgId}`),
    );
    expect(byAffiliate.items.map((c) => c.id)).toEqual([opened.id]);

    // DoD: no HTTP path under /compliance reaches LEDGER_POSTED / EARNED / PAYOUT_ELIGIBLE / PAID.
    const fresh = await openCase(plat, aff.orgId);
    const snap = snapshot();
    for (const state of ["LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"]) {
      expect((await h.as(plat.token, "POST", `${base}/cases/${fresh.id}/transition`, { to: state })).status, state).toBe(400);
      expect(
        (await h.as(plat.token, "POST", `${base}/cases/${fresh.id}/resolve`, { resolution: state, reason_code: "X" })).status,
        state,
      ).toBe(400);
      for (const [token, orgId] of [
        [plat.token, plat.orgId],
        [adv.owner, adv.orgId],
      ] as const) {
        for (const path of [
          `${compliance(orgId)}/conversions/${conversionId}/${state.toLowerCase()}`,
          `${compliance(orgId)}/cases/${fresh.id}/${state.toLowerCase()}`,
          `${compliance(orgId)}/ledger`,
          `${compliance(orgId)}/payouts`,
        ]) {
          const res = await h.as(token, "POST", path, { to: state });
          expect([403, 404], `${path} ${state}`).toContain(res.status);
        }
      }
    }
    expect(snapshot()).toEqual(snap);
    expect(lifecycleOf(conversionId)).toBe("PENDING");
    expect(count("conversion_status_history")).toBe(0);
  });
});
