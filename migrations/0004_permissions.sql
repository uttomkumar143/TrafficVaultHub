-- Migration 0004_permissions — TrafficVaultHub permission catalogue + role grants
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 1, Unit 4 — RBAC middleware; PRD §9, §10, §94, §116):
--   * permissions       — the PRD §10 action catalogue (offers.*, conversions.*,
--                         ledger.*, payouts.*, fraud.*, compliance.*, audit.read)
--                         plus the identity-module keys the middleware needs
--                         today (organizations.read/update, members.read/manage)
--   * role_permissions  — grants mapping the 14 PRD §9 system roles (0003) to
--                         those permissions
--
-- Additive only. Migrations 0001–0003 are immutable and are NOT modified.
--
-- As with 0003, the rows below are PRD-defined REFERENCE DATA (the permission
-- vocabulary), not business/demo data. Ids are fixed so every environment is
-- identical; `INSERT OR IGNORE` keeps re-runs idempotent. Grants are written as
-- INSERT … SELECT over role/permission KEYS so they cannot silently reference a
-- wrong id. Later phases add new permission keys with new migrations; they
-- never edit this file.
--
-- Grant policy (ADR-002 §5 records the rationale):
--   * *.read keys are broad within a tenant; mutating keys are narrow.
--   * offers.approve, conversions.approve/reject at network level, payouts.
--     review/approve/release, ledger.adjust, compliance.resolve, fraud.review
--     are PLATFORM-role powers (network operators), never tenant-role powers.
--     Advertiser roles may approve/reject conversions on their OWN offers —
--     resource ownership (PRD §10 "RBAC + resource ownership") is enforced by
--     the service layer in Phase 4, the key here only opens the door.
--   * members.manage lets a role add/change/remove non-owner members. Granting
--     or touching an OWNER seat additionally requires the caller to hold the
--     owner role — enforced in code (OrganizationService), not by a key.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Permission catalogue (PRD §10 + identity module).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  -- identity / organizations module
  ('00000000-0000-4000-8000-000000001001', 'organizations.read',   'organizations', 'read',   'View organization profile and roles'),
  ('00000000-0000-4000-8000-000000001002', 'organizations.update', 'organizations', 'update', 'Update organization profile'),
  ('00000000-0000-4000-8000-000000001003', 'members.read',         'members',       'read',   'List organization members'),
  ('00000000-0000-4000-8000-000000001004', 'members.manage',       'members',       'manage', 'Add, change role of and remove non-owner members'),
  -- offers (PRD §10)
  ('00000000-0000-4000-8000-000000001011', 'offers.read',          'offers',        'read',    'View offers'),
  ('00000000-0000-4000-8000-000000001012', 'offers.create',        'offers',        'create',  'Create offers'),
  ('00000000-0000-4000-8000-000000001013', 'offers.update',        'offers',        'update',  'Update offers'),
  ('00000000-0000-4000-8000-000000001014', 'offers.approve',       'offers',        'approve', 'Approve offers for the network'),
  ('00000000-0000-4000-8000-000000001015', 'offers.pause',         'offers',        'pause',   'Pause offers'),
  -- conversions
  ('00000000-0000-4000-8000-000000001021', 'conversions.read',     'conversions',   'read',    'View conversions'),
  ('00000000-0000-4000-8000-000000001022', 'conversions.approve',  'conversions',   'approve', 'Approve conversions'),
  ('00000000-0000-4000-8000-000000001023', 'conversions.reject',   'conversions',   'reject',  'Reject conversions'),
  -- ledger
  ('00000000-0000-4000-8000-000000001031', 'ledger.read',          'ledger',        'read',    'View ledger and balances'),
  ('00000000-0000-4000-8000-000000001032', 'ledger.adjust',        'ledger',        'adjust',  'Post manual ledger adjustments'),
  -- payouts
  ('00000000-0000-4000-8000-000000001041', 'payouts.read',         'payouts',       'read',    'View payouts'),
  ('00000000-0000-4000-8000-000000001042', 'payouts.review',       'payouts',       'review',  'Review payout requests'),
  ('00000000-0000-4000-8000-000000001043', 'payouts.approve',      'payouts',       'approve', 'Approve payouts'),
  ('00000000-0000-4000-8000-000000001044', 'payouts.release',      'payouts',       'release', 'Release approved payouts to the provider'),
  -- fraud
  ('00000000-0000-4000-8000-000000001051', 'fraud.read',           'fraud',         'read',    'View fraud signals and cases'),
  ('00000000-0000-4000-8000-000000001052', 'fraud.review',         'fraud',         'review',  'Review and decide fraud cases'),
  -- compliance
  ('00000000-0000-4000-8000-000000001061', 'compliance.read',      'compliance',    'read',    'View compliance cases'),
  ('00000000-0000-4000-8000-000000001062', 'compliance.resolve',   'compliance',    'resolve', 'Resolve compliance cases'),
  -- audit
  ('00000000-0000-4000-8000-000000001071', 'audit.read',           'audit',         'read',    'View audit logs');

