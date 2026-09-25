-- Migration 0006_affiliates — TrafficVaultHub affiliate module
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 2, Unit 2 — Affiliate module; PRD §7, §19, §20, §21, §27,
-- §92, §93, §94, §95, §124):
--   * affiliate_profiles              — one profile per AFFILIATE/PARTNER
--                                       organization; application fields and
--                                       the PRD §19 lifecycle status
--   * affiliate_traffic_sources       — declared traffic sources (PRD §27
--                                       catalogue) with promotional details;
--                                       one row per (profile, source_type)
--   * affiliate_status_transitions    — append-only history of every lifecycle
--                                       transition (actor, from, to, reason)
--   * permissions                     — affiliates.read / affiliates.manage
--                                       (tenant) and affiliates.review
--                                       (platform) + role grants
--
-- Additive only. Migrations 0001–0005 are immutable and are NOT modified.
--
-- No monetary fields here (payout details belong to Phase 5). Compliance
-- documents live in R2 and are referenced by `compliance_documents` (Phase 4).
-- `affiliate_offer_access` (PRD §92) is created with the offers migration.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- affiliate_profiles — the affiliate entity owned by one organization.
-- Exactly one profile per organization (UNIQUE organization_id). Rows are
-- never physically deleted; `TERMINATED` status + `archived_at` (PRD §95).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_profiles (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'APPLIED'
                          CHECK (status IN (
                            'APPLIED','EMAIL_VERIFIED','UNDER_REVIEW','APPROVED','ACTIVE',
                            'MORE_INFORMATION_REQUIRED','RESTRICTED','SUSPENDED','APPEAL','TERMINATED')),
  -- application: identity (PRD §21 review signals)
  display_name            TEXT NOT NULL,
  legal_name              TEXT,
  website_url             TEXT,
  app_url                 TEXT,
  promotional_methods     TEXT,
  audience_description    TEXT,
  monthly_traffic_estimate INTEGER CHECK (monthly_traffic_estimate IS NULL OR monthly_traffic_estimate >= 0),
  address_line1           TEXT,
  address_line2           TEXT,
  city                    TEXT,
  region                  TEXT,
  postal_code             TEXT,
  country_code            TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
  -- application: contact
  contact_name            TEXT,
  contact_email           TEXT,
  contact_phone           TEXT,
  messaging_handle        TEXT,
  -- acquisition channel (PRD §20)
  acquisition_channel     TEXT NOT NULL DEFAULT 'DIRECT'
                          CHECK (acquisition_channel IN (
                            'DIRECT','INVITATION','AFFILIATE_REFERRAL','MANAGER_INVITATION','PARTNER_REFERRAL')),
  referral_code           TEXT,
  -- review bookkeeping (set by platform reviewers)
  review_notes            TEXT,
  submitted_at            TEXT,
  approved_at             TEXT,
  activated_at            TEXT,
  archived_at             TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_affiliate_profiles_status ON affiliate_profiles (status, created_at);
CREATE INDEX IF NOT EXISTS ix_affiliate_profiles_country ON affiliate_profiles (country_code);

-- ---------------------------------------------------------------------------
-- affiliate_traffic_sources — declared traffic sources (PRD §27: "affiliate
-- must declare applicable sources"). One declaration per source type per
-- profile. Declarations are tenant-owned (organization_id) so every query is
-- scoped the same way as the profile. Removing a declaration is a physical
-- DELETE (it is a declaration, not a business record); the audit log keeps
-- the history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_traffic_sources (
  id                      TEXT PRIMARY KEY,
  affiliate_profile_id    TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  source_type             TEXT NOT NULL CHECK (source_type IN (
                            'SEO','PAID_SEARCH','SOCIAL','CONTENT','EMAIL','APP','INFLUENCER','WEBSITE','DIRECT','OTHER')),
  description             TEXT,
  url                     TEXT,
  estimated_monthly_volume INTEGER CHECK (estimated_monthly_volume IS NULL OR estimated_monthly_volume >= 0),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (affiliate_profile_id, source_type)
);

CREATE INDEX IF NOT EXISTS ix_aff_traffic_sources_org ON affiliate_traffic_sources (organization_id, source_type);

-- ---------------------------------------------------------------------------
-- affiliate_status_transitions — append-only lifecycle history (PRD §19 +
-- "same audit requirement" as advertisers). Rows are INSERTed only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_status_transitions (
  id                      TEXT PRIMARY KEY,
  affiliate_profile_id    TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_status             TEXT,
  to_status               TEXT NOT NULL,
  actor_user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_kind              TEXT NOT NULL CHECK (actor_kind IN ('TENANT','PLATFORM','SYSTEM')),
  reason                  TEXT,
  request_id              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_aff_transitions_profile_created
  ON affiliate_status_transitions (affiliate_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ix_aff_transitions_org
  ON affiliate_status_transitions (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- Permission keys (PRD §10 pattern). Reference data, fixed ids.
--   affiliates.read    — view own affiliate profile / traffic sources / status (tenant)
--   affiliates.manage  — create/update own profile + traffic sources, submit, appeal (tenant)
--   affiliates.review  — list/inspect/transition any affiliate (platform)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001091', 'affiliates.read',   'affiliates', 'read',   'View own affiliate profile, traffic sources and lifecycle status'),
  ('00000000-0000-4000-8000-000000001092', 'affiliates.manage', 'affiliates', 'manage', 'Create/update own affiliate profile and traffic sources, submit for review'),
  ('00000000-0000-4000-8000-000000001093', 'affiliates.review', 'affiliates', 'review', 'Review affiliates and drive lifecycle transitions (platform)');

-- Grants ---------------------------------------------------------------------
-- SUPER_ADMIN: everything (0004 granted a snapshot; extend for the new keys).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPER_ADMIN'
   AND p.key IN ('affiliates.read','affiliates.manage','affiliates.review');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('OPERATIONS_ADMIN','COMPLIANCE_MANAGER')
   AND p.key IN ('affiliates.read','affiliates.review');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('FINANCE_MANAGER','SUPPORT_AGENT','ANALYST')
   AND p.key IN ('affiliates.read');

-- Affiliate tenant roles (also PARTNER via role_org_types)
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('AFFILIATE_OWNER','AFFILIATE_MANAGER')
   AND p.key IN ('affiliates.read','affiliates.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('AFFILIATE_USER','VIEWER')
   AND p.key IN ('affiliates.read');
