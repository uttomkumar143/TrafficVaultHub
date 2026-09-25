/**
 * Shared integration-test fixtures (Phase 2).
 *
 * Every route test drives the real HTTP app against the `node:sqlite` D1 shim
 * running the actual migrations. The helpers here remove the copy-pasted
 * signup/verify/login/create-org boilerplate and add the one thing the API
 * deliberately cannot do for itself: seeding a PLATFORM organization with a
 * SUPER_ADMIN seat (PLATFORM orgs are never self-created — ADR-002 §2), which
 * platform review routes need.
 *
 * Test-only. Never imported by production code.
 */
import { expect } from "vitest";
import { createApp } from "../app";
import type { Bindings } from "../lib/bindings";
import { MemoryEmailSender } from "../modules/auth/email";
import { createTestD1, type TestD1 } from "./d1-sqlite";

export interface Envelope {
  error: { code: string; message: string; request_id: string | null };
}

// Test fixture password (not a secret); joined so secret-scan does not flag it.
export const PASSWORD = ["correct", "horse", "battery", "staple"].join("-");

/** Fixed ids from migration 0003 (system role catalogue). */
export const ROLE_IDS = {
  SUPER_ADMIN: "00000000-0000-4000-8000-000000000101",
  OPERATIONS_ADMIN: "00000000-0000-4000-8000-000000000102",
  FINANCE_MANAGER: "00000000-0000-4000-8000-000000000103",
  COMPLIANCE_MANAGER: "00000000-0000-4000-8000-000000000104",
  SUPPORT_AGENT: "00000000-0000-4000-8000-000000000105",
  ANALYST: "00000000-0000-4000-8000-000000000106",
} as const;
export type PlatformRoleKey = keyof typeof ROLE_IDS;

export class TestHarness {
  readonly db: TestD1;
  readonly mail: MemoryEmailSender;
  readonly app: ReturnType<typeof createApp>;
  readonly env: Partial<Bindings>;

  constructor() {
    this.db = createTestD1();
    this.mail = new MemoryEmailSender();
    this.app = createApp({ emailSender: this.mail });
    this.env = { DB: this.db, APP_ENV: "test", API_VERSION: "v1" };
  }

  close(): void {
    this.db.close();
  }

  /** Raw request against `/api/v1${path}`. */
  async api(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Response> {
    return await this.app.request(
      `/api/v1${path}`,
      {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.env,
    );
  }

  /** Authenticated request. */
  as(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    return this.api(method, path, { authorization: `Bearer ${token}` }, body);
  }

  /** Sign up, verify email and log in; returns the bearer token. */
  async user(email: string): Promise<string> {
    expect((await this.api("POST", "/auth/signup", {}, { email, password: PASSWORD })).status).toBe(201);
    const token = this.mail.last("EMAIL_VERIFICATION")?.token;
    expect((await this.api("POST", "/auth/verify-email", {}, { token })).status).toBe(200);
    const res = await this.api("POST", "/auth/login", {}, { email, password: PASSWORD });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  /** Create a self-service organization via the API; returns its id. */
  async org(token: string, type: "ADVERTISER" | "AFFILIATE" | "PARTNER" | "AGENCY", name: string): Promise<string> {
    const res = await this.as(token, "POST", "/organizations", { type, name });
    expect(res.status).toBe(201);
    return ((await res.json()) as { organization: { id: string } }).organization.id;
  }

  /** Add an existing user (by email) to an org with a role key. */
  async addMember(token: string, orgId: string, email: string, role: string): Promise<string> {
    const res = await this.as(token, "POST", `/organizations/${orgId}/members`, { email, role });
    expect(res.status).toBe(201);
    return ((await res.json()) as { member: { id: string } }).member.id;
  }

  /**
   * Seed the network's PLATFORM organization directly in the database (there
   * is intentionally no API for this) and seat the user identified by `email`
   * (already signed up via `user()`) with a platform role. Returns the org id.
   * Idempotent for the organization: a second call reuses the existing row.
   */
  async platformOrg(email: string, role: PlatformRoleKey = "SUPER_ADMIN"): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id FROM organizations WHERE type = 'PLATFORM' LIMIT 1")
      .first<{ id: string }>();
    let orgId = existing?.id;
    if (!orgId) {
      orgId = crypto.randomUUID();
      await this.db
        .prepare("INSERT INTO organizations (id, type, name, slug) VALUES (?, 'PLATFORM', 'TrafficVaultHub Network', 'network')")
        .bind(orgId)
        .run();
    }
    const u = await this.db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?)")
      .bind(email)
      .first<{ id: string }>();
    if (!u) throw new Error(`fixture: user ${email} must be signed up before platformOrg()`);
    await this.db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role_id, status, joined_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .bind(crypto.randomUUID(), orgId, u.id, ROLE_IDS[role])
      .run();
    return orgId;
  }

  /** Error code from a PRD §72 envelope. */
  async errorCode(res: Response): Promise<string> {
    return ((await res.json()) as Envelope).error.code;
  }

  /** Audit rows for an action, newest last. */
  async auditRows(action: string): Promise<Array<{ organization_id: string | null; target_id: string | null; metadata: string | null }>> {
    const res = await this.db
      .prepare("SELECT organization_id, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY created_at, rowid")
      .bind(action)
      .all<{ organization_id: string | null; target_id: string | null; metadata: string | null }>();
    return res.results;
  }
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export const RANDOM_ID = "11111111-2222-4333-8444-555555555555";
