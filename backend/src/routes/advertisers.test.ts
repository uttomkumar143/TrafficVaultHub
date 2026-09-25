/**
 * Phase 2 Unit 1 — Advertiser module routes (PRD §16, §17, §94, §116, §124).
 * HTTP → requireAuth → requireOrg → requirePermission → AdvertiserService →
 * AdvertiserRepository → D1 shim on the real migrations 0001–0005.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, RANDOM_ID, TestHarness, json } from "../test/fixtures";

interface Profile {
  id: string;
  organization_id: string;
  status: string;
  company_name: string;
  address: { country_code: string | null };
  contact: { email: string | null };
  allowed_transitions: string[];
  missing_fields: string[];
  review_notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  organization?: { id: string; name: string };
}
interface Transition {
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  reason: string | null;
}

const OWNER = "owner@acme.example";
const VIEWER = "viewer@acme.example";
const OTHER = "other@rival.example";
const REVIEWER = "reviewer@network.example";
const AFFILIATE = "aff@traffic.example";

const COMPLETE = {
  company_name: "Acme Ads",
  website_url: "https://acme.example",
  business_category: "E-commerce",
  legal_name: "Acme Advertising LLC",
  country_code: "us",
  contact_name: "Ada Acme",
  contact_email: "Ada@Acme.Example",
};

let h: TestHarness;
beforeEach(() => {
  h = new TestHarness();
});
afterEach(() => h.close());

async function seed() {
  const owner = await h.user(OWNER);
  const orgId = await h.org(owner, "ADVERTISER", "Acme Ads");
  return { owner, orgId };
}

async function reviewer() {
  const token = await h.user(REVIEWER);
  const platformId = await h.platformOrg(REVIEWER, "SUPER_ADMIN");
  return { token, platformId };
}

async function submitted() {
  const { owner, orgId } = await seed();
  const created = await json<{ profile: Profile }>(await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, COMPLETE));
  const res = await h.as(owner, "POST", `/organizations/${orgId}/advertiser/submit`);
  expect(res.status).toBe(200);
  const rv = await reviewer();
  return { owner, orgId, profileId: created.profile.id, ...rv };
}

describe("tenant: advertiser profile", () => {
  it("creates one profile per ADVERTISER org, starting EMAIL_VERIFIED with a SYSTEM transition + audit row", async () => {
    const { owner, orgId } = await seed();
    expect((await h.as(owner, "GET", `/organizations/${orgId}/advertiser`)).status).toBe(404);

    const res = await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Acme Ads" });
    expect(res.status).toBe(201);
    const { profile } = await json<{ profile: Profile }>(res);
    expect(profile.organization_id).toBe(orgId);
    expect(profile.status).toBe("EMAIL_VERIFIED");
    expect(profile.allowed_transitions).toEqual(["BUSINESS_REVIEW"]);
    expect(profile.missing_fields).toEqual([
      "website_url",
      "business_category",
      "legal_name",
      "country_code",
      "contact_name",
      "contact_email",
    ]);

    const dup = await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Again" });
    expect(dup.status).toBe(409);
    expect(await h.errorCode(dup)).toBe("ADVERTISER_PROFILE_EXISTS");

    const hist = await json<{ transitions: Transition[] }>(await h.as(owner, "GET", `/organizations/${orgId}/advertiser/history`));
    expect(hist.transitions).toEqual([
      expect.objectContaining({ from_status: null, to_status: "EMAIL_VERIFIED", actor_kind: "SYSTEM" }),
    ]);
    expect(await h.auditRows("advertiser.created")).toHaveLength(1);
  });

  it("rejects profiles on non-advertiser orgs and unknown fields", async () => {
    const aff = await h.user(AFFILIATE);
    const affOrg = await h.org(aff, "AFFILIATE", "Traffic Co");
    // AFFILIATE_OWNER lacks advertisers.manage → 403 before org-type check.
    const res = await h.as(aff, "POST", `/organizations/${affOrg}/advertiser`, { company_name: "X" });
    expect(res.status).toBe(403);
    // AFFILIATE_OWNER holds no advertisers.* key either → read is 403 too.
    expect((await h.as(aff, "GET", `/organizations/${affOrg}/advertiser`)).status).toBe(403);

    const { owner, orgId } = await seed();
    const bad = await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Acme", status: "ACTIVE" });
    expect(bad.status).toBe(400);
    expect(await h.errorCode(bad)).toBe("VALIDATION_ERROR");
  });

  it("PATCH updates onboarding fields only and never the status; audit row written", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Acme Ads" });
    const res = await h.as(owner, "PATCH", `/organizations/${orgId}/advertiser`, {
      country_code: "de",
      contact_email: "Ops@Acme.Example",
    });
    expect(res.status).toBe(200);
    const { profile } = await json<{ profile: Profile }>(res);
    expect(profile.address.country_code).toBe("DE");
    expect(profile.contact.email).toBe("ops@acme.example");
    expect(profile.status).toBe("EMAIL_VERIFIED");
    expect(await h.auditRows("advertiser.updated")).toHaveLength(1);
  });

  it("submit requires the PRD §17 fields, moves to BUSINESS_REVIEW once, and is audited", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, { company_name: "Acme Ads" });

    const incomplete = await h.as(owner, "POST", `/organizations/${orgId}/advertiser/submit`);
    expect(incomplete.status).toBe(400);
    expect(await h.errorCode(incomplete)).toBe("PROFILE_INCOMPLETE");

    await h.as(owner, "PATCH", `/organizations/${orgId}/advertiser`, COMPLETE);
    const ok = await h.as(owner, "POST", `/organizations/${orgId}/advertiser/submit`);
    expect(ok.status).toBe(200);
    const { profile } = await json<{ profile: Profile }>(ok);
    expect(profile.status).toBe("BUSINESS_REVIEW");
    expect(profile.submitted_at).not.toBeNull();
    expect(profile.allowed_transitions).toEqual([]); // tenant can do nothing while under review

    const again = await h.as(owner, "POST", `/organizations/${orgId}/advertiser/submit`);
    expect(again.status).toBe(409);
    expect(await h.errorCode(again)).toBe("INVALID_TRANSITION");

    const audit = await h.auditRows("advertiser.status_changed");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.metadata!)).toMatchObject({ from: "EMAIL_VERIFIED", to: "BUSINESS_REVIEW", actor_kind: "TENANT" });
  });

  it("VIEWER can read but not manage; non-members get 404", async () => {
    const { owner, orgId } = await seed();
    await h.as(owner, "POST", `/organizations/${orgId}/advertiser`, COMPLETE);
    await h.user(VIEWER);
    await h.addMember(owner, orgId, VIEWER, "VIEWER");
    const viewer = await h.api("POST", "/auth/login", {}, { email: VIEWER, password: PASSWORD });
    const vt = (await json<{ token: string }>(viewer)).token;

    expect((await h.as(vt, "GET", `/organizations/${orgId}/advertiser`)).status).toBe(200);
    expect((await h.as(vt, "PATCH", `/organizations/${orgId}/advertiser`, { city: "Berlin" })).status).toBe(403);
    expect((await h.as(vt, "POST", `/organizations/${orgId}/advertiser/submit`)).status).toBe(403);

    const other = await h.user(OTHER);
    await h.org(other, "ADVERTISER", "Rival");
    const res = await h.as(other, "GET", `/organizations/${orgId}/advertiser`);
    expect(res.status).toBe(404);
    expect(await h.errorCode(res)).toBe("ORGANIZATION_NOT_FOUND");
    expect((await h.api("GET", `/organizations/${orgId}/advertiser`)).status).toBe(401);
  });

  it("tenant can never reach the platform review routes (no advertisers.review grant)", async () => {
    const { owner, orgId, profileId } = await submitted();
    expect((await h.as(owner, "GET", `/organizations/${orgId}/platform/advertisers`)).status).toBe(403);
    const res = await h.as(owner, "POST", `/organizations/${orgId}/platform/advertisers/${profileId}/transition`, {
      to: "COMPLIANCE_REVIEW",
    });
    expect(res.status).toBe(403);
    // status unchanged
    const { profile } = await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/advertiser`));
    expect(profile.status).toBe("BUSINESS_REVIEW");
  });
});

describe("platform: advertiser review", () => {
  it("lists (cursor-paginated, status filter) and reads any tenant's profile", async () => {
    const { profileId, token, platformId } = await submitted();
    const other = await h.user(OTHER);
    const rivalOrg = await h.org(other, "ADVERTISER", "Rival");
    await h.as(other, "POST", `/organizations/${rivalOrg}/advertiser`, { company_name: "Rival Inc" });

    const all = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers`),
    );
    expect(all.items.map((p) => p.company_name).sort()).toEqual(["Acme Ads", "Rival Inc"]);
    expect(all.items[0]!.organization).toBeDefined();

    const page1 = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers?limit=1`),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await json<{ items: Profile[]; next_cursor: string | null }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers?limit=1&cursor=${page1.next_cursor}`),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    expect(page2.next_cursor).toBeNull();

    const filtered = await json<{ items: Profile[] }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers?status=BUSINESS_REVIEW`),
    );
    expect(filtered.items.map((p) => p.id)).toEqual([profileId]);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers?status=BOGUS`)).status).toBe(400);

    const one = await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers/${profileId}`);
    expect(one.status).toBe(200);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers/${RANDOM_ID}`)).status).toBe(404);
    expect((await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers/not-a-uuid`)).status).toBe(404);
  });

  it("drives the full happy path with audited transitions; reason required for restrictive targets; TERMINATED is terminal", async () => {
    const { owner, orgId, profileId, token, platformId } = await submitted();
    const move = (to: string, extra: Record<string, unknown> = {}) =>
      h.as(token, "POST", `/organizations/${platformId}/platform/advertisers/${profileId}/transition`, { to, ...extra });

    // Illegal skip
    const skip = await move("ACTIVE");
    expect(skip.status).toBe(409);
    expect(await h.errorCode(skip)).toBe("INVALID_TRANSITION");

    // Reason required
    const noReason = await move("MORE_INFORMATION_REQUIRED");
    expect(noReason.status).toBe(400);
    expect(await h.errorCode(noReason)).toBe("REASON_REQUIRED");
    const mir = await move("MORE_INFORMATION_REQUIRED", { reason: "Need registration number" });
    expect(mir.status).toBe(200);

    // Tenant answers by re-submitting
    const resubmit = await h.as(owner, "POST", `/organizations/${orgId}/advertiser/submit`);
    expect(resubmit.status).toBe(200);

    for (const to of ["COMPLIANCE_REVIEW", "BILLING_SETUP", "APPROVED", "ACTIVE"]) {
      const res = await move(to, { review_notes: `ok ${to}` });
      expect(res.status, to).toBe(200);
      expect((await json<{ profile: Profile }>(res)).profile.status).toBe(to);
    }
    const active = (await json<{ profile: Profile }>(await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers/${profileId}`))).profile;
    expect(active.approved_at).not.toBeNull();
    expect(active.activated_at).not.toBeNull();
    expect(active.review_notes).toBe("ok ACTIVE");
    expect(active.allowed_transitions).toEqual(["RESTRICTED", "SUSPENDED", "TERMINATED"]);

    // Tenant sees the same status, read-only
    const mine = (await json<{ profile: Profile }>(await h.as(owner, "GET", `/organizations/${orgId}/advertiser`))).profile;
    expect(mine.status).toBe("ACTIVE");
    expect(mine.allowed_transitions).toEqual([]);

    // Terminate (reason required) → terminal
    expect((await move("TERMINATED", { reason: "Fraud confirmed" })).status).toBe(200);
    const after = await move("ACTIVE");
    expect(after.status).toBe(409);
    const edit = await h.as(owner, "PATCH", `/organizations/${orgId}/advertiser`, { city: "X" });
    expect(edit.status).toBe(409);

    // History is append-only and complete: SYSTEM create, TENANT submit, PLATFORM MIR, TENANT resubmit, 4 platform steps, TERMINATED
    const hist = await json<{ transitions: Transition[] }>(
      await h.as(token, "GET", `/organizations/${platformId}/platform/advertisers/${profileId}/history`),
    );
    expect(hist.transitions.map((t) => t.to_status)).toEqual([
      "EMAIL_VERIFIED",
      "BUSINESS_REVIEW",
      "MORE_INFORMATION_REQUIRED",
      "BUSINESS_REVIEW",
      "COMPLIANCE_REVIEW",
      "BILLING_SETUP",
      "APPROVED",
      "ACTIVE",
      "TERMINATED",
    ]);
    expect(hist.transitions[2]).toMatchObject({ actor_kind: "PLATFORM", reason: "Need registration number" });
    const audits = await h.auditRows("advertiser.status_changed");
    expect(audits).toHaveLength(8);
    expect(audits.every((a) => a.organization_id === orgId && a.target_id === profileId)).toBe(true);
  });

  it("platform roles: OPERATIONS_ADMIN may review, ANALYST may not; review under a non-PLATFORM org is refused", async () => {
    const { profileId, platformId } = await submitted();
    const ops = await h.user("ops@network.example");
    await h.platformOrg("ops@network.example", "OPERATIONS_ADMIN");
    expect((await h.as(ops, "GET", `/organizations/${platformId}/platform/advertisers/${profileId}`)).status).toBe(200);

    const analyst = await h.user("analyst@network.example");
    await h.platformOrg("analyst@network.example", "ANALYST");
    expect((await h.as(analyst, "GET", `/organizations/${platformId}/platform/advertisers`)).status).toBe(403);
    expect(
      (
        await h.as(analyst, "POST", `/organizations/${platformId}/platform/advertisers/${profileId}/transition`, {
          to: "COMPLIANCE_REVIEW",
        })
      ).status,
    ).toBe(403);
  });
});
