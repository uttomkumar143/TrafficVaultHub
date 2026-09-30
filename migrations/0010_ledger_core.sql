-- 0010_ledger_core.sql
-- Phase 5 Unit 1 — Ledger core: chart of accounts, journals, commissions,
-- adjustments, reserves, financial fail-safe (PRD §56–§61, §114, §131).
-- ADDITIVE ONLY: no table created in 0001–0009 is rebuilt or dropped.
--
-- Money is INTEGER minor units + ISO-4217 alpha-3 currency everywhere. No
-- floats, no cross-currency rows: every entry of a journal carries the
-- journal's currency and must hit an account of the same currency.
--
-- APPEND-ONLY (§57): journal_entries, ledger_entries, commissions,
-- balance_snapshots and financial_processing_errors can never be UPDATEd or
-- DELETEd — BEFORE UPDATE / BEFORE DELETE triggers RAISE(ABORT). A mistake is
-- corrected by a compensating journal (journal_entries.reverses_journal_id),
-- never by editing the posted rows. Balanced journals (Σ debit = Σ credit) are
-- enforced by the pure layer (modules/ledger/journal.ts) before anything is
-- prepared for D1; SQLite has no deferred multi-row constraint for it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ledger_accounts — chart of accounts. One row per (owner org, code, currency).
--   organization_id  the org whose balance the account represents (affiliate,
--                    advertiser, or the PLATFORM org for platform accounts)
--   status           OPEN | CLOSED. Closing is the ONLY permitted update
--                    (status + closed_at); code/currency/type/owner are frozen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  code             TEXT NOT NULL CHECK (code IN ('CASH','ADVERTISER_RECEIVABLE','ADVERTISER_PREPAID','AFFILIATE_PAYABLE',
                                                'PLATFORM_REVENUE','PLATFORM_ADJUSTMENT','PAYOUT_CLEARING','PAYOUT_FEES')),
  account_type     TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','REVENUE','EXPENSE','EQUITY')),
  currency         TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, code, currency),
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_ledger_accounts_org ON ledger_accounts (organization_id, code, currency);

