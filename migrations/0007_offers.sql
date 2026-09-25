-- Migration 0007_offers — TrafficVaultHub offers & marketplace module
-- Target: Cloudflare D1 (SQLite)
--
-- Scope (Phase 2, Units 3–8 — Offers core, versioning, economics, access &
-- targeting, Marketplace; PRD §22–§30, §92, §94, §116, §124, §127):
--   * offers                     — the stable offer identity owned by ONE
--                                  advertiser organization; lifecycle status
--                                  (PRD §22) + marketplace access mode (§28);
--                                  points at its current immutable version
--   * offer_versions             — append-only, immutable economic/targeting
--                                  snapshot. Every material change (payout,
--                                  caps, attribution window, conversion event,
--                                  traffic rules, targeting) creates a NEW row;
--                                  history is never overwritten (PRD §24) so a
--                                  conversion can later reference the version
--                                  that was current at click time
--   * offer_version_targeting    — allow-list targeting rows per version
--                                  (country/region/device/os/browser/language/
--                                  traffic_source); immutable with the version
--   * affiliate_offer_access     — PRD §92 grant/application linking an
--                                  affiliate organization to a restricted offer
--                                  (INVITE_ONLY / PRIVATE / AFFILIATE_SPECIFIC /
--                                  APPLICATION_REQUIRED)
--
-- Additive only. Migrations 0001–0006 are immutable and are NOT modified.
--
-- Money is ALWAYS integer minor units (amount_minor) + a 3-letter currency,
-- never a float and never combined into one ambiguous number (PRD §25). The
-- advertiser payout and the network margin are advertiser/network-confidential
-- and are redacted from the affiliate-facing marketplace views in the service
-- layer — the frontend is never the security boundary (PRD §116).
--
-- Permission keys offers.read / offers.create / offers.update / offers.approve
-- / offers.pause already exist (migration 0004); no new keys are introduced.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- offers — stable offer identity, owned by one ADVERTISER/AGENCY organization
-- (organization_id is the tenant scope). Economic/targeting detail lives in the
-- versioned rows; only identity, lifecycle status and marketplace access mode
-- live here. `current_version_id` references offer_versions(id) logically; it is
-- a plain column (not a hard FK) to avoid a circular table dependency, and is
-- always set to a row this offer owns. Rows are never physically deleted —
-- ARCHIVED status + `archived_at` (PRD §95).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  advertiser_profile_id   TEXT NOT NULL REFERENCES advertiser_profiles (id) ON DELETE RESTRICT,
  status                  TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN (
                            'DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','LIVE',
                            'PAUSED','CAP_REACHED','BUDGET_EXHAUSTED','TRACKING_ISSUE',
                            'COMPLIANCE_HOLD','EXPIRED','ARCHIVED')),
  access_mode             TEXT NOT NULL DEFAULT 'PUBLIC'
                          CHECK (access_mode IN (
                            'PUBLIC','APPLICATION_REQUIRED','PRIVATE','INVITE_ONLY','AFFILIATE_SPECIFIC')),
  name                    TEXT NOT NULL,
  vertical                TEXT,
  description             TEXT,
  current_version_id      TEXT,
  review_notes            TEXT,
  submitted_at            TEXT,
  approved_at             TEXT,
  activated_at            TEXT,
  archived_at             TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_offers_org           ON offers (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ix_offers_status        ON offers (status, created_at);
CREATE INDEX IF NOT EXISTS ix_offers_access_mode   ON offers (access_mode, status);
CREATE INDEX IF NOT EXISTS ix_offers_vertical      ON offers (vertical);

-- ---------------------------------------------------------------------------
-- offer_versions — IMMUTABLE economic + rule snapshot. INSERT-only; the
-- application never UPDATEs or DELETEs a version row (PRD §24). version_number
-- is deterministic and sequential per offer (1, 2, 3, …). Economics are all
-- integer minor units + currency (PRD §25); revshare uses integer basis points
-- (0..10000) never a float percentage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_versions (
  id                        TEXT PRIMARY KEY,
  offer_id                  TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id           TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  version_number            INTEGER NOT NULL CHECK (version_number >= 1),
  -- economics (PRD §25) — never floats, never combined
  payout_type               TEXT NOT NULL CHECK (payout_type IN ('CPA','CPL','CPC','CPI','CPM','CPS','REVSHARE')),
  currency                  TEXT NOT NULL CHECK (length(currency) = 3),
  advertiser_payout_minor   INTEGER NOT NULL CHECK (advertiser_payout_minor >= 0),
  affiliate_commission_minor INTEGER NOT NULL CHECK (affiliate_commission_minor >= 0),
  network_margin_minor      INTEGER NOT NULL DEFAULT 0 CHECK (network_margin_minor >= 0),
  revshare_percent_bps      INTEGER CHECK (revshare_percent_bps IS NULL OR (revshare_percent_bps >= 0 AND revshare_percent_bps <= 10000)),
  -- caps & budget (PRD §23) — integer counts / minor units
  daily_conversion_cap      INTEGER CHECK (daily_conversion_cap IS NULL OR daily_conversion_cap >= 0),
  total_conversion_cap      INTEGER CHECK (total_conversion_cap IS NULL OR total_conversion_cap >= 0),
  budget_minor              INTEGER CHECK (budget_minor IS NULL OR budget_minor >= 0),
  -- attribution / conversion (PRD §26)
  attribution_window_seconds INTEGER NOT NULL DEFAULT 2592000 CHECK (attribution_window_seconds > 0),
  conversion_event          TEXT NOT NULL,
  destination_url           TEXT,
  -- time window (PRD §30 targeting) — the version's active window
  targeting_starts_at       TEXT,
  targeting_ends_at         TEXT,
  change_summary            TEXT,
  created_by_user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, version_number)
);

