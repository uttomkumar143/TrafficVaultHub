-- 0012_api_webhooks_notifications_support.sql
-- Phase 6 Unit 8 — API keys (PRD §76), webhook subscriptions / events /
-- deliveries / attempts (PRD §73–§75), notifications + per-user preferences
-- (PRD §79–§80), support tickets with restricted agent tenant access (PRD §81),
-- disputes with evidence + decisions (PRD §82) and appeals with audited
-- decisions (PRD §83).
-- ADDITIVE ONLY: no table created in 0001–0011 is rebuilt, altered or dropped.
--
-- SECRETS: an API key is stored as a SHA-256 HASH of the secret plus a 4-char
-- hint and a public lookup prefix — the plaintext is returned exactly once at
-- creation and is unrecoverable afterwards (PRD §76, §117). A webhook
-- subscription secret must be RECOVERABLE (we sign outbound payloads with it)
-- so it is stored AES-256-GCM wrapped under the Worker master key, the same
-- vault scheme as advertiser_postback_secrets (0008). No plaintext secret is
-- ever written to any table in this file.
--
-- APPEND-ONLY: webhook_events, webhook_delivery_attempts, support_ticket_
-- messages, support_ticket_events, dispute_evidence, dispute_decisions and
-- appeal_decisions can never be UPDATEd or DELETEd. api_keys, webhook_
-- subscriptions, webhook_deliveries, support_tickets, disputes and appeals
-- can never be deleted and have frozen identity columns.
--
-- Money appearing here (disputed amounts) is INTEGER minor units + ISO-4217
-- alpha-3 currency, never floats (PRD §56).
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- API KEYS (PRD §76): create, rotate, revoke, expire, scope, last_used.
--   key_prefix   public, non-secret lookup id embedded in the presented key
--                (`tvh_<prefix>_<secret>`); UNIQUE so lookup is O(1).
--   key_hash     hex SHA-256 of the secret part; compared constant-time in code.
--   scopes       JSON array of permission keys the key may exercise — always a
--                SUBSET of the creating user's permissions (enforced in service).
--   status       ACTIVE → ROTATED (superseded by rotated_to_key_id, still valid
--                until expires_at grace) | REVOKED | EXPIRED. Terminal:
--                REVOKED, EXPIRED.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  key_prefix            TEXT NOT NULL UNIQUE CHECK (length(key_prefix) BETWEEN 8 AND 16),
  key_hash              TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  secret_hint           TEXT NOT NULL CHECK (length(secret_hint) = 4),
  scopes                TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','REVOKED','EXPIRED')),
  expires_at            TEXT,
  last_used_at          TEXT,
  rotated_from_key_id   TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
  rotated_to_key_id     TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
  revoked_at            TEXT,
  revoked_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'ROTATED') = (rotated_to_key_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_api_keys_org_status ON api_keys (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_api_keys_expires ON api_keys (expires_at) WHERE expires_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_frozen
BEFORE UPDATE OF id, organization_id, created_by_user_id, key_prefix, key_hash, secret_hint, rotated_from_key_id, created_at ON api_keys
BEGIN
  SELECT RAISE(ABORT, 'API_KEY_IMMUTABLE');
END;

-- REVOKED / EXPIRED are final (no column may change afterwards).
CREATE TRIGGER IF NOT EXISTS trg_api_keys_terminal
BEFORE UPDATE ON api_keys
WHEN OLD.status IN ('REVOKED','EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'API_KEY_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_legal_transition
BEFORE UPDATE OF status ON api_keys
WHEN NEW.status <> OLD.status
 AND OLD.status NOT IN ('REVOKED','EXPIRED')
 AND NOT (
      (OLD.status = 'ACTIVE'  AND NEW.status IN ('ROTATED','REVOKED','EXPIRED'))
   OR (OLD.status = 'ROTATED' AND NEW.status IN ('REVOKED','EXPIRED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'API_KEY_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_no_delete
BEFORE DELETE ON api_keys
BEGIN
  SELECT RAISE(ABORT, 'API_KEY_IMMUTABLE');
END;

-- ===========================================================================
-- WEBHOOKS (PRD §73–§75)
-- ===========================================================================

-- webhook_subscriptions — a tenant endpoint that receives signed events.
--   secret_ciphertext/key_version/secret_hint follow the 0008 vault scheme.
--   event_types   JSON array of PRD §79 event names ('*' = all).
--   status        ACTIVE | PAUSED (operator/tenant pause, deliveries queue) |
--                 DISABLED (terminal — e.g. after endpoint verification failure).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  url                     TEXT NOT NULL CHECK (url LIKE 'https://%' AND length(url) <= 2048),
  description             TEXT CHECK (description IS NULL OR length(description) <= 500),
  event_types             TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(event_types) AND json_type(event_types) = 'array'),
  secret_ciphertext       TEXT NOT NULL,
  key_version             TEXT NOT NULL,
  secret_hint             TEXT NOT NULL CHECK (length(secret_hint) = 4),
  secret_rotated_at       TEXT,
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','DISABLED')),
  consecutive_failures    INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_at             TEXT,
  disabled_reason         TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'DISABLED') = (disabled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_webhook_subscriptions_org_status ON webhook_subscriptions (organization_id, status, created_at);

CREATE TRIGGER IF NOT EXISTS trg_webhook_subscriptions_frozen
BEFORE UPDATE OF id, organization_id, created_by_user_id, created_at ON webhook_subscriptions
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_SUBSCRIPTION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_subscriptions_terminal
BEFORE UPDATE OF status ON webhook_subscriptions
WHEN OLD.status = 'DISABLED' AND NEW.status <> 'DISABLED'
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_SUBSCRIPTION_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_subscriptions_no_delete
BEFORE DELETE ON webhook_subscriptions
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_SUBSCRIPTION_IMMUTABLE');
END;

-- webhook_events — the immutable fact being delivered. `id` IS the event id
-- that travels in every payload and header; a replay (§75) reuses this id so a
-- receiver can deduplicate. `idempotency_key` stops producers (e.g. a retried
-- state transition) from emitting the same business event twice.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'offer_status_changed','conversion_updated','payout_status_changed','billing_alert',
                      'compliance_action','security_event','tracking_issue')),
  payload           TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  reference_type    TEXT,
  reference_id      TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_webhook_events_org_type ON webhook_events (organization_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS ix_webhook_events_reference ON webhook_events (reference_type, reference_id);

CREATE TRIGGER IF NOT EXISTS trg_webhook_events_no_update
BEFORE UPDATE ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_EVENTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_events_no_delete
BEFORE DELETE ON webhook_events
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_EVENTS_APPEND_ONLY');
END;

-- webhook_deliveries — ONE row per (subscription, event). This uniqueness is
-- what makes replay idempotent in effect: replaying re-queues THIS row (with
-- the same event id) instead of creating a second delivery, and a DELIVERED
-- row is never re-queued.
--   QUEUED → DELIVERING → DELIVERED
--   DELIVERING → RETRY → DELIVERING …   RETRY → DEAD_LETTER (max_attempts)
--   RETRY | DEAD_LETTER → QUEUED        (operator replay only, §75)
--   DELIVERED is terminal.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  subscription_id       TEXT NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  event_id              TEXT NOT NULL REFERENCES webhook_events (id) ON DELETE RESTRICT,
  status                TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DELIVERING','DELIVERED','RETRY','DEAD_LETTER')),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  replay_count          INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  next_attempt_at       TEXT,
  last_attempt_at       TEXT,
  last_response_status  INTEGER,
  last_error_code       TEXT,
  delivered_at          TEXT,
  dead_lettered_at      TEXT,
  last_replayed_at      TEXT,
  last_replayed_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (subscription_id, event_id),
  CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK (status <> 'DEAD_LETTER' OR dead_lettered_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_org_status ON webhook_deliveries (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_event ON webhook_deliveries (event_id);

-- The subscription and the event must belong to the same tenant as the delivery.
CREATE TRIGGER IF NOT EXISTS trg_webhook_deliveries_tenant_guard
BEFORE INSERT ON webhook_deliveries
BEGIN
  SELECT CASE
    WHEN (SELECT organization_id FROM webhook_subscriptions WHERE id = NEW.subscription_id) IS NOT NEW.organization_id
      THEN RAISE(ABORT, 'WEBHOOK_DELIVERY_SUBSCRIPTION_ORG_MISMATCH')
    WHEN (SELECT organization_id FROM webhook_events WHERE id = NEW.event_id) IS NOT NEW.organization_id
      THEN RAISE(ABORT, 'WEBHOOK_DELIVERY_EVENT_ORG_MISMATCH')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_deliveries_frozen
BEFORE UPDATE OF id, organization_id, subscription_id, event_id, created_at ON webhook_deliveries
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_deliveries_terminal
BEFORE UPDATE OF status ON webhook_deliveries
WHEN OLD.status = 'DELIVERED' AND NEW.status <> 'DELIVERED'
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_deliveries_legal_transition
BEFORE UPDATE OF status ON webhook_deliveries
WHEN NEW.status <> OLD.status
 AND OLD.status <> 'DELIVERED'
 AND NOT (
      (OLD.status = 'QUEUED'      AND NEW.status IN ('DELIVERING'))
   OR (OLD.status = 'DELIVERING'  AND NEW.status IN ('DELIVERED','RETRY','DEAD_LETTER'))
   OR (OLD.status = 'RETRY'       AND NEW.status IN ('DELIVERING','DEAD_LETTER','QUEUED'))
   OR (OLD.status = 'DEAD_LETTER' AND NEW.status IN ('QUEUED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_deliveries_no_delete
BEFORE DELETE ON webhook_deliveries
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_IMMUTABLE');
END;

-- webhook_delivery_attempts — INSERT-only delivery log (§74 "delivery logs").
--   signed_at   the timestamp that went into the signature of this attempt
--   is_replay   1 when the attempt was triggered by an operator replay
CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id                    TEXT PRIMARY KEY,
  delivery_id           TEXT NOT NULL REFERENCES webhook_deliveries (id) ON DELETE RESTRICT,
  attempt_number        INTEGER NOT NULL CHECK (attempt_number >= 1),
  signed_at             TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  finished_at           TEXT,
  outcome               TEXT NOT NULL CHECK (outcome IN ('SUCCESS','HTTP_ERROR','NETWORK_ERROR','TIMEOUT','SIGNING_ERROR')),
  response_status       INTEGER,
  error_code            TEXT,
  is_replay             INTEGER NOT NULL DEFAULT 0 CHECK (is_replay IN (0, 1)),
  triggered_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS ix_webhook_delivery_attempts_delivery ON webhook_delivery_attempts (delivery_id, attempt_number);

CREATE TRIGGER IF NOT EXISTS trg_webhook_delivery_attempts_no_update
BEFORE UPDATE ON webhook_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_ATTEMPTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_delivery_attempts_no_delete
BEFORE DELETE ON webhook_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'WEBHOOK_DELIVERY_ATTEMPTS_APPEND_ONLY');
END;

-- ===========================================================================
-- NOTIFICATIONS (PRD §79–§80)
-- ===========================================================================

-- notifications — one row per (recipient, channel) fan-out of an event.
--   user_id NULL  = organization-wide in-app notice (every member sees it)
--   dedupe_key    producer-supplied, UNIQUE: the same event never notifies twice
--   status        PENDING → SENT | FAILED | SUPPRESSED (by preference)
CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'offer_status_changed','conversion_updated','payout_status_changed','billing_alert',
                      'compliance_action','security_event','tracking_issue')),
  channel           TEXT NOT NULL CHECK (channel IN ('IN_APP','EMAIL','WEBHOOK')),
  severity          TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body              TEXT NOT NULL CHECK (length(body) <= 4000),
  payload           TEXT CHECK (payload IS NULL OR (json_valid(payload) AND json_type(payload) = 'object')),
  reference_type    TEXT,
  reference_id      TEXT,
  dedupe_key        TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SUPPRESSED')),
  sent_at           TEXT,
  read_at           TEXT,
  error_code        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_notifications_recipient ON notifications (organization_id, user_id, channel, created_at);
CREATE INDEX IF NOT EXISTS ix_notifications_unread ON notifications (user_id, read_at) WHERE channel = 'IN_APP';
CREATE INDEX IF NOT EXISTS ix_notifications_pending ON notifications (status, channel, created_at) WHERE status = 'PENDING';

CREATE TRIGGER IF NOT EXISTS trg_notifications_frozen
BEFORE UPDATE OF id, organization_id, user_id, event_type, channel, severity, title, body, payload, reference_type, reference_id, dedupe_key, created_at
ON notifications
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_notifications_no_delete
BEFORE DELETE ON notifications
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_IMMUTABLE');
END;

-- notification_preferences — per user, per org, per event, per channel.
-- Absence of a row means the channel default (enabled). Security-critical
-- events (security_event, compliance_action) can NEVER be disabled on the
-- IN_APP channel (PRD §80 "cannot always be disabled") — enforced here so no
-- code path can bypass it.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL CHECK (event_type IN (
                      'offer_status_changed','conversion_updated','payout_status_changed','billing_alert',
                      'compliance_action','security_event','tracking_issue')),
  channel           TEXT NOT NULL CHECK (channel IN ('IN_APP','EMAIL','WEBHOOK')),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, organization_id, event_type, channel),
  CHECK (NOT (enabled = 0 AND channel = 'IN_APP' AND event_type IN ('security_event','compliance_action')))
);

CREATE INDEX IF NOT EXISTS ix_notification_preferences_user ON notification_preferences (user_id, organization_id);

-- ===========================================================================
-- SUPPORT (PRD §81)
-- ===========================================================================

-- support_agent_tenant_access — the restricted tenant access of a platform
-- support agent. An agent may only read/handle tickets of organizations
-- listed here with an unexpired, unrevoked grant. Tenant members never need a
-- row (they see their own organization's tickets through membership).
CREATE TABLE IF NOT EXISTS support_agent_tenant_access (
  agent_user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  granted_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason              TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  expires_at          TEXT,
  revoked_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_user_id, organization_id)
);

CREATE INDEX IF NOT EXISTS ix_support_agent_tenant_access_org ON support_agent_tenant_access (organization_id, revoked_at);

-- support_tickets — OPEN → IN_PROGRESS → WAITING_FOR_USER → WAITING_INTERNAL → RESOLVED → CLOSED
-- (plus the loop-backs a real desk needs: waiting states return to
-- IN_PROGRESS, RESOLVED may re-open to IN_PROGRESS; CLOSED is terminal).
CREATE TABLE IF NOT EXISTS support_tickets (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by_user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  assigned_agent_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  category                TEXT NOT NULL CHECK (category IN ('GENERAL','ACCOUNT','TRACKING','OFFER','CONVERSION','PAYOUT','BILLING','TECHNICAL','COMPLIANCE')),
  priority                TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  subject                 TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status                  TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_FOR_USER','WAITING_INTERNAL','RESOLVED','CLOSED')),
  reference_type          TEXT,
  reference_id            TEXT,
  first_response_at       TEXT,
  resolved_at             TEXT,
  closed_at               TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_support_tickets_org_status ON support_tickets (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_support_tickets_agent ON support_tickets (assigned_agent_user_id, status);

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_frozen
BEFORE UPDATE OF id, organization_id, created_by_user_id, created_at ON support_tickets
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_terminal
BEFORE UPDATE ON support_tickets
WHEN OLD.status = 'CLOSED'
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_legal_transition
BEFORE UPDATE OF status ON support_tickets
WHEN NEW.status <> OLD.status
 AND OLD.status <> 'CLOSED'
 AND NOT (
      (OLD.status = 'OPEN'             AND NEW.status IN ('IN_PROGRESS','CLOSED'))
   OR (OLD.status = 'IN_PROGRESS'      AND NEW.status IN ('WAITING_FOR_USER','WAITING_INTERNAL','RESOLVED'))
   OR (OLD.status = 'WAITING_FOR_USER' AND NEW.status IN ('IN_PROGRESS','WAITING_INTERNAL','RESOLVED','CLOSED'))
   OR (OLD.status = 'WAITING_INTERNAL' AND NEW.status IN ('IN_PROGRESS','WAITING_FOR_USER','RESOLVED'))
   OR (OLD.status = 'RESOLVED'         AND NEW.status IN ('IN_PROGRESS','CLOSED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_no_delete
BEFORE DELETE ON support_tickets
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_IMMUTABLE');
END;

-- support_ticket_messages — INSERT-only thread. is_internal = agent-only notes
-- that are never returned to tenant members.
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id                TEXT PRIMARY KEY,
  ticket_id         TEXT NOT NULL REFERENCES support_tickets (id) ON DELETE RESTRICT,
  author_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  author_type       TEXT NOT NULL CHECK (author_type IN ('REQUESTER','AGENT','SYSTEM')),
  body              TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  is_internal       INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (NOT (is_internal = 1 AND author_type = 'REQUESTER'))
);

CREATE INDEX IF NOT EXISTS ix_support_ticket_messages_ticket ON support_ticket_messages (ticket_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_support_ticket_messages_no_update
BEFORE UPDATE ON support_ticket_messages
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_MESSAGES_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_ticket_messages_no_delete
BEFORE DELETE ON support_ticket_messages
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_MESSAGES_APPEND_ONLY');
END;

-- support_ticket_events — INSERT-only status/assignment timeline.
CREATE TABLE IF NOT EXISTS support_ticket_events (
  id                TEXT PRIMARY KEY,
  ticket_id         TEXT NOT NULL REFERENCES support_tickets (id) ON DELETE RESTRICT,
  event_type        TEXT NOT NULL CHECK (event_type IN ('CREATED','STATUS_CHANGED','ASSIGNED','UNASSIGNED','PRIORITY_CHANGED')),
  from_status       TEXT,
  to_status         TEXT,
  actor_user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  metadata          TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_support_ticket_events_ticket ON support_ticket_events (ticket_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_support_ticket_events_no_update
BEFORE UPDATE ON support_ticket_events
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_EVENTS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_support_ticket_events_no_delete
BEFORE DELETE ON support_ticket_events
BEGIN
  SELECT RAISE(ABORT, 'SUPPORT_TICKET_EVENTS_APPEND_ONLY');
END;

-- ===========================================================================
-- DISPUTES (PRD §82)
-- ===========================================================================

-- disputes — raised by a tenant about one subject record.
--   category   CONVERSION | TRACKING | COMMISSION | PAYOUT | BILLING | TRAFFIC | OFFER | COMPLIANCE
--   status     OPEN → UNDER_REVIEW → DECIDED ; OPEN | UNDER_REVIEW → WITHDRAWN. DECIDED/WITHDRAWN terminal.
--   amount     optional disputed amount, integer minor units + currency (both or neither)
CREATE TABLE IF NOT EXISTS disputes (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  raised_by_user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  assigned_to_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  category              TEXT NOT NULL CHECK (category IN ('CONVERSION','TRACKING','COMMISSION','PAYOUT','BILLING','TRAFFIC','OFFER','COMPLIANCE')),
  subject_type          TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 60),
  subject_id            TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 120),
  title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description           TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 10000),
  disputed_amount_minor INTEGER CHECK (disputed_amount_minor IS NULL OR disputed_amount_minor > 0),
  currency              TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  status                TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','DECIDED','WITHDRAWN')),
  decided_at            TEXT,
  withdrawn_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((disputed_amount_minor IS NULL) = (currency IS NULL)),
  CHECK ((status = 'DECIDED') = (decided_at IS NOT NULL)),
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_disputes_org_status ON disputes (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_disputes_subject ON disputes (subject_type, subject_id);
-- One open dispute per subject per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_disputes_open_subject
  ON disputes (organization_id, subject_type, subject_id)
  WHERE status IN ('OPEN','UNDER_REVIEW');

CREATE TRIGGER IF NOT EXISTS trg_disputes_frozen
BEFORE UPDATE OF id, organization_id, raised_by_user_id, category, subject_type, subject_id, disputed_amount_minor, currency, created_at ON disputes
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_disputes_terminal
BEFORE UPDATE ON disputes
WHEN OLD.status IN ('DECIDED','WITHDRAWN')
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_disputes_legal_transition
BEFORE UPDATE OF status ON disputes
WHEN NEW.status <> OLD.status
 AND OLD.status NOT IN ('DECIDED','WITHDRAWN')
 AND NOT (
      (OLD.status = 'OPEN'         AND NEW.status IN ('UNDER_REVIEW','WITHDRAWN'))
   OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('DECIDED','WITHDRAWN'))
 )
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_disputes_no_delete
BEFORE DELETE ON disputes
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_IMMUTABLE');
END;

-- dispute_evidence — INSERT-only. Either side may attach evidence while the
-- dispute is open. `content` is text or an opaque reference (URL / record id /
-- R2 key) — never raw documents.
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id                    TEXT PRIMARY KEY,
  dispute_id            TEXT NOT NULL REFERENCES disputes (id) ON DELETE RESTRICT,
  submitted_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  submitter_side        TEXT NOT NULL CHECK (submitter_side IN ('TENANT','NETWORK')),
  kind                  TEXT NOT NULL CHECK (kind IN ('TEXT','URL','RECORD_REF','FILE_REF')),
  content               TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_dispute_evidence_dispute ON dispute_evidence (dispute_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_dispute_evidence_open_only
BEFORE INSERT ON dispute_evidence
WHEN (SELECT status FROM disputes WHERE id = NEW.dispute_id) NOT IN ('OPEN','UNDER_REVIEW')
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_NOT_OPEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_dispute_evidence_no_update
BEFORE UPDATE ON dispute_evidence
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_EVIDENCE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_dispute_evidence_no_delete
BEFORE DELETE ON dispute_evidence
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_EVIDENCE_APPEND_ONLY');
END;

-- dispute_decisions — INSERT-only. PRD §82: every decision records decision,
-- reason, evidence, actor, timestamp — all NOT NULL here. Exactly one decision
-- per dispute (UNIQUE dispute_id).
CREATE TABLE IF NOT EXISTS dispute_decisions (
  id                TEXT PRIMARY KEY,
  dispute_id        TEXT NOT NULL UNIQUE REFERENCES disputes (id) ON DELETE RESTRICT,
  decision          TEXT NOT NULL CHECK (decision IN ('UPHELD','PARTIALLY_UPHELD','REJECTED')),
  reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  evidence          TEXT NOT NULL CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  actor_user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decided_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS trg_dispute_decisions_no_update
BEFORE UPDATE ON dispute_decisions
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_DECISIONS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_dispute_decisions_no_delete
BEFORE DELETE ON dispute_decisions
BEGIN
  SELECT RAISE(ABORT, 'DISPUTE_DECISIONS_APPEND_ONLY');
END;

-- ===========================================================================
-- APPEALS (PRD §83)
-- ===========================================================================

-- appeals — against account restrictions/suspensions, conversion decisions,
-- payout holds, compliance decisions.
--   status  SUBMITTED → UNDER_REVIEW → DECIDED ; SUBMITTED | UNDER_REVIEW → WITHDRAWN
CREATE TABLE IF NOT EXISTS appeals (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  submitted_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  assigned_to_user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  appeal_type           TEXT NOT NULL CHECK (appeal_type IN ('ACCOUNT_RESTRICTION','ACCOUNT_SUSPENSION','CONVERSION_DECISION','PAYOUT_HOLD','COMPLIANCE_DECISION')),
  subject_type          TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 60),
  subject_id            TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 120),
  grounds               TEXT NOT NULL CHECK (length(grounds) BETWEEN 1 AND 10000),
  status                TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','DECIDED','WITHDRAWN')),
  decided_at            TEXT,
  withdrawn_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'DECIDED') = (decided_at IS NOT NULL)),
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_appeals_org_status ON appeals (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_appeals_subject ON appeals (subject_type, subject_id);
-- One open appeal per subject per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_appeals_open_subject
  ON appeals (organization_id, appeal_type, subject_type, subject_id)
  WHERE status IN ('SUBMITTED','UNDER_REVIEW');

CREATE TRIGGER IF NOT EXISTS trg_appeals_frozen
BEFORE UPDATE OF id, organization_id, submitted_by_user_id, appeal_type, subject_type, subject_id, grounds, created_at ON appeals
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_appeals_terminal
BEFORE UPDATE ON appeals
WHEN OLD.status IN ('DECIDED','WITHDRAWN')
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_FINAL');
END;

CREATE TRIGGER IF NOT EXISTS trg_appeals_legal_transition
BEFORE UPDATE OF status ON appeals
WHEN NEW.status <> OLD.status
 AND OLD.status NOT IN ('DECIDED','WITHDRAWN')
 AND NOT (
      (OLD.status = 'SUBMITTED'    AND NEW.status IN ('UNDER_REVIEW','WITHDRAWN'))
   OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('DECIDED','WITHDRAWN'))
 )
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_ILLEGAL_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS trg_appeals_no_delete
BEFORE DELETE ON appeals
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_IMMUTABLE');
END;

-- appeal_decisions — INSERT-only, one per appeal; outcome + reason + actor +
-- timestamp are mandatory (PRD §83 "outcomes are audited" — the service also
-- writes an audit_logs row in the same batch).
CREATE TABLE IF NOT EXISTS appeal_decisions (
  id                TEXT PRIMARY KEY,
  appeal_id         TEXT NOT NULL UNIQUE REFERENCES appeals (id) ON DELETE RESTRICT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','PARTIALLY_ACCEPTED','REJECTED')),
  reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  evidence          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  actor_user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decided_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS trg_appeal_decisions_no_update
BEFORE UPDATE ON appeal_decisions
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_DECISIONS_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_appeal_decisions_no_delete
BEFORE DELETE ON appeal_decisions
BEGIN
  SELECT RAISE(ABORT, 'APPEAL_DECISIONS_APPEND_ONLY');
END;

-- ===========================================================================
-- Permissions (PRD §10/§11). Ids continue after 0011's last id (…001120).
--   api_keys.read / api_keys.manage       — tenant self-service (owner/admin)
--   webhooks.read / webhooks.manage       — tenant self-service (owner/admin)
--   webhooks.replay                       — PLATFORM operators only (§75)
--   notifications.read                    — every tenant role (own in-app feed)
--   support.read / support.create         — tenant roles: own org's tickets
--   support.manage                        — SUPPORT_AGENT/OPERATIONS_ADMIN/SUPER_ADMIN
--                                           (tenant-restricted via support_agent_tenant_access)
--   disputes.read / disputes.create       — tenant owner/admin/manager roles
--   disputes.manage                       — PLATFORM: assign/review/decide
--   appeals.read / appeals.create         — tenant owner/admin roles
--   appeals.manage                        — PLATFORM: COMPLIANCE_MANAGER/OPERATIONS_ADMIN/SUPER_ADMIN
-- ===========================================================================
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001121', 'api_keys.read',       'api_keys',      'read',   'List API keys (never the secret) of the organization'),
  ('00000000-0000-4000-8000-000000001122', 'api_keys.manage',     'api_keys',      'manage', 'Create, rotate and revoke API keys of the organization'),
  ('00000000-0000-4000-8000-000000001123', 'webhooks.read',       'webhooks',      'read',   'View webhook subscriptions and delivery logs'),
  ('00000000-0000-4000-8000-000000001124', 'webhooks.manage',     'webhooks',      'manage', 'Create, update, pause and rotate webhook subscriptions'),
  ('00000000-0000-4000-8000-000000001125', 'webhooks.replay',     'webhooks',      'replay', 'Replay a failed webhook delivery by its original event id'),
  ('00000000-0000-4000-8000-000000001126', 'notifications.read',  'notifications', 'read',   'Read own in-app notifications and manage own preferences'),
  ('00000000-0000-4000-8000-000000001127', 'support.read',        'support',       'read',   'View support tickets of the organization'),
  ('00000000-0000-4000-8000-000000001128', 'support.create',      'support',       'create', 'Open support tickets and reply as the requester'),
  ('00000000-0000-4000-8000-000000001129', 'support.manage',      'support',       'manage', 'Work tickets as an agent within granted tenant access'),
  ('00000000-0000-4000-8000-000000001130', 'disputes.read',       'disputes',      'read',   'View disputes of the organization'),
  ('00000000-0000-4000-8000-000000001131', 'disputes.create',     'disputes',      'create', 'Raise disputes and attach evidence'),
  ('00000000-0000-4000-8000-000000001132', 'disputes.manage',     'disputes',      'manage', 'Review and decide disputes for the network'),
  ('00000000-0000-4000-8000-000000001133', 'appeals.read',        'appeals',       'read',   'View appeals of the organization'),
  ('00000000-0000-4000-8000-000000001134', 'appeals.create',      'appeals',       'create', 'Submit appeals against restrictions and decisions'),
  ('00000000-0000-4000-8000-000000001135', 'appeals.manage',      'appeals',       'manage', 'Review and decide appeals for the network');

-- Platform: SUPER_ADMIN and OPERATIONS_ADMIN hold everything in this unit.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('SUPER_ADMIN','OPERATIONS_ADMIN')
   AND p.key IN ('api_keys.read','api_keys.manage','webhooks.read','webhooks.manage','webhooks.replay','notifications.read',
                 'support.read','support.create','support.manage','disputes.read','disputes.create','disputes.manage',
                 'appeals.read','appeals.create','appeals.manage');

-- SUPPORT_AGENT: works tickets (restricted by tenant grants), reads disputes/appeals/webhook logs, never decides.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPPORT_AGENT'
   AND p.key IN ('support.read','support.manage','disputes.read','appeals.read','webhooks.read','notifications.read');

-- FINANCE_MANAGER: decides money disputes; reads appeals; reads webhook logs.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'FINANCE_MANAGER'
   AND p.key IN ('disputes.read','disputes.manage','appeals.read','webhooks.read','notifications.read','support.read');

-- COMPLIANCE_MANAGER: decides appeals and disputes; reads support/webhooks.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'COMPLIANCE_MANAGER'
   AND p.key IN ('disputes.read','disputes.manage','appeals.read','appeals.manage','webhooks.read','notifications.read','support.read');

-- ANALYST: read-only.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'ANALYST'
   AND p.key IN ('disputes.read','appeals.read','support.read','webhooks.read','notifications.read');

-- Tenant owners/admins: full self-service on keys, webhooks, support, disputes, appeals (never manage/replay/decide).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN','AFFILIATE_OWNER','AFFILIATE_MANAGER')
   AND p.key IN ('api_keys.read','api_keys.manage','webhooks.read','webhooks.manage','notifications.read',
                 'support.read','support.create','disputes.read','disputes.create','appeals.read','appeals.create');

-- Tenant operational roles: read keys/webhooks, open tickets and disputes, read appeals.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('CAMPAIGN_MANAGER','BILLING_MANAGER','AFFILIATE_USER')
   AND p.key IN ('api_keys.read','webhooks.read','notifications.read','support.read','support.create','disputes.read','disputes.create','appeals.read');

-- VIEWER: own notifications and read-only visibility.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'VIEWER'
   AND p.key IN ('notifications.read','support.read','disputes.read','appeals.read');