CREATE TRIGGER IF NOT EXISTS trg_ledger_accounts_frozen_columns
BEFORE UPDATE OF id, organization_id, code, account_type, currency, created_at ON ledger_accounts
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ACCOUNT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_accounts_no_reopen
BEFORE UPDATE OF status ON ledger_accounts
WHEN OLD.status = 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ACCOUNT_CLOSED');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_accounts_no_delete
BEFORE DELETE ON ledger_accounts
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ACCOUNT_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- journal_entries — one balanced business event. APPEND-ONLY.
--   organization_id      tenant that owns the business event (the conversion's
--                        advertiser org, the adjustment's org, the payout's
--                        affiliate org)
--   idempotency_key      UNIQUE: retrying the same event can never post twice
--   reverses_journal_id  set on a compensating journal; the original is untouched
--   total_minor          Σ debits (= Σ credits), kept for reporting/reconciliation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  journal_type         TEXT NOT NULL CHECK (journal_type IN ('CONVERSION_COMMISSION','CONVERSION_REVERSAL','ADJUSTMENT',
                                                            'PAYOUT','PAYOUT_REVERSAL','FUNDING','FUNDING_REVERSAL')),
  currency             TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total_minor          INTEGER NOT NULL CHECK (total_minor > 0),
  reference_type       TEXT NOT NULL CHECK (reference_type IN ('CONVERSION','CONVERSION_REVERSAL','FINANCIAL_ADJUSTMENT','PAYOUT','FUNDING')),
  reference_id         TEXT NOT NULL,
  reverses_journal_id  TEXT REFERENCES journal_entries (id) ON DELETE RESTRICT,
  idempotency_key      TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  actor_type           TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL')),
  posted_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  description          TEXT CHECK (description IS NULL OR length(description) <= 500),
  request_id           TEXT,
  posted_at            TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((journal_type IN ('CONVERSION_REVERSAL','PAYOUT_REVERSAL','FUNDING_REVERSAL')) = (reverses_journal_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_journal_entries_org_time  ON journal_entries (organization_id, posted_at);
CREATE INDEX IF NOT EXISTS ix_journal_entries_reference ON journal_entries (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS ix_journal_entries_reverses  ON journal_entries (reverses_journal_id);

CREATE TRIGGER IF NOT EXISTS trg_journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'JOURNAL_ENTRIES_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'JOURNAL_ENTRIES_APPEND_ONLY');
END;

-- A compensating journal must reverse a journal of the same currency and total.
CREATE TRIGGER IF NOT EXISTS trg_journal_entries_reversal_matches
BEFORE INSERT ON journal_entries
WHEN NEW.reverses_journal_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT currency FROM journal_entries WHERE id = NEW.reverses_journal_id) IS NULL
      THEN RAISE(ABORT, 'JOURNAL_REVERSAL_TARGET_MISSING')
    WHEN (SELECT currency FROM journal_entries WHERE id = NEW.reverses_journal_id) <> NEW.currency
      THEN RAISE(ABORT, 'JOURNAL_REVERSAL_CURRENCY_MISMATCH')
    WHEN (SELECT total_minor FROM journal_entries WHERE id = NEW.reverses_journal_id) <> NEW.total_minor
      THEN RAISE(ABORT, 'JOURNAL_REVERSAL_TOTAL_MISMATCH')
    WHEN (SELECT reverses_journal_id FROM journal_entries WHERE id = NEW.reverses_journal_id) IS NOT NULL
      THEN RAISE(ABORT, 'JOURNAL_REVERSAL_OF_REVERSAL')
    WHEN EXISTS (SELECT 1 FROM journal_entries WHERE reverses_journal_id = NEW.reverses_journal_id)
      THEN RAISE(ABORT, 'JOURNAL_ALREADY_REVERSED')
  END;
END;

-- ---------------------------------------------------------------------------
-- ledger_entries — the debit/credit legs of a journal. APPEND-ONLY.
--   amount_minor > 0 always; direction carries the sign.
--   Triggers refuse legs on a CLOSED account and any currency mismatch between
--   leg, account and journal (posting to a closed account is a DB error, not a
--   convention).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id               TEXT PRIMARY KEY,
  journal_id       TEXT NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  account_id       TEXT NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  entry_index      INTEGER NOT NULL CHECK (entry_index >= 0),
  direction        TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  memo             TEXT CHECK (memo IS NULL OR length(memo) <= 200),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (journal_id, entry_index)
);

CREATE INDEX IF NOT EXISTS ix_ledger_entries_account ON ledger_entries (account_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ledger_entries_org     ON ledger_entries (organization_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ENTRIES_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ENTRIES_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_ledger_entries_account_guard
BEFORE INSERT ON ledger_entries
BEGIN
  SELECT CASE
    WHEN (SELECT status FROM ledger_accounts WHERE id = NEW.account_id) IS NULL
      THEN RAISE(ABORT, 'LEDGER_ACCOUNT_MISSING')
    WHEN (SELECT status FROM ledger_accounts WHERE id = NEW.account_id) <> 'OPEN'
      THEN RAISE(ABORT, 'LEDGER_ACCOUNT_NOT_OPEN')
    WHEN (SELECT currency FROM ledger_accounts WHERE id = NEW.account_id) <> NEW.currency
      THEN RAISE(ABORT, 'LEDGER_ENTRY_ACCOUNT_CURRENCY_MISMATCH')
    WHEN (SELECT currency FROM journal_entries WHERE id = NEW.journal_id) <> NEW.currency
      THEN RAISE(ABORT, 'LEDGER_ENTRY_JOURNAL_CURRENCY_MISMATCH')
  END;
END;

-- ---------------------------------------------------------------------------
-- balance_snapshots — CACHE of Σ credits − Σ debits per account at a point in
-- time. Balances are always computable from ledger_entries; a snapshot is
-- never the source of truth. INSERT-only: a newer snapshot supersedes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  organization_id    TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  debit_total_minor  INTEGER NOT NULL CHECK (debit_total_minor >= 0),
  credit_total_minor INTEGER NOT NULL CHECK (credit_total_minor >= 0),
  balance_minor      INTEGER NOT NULL,
  entry_count        INTEGER NOT NULL CHECK (entry_count >= 0),
  last_entry_id      TEXT REFERENCES ledger_entries (id) ON DELETE RESTRICT,
  as_of              TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (balance_minor = credit_total_minor - debit_total_minor)
);

CREATE INDEX IF NOT EXISTS ix_balance_snapshots_account ON balance_snapshots (account_id, as_of);

CREATE TRIGGER IF NOT EXISTS trg_balance_snapshots_no_update
BEFORE UPDATE ON balance_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_SNAPSHOTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_balance_snapshots_no_delete
BEFORE DELETE ON balance_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_SNAPSHOTS_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- commissions — the verified commission record of ONE approved conversion
-- (§58). UNIQUE conversion_id: a duplicate conversion can never earn twice.
-- Amounts are what was RECOMPUTED from the pinned offer version and matched
-- against conversions.commission_amount_minor at posting time. APPEND-ONLY;
-- a reversal is a CONVERSION_REVERSAL journal with reverses_journal_id =
-- commissions.journal_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commissions (
  id                          TEXT PRIMARY KEY,
  organization_id             TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  conversion_id               TEXT NOT NULL UNIQUE REFERENCES conversions (id) ON DELETE RESTRICT,
  affiliate_organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  offer_id                    TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  offer_version_id            TEXT NOT NULL REFERENCES offer_versions (id) ON DELETE RESTRICT,
  payout_type                 TEXT NOT NULL CHECK (payout_type IN ('CPA','CPL','CPC','CPI','CPM','CPS','REVSHARE')),
  currency                    TEXT NOT NULL CHECK (length(currency) = 3),
  affiliate_commission_minor  INTEGER NOT NULL CHECK (affiliate_commission_minor > 0),
  -- Advertiser-side amount is only recorded when it is VERIFIABLE from the
  -- pinned version (fixed payout types). REVSHARE has no fixed advertiser
  -- amount → NULL, and the platform margin is NOT guessed (§131).
  advertiser_payout_minor     INTEGER CHECK (advertiser_payout_minor IS NULL OR advertiser_payout_minor >= affiliate_commission_minor),
  platform_margin_minor       INTEGER CHECK (platform_margin_minor IS NULL OR platform_margin_minor >= 0),
  journal_id                  TEXT NOT NULL UNIQUE REFERENCES journal_entries (id) ON DELETE RESTRICT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((advertiser_payout_minor IS NULL) = (platform_margin_minor IS NULL)),
  CHECK (platform_margin_minor IS NULL OR platform_margin_minor = advertiser_payout_minor - affiliate_commission_minor),
  CHECK (payout_type = 'REVSHARE' OR advertiser_payout_minor IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_commissions_affiliate ON commissions (affiliate_organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_commissions_org       ON commissions (organization_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_commissions_no_update
BEFORE UPDATE ON commissions
BEGIN
  SELECT RAISE(ABORT, 'COMMISSIONS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_commissions_no_delete
BEFORE DELETE ON commissions
BEGIN
  SELECT RAISE(ABORT, 'COMMISSIONS_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- financial_adjustments — manual adjustment workflow (§59). The row is a
-- REQUEST that must be APPROVED by a different user holding ledger.approve
-- before an ADJUSTMENT journal is posted. before_state / after_state are the
-- JSON balances of the target account captured at request and at posting.
-- CHECK: approver ≠ requester; POSTED implies journal_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_adjustments (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  account_id            TEXT NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  counter_account_id    TEXT NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  reason_code           TEXT NOT NULL CHECK (reason_code IN ('BONUS','CORRECTION','CLAWBACK','GOODWILL','FEE','DISPUTE_SETTLEMENT',
                                                            'CHARGEBACK','MANUAL_CORRECTION','OTHER')),
  reason_note           TEXT NOT NULL CHECK (length(reason_note) BETWEEN 1 AND 1000),
  reference_type        TEXT CHECK (reference_type IS NULL OR reference_type IN ('CONVERSION','PAYOUT','FRAUD_CASE','COMPLIANCE_CASE',
                                                                                 'RECONCILIATION_CASE','TICKET','OTHER')),
  reference_id          TEXT,
  status                TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  before_state          TEXT NOT NULL,
  after_state           TEXT,
  requested_by_user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approved_by_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  approval_note         TEXT CHECK (approval_note IS NULL OR length(approval_note) <= 1000),
  approved_at           TEXT,
  posted_at             TEXT,
  journal_id            TEXT UNIQUE REFERENCES journal_entries (id) ON DELETE RESTRICT,
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (account_id <> counter_account_id),
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id),
  CHECK ((status IN ('APPROVED','POSTED')) = (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL AND posted_at IS NOT NULL AND after_state IS NOT NULL)),
  CHECK ((reference_type IS NULL) = (reference_id IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_financial_adjustments_org_status ON financial_adjustments (organization_id, status, created_at);

-- Terminal states are final: no row leaves POSTED / REJECTED / CANCELLED.
CREATE TRIGGER IF NOT EXISTS trg_financial_adjustments_terminal
BEFORE UPDATE OF status ON financial_adjustments
WHEN OLD.status IN ('POSTED','REJECTED','CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_ADJUSTMENT_FINAL');
END;

-- The money of a request is frozen once written: approve/post never change it.
CREATE TRIGGER IF NOT EXISTS trg_financial_adjustments_frozen_money
BEFORE UPDATE OF organization_id, account_id, counter_account_id, direction, amount_minor, currency, requested_by_user_id, before_state
ON financial_adjustments
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_ADJUSTMENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_financial_adjustments_no_delete
BEFORE DELETE ON financial_adjustments
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_ADJUSTMENT_IMMUTABLE');
END;

-- INSERT-only history of every adjustment status change (§115).
CREATE TABLE IF NOT EXISTS financial_adjustment_history (
  id              TEXT PRIMARY KEY,
  adjustment_id   TEXT NOT NULL REFERENCES financial_adjustments (id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_status     TEXT CHECK (from_status IS NULL OR from_status IN ('REQUESTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  to_status       TEXT NOT NULL CHECK (to_status IN ('REQUESTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  actor_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL')),
  note            TEXT CHECK (note IS NULL OR length(note) <= 1000),
  request_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_financial_adjustment_history_adj ON financial_adjustment_history (adjustment_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_financial_adjustment_history_no_update
BEFORE UPDATE ON financial_adjustment_history
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_ADJUSTMENT_HISTORY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_financial_adjustment_history_no_delete
BEFORE DELETE ON financial_adjustment_history
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_ADJUSTMENT_HISTORY_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- reserves — money held back from an org's available balance (§60).
-- Independent from the ledger: available = balance − active holds − active
-- reserves, computed in modules/ledger/reserves.ts. Releasing is the only
-- permitted update (status/released_*), like conversion_holds.
--   organization_id  the org whose available balance is reduced
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserves (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  reserve_type          TEXT NOT NULL CHECK (reserve_type IN ('AFFILIATE','ADVERTISER','CHARGEBACK','RISK')),
  currency              TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED')),
  reason_code           TEXT NOT NULL CHECK (reason_code GLOB '[A-Z0-9_]*' AND length(reason_code) BETWEEN 1 AND 64),
  reference_type        TEXT CHECK (reference_type IS NULL OR reference_type IN ('CONVERSION','PAYOUT','FRAUD_CASE','COMPLIANCE_CASE',
                                                                                 'RECONCILIATION_CASE','FUNDING','OTHER')),
  reference_id          TEXT,
  actor_type            TEXT NOT NULL CHECK (actor_type IN ('TENANT','PLATFORM','SYSTEM','INTERNAL')),
  created_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  released_at           TEXT,
  released_by_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  release_reason        TEXT CHECK (release_reason IS NULL OR length(release_reason) <= 500),
  request_id            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL)),
  CHECK ((reference_type IS NULL) = (reference_id IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_reserves_org_status ON reserves (organization_id, status, currency);

CREATE TRIGGER IF NOT EXISTS trg_reserves_frozen_money
BEFORE UPDATE OF id, organization_id, reserve_type, currency, amount_minor, reason_code, reference_type, reference_id, created_at
ON reserves
BEGIN
  SELECT RAISE(ABORT, 'RESERVE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_reserves_no_reactivate
BEFORE UPDATE OF status ON reserves
WHEN OLD.status = 'RELEASED'
BEGIN
  SELECT RAISE(ABORT, 'RESERVE_ALREADY_RELEASED');
END;

CREATE TRIGGER IF NOT EXISTS trg_reserves_no_delete
BEFORE DELETE ON reserves
BEGIN
  SELECT RAISE(ABORT, 'RESERVE_IMMUTABLE');
END;

-- ---------------------------------------------------------------------------
-- financial_processing_errors — the §131 fail-safe record. When a calculation
-- cannot be verified the ledger posts NOTHING and writes one of these rows
-- instead (reason_code = PostingDecision reject reason). APPEND-ONLY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_processing_errors (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  operation        TEXT NOT NULL CHECK (operation IN ('POST_CONVERSION_COMMISSION','POST_CONVERSION_REVERSAL','POST_ADJUSTMENT',
                                                     'POST_PAYOUT','POST_PAYOUT_REVERSAL','POST_FUNDING','RECONCILE_LEDGER')),
  reference_type   TEXT NOT NULL CHECK (reference_type IN ('CONVERSION','CONVERSION_REVERSAL','FINANCIAL_ADJUSTMENT','PAYOUT','FUNDING',
                                                          'RECONCILIATION_RUN')),
  reference_id     TEXT NOT NULL,
  reason_code      TEXT NOT NULL CHECK (reason_code GLOB '[A-Z0-9_]*' AND length(reason_code) BETWEEN 1 AND 64),
  detail           TEXT,
  request_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_financial_processing_errors_ref ON financial_processing_errors (reference_type, reference_id, created_at);
CREATE INDEX IF NOT EXISTS ix_financial_processing_errors_org ON financial_processing_errors (organization_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_financial_processing_errors_no_update
BEFORE UPDATE ON financial_processing_errors
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_PROCESSING_ERRORS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_financial_processing_errors_no_delete
BEFORE DELETE ON financial_processing_errors
BEGIN
  SELECT RAISE(ABORT, 'FINANCIAL_PROCESSING_ERRORS_APPEND_ONLY');
END;

-- ---------------------------------------------------------------------------
-- Permissions (PRD §10/§11). ledger.read / ledger.adjust exist since 0004.
-- Phase 5 adds the separation-of-duties keys: an adjustment is REQUESTED with
-- ledger.adjust and APPROVED by a DIFFERENT user with ledger.approve;
-- reserves are managed with ledger.reserve. Network-only, never tenant roles.
-- Ids continue after 0009's last id (…001115).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001116', 'ledger.approve', 'ledger', 'approve', 'Approve a requested financial adjustment (must differ from the requester)'),
  ('00000000-0000-4000-8000-000000001117', 'ledger.reserve', 'ledger', 'reserve', 'Place and release balance reserves');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('SUPER_ADMIN','OPERATIONS_ADMIN','FINANCE_MANAGER')
   AND p.key IN ('ledger.approve','ledger.reserve');