CREATE INDEX IF NOT EXISTS ix_offer_versions_offer ON offer_versions (offer_id, version_number);
CREATE INDEX IF NOT EXISTS ix_offer_versions_org   ON offer_versions (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- offer_version_targeting — allow-list targeting rows attached to ONE immutable
-- version (PRD §30). One row per (version, dimension, value). Absence of any
-- row for a dimension means "no restriction on that dimension" (open). Rows are
-- inserted with their version and never mutated afterwards; a new version gets
-- its own fresh set of rows. `offer_id` / `organization_id` are denormalized so
-- marketplace filtering stays tenant-safe and index-friendly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_version_targeting (
  id                      TEXT PRIMARY KEY,
  offer_version_id        TEXT NOT NULL REFERENCES offer_versions (id) ON DELETE RESTRICT,
  offer_id                TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id         TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  dimension               TEXT NOT NULL CHECK (dimension IN (
                            'COUNTRY','REGION','DEVICE','OS','BROWSER','LANGUAGE','TRAFFIC_SOURCE')),
  value                   TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_version_id, dimension, value)
);

CREATE INDEX IF NOT EXISTS ix_offer_targeting_version ON offer_version_targeting (offer_version_id, dimension);
CREATE INDEX IF NOT EXISTS ix_offer_targeting_lookup  ON offer_version_targeting (dimension, value);

-- ---------------------------------------------------------------------------
-- affiliate_offer_access — PRD §92 access grant / application linking one
-- affiliate organization to one restricted offer. Drives marketplace visibility
-- for INVITE_ONLY / PRIVATE / AFFILIATE_SPECIFIC / APPLICATION_REQUIRED offers.
--   INVITED   — advertiser invited the affiliate (INVITE_ONLY / AFFILIATE_SPECIFIC)
--   REQUESTED — affiliate applied (APPLICATION_REQUIRED / PRIVATE-on-request)
--   APPROVED  — access granted; the affiliate may see confidential-safe detail
--   REJECTED  — application declined
--   REVOKED   — previously-granted access withdrawn
-- `organization_id` is the advertiser org that OWNS the offer (tenant scope for
-- the advertiser side); `affiliate_organization_id` is the affiliate. One row
-- per (offer, affiliate org).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_offer_access (
  id                        TEXT PRIMARY KEY,
  offer_id                  TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id           TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  affiliate_organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  status                    TEXT NOT NULL DEFAULT 'REQUESTED'
                            CHECK (status IN ('INVITED','REQUESTED','APPROVED','REJECTED','REVOKED')),
  reason                    TEXT,
  requested_at              TEXT,
  decided_at                TEXT,
  decided_by_user_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (offer_id, affiliate_organization_id)
);

CREATE INDEX IF NOT EXISTS ix_aff_offer_access_affiliate ON affiliate_offer_access (affiliate_organization_id, status);
CREATE INDEX IF NOT EXISTS ix_aff_offer_access_offer     ON affiliate_offer_access (offer_id, status);
CREATE INDEX IF NOT EXISTS ix_aff_offer_access_org       ON affiliate_offer_access (organization_id, created_at);

-- ---------------------------------------------------------------------------
-- offer_status_transitions — append-only lifecycle history (PRD §22 + the
-- Phase 2 "every transition is audited" requirement). Rows are INSERTed only,
-- never updated or deleted; `from_status` is NULL for the row created with the
-- offer. Mirrors `affiliate_status_transitions` (migration 0006).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_status_transitions (
  id                TEXT PRIMARY KEY,
  offer_id          TEXT NOT NULL REFERENCES offers (id) ON DELETE RESTRICT,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  actor_user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('TENANT','PLATFORM','SYSTEM')),
  reason            TEXT,
  request_id        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS ix_offer_transitions_offer_created
  ON offer_status_transitions (offer_id, created_at);
CREATE INDEX IF NOT EXISTS ix_offer_transitions_org
  ON offer_status_transitions (organization_id, created_at);