-- ---------------------------------------------------------------------------
-- Grants. Helper pattern: one INSERT … SELECT per role, keyed by role.key and
-- permissions.key. Only system roles (organization_id IS NULL) are granted.
-- ---------------------------------------------------------------------------

-- Platform ------------------------------------------------------------------
-- SUPER_ADMIN: every permission in the catalogue.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPER_ADMIN';

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'OPERATIONS_ADMIN'
   AND p.key IN ('organizations.read','organizations.update','members.read','members.manage',
                 'offers.read','offers.create','offers.update','offers.approve','offers.pause',
                 'conversions.read','conversions.approve','conversions.reject',
                 'ledger.read','payouts.read','fraud.read','fraud.review','compliance.read','audit.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'FINANCE_MANAGER'
   AND p.key IN ('organizations.read','members.read','offers.read','conversions.read',
                 'ledger.read','ledger.adjust',
                 'payouts.read','payouts.review','payouts.approve','payouts.release','audit.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'COMPLIANCE_MANAGER'
   AND p.key IN ('organizations.read','members.read','offers.read','offers.pause','conversions.read',
                 'fraud.read','fraud.review','compliance.read','compliance.resolve','audit.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPPORT_AGENT'
   AND p.key IN ('organizations.read','members.read','offers.read','conversions.read','payouts.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'ANALYST'
   AND p.key IN ('organizations.read','offers.read','conversions.read','ledger.read','payouts.read',
                 'fraud.read','compliance.read');

-- Advertiser (also AGENCY via role_org_types) ---------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN')
   AND p.key IN ('organizations.read','organizations.update','members.read','members.manage',
                 'offers.read','offers.create','offers.update','offers.pause',
                 'conversions.read','conversions.approve','conversions.reject',
                 'ledger.read','fraud.read','audit.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'CAMPAIGN_MANAGER'
   AND p.key IN ('organizations.read','members.read',
                 'offers.read','offers.create','offers.update','offers.pause',
                 'conversions.read','conversions.approve','conversions.reject','fraud.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'BILLING_MANAGER'
   AND p.key IN ('organizations.read','members.read','offers.read','conversions.read','ledger.read');

-- Affiliate (also PARTNER via role_org_types) ---------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'AFFILIATE_OWNER'
   AND p.key IN ('organizations.read','organizations.update','members.read','members.manage',
                 'offers.read','conversions.read','ledger.read','payouts.read','audit.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'AFFILIATE_MANAGER'
   AND p.key IN ('organizations.read','members.read','members.manage',
                 'offers.read','conversions.read','ledger.read','payouts.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'AFFILIATE_USER'
   AND p.key IN ('organizations.read','members.read','offers.read','conversions.read');

-- Shared tenant role ----------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'VIEWER'
   AND p.key IN ('organizations.read','members.read','offers.read','conversions.read');
