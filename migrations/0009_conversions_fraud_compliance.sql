-- 0009_conversions_fraud_compliance.sql
-- Phase 4 Unit 1 — Conversion lifecycle, fraud, compliance, reconciliation
-- (PRD §38 conversion states, §40–§44 fraud, §45–§47 / §132 compliance,
-- §48 reconciliation, §115 auditability). ADDITIVE ONLY: no table created in
-- 0001–0008 is rebuilt or dropped. Money is integer minor units everywhere.
--
-- conversions.status (0008) carries a CHECK limited to the five Phase-3 intake
-- values and SQLite cannot alter a CHECK, so the full 12-state lifecycle lives
-- in a NEW column `lifecycle_status`, backfilled from `status`. From Phase 4 on
-- `lifecycle_status` is the authority; `status` stays as the intake snapshot.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- conversions — additive columns
--   lifecycle_status        full state machine (modules/conversions/state-machine.ts)
--   idempotency_key         dedupKey() of the postback (Unit 4); partial UNIQUE
--   commission_amount_minor set ONCE when the conversion reaches APPROVED
--   commission_currency     ISO-4217 alpha-3, set with commission_amount_minor
-- ---------------------------------------------------------------------------
ALTER TABLE conversions ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'RECEIVED'
  CHECK (lifecycle_status IN ('RECEIVED','VALIDATING','PENDING','APPROVED','LEDGER_POSTED','EARNED',
                              'PAYOUT_ELIGIBLE','PAID','REJECTED','FRAUD_REVIEW','DISPUTED','REVERSED'));
ALTER TABLE conversions ADD COLUMN idempotency_key TEXT
  CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 256);
ALTER TABLE conversions ADD COLUMN commission_amount_minor INTEGER
  CHECK (commission_amount_minor IS NULL OR commission_amount_minor >= 0);
ALTER TABLE conversions ADD COLUMN commission_currency TEXT
  CHECK (commission_currency IS NULL OR length(commission_currency) = 3);

UPDATE conversions SET lifecycle_status = status WHERE lifecycle_status <> status;

