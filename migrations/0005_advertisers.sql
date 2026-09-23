-- Migration 0005_advertisers — TrafficVaultHub advertiser module
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 2, Unit 1 — Advertiser module; PRD §7, §16, §17, §92, §93,
-- §94, §95, §124):
--   * advertiser_profiles              — one profile per ADVERTISER/AGENCY
--                                        organization; onboarding fields and the
--                                        PRD §16 lifecycle status
--   * advertiser_status_transitions    — append-only history of every lifecycle
--                                        transition (actor, from, to, reason)
--   * permissions                      — advertisers.read / advertisers.manage
--                                        (tenant) and advertisers.review
--                                        (platform) + role grants
--
-- Additive only. Migrations 0001–0004 are immutable and are NOT modified.
-- PRD §109 lists illustrative migration names (0003_offers…); the real
-- sequence in this repository is 0003_organizations, 0004_permissions,
-- 0005_advertisers — numbering continues from what has actually been applied.
--
-- No monetary fields here. Billing information is a reference to the future
-- `advertiser_billing_accounts` table (Phase 5) — only a nullable free-text
-- `billing_contact_email` is captured at onboarding. Documents live in R2 and
-- are referenced by `compliance_documents` (Phase 4); not modelled here.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- advertiser_profiles — the advertiser entity owned by one organization.
-- Exactly one profile per organization (UNIQUE organization_id). Rows are
-- never physically deleted; `TERMINATED` status + `archived_at` (PRD §95).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_profiles (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'REGISTERED'
                          CHECK (status IN (
                            'REGISTERED','EMAIL_VERIFIED','BUSINESS_REVIEW','COMPLIANCE_REVIEW',
                            'BILLING_SETUP','APPROVED','ACTIVE',
                            'MORE_INFORMATION_REQUIRED','RESTRICTED','SUSPENDED','TERMINATED')),
  -- onboarding: identity / business (PRD §17)
  company_name            TEXT NOT NULL,
  website_url             TEXT,
  business_category       TEXT,
  legal_name              TEXT,
  registration_number     TEXT,
  tax_id                  TEXT,
  address_line1           TEXT,
  address_line2           TEXT,
  city                    TEXT,
  region                  TEXT,
  postal_code             TEXT,
  country_code            TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
  -- onboarding: contact
  contact_name            TEXT,
  contact_email           TEXT,
  contact_phone           TEXT,
  -- onboarding: billing reference (Phase 5 owns the billing account itself)
  billing_contact_email   TEXT,
  -- review bookkeeping (set by platform reviewers)
  review_notes            TEXT,
  submitted_at            TEXT,
  approved_at             TEXT,
  activated_at            TEXT,
  archived_at             TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_advertiser_profiles_status ON advertiser_profiles (status, created_at);
CREATE INDEX IF NOT EXISTS ix_advertiser_profiles_country ON advertiser_profiles (country_code);

-- ---------------------------------------------------------------------------
-- advertiser_status_transitions — append-only lifecycle history (PRD §16
-- "every state transition is audited"). In addition to `audit_logs`, this
-- table gives a typed, queryable timeline per advertiser. Rows are INSERTed
-- only; the application never UPDATEs or DELETEs them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_status_transitions (
  id                      TEXT PRIMARY KEY,
  advertiser_profile_id   TEXT NOT NULL REFERENCES advertiser_profiles (id) ON DELETE RESTRICT,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_status             TEXT,
  to_status               TEXT NOT NULL,
  actor_user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_kind              TEXT NOT NULL CHECK (actor_kind IN ('TENANT','PLATFORM','SYSTEM')),
  reason                  TEXT,
  request_id              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_adv_transitions_profile_created
  ON advertiser_status_transitions (advertiser_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ix_adv_transitions_org
  ON advertiser_status_transitions (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- Permission keys (PRD §10 pattern). Reference data, fixed ids.
--   advertisers.read    — view own advertiser profile / status (tenant)
--   advertisers.manage  — create/update own profile, submit for review (tenant)
--   advertisers.review  — list/inspect/transition any advertiser (platform)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001081', 'advertisers.read',   'advertisers', 'read',   'View own advertiser profile and lifecycle status'),
  ('00000000-0000-4000-8000-000000001082', 'advertisers.manage', 'advertisers', 'manage', 'Create/update own advertiser profile and submit for review'),
  ('00000000-0000-4000-8000-000000001083', 'advertisers.review', 'advertisers', 'review', 'Review advertisers and drive lifecycle transitions (platform)');

-- Grants ---------------------------------------------------------------------
-- SUPER_ADMIN: everything (0004 granted a snapshot; extend for the new keys).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPER_ADMIN'
   AND p.key IN ('advertisers.read','advertisers.manage','advertisers.review');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('OPERATIONS_ADMIN','COMPLIANCE_MANAGER')
   AND p.key IN ('advertisers.read','advertisers.review');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('FINANCE_MANAGER','SUPPORT_AGENT','ANALYST')
   AND p.key IN ('advertisers.read');

-- Advertiser tenant roles (also AGENCY via role_org_types)
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN')
   AND p.key IN ('advertisers.read','advertisers.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('CAMPAIGN_MANAGER','BILLING_MANAGER','VIEWER')
   AND p.key IN ('advertisers.read');
