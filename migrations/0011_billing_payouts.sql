-- 0011_billing_payouts.sql
-- Phase 5 Unit 7 — Advertiser funding & billing (PRD §62) and payout
-- persistence (PRD §63–§66, §114): billing profiles, INSERT-only funding
-- events, payout methods, payouts, payout status history, payout attempts and
-- funding alerts (audit/notification rows only — no external delivery here).
-- ADDITIVE ONLY: no table created in 0001–0010 is rebuilt, altered or dropped.
--
-- Money is INTEGER minor units + ISO-4217 alpha-3 currency on every row. No
-- floats, no cross-currency rows: a payout's currency must match its payout
-- method's currency (enforced by trigger), a funding event carries the
-- billing profile's currency (enforced by trigger).
--
-- APPEND-ONLY: advertiser_funding_events, payout_status_history and
-- payout_attempts can never be UPDATEd or DELETEd. payouts rows can never be
-- deleted, their money/identity columns are frozen once written, PAID and
-- CANCELLED are final, and a provider reference, once set, can never change
-- (idempotency: a retry can only ever observe the same reference).
--
-- GAP RECORDED: 0006_affiliates.sql deliberately carries no payout-method
-- field ("payout details belong to Phase 5"), so `payout_methods` is created
-- here in its minimal form. Raw account data is NEVER stored: `provider_token`
-- is an opaque reference held by the payment provider (PRD §117).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- advertiser_billing_profiles — one per advertiser org (§62).
--   funding_model           PREPAID  — capacity is the ADVERTISER_PREPAID ledger
--                                      balance (computed from ledger_entries,
--                                      never stored here)
--                           POSTPAID — capacity is credit_limit − used_credit,
--                                      invoiced on `payment_terms_days`
--                           CREDIT   — capacity is credit_limit − used_credit
--   available_credit_minor  stored AND kept consistent by CHECK:
--                           available = credit_limit − used_credit, always.
--   risk_status             NORMAL | WATCH | HIGH | BLOCKED — BLOCKED has zero
--                           capacity regardless of model.
--   billing_status          ACTIVE | PAST_DUE | SUSPENDED | CLOSED — only
--                           ACTIVE has capacity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_billing_profiles (
  id                          TEXT PRIMARY KEY,
  organization_id             TEXT NOT NULL UNIQUE REFERENCES organizations (id) ON DELETE RESTRICT,
  advertiser_profile_id       TEXT NOT NULL UNIQUE REFERENCES advertiser_profiles (id) ON DELETE RESTRICT,
  funding_model               TEXT NOT NULL CHECK (funding_model IN ('PREPAID','POSTPAID','CREDIT')),
  currency                    TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  credit_limit_minor          INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  used_credit_minor           INTEGER NOT NULL DEFAULT 0 CHECK (used_credit_minor >= 0),
  available_credit_minor      INTEGER NOT NULL DEFAULT 0,
  payment_terms_days          INTEGER CHECK (payment_terms_days IS NULL OR (payment_terms_days BETWEEN 0 AND 180)),
  low_balance_threshold_minor INTEGER NOT NULL DEFAULT 0 CHECK (low_balance_threshold_minor >= 0),
  risk_status                 TEXT NOT NULL DEFAULT 'NORMAL' CHECK (risk_status IN ('NORMAL','WATCH','HIGH','BLOCKED')),
  billing_status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (billing_status IN ('ACTIVE','PAST_DUE','SUSPENDED','CLOSED')),
  funding_protection_active   INTEGER NOT NULL DEFAULT 0 CHECK (funding_protection_active IN (0, 1)),
  funding_protection_since    TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (available_credit_minor = credit_limit_minor - used_credit_minor),
  CHECK ((funding_model = 'PREPAID') = (credit_limit_minor = 0)),
  CHECK (funding_model <> 'POSTPAID' OR payment_terms_days IS NOT NULL),
  CHECK ((funding_protection_active = 1) = (funding_protection_since IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_advertiser_billing_profiles_status
  ON advertiser_billing_profiles (billing_status, risk_status, funding_model);

-- Identity/currency of a billing profile never changes (a currency change is a new profile).
CREATE TRIGGER IF NOT EXISTS trg_advertiser_billing_profiles_frozen
BEFORE UPDATE OF id, organization_id, advertiser_profile_id, currency, created_at ON advertiser_billing_profiles
BEGIN
  SELECT RAISE(ABORT, 'BILLING_PROFILE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_advertiser_billing_profiles_no_delete
BEFORE DELETE ON advertiser_billing_profiles
BEGIN
  SELECT RAISE(ABORT, 'BILLING_PROFILE_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- advertiser_funding_events — INSERT-only history of everything that changes
-- an advertiser's funding position (§62, §115): deposits, invoices, credit
-- limit / used credit changes, status changes, funding-protection on/off.
-- Money movements that hit the ledger reference their journal; state changes
-- carry before/after JSON.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_funding_events (
  id                    TEXT PRIMARY KEY,
  billing_profile_id    TEXT NOT NULL REFERENCES advertiser_billing_profiles (id) ON DELETE RESTRICT,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  event_type            TEXT NOT NULL CHECK (event_type IN ('DEPOSIT','WITHDRAWAL','INVOICE_ISSUED','INVOICE_PAID','INVOICE_OVERDUE',
                                                           'CREDIT_LIMIT_CHANGED','USED_CREDIT_CHANGED','FUNDING_MODEL_CHANGED',
                                                           'RISK_STATUS_CHANGED','BILLING_STATUS_CHANGED',
                                                           'FUNDING_PROTECTION_TRIGGERED','FUNDING_PROTECTION_CLEARED')),
  amount_minor          INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  before_state          TEXT,
  after_state           TEXT,
  journal_id            TEXT UNIQUE REFERENCES journal_entries (id) ON DELETE RESTRICT,
  reference_type        TEXT CHECK (reference_type IS NULL OR reference_type IN ('INVOICE','PAYMENT','OFFER','PAYOUT','TICKET','OTHER')),
  reference_id          TEXT,
  idempotency_key       TEXT UNIQUE,
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL')),
  actor_user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  note                  TEXT CHECK (note IS NULL OR length(note) <= 1000),
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((reference_type IS NULL) = (reference_id IS NULL)),
  CHECK (event_type NOT IN ('DEPOSIT','WITHDRAWAL','INVOICE_ISSUED','INVOICE_PAID') OR amount_minor IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_advertiser_funding_events_profile ON advertiser_funding_events (billing_profile_id, created_at);
CREATE INDEX IF NOT EXISTS ix_advertiser_funding_events_org_type ON advertiser_funding_events (organization_id, event_type, created_at);

-- A funding event is always in its profile's currency (no cross-currency rows).
CREATE TRIGGER IF NOT EXISTS trg_advertiser_funding_events_currency
BEFORE INSERT ON advertiser_funding_events
WHEN NEW.currency <> (SELECT currency FROM advertiser_billing_profiles WHERE id = NEW.billing_profile_id)
BEGIN
  SELECT RAISE(ABORT, 'FUNDING_EVENT_CURRENCY_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_advertiser_funding_events_no_update
BEFORE UPDATE ON advertiser_funding_events
BEGIN
  SELECT RAISE(ABORT, 'FUNDING_EVENTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_advertiser_funding_events_no_delete
BEFORE DELETE ON advertiser_funding_events
BEGIN
  SELECT RAISE(ABORT, 'FUNDING_EVENTS_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- funding_alerts — notification/audit rows for funding protection (§62):
-- "alerts the advertiser AND operations". One row per (audience, dedupe_key);
-- the UNIQUE dedupe key is what makes the trigger idempotent — running it
-- twice cannot double-alert. Rows are never delivered externally from here
-- (Phase 6 notifications read them). The ONLY permitted update is
-- acknowledgement.
--   organization_id  the advertiser the alert is ABOUT (for both audiences)
--   audience         ADVERTISER (tenant inbox) | OPERATIONS (network inbox)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funding_alerts (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  billing_profile_id      TEXT NOT NULL REFERENCES advertiser_billing_profiles (id) ON DELETE RESTRICT,
  audience                TEXT NOT NULL CHECK (audience IN ('ADVERTISER','OPERATIONS')),
  alert_type              TEXT NOT NULL CHECK (alert_type IN ('INSUFFICIENT_CAPACITY','LOW_BALANCE','CREDIT_LIMIT_REACHED',
                                                             'INVOICE_OVERDUE','CAPACITY_RESTORED')),
  severity                TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  dedupe_key              TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  acknowledged_at         TEXT,
  acknowledged_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  request_id              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (audience, dedupe_key),
  CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_funding_alerts_audience_open ON funding_alerts (audience, acknowledged_at, created_at);
CREATE INDEX IF NOT EXISTS ix_funding_alerts_org ON funding_alerts (organization_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_funding_alerts_frozen
BEFORE UPDATE OF id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload, request_id, created_at
ON funding_alerts
BEGIN
  SELECT RAISE(ABORT, 'FUNDING_ALERT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_alerts_no_delete
BEFORE DELETE ON funding_alerts
BEGIN
  SELECT RAISE(ABORT, 'FUNDING_ALERT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- payout_methods — where an affiliate is paid (§63). Minimal: the provider
-- holds the account details; we hold an opaque `provider_token` plus a
-- display label. One VERIFIED default per org. Status is the only mutable
-- workflow field; identity/currency/token are frozen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_methods (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_profile_id  TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  method_type           TEXT NOT NULL CHECK (method_type IN ('BANK_TRANSFER','PAYPAL','WISE','PAYONEER','CRYPTO','OTHER')),
  provider              TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_token        TEXT NOT NULL CHECK (length(provider_token) BETWEEN 1 AND 256),
  display_label         TEXT NOT NULL CHECK (length(display_label) BETWEEN 1 AND 120),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  country_code          TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
  status                TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                        CHECK (status IN ('PENDING_VERIFICATION','VERIFIED','REJECTED','DISABLED')),
  is_default            INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  verified_at           TEXT,
  disabled_at           TEXT,
  created_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, provider_token),
  CHECK ((status = 'VERIFIED') = (verified_at IS NOT NULL) OR status = 'DISABLED'),
  CHECK ((status = 'DISABLED') = (disabled_at IS NOT NULL)),
  CHECK (is_default = 0 OR status = 'VERIFIED')
);

CREATE INDEX IF NOT EXISTS ix_payout_methods_org_status ON payout_methods (organization_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payout_methods_default ON payout_methods (organization_id) WHERE is_default = 1;

CREATE TRIGGER IF NOT EXISTS trg_payout_methods_frozen
BEFORE UPDATE OF id, organization_id, affiliate_profile_id, method_type, provider, provider_token, currency, created_at
ON payout_methods
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_METHOD_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_methods_no_delete
BEFORE DELETE ON payout_methods
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_METHOD_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- payouts — one row per payout, with an immutable internal id and (once the
-- provider answers) the provider's reference (§65, §66).
--   idempotency_key      UNIQUE — the request that created the payout; a retry
--                        with the same key hits the UNIQUE constraint and can
--                        never create a second payout (§114).
--   provider_reference   UNIQUE when not null; frozen once set.
--   State machine (§65): REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW →
--   APPROVED → PROCESSING → PAID, with FAILED (recoverable: back to
--   PROCESSING or on to CANCELLED) and CANCELLED. PAID and CANCELLED are final.
--   Approver must differ from requester (§132).
--   journal_id           the ledger journal that moved AFFILIATE_PAYABLE →
--                        PAYOUT_CLEARING; set when PAID, never before.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  payout_method_id      TEXT NOT NULL REFERENCES payout_methods (id) ON DELETE RESTRICT,
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  fee_minor             INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0 AND fee_minor < amount_minor),
  status                TEXT NOT NULL DEFAULT 'REQUESTED'
                        CHECK (status IN ('REQUESTED','ELIGIBILITY_CHECK','UNDER_REVIEW','APPROVED','PROCESSING','PAID','FAILED','CANCELLED')),
  idempotency_key       TEXT NOT NULL UNIQUE,
  provider              TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 64),
  provider_reference    TEXT CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 256),
  period_start          TEXT,
  period_end            TEXT,
  eligibility_snapshot  TEXT,
  requested_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  requested_actor_type  TEXT NOT NULL CHECK (requested_actor_type IN ('TENANT','PLATFORM','SYSTEM')),
  approved_by_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at           TEXT,
  approval_note         TEXT CHECK (approval_note IS NULL OR length(approval_note) <= 1000),
  failure_code          TEXT CHECK (failure_code IS NULL OR (failure_code GLOB '[A-Z0-9_]*' AND length(failure_code) BETWEEN 1 AND 64)),
  failure_reason        TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 1000),
  paid_at               TEXT,
  cancelled_at          TEXT,
  cancel_reason         TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 1000),
  journal_id            TEXT UNIQUE REFERENCES journal_entries (id) ON DELETE RESTRICT,
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (approved_by_user_id IS NULL OR requested_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id),
  CHECK (requested_actor_type = 'SYSTEM' OR requested_by_user_id IS NOT NULL),
  CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  CHECK (status NOT IN ('APPROVED','PROCESSING','PAID') OR approved_at IS NOT NULL),
  CHECK (status NOT IN ('REQUESTED','ELIGIBILITY_CHECK','UNDER_REVIEW') OR approved_at IS NULL),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL),
  CHECK (journal_id IS NULL OR status = 'PAID'),
  CHECK ((period_start IS NULL) = (period_end IS NULL)),
  CHECK (period_start IS NULL OR period_start <= period_end)
);

CREATE INDEX IF NOT EXISTS ix_payouts_org_status ON payouts (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_payouts_status ON payouts (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payouts_provider_reference ON payouts (provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- A payout is always in its method's currency and the method belongs to the same org (no cross-currency / cross-tenant rows).
CREATE TRIGGER IF NOT EXISTS trg_payouts_method_guard
BEFORE INSERT ON payouts
BEGIN
  SELECT CASE
    WHEN (SELECT id FROM payout_methods WHERE id = NEW.payout_method_id) IS NULL
      THEN RAISE(ABORT, 'PAYOUT_METHOD_MISSING')
    WHEN (SELECT organization_id FROM payout_methods WHERE id = NEW.payout_method_id) <> NEW.organization_id
      THEN RAISE(ABORT, 'PAYOUT_METHOD_ORG_MISMATCH')
    WHEN (SELECT currency FROM payout_methods WHERE id = NEW.payout_method_id) <> NEW.currency
      THEN RAISE(ABORT, 'PAYOUT_METHOD_CURRENCY_MISMATCH')
  END;
END;

-- Money and identity are frozen once written (§66 immutable internal id).
CREATE TRIGGER IF NOT EXISTS trg_payouts_frozen_money
BEFORE UPDATE OF id, organization_id, payout_method_id, amount_minor, currency, idempotency_key, requested_by_user_id, requested_actor_type, created_at
ON payouts
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_IMMUTABLE');
END;

-- Terminal states are final.
CREATE TRIGGER IF NOT EXISTS trg_payouts_terminal
BEFORE UPDATE ON payouts
WHEN OLD.status IN ('PAID','CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_FINAL');
END;

-- The provider reference, once known, never changes (a retry must observe the same reference).
CREATE TRIGGER IF NOT EXISTS trg_payouts_provider_reference_frozen
BEFORE UPDATE OF provider, provider_reference ON payouts
WHEN OLD.provider_reference IS NOT NULL
 AND (NEW.provider_reference IS NOT OLD.provider_reference OR NEW.provider IS NOT OLD.provider)
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_PROVIDER_REFERENCE_IMMUTABLE');
END;

-- Only the §65 edges are legal; everything else aborts at the database.
CREATE TRIGGER IF NOT EXISTS trg_payouts_legal_transition
BEFORE UPDATE OF status ON payouts
WHEN NEW.status <> OLD.status
 AND NOT (
      (OLD.status = 'REQUESTED'         AND NEW.status IN ('ELIGIBILITY_CHECK','CANCELLED'))
   OR (OLD.status = 'ELIGIBILITY_CHECK' AND NEW.status IN ('UNDER_REVIEW','FAILED','CANCELLED'))
   OR (OLD.status = 'UNDER_REVIEW'      AND NEW.status IN ('APPROVED','CANCELLED'))
   OR (OLD.status = 'APPROVED'          AND NEW.status IN ('PROCESSING','CANCELLED'))
   OR (OLD.status = 'PROCESSING'        AND NEW.status IN ('PAID','FAILED'))
   OR (OLD.status = 'FAILED'            AND NEW.status IN ('PROCESSING','CANCELLED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_payouts_no_delete
BEFORE DELETE ON payouts
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- payout_status_history — INSERT-only timeline of every payout status change (§115).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_status_history (
  id              TEXT PRIMARY KEY,
  payout_id       TEXT NOT NULL REFERENCES payouts (id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_status     TEXT CHECK (from_status IS NULL OR from_status IN ('REQUESTED','ELIGIBILITY_CHECK','UNDER_REVIEW','APPROVED','PROCESSING','PAID','FAILED','CANCELLED')),
  to_status       TEXT NOT NULL CHECK (to_status IN ('REQUESTED','ELIGIBILITY_CHECK','UNDER_REVIEW','APPROVED','PROCESSING','PAID','FAILED','CANCELLED')),
  actor_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL','PROVIDER')),
  reason_code     TEXT CHECK (reason_code IS NULL OR (reason_code GLOB '[A-Z0-9_]*' AND length(reason_code) BETWEEN 1 AND 64)),
  note            TEXT CHECK (note IS NULL OR length(note) <= 1000),
  request_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_payout_status_history_payout ON payout_status_history (payout_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_payout_status_history_no_update
BEFORE UPDATE ON payout_status_history
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_STATUS_HISTORY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_status_history_no_delete
BEFORE DELETE ON payout_status_history
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_STATUS_HISTORY_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- payout_attempts — INSERT-only record of every call made to a payment
-- provider for a payout (§66 "failed payout → recoverable"). Attempt numbers
-- are unique per payout; the provider's reference is recorded per attempt so
-- a retry that returns the SAME reference is visibly a replay, not a second
-- payment. Raw provider payloads are never stored — only a hash + codes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payout_attempts (
  id                    TEXT PRIMARY KEY,
  payout_id             TEXT NOT NULL REFERENCES payouts (id) ON DELETE RESTRICT,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  attempt_number        INTEGER NOT NULL CHECK (attempt_number >= 1),
  provider              TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_idempotency_key TEXT NOT NULL CHECK (length(provider_idempotency_key) BETWEEN 1 AND 256),
  provider_reference    TEXT CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 256),
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  outcome               TEXT NOT NULL CHECK (outcome IN ('SUBMITTED','ACCEPTED','SUCCEEDED','FAILED','TIMEOUT','REJECTED')),
  response_code         TEXT CHECK (response_code IS NULL OR length(response_code) <= 64),
  error_code            TEXT CHECK (error_code IS NULL OR (error_code GLOB '[A-Z0-9_]*' AND length(error_code) BETWEEN 1 AND 64)),
  error_message         TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),
  request_hash          TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('PLATFORM','SYSTEM','INTERNAL')),
  actor_user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (payout_id, attempt_number),
  UNIQUE (provider, provider_idempotency_key, attempt_number),
  CHECK (outcome NOT IN ('FAILED','TIMEOUT','REJECTED') OR error_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_payout_attempts_payout ON payout_attempts (payout_id, attempt_number);

-- An attempt always carries its payout's money (no retry can change the amount) and org.
CREATE TRIGGER IF NOT EXISTS trg_payout_attempts_payout_guard
BEFORE INSERT ON payout_attempts
BEGIN
  SELECT CASE
    WHEN (SELECT id FROM payouts WHERE id = NEW.payout_id) IS NULL
      THEN RAISE(ABORT, 'PAYOUT_MISSING')
    WHEN (SELECT organization_id FROM payouts WHERE id = NEW.payout_id) <> NEW.organization_id
      THEN RAISE(ABORT, 'PAYOUT_ATTEMPT_ORG_MISMATCH')
    WHEN (SELECT amount_minor FROM payouts WHERE id = NEW.payout_id) <> NEW.amount_minor
      OR (SELECT currency FROM payouts WHERE id = NEW.payout_id) <> NEW.currency
      THEN RAISE(ABORT, 'PAYOUT_ATTEMPT_MONEY_MISMATCH')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_attempts_no_update
BEFORE UPDATE ON payout_attempts
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_ATTEMPTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_attempts_no_delete
BEFORE DELETE ON payout_attempts
BEGIN
  SELECT RAISE(ABORT, 'PAYOUT_ATTEMPTS_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- Permissions (PRD §10/§11). payouts.read/review/approve/release exist since
-- 0004. Phase 5 Unit 7 adds:
--   billing.read     — view an advertiser's funding position and alerts
--   billing.manage   — change funding model / credit limits / statuses and
--                      record deposits & invoices (network finance only)
--   payouts.request  — an affiliate asks for a payout of its own balance
-- Ids continue after 0010's last id (…001117).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001118', 'billing.read',    'billing', 'read',    'View advertiser funding, billing status and funding alerts'),
  ('00000000-0000-4000-8000-000000001119', 'billing.manage',  'billing', 'manage',  'Manage advertiser funding model, credit limits, deposits and billing status'),
  ('00000000-0000-4000-8000-000000001120', 'payouts.request', 'payouts', 'request', 'Request a payout of the organization''s own available balance');

-- Network roles: finance owns billing management; analysts/support read.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('SUPER_ADMIN','OPERATIONS_ADMIN','FINANCE_MANAGER')
   AND p.key IN ('billing.read','billing.manage','payouts.request');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ANALYST','SUPPORT_AGENT')
   AND p.key IN ('billing.read');

-- Advertiser tenant roles read their own funding position (never manage it).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN','BILLING_MANAGER')
   AND p.key IN ('billing.read');

-- Affiliate owners/managers may request a payout of their own balance.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('AFFILIATE_OWNER','AFFILIATE_MANAGER')
   AND p.key IN ('payouts.request');