CREATE UNIQUE INDEX IF NOT EXISTS ux_conversions_idempotency
  ON conversions (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_conversions_org_lifecycle ON conversions (organization_id, lifecycle_status, received_at);
CREATE INDEX IF NOT EXISTS ix_conversions_affiliate_lifecycle ON conversions (affiliate_organization_id, lifecycle_status);

-- ---------------------------------------------------------------------------
-- conversion_status_history — INSERT-only, one row per lifecycle transition.
-- actor_type SYSTEM/INTERNAL rows carry actor_user_id NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_status_history (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id    TEXT NOT NULL REFERENCES conversions (id) ON DELETE RESTRICT,
  from_status      TEXT CHECK (from_status IS NULL OR from_status IN ('RECEIVED','VALIDATING','PENDING','APPROVED','LEDGER_POSTED','EARNED',
                              'PAYOUT_ELIGIBLE','PAID','REJECTED','FRAUD_REVIEW','DISPUTED','REVERSED')),
  to_status        TEXT NOT NULL CHECK (to_status IN ('RECEIVED','VALIDATING','PENDING','APPROVED','LEDGER_POSTED','EARNED',
                              'PAYOUT_ELIGIBLE','PAID','REJECTED','FRAUD_REVIEW','DISPUTED','REVERSED')),
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL')),
  actor_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason_code      TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  note             TEXT CHECK (note IS NULL OR length(note) <= 1000),
  request_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_conversion_status_history_conv ON conversion_status_history (conversion_id, created_at);
CREATE INDEX IF NOT EXISTS ix_conversion_status_history_org  ON conversion_status_history (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- conversion_reversals — INSERT-only compensating record (PRD §38 reversal).
-- The original conversion row is never edited except lifecycle_status through
-- the audited state machine; the economic reversal is THIS row. One per
-- conversion (UNIQUE conversion_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_reversals (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id         TEXT NOT NULL UNIQUE REFERENCES conversions (id) ON DELETE RESTRICT,
  reason_code           TEXT NOT NULL CHECK (reason_code IN ('REFUND','CHARGEBACK','FRAUD_CONFIRMED','ADVERTISER_DISPUTE',
                                                            'DUPLICATE_DETECTED_LATE','COMPLIANCE_VIOLATION','MANUAL_CORRECTION')),
  amount_minor          INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  reversed_by_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM')),
  note                  TEXT CHECK (note IS NULL OR length(note) <= 1000),
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_conversion_reversals_org ON conversion_reversals (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- conversion_holds — a hold blocks a lifecycle edge while ACTIVE.
--   CONVERSION_HOLD  blocks → APPROVED
--   PAYOUT_HOLD      blocks → PAYOUT_ELIGIBLE
--   COMPLIANCE_BLOCK blocks → PAYOUT_ELIGIBLE (created by compliance module)
-- Scope: conversion_id (single conversion) OR affiliate_organization_id (all
-- conversions of that affiliate under this advertiser org); at least one set.
-- source_type/source_id point at the fraud_case / fraud_action /
-- compliance_case that created it. Release is an UPDATE of status + released_*
-- (the only mutable fields).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversion_holds (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id              TEXT REFERENCES conversions (id) ON DELETE RESTRICT,
  affiliate_organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  hold_type                  TEXT NOT NULL CHECK (hold_type IN ('CONVERSION_HOLD','PAYOUT_HOLD','COMPLIANCE_BLOCK')),
  status                     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  reason_code                TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  source_type                TEXT NOT NULL CHECK (source_type IN ('FRAUD_CASE','FRAUD_ACTION','COMPLIANCE_CASE','MANUAL','SYSTEM')),
  source_id                  TEXT,
  created_by_user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  released_by_user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  released_reason_code       TEXT CHECK (released_reason_code IS NULL OR length(released_reason_code) BETWEEN 1 AND 64),
  released_at                TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (conversion_id IS NOT NULL OR affiliate_organization_id IS NOT NULL),
  CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_conversion_holds_conv      ON conversion_holds (conversion_id, status);
CREATE INDEX IF NOT EXISTS ix_conversion_holds_affiliate ON conversion_holds (organization_id, affiliate_organization_id, status);

-- ---------------------------------------------------------------------------
-- fraud_assessments — INSERT-only output of modules/fraud/risk-engine.ts for a
-- conversion (or click). A score is a signal, never proof (PRD §40).
-- signals_json: deterministic list of {code, weight, detail}.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_assessments (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  subject_type               TEXT NOT NULL CHECK (subject_type IN ('CONVERSION','CLICK','AFFILIATE')),
  subject_id                 TEXT NOT NULL,
  conversion_id              TEXT REFERENCES conversions (id) ON DELETE RESTRICT,
  affiliate_organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  rule_version               TEXT NOT NULL CHECK (length(rule_version) BETWEEN 1 AND 32),
  score                      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  level                      TEXT NOT NULL CHECK (level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  signals_json               TEXT NOT NULL DEFAULT '[]',
  evaluated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_fraud_assessments_conv ON fraud_assessments (conversion_id, evaluated_at);
CREATE INDEX IF NOT EXISTS ix_fraud_assessments_org  ON fraud_assessments (organization_id, level, evaluated_at);

-- ---------------------------------------------------------------------------
-- fraud_cases — human review container (PRD §41–§43). status is mutable
-- through the fraud service only; every change is mirrored in
-- fraud_case_events (INSERT-only). Appeal fields record the affiliate's appeal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_cases (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id              TEXT REFERENCES conversions (id) ON DELETE RESTRICT,
  assessment_id              TEXT REFERENCES fraud_assessments (id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN','UNDER_REVIEW','CONFIRMED','DISMISSED','APPEALED','APPEAL_UPHELD','APPEAL_REJECTED','CLOSED')),
  severity                   TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reason_code                TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  summary                    TEXT CHECK (summary IS NULL OR length(summary) <= 2000),
  reviewer_user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  decision_reason_code       TEXT CHECK (decision_reason_code IS NULL OR length(decision_reason_code) BETWEEN 1 AND 64),
  decided_at                 TEXT,
  appeal_note                TEXT CHECK (appeal_note IS NULL OR length(appeal_note) <= 2000),
  appealed_by_user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  appealed_at                TEXT,
  opened_by_user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_fraud_cases_org_status ON fraud_cases (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_fraud_cases_affiliate  ON fraud_cases (affiliate_organization_id, status);
CREATE INDEX IF NOT EXISTS ix_fraud_cases_conv       ON fraud_cases (conversion_id);

CREATE TABLE IF NOT EXISTS fraud_case_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  case_id          TEXT NOT NULL REFERENCES fraud_cases (id) ON DELETE RESTRICT,
  event_type       TEXT NOT NULL CHECK (event_type IN ('OPENED','ASSIGNED','STATUS_CHANGED','NOTE_ADDED','ACTION_TAKEN','APPEAL_FILED','APPEAL_DECIDED','CLOSED')),
  from_status      TEXT,
  to_status        TEXT,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM')),
  actor_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason_code      TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  note             TEXT CHECK (note IS NULL OR length(note) <= 2000),
  request_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_fraud_case_events_case ON fraud_case_events (case_id, created_at);

-- ---------------------------------------------------------------------------
-- fraud_actions — INSERT-only decisions taken on a case (PRD §44). Account-level
-- actions (TRAFFIC_RESTRICTION, ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION) are
-- RECORDED here; no Phase-4 service mutates organizations.status (known gap,
-- documented in STATE.md). Conversion/payout holds materialize as
-- conversion_holds rows (hold_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_actions (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  case_id                    TEXT NOT NULL REFERENCES fraud_cases (id) ON DELETE RESTRICT,
  affiliate_organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id              TEXT REFERENCES conversions (id) ON DELETE RESTRICT,
  action_type                TEXT NOT NULL CHECK (action_type IN ('MONITOR','MANUAL_REVIEW','CONVERSION_HOLD','TRAFFIC_RESTRICTION',
                                                                 'PAYOUT_HOLD','ACCOUNT_RESTRICTION','ACCOUNT_SUSPENSION')),
  hold_id                    TEXT REFERENCES conversion_holds (id) ON DELETE SET NULL,
  reason_code                TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  note                       TEXT CHECK (note IS NULL OR length(note) <= 2000),
  taken_by_user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_type                 TEXT NOT NULL CHECK (actor_type IN ('PLATFORM','SYSTEM')),
  request_id                 TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_fraud_actions_case ON fraud_actions (case_id, created_at);
CREATE INDEX IF NOT EXISTS ix_fraud_actions_org  ON fraud_actions (organization_id, action_type, created_at);

-- ---------------------------------------------------------------------------
-- compliance_rules — versioned deterministic rules (PRD §45–§47, §132).
-- INSERT-only versions per (organization_id NULL = platform-wide, rule_key);
-- is_current flips to 0 on the prior row when a new version is inserted.
-- definition_json is interpreted by modules/compliance/rules.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_rules (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  rule_key         TEXT NOT NULL CHECK (length(rule_key) BETWEEN 1 AND 64),
  version_number   INTEGER NOT NULL CHECK (version_number >= 1),
  is_current       INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  severity         TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','BLOCKING')),
  applies_to       TEXT NOT NULL CHECK (applies_to IN ('AFFILIATE','ADVERTISER','OFFER','CONVERSION')),
  definition_json  TEXT NOT NULL,
  description      TEXT CHECK (description IS NULL OR length(description) <= 1000),
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, rule_key, version_number)
);

CREATE INDEX IF NOT EXISTS ix_compliance_rules_current ON compliance_rules (rule_key, is_current);

-- ---------------------------------------------------------------------------
-- compliance_evaluations — INSERT-only result of running a rule version
-- against a subject. outcome PASS/FAIL/INSUFFICIENT_INFORMATION — the last one
-- is FAIL-SAFE: it never grants restricted access (PRD §132).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_evaluations (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  rule_id           TEXT NOT NULL REFERENCES compliance_rules (id) ON DELETE RESTRICT,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('AFFILIATE','ADVERTISER','OFFER','CONVERSION')),
  subject_id        TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('PASS','FAIL','INSUFFICIENT_INFORMATION')),
  reason_code       TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  details_json      TEXT NOT NULL DEFAULT '{}',
  case_id           TEXT,
  evaluated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_compliance_evaluations_subject ON compliance_evaluations (organization_id, subject_type, subject_id, evaluated_at);

-- ---------------------------------------------------------------------------
-- compliance_cases — state machine OPEN → INVESTIGATING → WAITING_FOR_INFORMATION
-- → ESCALATED → RESOLVED → CLOSED (modules/compliance/service.ts). A BLOCKING
-- case creates a COMPLIANCE_BLOCK conversion_hold (hold_id) that is released
-- only on RESOLVED with resolution COMPLIANT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_cases (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  subject_type               TEXT NOT NULL CHECK (subject_type IN ('AFFILIATE','ADVERTISER','OFFER','CONVERSION')),
  subject_id                 TEXT NOT NULL,
  affiliate_organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  rule_id                    TEXT REFERENCES compliance_rules (id) ON DELETE SET NULL,
  evaluation_id              TEXT REFERENCES compliance_evaluations (id) ON DELETE SET NULL,
  status                     TEXT NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN','INVESTIGATING','WAITING_FOR_INFORMATION','ESCALATED','RESOLVED','CLOSED')),
  severity                   TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','BLOCKING')),
  reason_code                TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  summary                    TEXT CHECK (summary IS NULL OR length(summary) <= 2000),
  hold_id                    TEXT REFERENCES conversion_holds (id) ON DELETE SET NULL,
  assignee_user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  resolution                 TEXT CHECK (resolution IS NULL OR resolution IN ('COMPLIANT','NON_COMPLIANT','NO_ACTION')),
  resolution_reason_code     TEXT CHECK (resolution_reason_code IS NULL OR length(resolution_reason_code) BETWEEN 1 AND 64),
  resolved_at                TEXT,
  opened_by_user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_compliance_cases_org_status ON compliance_cases (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_compliance_cases_subject    ON compliance_cases (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS compliance_case_events (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  case_id          TEXT NOT NULL REFERENCES compliance_cases (id) ON DELETE RESTRICT,
  event_type       TEXT NOT NULL CHECK (event_type IN ('OPENED','ASSIGNED','STATUS_CHANGED','INFORMATION_REQUESTED','INFORMATION_RECEIVED','NOTE_ADDED','RESOLVED','CLOSED')),
  from_status      TEXT,
  to_status        TEXT,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM')),
  actor_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason_code      TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  note             TEXT CHECK (note IS NULL OR length(note) <= 2000),
  request_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_compliance_case_events_case ON compliance_case_events (case_id, created_at);

-- ---------------------------------------------------------------------------
-- reconciliation_runs / reconciliation_cases (PRD §48). A run compares
-- advertiser-reported conversions vs TVH conversions vs approved/rejected
-- outcomes for one advertiser org and a period. ledger_status is
-- NOT_AVAILABLE until a ledger exists (Phase 5) — reported honestly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  period_start             TEXT NOT NULL,
  period_end               TEXT NOT NULL,
  trigger                  TEXT NOT NULL CHECK (trigger IN ('MANUAL','SCHEDULED')),
  status                   TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  reported_count           INTEGER NOT NULL DEFAULT 0 CHECK (reported_count >= 0),
  tvh_count                INTEGER NOT NULL DEFAULT 0 CHECK (tvh_count >= 0),
  approved_count           INTEGER NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
  rejected_count           INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  mismatch_count           INTEGER NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  ledger_status            TEXT NOT NULL DEFAULT 'NOT_AVAILABLE' CHECK (ledger_status IN ('NOT_AVAILABLE','MATCHED','MISMATCHED')),
  started_by_user_id       TEXT REFERENCES users (id) ON DELETE SET NULL,
  started_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at             TEXT,
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS ix_reconciliation_runs_org ON reconciliation_runs (organization_id, started_at);

CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  run_id                   TEXT NOT NULL REFERENCES reconciliation_runs (id) ON DELETE RESTRICT,
  conversion_id            TEXT REFERENCES conversions (id) ON DELETE RESTRICT,
  external_conversion_id   TEXT CHECK (external_conversion_id IS NULL OR length(external_conversion_id) BETWEEN 1 AND 128),
  mismatch_type            TEXT NOT NULL CHECK (mismatch_type IN ('MISSING_IN_TVH','MISSING_AT_ADVERTISER','AMOUNT_MISMATCH',
                                                                 'CURRENCY_MISMATCH','STATUS_MISMATCH','LEDGER_MISMATCH')),
  reported_amount_minor    INTEGER CHECK (reported_amount_minor IS NULL OR reported_amount_minor >= 0),
  tvh_amount_minor         INTEGER CHECK (tvh_amount_minor IS NULL OR tvh_amount_minor >= 0),
  reported_status          TEXT,
  tvh_status               TEXT,
  status                   TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  resolution_reason_code   TEXT CHECK (resolution_reason_code IS NULL OR length(resolution_reason_code) BETWEEN 1 AND 64),
  resolved_by_user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  resolved_at              TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_reconciliation_cases_run ON reconciliation_cases (run_id, status);
CREATE INDEX IF NOT EXISTS ix_reconciliation_cases_org ON reconciliation_cases (organization_id, status, created_at);

-- ---------------------------------------------------------------------------
-- Permission keys (PRD §10 pattern). Fixed ids continue …1101–1104 → …1111–1115.
-- 0004 already defines conversions.read/approve/reject, fraud.read/review,
-- compliance.read/resolve; only the missing keys are added here.
--   conversions.reverse   — reverse an APPROVED conversion (compensating record)
--   fraud.manage          — high-impact fraud actions: PAYOUT_HOLD,
--                           ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION (platform)
--   compliance.manage     — manage compliance rule versions, escalate/close
--                           cases (platform)
--   reconciliation.read   — view reconciliation runs and cases
--   reconciliation.manage — start runs, resolve reconciliation cases (platform)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001111', 'conversions.reverse',   'conversions',    'reverse', 'Reverse an approved conversion with a compensating record'),
  ('00000000-0000-4000-8000-000000001112', 'fraud.manage',          'fraud',          'manage',  'Take high-impact fraud actions (payout hold, account restriction/suspension)'),
  ('00000000-0000-4000-8000-000000001113', 'compliance.manage',     'compliance',     'manage',  'Manage compliance rule versions and escalate or close compliance cases'),
  ('00000000-0000-4000-8000-000000001114', 'reconciliation.read',   'reconciliation', 'read',    'View reconciliation runs and mismatch cases'),
  ('00000000-0000-4000-8000-000000001115', 'reconciliation.manage', 'reconciliation', 'manage',  'Start reconciliation runs and resolve mismatch cases');

-- Grants ---------------------------------------------------------------------
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPER_ADMIN'
   AND p.key IN ('conversions.reverse','fraud.manage','compliance.manage','reconciliation.read','reconciliation.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'OPERATIONS_ADMIN'
   AND p.key IN ('conversions.reverse','fraud.manage','compliance.manage','reconciliation.read','reconciliation.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'FINANCE_MANAGER'
   AND p.key IN ('conversions.reverse','reconciliation.read','reconciliation.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'COMPLIANCE_MANAGER'
   AND p.key IN ('fraud.manage','compliance.manage','reconciliation.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('SUPPORT_AGENT','ANALYST')
   AND p.key IN ('reconciliation.read');

-- Advertiser tenant roles: may reverse their own approved conversions
-- (refund/chargeback) and read reconciliation of their own offers.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN')
   AND p.key IN ('conversions.reverse','reconciliation.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'BILLING_MANAGER'
   AND p.key IN ('reconciliation.read');
