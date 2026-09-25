/**
 * Phase 2 Unit 2 — Affiliate module routes (PRD §19, §20, §21, §27, §94,
 * §116, §124). HTTP → requireAuth → requireOrg → requirePermission →
 * AffiliateService → AffiliateRepository → D1 shim on the real migrations
 * 0001–0006. Mirrors `routes/advertisers.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "../test/fixtures";

interface Source {
  id: string;
  source_type: string;
  description: string | null;
  url: string | null;
  estimated_monthly_volume: number | null;
}
interface Profile {
  id: string;
  organization_id: string;
  status: string;
  display_name: string;
  acquisition_channel: string;
  address: { country_code: string | null };
  contact: { email: string | null };
  traffic_sources: Source[];
  allowed_transitions: string[];
  missing_fields: string[];
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  organization?: { id: string; name: string; type: string };
}
interface Transition {
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  reason: string | null;
}

const OWNER = "owner@traffic.example";
const VIEWER = "viewer@traffic.example";
const OTHER = "other@rival.example";
const REVIEWER = "reviewer@network.example";
const ADVERTISER = "ads@acme.example";

const COMPLETE = {
  display_name: "Traffic Co",
  website_url: "https://traffic.example",
  promotional_methods: "SEO blog + newsletter",
  country_code: "gb",
  contact_name: "Tess Traffic",
  contact_email: "Tess@Traffic.Example",
};

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

async function seed() {
  const owner = await h.user(OWNER);
  const orgId = await h.org(owner, "AFFILIATE", "Traffic Co");
  return { owner, orgId };
}

async function reviewer() {
  const token = await h.user(REVIEWER);
  const platformId = await h.platformOrg(REVIEWER, "SUPER_ADMIN");
  return { token, platformId };
}

/** Complete profile + one traffic source, submitted → UNDER_REVIEW. */
async function submitted() {
  const { owner, orgId } = await seed();
  const created = await json<{ profile: Profile }>(await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, COMPLETE));
  expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {})).status).toBe(201);
  const res = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`);
  expect(res.status).toBe(200);
  const rv = await reviewer();
  return { owner, orgId, profileId: created.profile.id, ...rv };
}

describe("tenant: affiliate profile", () => {
  it("creates one profile per AFFILIATE org, starting EMAIL_VERIFIED with a SYSTEM transition + audit row", async () => {
    const { owner, orgId } = await seed();
    expect((await h.as(owner, "GET", `/organizations/${orgId}/affiliate`)).status).toBe(404);

    const res = await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Traffic Co" });
    expect(res.status).toBe(201);
    const { profile } = await json<{ profile: Profile }>(res);
    expect(profile.organization_id).toBe(orgId);
    expect(profile.status).toBe("EMAIL_VERIFIED");
    expect(profile.acquisition_channel).toBe("DIRECT");
    expect(profile.traffic_sources).toEqual([]);
    expect(profile.allowed_transitions).toEqual(["UNDER_REVIEW"]);
    expect(profile.missing_fields).toEqual([
      "promotional_methods",
      "country_code",
      "contact_name",
      "contact_email",
      "website_url_or_app_url",
      "traffic_sources",
    ]);

    const dup = await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Again" });
    expect(dup.status).toBe(409);
    expect(await h.errorCode(dup)).toBe("AFFILIATE_PROFILE_EXISTS");

    const hist = await json<{ transitions: Transition[] }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate/history`));
    expect(hist.transitions).toEqual([
      expect.objectContaining({ from_status: null, to_status: "EMAIL_VERIFIED", actor_kind: "SYSTEM" }),
    ]);
    expect(await h.auditRows("affiliate.created")).toHaveLength(1);
  });

  it("PARTNER orgs may own a profile; ADVERTISER orgs hold no affiliates.* keys; unknown fields rejected", async () => {
    const partner = await h.user("partner@agency.example");
    const partnerOrg = await h.org(partner, "PARTNER", "Partner Co");
    const pres = await h.as(partner, "POST", `/organizations/${partnerOrg}/affiliate`, {
      display_name: "Partner Co",
      acquisition_channel: "PARTNER_REFERRAL",
    });
    expect(pres.status).toBe(201);
    expect((await json<{ profile: Profile }>(pres)).profile.acquisition_channel).toBe("PARTNER_REFERRAL");

    const adv = await h.user(ADVERTISER);
    const advOrg = await h.org(adv, "ADVERTISER", "Acme Ads");
    // ADVERTISER_OWNER lacks affiliates.manage → 403 before the org-type check.
    expect((await h.as(adv, "POST", `/organizations/${advOrg}/affiliate`, { display_name: "X" })).status).toBe(403);
    expect((await h.as(adv, "GET", `/organizations/${advOrg}/affiliate`)).status).toBe(403);

    const { owner, orgId } = await seed();
    const bad = await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Traffic", status: "ACTIVE" });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
    const badChannel = await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, {
      display_name: "Traffic",
      acquisition_channel: "BOGUS",
    });
    expect(badChannel.status).toBe(400);
  });

  it("PATCH updates application fields only and never the status; audit row written", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Traffic Co" });
    const res = await h.as(owner, "PATCH", `/organizations/${orgId}/affiliate`, {
      country_code: "de",
      contact_email: "Ops@Traffic.Example",
      monthly_traffic_estimate: 50000,
    });
    expect(res.status).toBe(200);
    const { profile } = await json<{ profile: Profile }>(res);
    expect(profile.address.country_code).toBe("DE");
    expect(profile.contact.email).toBe("ops@traffic.example");
    expect(profile.status).toBe("EMAIL_VERIFIED");
    expect(await h.auditRows("affiliate.updated")).toHaveLength(1);
  });

  it("traffic sources: PUT declares (201) / re-declares (200), GET lists, DELETE removes (204/404); invalid type 400", async () => {
    const { owner, orgId } = await seed();
    // No profile yet → 404
    expect((await h.as(owner, "GET", `/organizations/${orgId}/affiliate/traffic-sources`)).status).toBe(404);
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Traffic Co" });

    const first = await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {
      description: "Organic blog",
      url: "https://blog.traffic.example",
      estimated_monthly_volume: 12000,
    });
    expect(first.status).toBe(201);
    const { source } = await json<{ source: Source }>(first);
    expect(source.source_type).toBe("SEO");
    expect(source.estimated_monthly_volume).toBe(12000);

    const again = await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/SEO`, { description: "Updated" });
    expect(again.status).toBe(200);
    expect((await json<{ source: Source }>(again)).source.id).toBe(source.id);
    expect((await json<{ source: Source }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate/traffic-sources`))).source).toBeUndefined();

    expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/email`, {})).status).toBe(201);
    const list = await json<{ sources: Source[] }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate/traffic-sources`));
    expect(list.sources.map((s) => s.source_type)).toEqual(["EMAIL", "SEO"]);
    expect(list.sources.find((s) => s.source_type === "SEO")?.description).toBe("Updated");

    const badType = await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/carrier-pigeon`, {});
    expect(badType.status).toBe(400);
    expect(await h.errorCode(badType)).toBe("VALIDATION_ERROR");
    const badBody = await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/social`, { bogus: 1 });
    expect(badBody.status).toBe(400);

    expect((await h.as(owner, "DELETE", `/organizations/${orgId}/affiliate/traffic-sources/email`)).status).toBe(204);
    const gone = await h.as(owner, "DELETE", `/organizations/${orgId}/affiliate/traffic-sources/email`);
    expect(gone.status).toBe(404);
    expect(await h.errorCode(gone)).toBe("TRAFFIC_SOURCE_NOT_FOUND");

    const profile = (await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate`))).profile;
    expect(profile.traffic_sources.map((s) => s.source_type)).toEqual(["SEO"]);
    expect(profile.missing_fields).not.toContain("traffic_sources");

    const audits = [
      ...(await h.auditRows("affiliate.traffic_source_declared")),
      ...(await h.auditRows("affiliate.traffic_source_updated")),
      ...(await h.auditRows("affiliate.traffic_source_removed")),
    ];
    expect(audits).toHaveLength(4); // 2 declared, 1 updated, 1 removed
  });

  it("submit requires the PRD §21 fields AND ≥1 traffic source, moves to UNDER_REVIEW once, and is audited", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, { display_name: "Traffic Co" });

    const incomplete = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`);
    expect(incomplete.status).toBe(400);
    expect(await h.errorCode(incomplete)).toBe("PROFILE_INCOMPLETE");

    // §21 fields complete but no traffic source declared → still incomplete (PRD §27)
    await h.as(owner, "PATCH", `/organizations/${orgId}/affiliate`, COMPLETE);
    const noSource = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`);
    expect(noSource.status).toBe(400);
    const noSourceBody = await json<{ error: { code: string; message: string } }>(noSource);
    expect(noSourceBody.error.code).toBe("PROFILE_INCOMPLETE");
    expect(noSourceBody.error.message).toContain("traffic_sources");

    // app_url alone satisfies "website OR app"
    await h.as(owner, "PATCH", `/organizations/${orgId}/affiliate`, { website_url: null, app_url: "https://apps.example/traffic" });
    await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/app`, {});
    const ok = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`);
    expect(ok.status).toBe(200);
    const { profile } = await json<{ profile: Profile }>(ok);
    expect(profile.status).toBe("UNDER_REVIEW");
    expect(profile.submitted_at).not.toBeNull();
    expect(profile.allowed_transitions).toEqual([]); // tenant can do nothing while under review

    const again = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`);
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("INVALID_TRANSITION");

    // appeal is not available from UNDER_REVIEW
    const appeal = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/appeal`, { reason: "please" });
    expect(appeal.status).toBe(409);

    const audit = await h.auditRows("affiliate.status_changed");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.metadata!)).toMatchObject({ from: "EMAIL_VERIFIED", to: "UNDER_REVIEW", actor_kind: "TENANT" });
  });

  it("VIEWER can read but not manage; non-members get 404; anonymous 401", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, COMPLETE);
    await h.user(VIEWER);
    await h.addMember(owner, orgId, VIEWER, "VIEWER");
    const viewer = await h.api("POST", "/auth/login", {}, { email: VIEWER, password: PASSWORD });
    const vt = (await json<{ token: string }>(viewer)).token;

    expect((await h.as(vt, "GET", `/organizations/${orgId}/affiliate`)).status).toBe(200);
    expect((await h.as(vt, "GET", `/organizations/${orgId}/affiliate/traffic-sources`)).status).toBe(200);
    expect((await h.as(vt, "PATCH", `/organizations/${orgId}/affiliate`, { city: "Berlin" })).status).toBe(403);
    expect((await h.as(vt, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(403);
    expect((await h.as(vt, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/seo`, {})).status).toBe(403);
    expect((await h.as(vt, "DELETE", `/organizations/${orgId}/affiliate/traffic-sources/seo`)).status).toBe(403);
    expect((await h.as(vt, "POST", `/organizations/${orgId}/affiliate/appeal`, { reason: "x" })).status).toBe(403);

    const other = await h.user(OTHER);
    await h.org(other, "AFFILIATE", "Rival");
    const res = await h.as(other, "GET", `/organizations/${orgId}/affiliate`);
    expect(res.status).toBe(404);
    expect(await h.errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    expect((await h.api("GET", `/organizations/${orgId}/affiliate`)).status).toBe(401);
  });

  it("tenant can never reach the platform review routes (no affiliates.review grant)", async () => {
    const { owner, orgId, profileId } = await submitted();
    expect((await h.as(owner, "GET", `/organizations/${orgId}/platform/affiliates`)).status).toBe(403);
    const res = await h.as(owner, "POST", `/organizations/${orgId}/platform/affiliates/${profileId}/transition`, {
      to: "APPROVED",
    });
    expect(res.status).toBe(403);
    const { profile } = await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate`));
    expect(profile.status).toBe("UNDER_REVIEW");
  });
});

describe("platform: affiliate review", () => {
  it("lists (cursor-paginated, status filter) and reads any tenant's profile incl. traffic sources", async () => {
    const { profileId, token, platformId } = await submitted();
    const other = await h.user(OTHER);
    const rivalOrg = await h.org(other, "AFFILIATE", "Rival");
    await h.as(other, "POST", `/organizations/${rivalOrg}/affiliate`, { display_name: "Rival Traffic" });

    const all = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates`),
    );
    expect(all.items.map((p) => p.display_name).sort()).toEqual(["Rival Traffic", "Traffic Co"]);
    expect(all.items[0]!.organization).toBeDefined();

    const page1 = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates?limit=1`),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates?limit=1&cursor=${page1.next_cursor}`),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(page2.next_cursor).toBeNull();

    const filtered = await json<{ items: Profile[] }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates?status=UNDER_REVIEW`),
    );
    expect(filtered.items.map((p) => p.id)).toEqual([profileId]);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates?status=BOGUS`)).status).toBe(400);

    const one = await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates/${profileId}`);
    expect(one.status).toBe(200);
    const detail = (await json<{ profile: Profile }>(one)).profile;
    expect(detail.traffic_sources.map((s) => s.source_type)).toEqual(["SEO"]);
    expect(detail.organization?.type).toBe("AFFILIATE");
    expect(detail.allowed_transitions).toEqual(["APPROVED", "MORE_INFORMATION_REQUIRED", "RESTRICTED", "TERMINATED"]);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates/${RANDOM_ID}`)).status).toBe(404);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates/not-a-uuid`)).status).toBe(404);
  });

  it("drives happy path + MIR resubmit + appeal path with audited transitions; reason required; TERMINATED terminal", async () => {
    const { owner, orgId, profileId, token, platformId } = await submitted();
    const move = (to: string, extra: Record<string, unknown> = {}) =>
      h.as(token, "POST", `/organizations/${platformId}/platform/affiliates/${profileId}/transition`, { to, ...extra });

    // Illegal skip
    const skip = await move("ACTIVE");
    expect(skip.status).toBe(409);
    expect(await h.errorCode(skip)).toBe("INVALID_TRANSITION");
    // Unknown target
    expect((await move("BOGUS")).status).toBe(400);

    // Reason required
    const noReason = await move("MORE_INFORMATION_REQUIRED");
    expect(noReason.status).toBe(400);
    expect(await h.errorCode(noReason)).toBe("REASON_REQUIRED");
    expect((await move("MORE_INFORMATION_REQUIRED", { reason: "Describe your audience" })).status).toBe(200);

    // Tenant answers by re-submitting
    expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/submit`)).status).toBe(200);

    for (const to of ["APPROVED", "ACTIVE"]) {
      const res = await move(to, { review_notes: `ok ${to}` });
      expect(res.status, to).toBe(200);
      expect((await json<{ profile: Profile }>(res)).profile.status).toBe(to);
    }
    const active = (await json<{ profile: Profile }>(await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates/${profileId}`))).profile;
    expect(active.approved_at).not.toBeNull();
    expect(active.activated_at).not.toBeNull();
    expect(active.review_notes).toBe("ok ACTIVE");
    expect(active.allowed_transitions).toEqual(["RESTRICTED", "SUSPENDED", "TERMINATED"]);

    // Tenant sees the same status; nothing to do while ACTIVE
    const mine = (await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate`))).profile;
    expect(mine.status).toBe("ACTIVE");
    expect(mine.allowed_transitions).toEqual([]);

    // Suspend (reason required) → tenant may appeal (reason required) → platform reinstates
    expect((await move("SUSPENDED")).status).toBe(400);
    expect((await move("SUSPENDED", { reason: "Suspicious traffic spike" })).status).toBe(200);
    const suspended = (await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate`))).profile;
    expect(suspended.allowed_transitions).toEqual(["APPEAL"]);
    const noGrounds = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/appeal`, { reason: "  " });
    expect(noGrounds.status).toBe(400);
    const appealed = await h.as(owner, "POST", `/organizations/${orgId}/affiliate/appeal`, { reason: "Spike was a viral post; see analytics" });
    expect(appealed.status).toBe(200);
    expect((await json<{ profile: Profile }>(appealed)).profile.status).toBe("APPEAL");
    expect((await h.as(owner, "POST", `/organizations/${orgId}/affiliate/appeal`, { reason: "again" })).status).toBe(409);
    expect((await move("ACTIVE", { review_notes: "Appeal upheld" })).status).toBe(200);

    // Terminate (reason required) → terminal; tenant edits refused
    expect((await move("TERMINATED", { reason: "Fraud confirmed" })).status).toBe(200);
    expect((await move("ACTIVE")).status).toBe(409);
    expect((await h.as(owner, "PATCH", `/organizations/${orgId}/affiliate`, { city: "X" })).status).toBe(409);
    expect((await h.as(owner, "PUT", `/organizations/${orgId}/affiliate/traffic-sources/email`, {})).status).toBe(409);
    expect((await h.as(owner, "DELETE", `/organizations/${orgId}/affiliate/traffic-sources/seo`)).status).toBe(409);
    const terminated = (await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate`))).profile;
    expect(terminated.archived_at).not.toBeNull();

    // History is append-only and complete
    const hist = await json<{ transitions: Transition[] }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/affiliates/${profileId}/history`),
    );
    expect(hist.transitions.map((t) => t.to_status)).toEqual([
      "EMAIL_VERIFIED",
      "UNDER_REVIEW",
      "MORE_INFORMATION_REQUIRED",
      "UNDER_REVIEW",
      "APPROVED",
      "ACTIVE",
      "SUSPENDED",
      "APPEAL",
      "ACTIVE",
      "TERMINATED",
    ]);
    expect(hist.transitions[2]).toMatchObject({ actor_kind: "PLATFORM", reason: "Describe your audience" });
    expect(hist.transitions[7]).toMatchObject({ actor_kind: "TENANT", reason: "Spike was a viral post; see analytics" });
    // Tenant history view matches
    const mineHist = await json<{ transitions: Transition[] }>(await h.as(owner, "GET", `/organizations/${orgId}/affiliate/history`));
    expect(mineHist.transitions).toHaveLength(10);

    const audits = await h.auditRows("affiliate.status_changed");
    expect(audits).toHaveLength(9);
    expect(audits.every((a) => a.organization_id === orgId && a.target_id === profileId)).toBe(true);
  });

  it("platform roles: OPERATIONS_ADMIN / COMPLIANCE_MANAGER may review, ANALYST may read nothing here and cannot transition", async () => {
    const { profileId, platformId } = await submitted();
    const ops = await h.user("ops@network.example");
    await h.platformOrg("ops@network.example", "OPERATIONS_ADMIN");
    expect((await h.as(ops, "GET", `/organizations/${platformId}/platform/affiliates/${profileId}`)).status).toBe(200);

    const compliance = await h.user("compliance@network.example");
    await h.platformOrg("compliance@network.example", "COMPLIANCE_MANAGER");
    expect((await h.as(compliance, "GET", `/organizations/${platformId}/platform/affiliates`)).status).toBe(200);

    const analyst = await h.user("analyst@network.example");
    await h.platformOrg("analyst@network.example", "ANALYST");
    expect((await h.as(analyst, "GET", `/organizations/${platformId}/platform/affiliates`)).status).toBe(403);
    const res = await h.as(analyst, "POST", `/organizations/${platformId}/platform/affiliates/${profileId}/transition`, {
      to: "APPROVED",
    });
    expect(res.status).toBe(403);
  });

  it("review routes under a non-PLATFORM org are refused even for a user who holds affiliates.review elsewhere", async () => {
    const { owner, orgId, profileId, token } = await submitted();
    // Seat the platform reviewer inside the affiliate org as its OWNER (holds affiliates.read/manage, not review) → 403 by permission.
    await h.addMember(owner, orgId, REVIEWER, "AFFILIATE_OWNER");
    expect((await h.as(token, "GET", `/organizations/${orgId}/platform/affiliates`)).status).toBe(403);
    expect((await h.as(token, "GET", `/organizations/${orgId}/platform/affiliates/${profileId}`)).status).toBe(403);
    // And the affiliate tenant routes carry no review authority: profile still UNDER_REVIEW.
    const { profile } = await json<{ profile: Profile }>(await h.as(token, "GET", `/organizations/${orgId}/affiliate`));
    expect(profile.status).toBe("UNDER_REVIEW");
  });

  it("advertiser-only roles hold no affiliates.* keys and affiliate roles hold no advertisers.* keys", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/affiliate`, COMPLETE);
    // AFFILIATE_OWNER → advertisers.* absent
    expect((await h.as(owner, "GET", `/organizations/${orgId}/advertiser`)).status).toBe(403);
    expect((await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "X" })).status).toBe(403);
    // ADVERTISER_OWNER → affiliates.* absent
    const adv = await h.user(ADVERTISER);
    const advOrg = await h.org(adv, "ADVERTISER", "Acme Ads");
    expect((await h.as(adv, "GET", `/organizations/${advOrg}/affiliate/traffic-sources`)).status).toBe(403);
    expect((await h.as(adv, "POST", `/organizations/${advOrg}/affiliate/appeal`, { reason: "x" })).status).toBe(403);
  });
});
