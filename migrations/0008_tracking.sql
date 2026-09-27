-- Migration 0008_tracking — TrafficVaultHub tracking, SmartLinks & attribution
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 3, Unit 8 — Tracking, Attribution & SmartLinks; PRD §31–§36,
-- §39, §42–§46, §92, §93, §107, §115, §129, §130):
--   * tracking_links               — affiliate-owned tracking URL identity for
--                                    ONE offer (PRD §31/§32); the public redirect
--                                    resolves a short `code` to this row
--   * smartlinks                   — affiliate-owned SmartLink identity with a
--                                    routing mode (PRD §43) + versioned routing
--                                    algorithm reference
--   * smartlink_offers             — candidate offer pool per SmartLink with
--                                    weight / priority (RULE_BASED, WEIGHTED …)
--   * clicks                       — one row per accepted click (PRD §32):
--                                    globally unique click_id, sub1–sub5, the
--                                    coarse signals used for eligibility and the
--                                    routing decision that produced the redirect
--   * conversions                  — the conversion record referenced by the
--                                    attribution engine (PRD §33/§37/§39); the
--                                    Phase 4 conversion engine extends it with
--                                    its own tables and never rewrites this one
--   * attributions                 — PRD §36 explainable attribution record
--                                    (attribution_id, conversion_id, click_id,
--                                    rule_version, decision, reason_code, ts)
--   * attribution_policies         — versioned attribution policy per offer
--                                    (PRD §35): window, model, dedup key rule,
--                                    fallback; INSERT-only (a change = new version)
--   * offer_cap_counters           — durable snapshot of the PRD §44 cap
--                                    counters (daily click / daily conversion /
--                                    monthly / total / budget) per offer+period;
--                                    the Durable Object owns the live count and
--                                    flushes here, the row is the persisted truth
--   * postback_nonces              — replay protection for S2S postbacks
--                                    (PRD §74/§115): one row per accepted
--                                    (advertiser, nonce), TTL-bounded
--   * advertiser_postback_secrets  — HMAC-SHA-256 signing keys advertisers use
--                                    to sign S2S postbacks (PRD §101, §115)
--   * permissions                  — tracking.read / tracking.manage,
--                                    attribution.read / attribution.manage
--                                    + role grants
--
-- Additive only. Migrations 0001–0007 are immutable and are NOT modified.
--
-- Privacy (PRD §34): `clicks` stores coarse, non-invasive signals only — ISO
-- country/region, device class, OS family, browser family, language — plus a
-- salted SHA-256 `ip_hash` for deduplication/fraud correlation. The raw IP is
-- NEVER stored in this table; raw-IP access is restricted and audited elsewhere.
-- No canvas/audio/font fingerprinting fields exist by design. sub1–sub5 are
-- opaque affiliate-supplied strings capped at 255 chars; the application must
-- not accept or derive personal data through them.
--
-- Secrets (PRD §101, §76): `advertiser_postback_secrets.secret_ciphertext` holds
-- the HMAC key ENCRYPTED AT REST (AES-GCM under a Worker-held master key, see
-- `key_version`). HMAC verification needs the key material itself, so a one-way
-- hash (as used for session tokens) is not possible here. The plaintext is
-- returned to the advertiser exactly once at creation, is never SELECTed by any
-- list/read route afterwards, and is never logged. `secret_hint` is the last 4
-- chars, for display only.
--
-- Hot path (PRD §107, §129): the public redirect touches at most
-- `tracking_links`/`smartlinks` (via KV cache), `offer_cap_counters` (via DO)
-- and one INSERT into `clicks`. Everything else is queue-driven enrichment.
--
-- Money is ALWAYS integer minor units + 3-letter currency (PRD §25/§14).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- tracking_links — affiliate-owned tracking URL for ONE offer.
-- `organization_id` is the AFFILIATE organization (tenant scope). `code` is the
-- short, URL-safe public identifier the redirect endpoint resolves
-- (`/t/:code`); it is globally unique and never reused. `offer_organization_id`
-- is denormalized so revocation/pause invalidation can fan out by advertiser
-- without a join. Rows are never physically deleted (status ARCHIVED, PRD §95).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_links (
  id                        TEXT PRIMARY KEY,
  organization_id           TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_profile_id      TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  offer_id                  TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  offer_organization_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  traffic_source_id         TEXT REFERENCES affiliate_traffic_sources (id) ON DELETE SET NULL,
  code                      TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 6 AND 32),
  name                      TEXT,
  creative_id               TEXT,
  status                    TEXT NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  -- affiliate-declared defaults appended to every click unless overridden (§32)
  default_sub1              TEXT CHECK (default_sub1 IS NULL OR length(default_sub1) <= 255),
  default_sub2              TEXT CHECK (default_sub2 IS NULL OR length(default_sub2) <= 255),
  default_sub3              TEXT CHECK (default_sub3 IS NULL OR length(default_sub3) <= 255),
  default_sub4              TEXT CHECK (default_sub4 IS NULL OR length(default_sub4) <= 255),
  default_sub5              TEXT CHECK (default_sub5 IS NULL OR length(default_sub5) <= 255),
  archived_at               TEXT,
  created_by_user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_tracking_links_org        ON tracking_links (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_tracking_links_offer      ON tracking_links (offer_id, status);
CREATE INDEX IF NOT EXISTS ix_tracking_links_offer_org  ON tracking_links (offer_organization_id, status);

-- ---------------------------------------------------------------------------
-- smartlinks — affiliate-owned SmartLink (PRD §42/§43). `routing_mode` is one
-- of the PRD §43 modes; `routing_algorithm_version` is the version string of
-- the engine implementation that evaluates this link (recorded on every click
-- decision, PRD §43 "routing algorithm version must be recorded").
-- `fallback_url` is the affiliate's own safe destination used ONLY when no
-- eligible offer exists after failover (PRD §46 — never an inactive offer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smartlinks (
  id                          TEXT PRIMARY KEY,
  organization_id             TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_profile_id        TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  traffic_source_id           TEXT REFERENCES affiliate_traffic_sources (id) ON DELETE SET NULL,
  code                        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 6 AND 32),
  name                        TEXT NOT NULL,
  routing_mode                TEXT NOT NULL DEFAULT 'RULE_BASED'
                              CHECK (routing_mode IN (
                                'RULE_BASED','WEIGHTED','PERFORMANCE_BASED','GEO_BASED','DEVICE_BASED','HYBRID')),
  routing_algorithm_version   TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','PAUSED','ARCHIVED')),
  fallback_url                TEXT,
  archived_at                 TEXT,
  created_by_user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_smartlinks_org    ON smartlinks (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_smartlinks_status ON smartlinks (status);

-- ---------------------------------------------------------------------------
-- smartlink_offers — the candidate offer pool of one SmartLink. `weight`
-- (WEIGHTED/HYBRID) and `priority` (RULE_BASED: lower = tried first) are
-- affiliate-configured hints; eligibility (offer status, access grant,
-- targeting, caps, budget, tracking health, compliance, risk — PRD §42) is
-- ALWAYS re-evaluated by the engine at click time and never stored here.
-- `offer_organization_id` denormalized for invalidation fan-out.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smartlink_offers (
  id                      TEXT PRIMARY KEY,
  smartlink_id            TEXT NOT NULL REFERENCES smartlinks (id) ON DELETE RESTRICT,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  offer_id                TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  offer_organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  weight                  INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 10000),
  priority                INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (smartlink_id, offer_id)
);

CREATE INDEX IF NOT EXISTS ix_smartlink_offers_smartlink ON smartlink_offers (smartlink_id, enabled, priority);
CREATE INDEX IF NOT EXISTS ix_smartlink_offers_offer     ON smartlink_offers (offer_id);
CREATE INDEX IF NOT EXISTS ix_smartlink_offers_org       ON smartlink_offers (organization_id);

-- ---------------------------------------------------------------------------
-- clicks — one row per ACCEPTED click (PRD §32). `id` IS the globally unique
-- click_id handed to the advertiser. Exactly one of `tracking_link_id` /
-- `smartlink_id` is set. `offer_id` / `offer_version_id` record what the
-- visitor was actually routed to (after SmartLink evaluation + failover, §46)
-- so a later conversion references the version current at click time (§23).
-- `organization_id` = affiliate org (tenant scope); `offer_organization_id` =
-- advertiser org (so advertisers can read clicks on their offers).
-- Coarse signals only (§34) — see header. `decision_*` explain the route.
-- INSERT-only: a click is a fact, it is never updated or deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clicks (
  id                          TEXT PRIMARY KEY,
  organization_id             TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_profile_id        TEXT NOT NULL REFERENCES affiliate_profiles (id) ON DELETE RESTRICT,
  tracking_link_id            TEXT REFERENCES tracking_links (id) ON DELETE RESTRICT,
  smartlink_id                TEXT REFERENCES smartlinks (id) ON DELETE RESTRICT,
  offer_id                    TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  offer_version_id            TEXT NOT NULL REFERENCES offer_versions (id) ON DELETE RESTRICT,
  offer_organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  traffic_source_id           TEXT REFERENCES affiliate_traffic_sources (id) ON DELETE SET NULL,
  creative_id                 TEXT,
  -- affiliate-supplied opaque sub IDs (§32), bounded (§34)
  sub1                        TEXT CHECK (sub1 IS NULL OR length(sub1) <= 255),
  sub2                        TEXT CHECK (sub2 IS NULL OR length(sub2) <= 255),
  sub3                        TEXT CHECK (sub3 IS NULL OR length(sub3) <= 255),
  sub4                        TEXT CHECK (sub4 IS NULL OR length(sub4) <= 255),
  sub5                        TEXT CHECK (sub5 IS NULL OR length(sub5) <= 255),
  -- coarse, privacy-preserving signals (§34) — no raw IP, no fingerprint
  country_code                TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
  region_code                 TEXT,
  device_type                 TEXT CHECK (device_type IS NULL OR device_type IN ('DESKTOP','MOBILE','TABLET','TV','OTHER')),
  os_family                   TEXT,
  browser_family              TEXT,
  language                    TEXT CHECK (language IS NULL OR length(language) <= 16),
  ip_hash                     TEXT,
  user_agent_hash             TEXT,
  referrer_host               TEXT,
  -- routing decision (§43 / §46) — explainable, never a black box
  routing_mode                TEXT CHECK (routing_mode IS NULL OR routing_mode IN (
                                'RULE_BASED','WEIGHTED','PERFORMANCE_BASED','GEO_BASED','DEVICE_BASED','HYBRID')),
  routing_algorithm_version   TEXT,
  decision_reason_code        TEXT NOT NULL DEFAULT 'DIRECT',
  failover_from_offer_id      TEXT REFERENCES offers (id) ON DELETE SET NULL,
  destination_url             TEXT NOT NULL,
  request_id                  TEXT,
  clicked_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((tracking_link_id IS NOT NULL) <> (smartlink_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_clicks_org_time        ON clicks (organization_id, clicked_at);
CREATE INDEX IF NOT EXISTS ix_clicks_offer_org_time  ON clicks (offer_organization_id, clicked_at);
CREATE INDEX IF NOT EXISTS ix_clicks_offer_time      ON clicks (offer_id, clicked_at);
CREATE INDEX IF NOT EXISTS ix_clicks_tracking_link   ON clicks (tracking_link_id, clicked_at);
CREATE INDEX IF NOT EXISTS ix_clicks_smartlink       ON clicks (smartlink_id, clicked_at);
CREATE INDEX IF NOT EXISTS ix_clicks_ip_hash_time    ON clicks (ip_hash, clicked_at);

-- ---------------------------------------------------------------------------
-- attribution_policies — VERSIONED attribution policy per offer (PRD §35).
-- INSERT-only: changing a policy inserts version_number+1; `attributions.
-- rule_version` points at the exact policy row that decided, so every decision
-- stays explainable after the policy changes. `organization_id` = advertiser
-- org (owner of the offer). `is_current` marks the active version (exactly one
-- per offer, maintained by the service in the same batch as the insert).
--   model          — LAST_CLICK (default) | FIRST_CLICK
--   window_seconds — click→conversion lookback (defaults to the offer version's
--                    attribution_window_seconds at creation)
--   dedup_scope    — which key set makes two postbacks "the same conversion" (§39)
--   fallback_rule  — what to do when no click matches inside the window
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attribution_policies (
  id                    TEXT PRIMARY KEY,
  offer_id              TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id       TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  version_number        INTEGER NOT NULL CHECK (version_number >= 1),
  is_current            INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  model                 TEXT NOT NULL DEFAULT 'LAST_CLICK' CHECK (model IN ('LAST_CLICK','FIRST_CLICK')),
  window_seconds        INTEGER NOT NULL CHECK (window_seconds > 0),
  dedup_scope           TEXT NOT NULL DEFAULT 'EXTERNAL_CONVERSION_ID'
                        CHECK (dedup_scope IN ('EXTERNAL_CONVERSION_ID','CLICK_ID_EVENT','TRANSACTION_ID')),
  fallback_rule         TEXT NOT NULL DEFAULT 'REJECT'
                        CHECK (fallback_rule IN ('REJECT','HOLD_FOR_REVIEW')),
  require_signature     INTEGER NOT NULL DEFAULT 1 CHECK (require_signature IN (0, 1)),
  change_summary        TEXT,
  created_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, version_number)
);

CREATE INDEX IF NOT EXISTS ix_attribution_policies_offer_current ON attribution_policies (offer_id, is_current);
CREATE INDEX IF NOT EXISTS ix_attribution_policies_org           ON attribution_policies (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- conversions — the conversion record the attribution engine decides about
-- (PRD §33 IDs, §37 initial states, §39 dedup). Created from an S2S postback
-- (or advertiser API in Phase 6). `id` = conversion_id. `click_id` is NULL
-- until attribution assigns one (unattributed rows are kept as evidence, §130
-- "avoid false conversion"). `organization_id` = ADVERTISER org (source of the
-- event, tenant scope); `affiliate_organization_id` is filled by attribution.
-- Only the Phase-3 states are allowed here; Phase 4 extends the CHECK by a new
-- migration when the conversion engine lands (§37 full state machine).
-- Dedup (§39): UNIQUE (organization_id, offer_id, external_conversion_id) —
-- a repeated postback with the same external id never creates a second row.
-- Money: integer minor units + currency (§25); nullable until priced in Phase 4.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversions (
  id                          TEXT PRIMARY KEY,
  organization_id             TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  offer_id                    TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  offer_version_id            TEXT REFERENCES offer_versions (id) ON DELETE RESTRICT,
  click_id                    TEXT REFERENCES clicks (id) ON DELETE RESTRICT,
  affiliate_organization_id   TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  external_conversion_id      TEXT NOT NULL CHECK (length(external_conversion_id) BETWEEN 1 AND 128),
  transaction_id              TEXT CHECK (transaction_id IS NULL OR length(transaction_id) <= 128),
  event_id                    TEXT CHECK (event_id IS NULL OR length(event_id) <= 128),
  conversion_event            TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'RECEIVED'
                              CHECK (status IN ('RECEIVED','VALIDATING','PENDING','REJECTED','FRAUD_REVIEW')),
  source                      TEXT NOT NULL DEFAULT 'S2S_POSTBACK'
                              CHECK (source IN ('S2S_POSTBACK','ADVERTISER_API','MANUAL')),
  sale_amount_minor           INTEGER CHECK (sale_amount_minor IS NULL OR sale_amount_minor >= 0),
  currency                    TEXT CHECK (currency IS NULL OR length(currency) = 3),
  occurred_at                 TEXT NOT NULL,
  received_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_id                  TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, offer_id, external_conversion_id)
);

CREATE INDEX IF NOT EXISTS ix_conversions_org_time       ON conversions (organization_id, received_at);
CREATE INDEX IF NOT EXISTS ix_conversions_affiliate_time ON conversions (affiliate_organization_id, received_at);
CREATE INDEX IF NOT EXISTS ix_conversions_offer_status   ON conversions (offer_id, status);
CREATE INDEX IF NOT EXISTS ix_conversions_click          ON conversions (click_id);
CREATE INDEX IF NOT EXISTS ix_conversions_transaction    ON conversions (organization_id, transaction_id);

-- ---------------------------------------------------------------------------
-- attributions — PRD §36 record, one per attribution decision. INSERT-only.
-- `rule_version` references the exact `attribution_policies` row that decided.
-- `decision` ATTRIBUTED/REJECTED/DUPLICATE/HELD + a machine `reason_code`
-- (e.g. CLICK_MATCHED_LAST, NO_CLICK_IN_WINDOW, DUPLICATE_EXTERNAL_ID,
-- CLICK_OFFER_MISMATCH, WINDOW_EXPIRED, SIGNATURE_INVALID, REPLAY) so the
-- outcome is internally explainable (§35). `organization_id` = advertiser org.
-- One decision per conversion (UNIQUE conversion_id); a re-evaluation would be
-- a new conversion row, never an UPDATE here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attributions (
  id                          TEXT PRIMARY KEY,
  conversion_id               TEXT NOT NULL UNIQUE REFERENCES conversions (id) ON DELETE RESTRICT,
  click_id                    TEXT REFERENCES clicks (id) ON DELETE RESTRICT,
  organization_id             TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_organization_id   TEXT REFERENCES organizations (id) ON DELETE RESTRICT,
  offer_id                    TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  rule_version                TEXT NOT NULL REFERENCES attribution_policies (id) ON DELETE RESTRICT,
  decision                    TEXT NOT NULL CHECK (decision IN ('ATTRIBUTED','REJECTED','DUPLICATE','HELD')),
  reason_code                 TEXT NOT NULL,
  click_to_conversion_seconds INTEGER CHECK (click_to_conversion_seconds IS NULL OR click_to_conversion_seconds >= 0),
  request_id                  TEXT,
  decided_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_attributions_org_time       ON attributions (organization_id, decided_at);
CREATE INDEX IF NOT EXISTS ix_attributions_affiliate_time ON attributions (affiliate_organization_id, decided_at);
CREATE INDEX IF NOT EXISTS ix_attributions_click          ON attributions (click_id);
CREATE INDEX IF NOT EXISTS ix_attributions_offer_decision ON attributions (offer_id, decision);

-- ---------------------------------------------------------------------------
-- offer_cap_counters — persisted PRD §44 cap counters. The Durable Object
-- keyed by offer_id owns the concurrency-safe live counter and periodically
-- (and on exhaustion) writes the snapshot here; the row is the durable truth
-- used to rebuild DO state and to show cap status (PRD §30). One row per
-- (offer, cap_type, period_key). `period_key` is 'YYYY-MM-DD' for DAILY_*,
-- 'YYYY-MM' for MONTHLY_*, 'TOTAL' for TOTAL_* / BUDGET. `limit_value` is the
-- cap in effect (count, or integer minor units for BUDGET) copied from the
-- offer version when the period opened; `exhausted_at` is set once and drives
-- the KV invalidation (§45). Semantics are documented per cap_type in
-- docs/architecture (Unit 4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_cap_counters (
  id                TEXT PRIMARY KEY,
  offer_id          TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  cap_type          TEXT NOT NULL CHECK (cap_type IN (
                      'DAILY_CLICK','DAILY_CONVERSION','MONTHLY_CLICK','MONTHLY_CONVERSION',
                      'TOTAL_CLICK','TOTAL_CONVERSION','BUDGET')),
  period_key        TEXT NOT NULL,
  currency          TEXT CHECK (currency IS NULL OR length(currency) = 3),
  limit_value       INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
  current_value     INTEGER NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  exhausted_at      TEXT,
  last_flushed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, cap_type, period_key)
);

CREATE INDEX IF NOT EXISTS ix_offer_cap_counters_org       ON offer_cap_counters (organization_id, offer_id);
CREATE INDEX IF NOT EXISTS ix_offer_cap_counters_exhausted ON offer_cap_counters (exhausted_at);

-- ---------------------------------------------------------------------------
-- advertiser_postback_secrets — HMAC-SHA-256 signing keys for S2S postbacks
-- (PRD §74-style signature + §115 "invalid signature rejected"). Stored
-- ENCRYPTED at rest (`secret_ciphertext`, AES-GCM; `key_version` names the
-- Worker master key that wrapped it) because verification needs the key
-- material. Plaintext is returned once at creation and never again; list/read
-- routes select id/label/secret_hint/status/timestamps ONLY. Rotation = insert
-- a new ACTIVE row and set the old one to ROTATED with `expires_at` (grace
-- window), then REVOKED. Multiple ACTIVE rows per advertiser are allowed so
-- rotation is zero-downtime. `organization_id` = advertiser org.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_postback_secrets (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  advertiser_profile_id   TEXT NOT NULL REFERENCES advertiser_profiles (id) ON DELETE RESTRICT,
  label                   TEXT,
  secret_ciphertext       TEXT NOT NULL,
  key_version             TEXT NOT NULL,
  secret_hint             TEXT NOT NULL CHECK (length(secret_hint) = 4),
  status                  TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  last_used_at            TEXT,
  expires_at              TEXT,
  revoked_at              TEXT,
  created_by_user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_postback_secrets_org_status ON advertiser_postback_secrets (organization_id, status);

-- ---------------------------------------------------------------------------
-- postback_nonces — replay protection (PRD §74, §115 "replay rejected"). Every
-- signed postback carries a nonce + timestamp; the verifier accepts a nonce
-- once per advertiser org and rejects any repeat. `expires_at` = signed
-- timestamp + the tolerance window; rows past it may be purged (the timestamp
-- check alone rejects them after expiry, so purging is safe). INSERT-only;
-- the UNIQUE constraint IS the replay check (atomic insert-or-fail).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS postback_nonces (
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  nonce             TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  secret_id         TEXT REFERENCES advertiser_postback_secrets (id) ON DELETE SET NULL,
  signed_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id, nonce)
);

CREATE INDEX IF NOT EXISTS ix_postback_nonces_expires ON postback_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- Permission keys (PRD §10 pattern). Reference data, fixed ids (continues the
-- 0005/0006 sequence …1081–1083, …1091–1093 → …1101–1104).
--   tracking.read       — view own tracking links, SmartLinks, clicks (tenant:
--                         affiliate side owns links; advertiser side sees
--                         clicks on its offers via offer_organization_id)
--   tracking.manage     — create/update/pause/archive own tracking links and
--                         SmartLinks, manage the candidate pool (affiliate)
--   attribution.read    — view attribution records / policies (both sides,
--                         scoped: advertiser by offer ownership, affiliate by
--                         affiliate_organization_id)
--   attribution.manage  — create attribution policy versions and postback
--                         secrets for own offers (advertiser)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, key, resource, action, description) VALUES
  ('00000000-0000-4000-8000-000000001101', 'tracking.read',      'tracking',    'read',   'View own tracking links, SmartLinks and clicks'),
  ('00000000-0000-4000-8000-000000001102', 'tracking.manage',    'tracking',    'manage', 'Create, update, pause and archive own tracking links and SmartLinks'),
  ('00000000-0000-4000-8000-000000001103', 'attribution.read',   'attribution', 'read',   'View attribution records and attribution policies'),
  ('00000000-0000-4000-8000-000000001104', 'attribution.manage', 'attribution', 'manage', 'Manage attribution policy versions and postback signing secrets for own offers');

-- Grants ---------------------------------------------------------------------
-- SUPER_ADMIN: everything (0004 granted a snapshot; extend for the new keys).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'SUPER_ADMIN'
   AND p.key IN ('tracking.read','tracking.manage','attribution.read','attribution.manage');

-- Platform operators: read everything; OPERATIONS_ADMIN may also manage (support/incident).
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'OPERATIONS_ADMIN'
   AND p.key IN ('tracking.read','tracking.manage','attribution.read','attribution.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('FINANCE_MANAGER','COMPLIANCE_MANAGER','SUPPORT_AGENT','ANALYST')
   AND p.key IN ('tracking.read','attribution.read');

-- Advertiser tenant roles (also AGENCY via role_org_types): read clicks on own
-- offers, manage attribution policy + postback secrets for own offers.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('ADVERTISER_OWNER','ADVERTISER_ADMIN','CAMPAIGN_MANAGER')
   AND p.key IN ('tracking.read','attribution.read','attribution.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key = 'BILLING_MANAGER'
   AND p.key IN ('tracking.read','attribution.read');

-- Affiliate tenant roles (also PARTNER via role_org_types): own links/SmartLinks.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('AFFILIATE_OWNER','AFFILIATE_MANAGER')
   AND p.key IN ('tracking.read','tracking.manage','attribution.read');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.organization_id IS NULL AND r.key IN ('AFFILIATE_USER','VIEWER')
   AND p.key IN ('tracking.read','attribution.read');
