-- Migration 0003_organizations — TrafficVaultHub organizations & role catalogue
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 1, Unit 3 — Organizations CRUD + membership; PRD §7–§9, §16,
-- §92, §94, §124):
--   * roles.is_owner            — marks the single "owner" role per org type so
--                                 the creator of an organization can be seated
--                                 and the last owner can never be removed
--   * role_org_types            — which organization types a system role may be
--                                 assigned in (PRD §9 groups roles by tenant kind)
--   * system role catalogue     — the fixed PRD §9 role keys as reference rows
--                                 (organization_id NULL, is_system = 1)
--   * audit_logs                — append-only audit trail (PRD §92) used from
--                                 this unit onward for organization/membership
--                                 changes; later modules reuse it
--
-- Additive only. Migrations 0001 and 0002 are immutable and are NOT modified.
--
-- On "no seed data in migrations": the rows inserted below are the PRD-defined
-- role CATALOGUE (reference data required for the schema to be usable), not
-- business, demo or production statistics. Ids are fixed so that every
-- environment shares the same identifiers; `INSERT OR IGNORE` keeps re-runs
-- idempotent. Permissions and role_permissions are seeded in the RBAC unit.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- roles.is_owner — exactly one owner role per organization type.
-- ---------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1));

-- ---------------------------------------------------------------------------
-- role_org_types — a role may be granted only inside organizations of the
-- listed types. Platform roles → PLATFORM; advertiser roles → ADVERTISER and
-- AGENCY (agencies operate advertiser accounts); affiliate roles → AFFILIATE
-- and PARTNER (partners supply traffic). VIEWER is shared by all tenant kinds.
-- See ADR-002 for the rationale and the open question for PARTNER/AGENCY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_org_types (
  role_id   TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  org_type  TEXT NOT NULL
            CHECK (org_type IN ('PLATFORM','ADVERTISER','AFFILIATE','PARTNER','AGENCY')),
  PRIMARY KEY (role_id, org_type)
);

CREATE INDEX IF NOT EXISTS ix_role_org_types_org_type ON role_org_types (org_type);

-- ---------------------------------------------------------------------------
-- System role catalogue (PRD §9). Fixed UUID-format ids; keys are the API
-- identifiers. `VIEWER` appears once (system role keys are globally unique).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (id, organization_id, key, name, description, is_system, is_owner) VALUES
  -- Platform
  ('00000000-0000-4000-8000-000000000101', NULL, 'SUPER_ADMIN',        'Super Admin',        'Full platform authority',                        1, 1),
  ('00000000-0000-4000-8000-000000000102', NULL, 'OPERATIONS_ADMIN',   'Operations Admin',   'Network operations management',                  1, 0),
  ('00000000-0000-4000-8000-000000000103', NULL, 'FINANCE_MANAGER',    'Finance Manager',    'Ledger, billing and payout operations',          1, 0),
  ('00000000-0000-4000-8000-000000000104', NULL, 'COMPLIANCE_MANAGER', 'Compliance Manager', 'Compliance and fraud case management',           1, 0),
  ('00000000-0000-4000-8000-000000000105', NULL, 'SUPPORT_AGENT',      'Support Agent',      'Support with restricted tenant access',          1, 0),
  ('00000000-0000-4000-8000-000000000106', NULL, 'ANALYST',            'Analyst',            'Read-only reporting and analytics',              1, 0),
  -- Advertiser
  ('00000000-0000-4000-8000-000000000201', NULL, 'ADVERTISER_OWNER',   'Advertiser Owner',   'Owns the advertiser organization',               1, 1),
  ('00000000-0000-4000-8000-000000000202', NULL, 'ADVERTISER_ADMIN',   'Advertiser Admin',   'Administers the advertiser organization',        1, 0),
  ('00000000-0000-4000-8000-000000000203', NULL, 'CAMPAIGN_MANAGER',   'Campaign Manager',   'Manages offers and campaigns',                   1, 0),
  ('00000000-0000-4000-8000-000000000204', NULL, 'BILLING_MANAGER',    'Billing Manager',    'Manages billing and invoices',                   1, 0),
  -- Affiliate
  ('00000000-0000-4000-8000-000000000301', NULL, 'AFFILIATE_OWNER',    'Affiliate Owner',    'Owns the affiliate organization',                1, 1),
  ('00000000-0000-4000-8000-000000000302', NULL, 'AFFILIATE_MANAGER',  'Affiliate Manager',  'Manages affiliate users and traffic sources',    1, 0),
  ('00000000-0000-4000-8000-000000000303', NULL, 'AFFILIATE_USER',     'Affiliate User',     'Runs traffic and views own performance',         1, 0),
  -- Shared tenant role
  ('00000000-0000-4000-8000-000000000401', NULL, 'VIEWER',             'Viewer',             'Read-only access within the organization',       1, 0);

INSERT OR IGNORE INTO role_org_types (role_id, org_type) VALUES
  ('00000000-0000-4000-8000-000000000101', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000102', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000103', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000104', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000105', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000106', 'PLATFORM'),
  ('00000000-0000-4000-8000-000000000201', 'ADVERTISER'),
  ('00000000-0000-4000-8000-000000000201', 'AGENCY'),
  ('00000000-0000-4000-8000-000000000202', 'ADVERTISER'),
  ('00000000-0000-4000-8000-000000000202', 'AGENCY'),
  ('00000000-0000-4000-8000-000000000203', 'ADVERTISER'),
  ('00000000-0000-4000-8000-000000000203', 'AGENCY'),
  ('00000000-0000-4000-8000-000000000204', 'ADVERTISER'),
  ('00000000-0000-4000-8000-000000000204', 'AGENCY'),
  ('00000000-0000-4000-8000-000000000301', 'AFFILIATE'),
  ('00000000-0000-4000-8000-000000000301', 'PARTNER'),
  ('00000000-0000-4000-8000-000000000302', 'AFFILIATE'),
  ('00000000-0000-4000-8000-000000000302', 'PARTNER'),
  ('00000000-0000-4000-8000-000000000303', 'AFFILIATE'),
  ('00000000-0000-4000-8000-000000000303', 'PARTNER'),
  ('00000000-0000-4000-8000-000000000401', 'ADVERTISER'),
  ('00000000-0000-4000-8000-000000000401', 'AGENCY'),
  ('00000000-0000-4000-8000-000000000401', 'AFFILIATE'),
  ('00000000-0000-4000-8000-000000000401', 'PARTNER');

-- ---------------------------------------------------------------------------
-- audit_logs — append-only record of sensitive actions (PRD §16, §92, §102,
-- §124). Rows are never updated or deleted by the application. `metadata` is
-- a JSON document with non-sensitive before/after values; it must never carry
-- passwords, tokens or secrets. `organization_id` is NULL for user-level or
-- platform-level actions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  actor_user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_id         TEXT,
  metadata          TEXT,
  ip_address        TEXT,
  user_agent        TEXT,
  request_id        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_org_created ON audit_logs (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_created ON audit_logs (actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_logs_target ON audit_logs (target_type, target_id);
