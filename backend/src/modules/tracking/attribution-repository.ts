/**
 * Attribution persistence over D1 (Phase 3 Unit 7c; migration 0008, PRD
 * §35–§37, §39, §74, §115). Pure data access for the five attribution tables —
 * policy lives in `attribution-service.ts`, the decision rules in
 * `attribution.ts`, signature crypto in `postback-auth.ts`.
 *
 *   attribution_policies        INSERT-only versions (version_number + 1); the
 *                               service flips `is_current` in the same batch.
 *   conversions                 one row per accepted postback; UNIQUE
 *                               (organization_id, offer_id, external_conversion_id)
 *                               surfaces as `ConversionDuplicateError`.
 *   attributions                INSERT-only decision per conversion (UNIQUE
 *                               conversion_id); written in the same batch as
 *                               its conversion.
 *   advertiser_postback_secrets `secret_ciphertext` is selected ONLY by
 *                               `findActiveSecretForVerification` (the
 *                               verifier); every list/read path uses
 *                               `SECRET_PUBLIC_COLUMNS`. Plaintext never
 *                               enters this module.
 *   postback_nonces             INSERT-only; the PRIMARY KEY (organization_id,
 *                               nonce) IS the replay check — `claimNonce`
 *                               returns false on a repeat, never throws.
 *
 * Tenant path: every tenant read/write takes a branded `TenantId` and runs
 * through `scopedQuery` (`organization_id = ?` first). The public postback
 * path addresses the advertiser by `key_id` (the secret row id) and derives
 * the organization from D1, never from the request.
 */
import { slicePage, type Page, type PageRequest } from "../../lib/pagination";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import type { AttributionDecision, AttributionModel, AttributionReasonCode, ClickCandidate, DedupScope, FallbackRule } from "./attribution";

// ---- attribution_policies ---------------------------------------------------

export interface AttributionPolicyRow {
  id: string;
  offer_id: string;
  organization_id: string;
  version_number: number;
  is_current: number;
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
  require_signature: number;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface AttributionPolicyInsert {
  id: string;
  offer_id: string;
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
  require_signature: boolean;
  change_summary: string | null;
  created_by_user_id: string | null;
}

// ---- conversions --------------------------------------------------------------

export const CONVERSION_STATUSES = ["RECEIVED", "VALIDATING", "PENDING", "REJECTED", "FRAUD_REVIEW"] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export const CONVERSION_SOURCES = ["S2S_POSTBACK", "ADVERTISER_API", "MANUAL"] as const;
export type ConversionSource = (typeof CONVERSION_SOURCES)[number];

export interface ConversionRow {
  id: string;
  organization_id: string;
  offer_id: string;
  offer_version_id: string | null;
  click_id: string | null;
  affiliate_organization_id: string | null;
  external_conversion_id: string;
  transaction_id: string | null;
  event_id: string | null;
  conversion_event: string;
  status: ConversionStatus;
  source: ConversionSource;
  sale_amount_minor: number | null;
  currency: string | null;
  occurred_at: string;
  received_at: string;
  request_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversionInsert {
  id: string;
  offer_id: string;
  offer_version_id: string | null;
  click_id: string | null;
  affiliate_organization_id: string | null;
  external_conversion_id: string;
  transaction_id: string | null;
  event_id: string | null;
  conversion_event: string;
  status: ConversionStatus;
  source: ConversionSource;
  /** Integer minor units (PRD §25); never a float. */
  sale_amount_minor: number | null;
  currency: string | null;
  occurred_at: string;
  request_id: string | null;
}

// ---- attributions -------------------------------------------------------------

export interface AttributionRow {
  id: string;
  conversion_id: string;
  click_id: string | null;
  organization_id: string;
  affiliate_organization_id: string | null;
  offer_id: string;
  rule_version: string;
  decision: AttributionDecision;
  reason_code: AttributionReasonCode | string;
  click_to_conversion_seconds: number | null;
  request_id: string | null;
  decided_at: string;
  created_at: string;
}

export interface AttributionInsert {
  id: string;
  conversion_id: string;
  click_id: string | null;
  affiliate_organization_id: string | null;
  offer_id: string;
  rule_version: string;
  decision: AttributionDecision;
  reason_code: AttributionReasonCode;
  click_to_conversion_seconds: number | null;
  request_id: string | null;
}

// ---- advertiser_postback_secrets ---------------------------------------------

export const POSTBACK_SECRET_STATUSES = ["ACTIVE", "ROTATED", "REVOKED"] as const;
export type PostbackSecretStatus = (typeof POSTBACK_SECRET_STATUSES)[number];

/** Everything a tenant may see about a secret. NO ciphertext, NO plaintext. */
export interface PostbackSecretRow {
  id: string;
  organization_id: string;
  advertiser_profile_id: string;
  label: string | null;
  secret_hint: string;
  status: PostbackSecretStatus;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The verifier's read: the wrapped key material plus what it needs to scope the postback. */
export interface PostbackSecretVerificationRow {
  id: string;
  organization_id: string;
  status: PostbackSecretStatus;
  expires_at: string | null;
  secret_ciphertext: string;
  key_version: string;
}

export interface PostbackSecretInsert {
  id: string;
  advertiser_profile_id: string;
  label: string | null;
  secret_ciphertext: string;
  key_version: string;
  secret_hint: string;
  created_by_user_id: string | null;
}

// ---- errors -------------------------------------------------------------------

/** UNIQUE (organization_id, offer_id, external_conversion_id) fired: the postback repeats an accepted conversion. */
export class ConversionDuplicateError extends Error {
  constructor() {
    super("conversion already recorded for this external_conversion_id");
    this.name = "ConversionDuplicateError";
  }
}

const POLICY_COLUMNS =
  "id, offer_id, organization_id, version_number, is_current, model, window_seconds, dedup_scope, fallback_rule, require_signature, change_summary, created_by_user_id, created_at";

const SECRET_PUBLIC_COLUMNS =
  "id, organization_id, advertiser_profile_id, label, secret_hint, status, last_used_at, expires_at, revoked_at, created_by_user_id, created_at, updated_at";

export class AttributionRepository {
  constructor(private readonly db: D1Database) {}

  // ---- attribution_policies (tenant = advertiser org) --------------------------

  /** All versions of an offer's policy, newest first. */
  async listPolicyVersions(tenantId: TenantId, offerId: string): Promise<AttributionPolicyRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${POLICY_COLUMNS} FROM attribution_policies
        WHERE organization_id = ? AND offer_id = ?
        ORDER BY version_number DESC`,
      tenantId,
      offerId,
    ).all<AttributionPolicyRow>();
    return res.results;
  }

  findCurrentPolicy(tenantId: TenantId, offerId: string): Promise<AttributionPolicyRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${POLICY_COLUMNS} FROM attribution_policies
        WHERE organization_id = ? AND offer_id = ? AND is_current = 1
        LIMIT 1`,
      tenantId,
      offerId,
    ).first<AttributionPolicyRow>();
  }

  /**
   * Postback path: the current policy for an offer, addressed by the
   * advertiser organization derived from the signing key row (not the
   * request). Null when the offer has no policy yet.
   */
  findCurrentPolicyForOffer(advertiserOrganizationId: string, offerId: string): Promise<AttributionPolicyRow | null> {
    return this.db
      .prepare(
        `SELECT ${POLICY_COLUMNS} FROM attribution_policies
          WHERE organization_id = ? AND offer_id = ? AND is_current = 1
          LIMIT 1`,
      )
      .bind(advertiserOrganizationId, offerId)
      .first<AttributionPolicyRow>();
  }

  /**
   * Append a policy version. `version_number` = current max + 1 for the offer
   * (computed inside the INSERT so concurrent writers collide on the UNIQUE
   * (offer_id, version_number) instead of both winning); every earlier row of
   * the offer is demoted to `is_current = 0` in the same batch.
   */
  async insertPolicyVersion(tenantId: TenantId, input: AttributionPolicyInsert, extra: D1PreparedStatement[]): Promise<void> {
    await this.db.batch([
      scopedQuery(
        this.db,
        `UPDATE attribution_policies SET is_current = 0 WHERE organization_id = ? AND offer_id = ? AND is_current = 1`,
        tenantId,
        input.offer_id,
      ),
      this.db
        .prepare(
          `INSERT INTO attribution_policies
             (organization_id, id, offer_id, version_number, is_current, model, window_seconds, dedup_scope, fallback_rule,
              require_signature, change_summary, created_by_user_id)
           SELECT ?, ?, ?, COALESCE(MAX(version_number), 0) + 1, 1, ?, ?, ?, ?, ?, ?, ?
             FROM attribution_policies WHERE offer_id = ?`,
        )
        .bind(
          tenantId,
          input.id,
          input.offer_id,
          input.model,
          input.window_seconds,
          input.dedup_scope,
          input.fallback_rule,
          input.require_signature ? 1 : 0,
          input.change_summary,
          input.created_by_user_id,
          input.offer_id,
        ),
      ...extra,
    ]);
  }

  // ---- conversions + attributions ----------------------------------------------

  /**
   * Candidate clicks for a conversion: every click on the offer whose
   * `clicked_at` lies inside [occurred_at − window, occurred_at + slack] — the
   * slack lets the engine see (and name) CLICK_AFTER_CONVERSION. The echoed
   * click, when given, is always included regardless of time / offer so the
   * engine can distinguish CLICK_NOT_FOUND from CLICK_OFFER_MISMATCH.
   * Bounded so a hot offer cannot make the verifier read unbounded rows.
   */
  async listClickCandidates(input: {
    advertiser_organization_id: string;
    offer_id: string;
    occurred_at: string;
    window_seconds: number;
    echoed_click_id: string | null;
    limit?: number;
  }): Promise<ClickCandidate[]> {
    const limit = input.limit ?? 500;
    const occurred = Date.parse(input.occurred_at);
    const from = Number.isFinite(occurred) ? new Date(occurred - input.window_seconds * 1000).toISOString() : input.occurred_at;
    const to = Number.isFinite(occurred) ? new Date(occurred + CLICK_AFTER_SLACK_SECONDS * 1000).toISOString() : input.occurred_at;
    const res = await this.db
      .prepare(
        `SELECT id, offer_id, organization_id, clicked_at FROM clicks
          WHERE offer_organization_id = ? AND offer_id = ? AND clicked_at >= ? AND clicked_at <= ?
          ORDER BY clicked_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(input.advertiser_organization_id, input.offer_id, from, to, limit)
      .all<ClickCandidate>();
    const rows = res.results;
    if (input.echoed_click_id && !rows.some((r) => r.id === input.echoed_click_id)) {
      const echoed = await this.db
        .prepare(`SELECT id, offer_id, organization_id, clicked_at FROM clicks WHERE offer_organization_id = ? AND id = ?`)
        .bind(input.advertiser_organization_id, input.echoed_click_id)
        .first<ClickCandidate>();
      if (echoed) rows.push(echoed);
    }
    return rows;
  }

  /**
   * §39 dedup probe for scopes beyond the always-on UNIQUE constraint. Returns
   * the id of an earlier conversion on the same offer sharing the key, or null.
   */
  async findDuplicateConversion(
    advertiserOrganizationId: string,
    offerId: string,
    key: { column: "external_conversion_id" | "transaction_id" | "click_event"; value: string },
  ): Promise<string | null> {
    let row: { id: string } | null;
    if (key.column === "click_event") {
      const sep = key.value.indexOf("\u0000");
      const clickId = sep >= 0 ? key.value.slice(0, sep) : key.value;
      const event = sep >= 0 ? key.value.slice(sep + 1) : "";
      row = await this.db
        .prepare(
          `SELECT id FROM conversions
            WHERE organization_id = ? AND offer_id = ? AND click_id = ? AND conversion_event = ?
            ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(advertiserOrganizationId, offerId, clickId, event)
        .first<{ id: string }>();
    } else {
      row = await this.db
        .prepare(
          `SELECT id FROM conversions
            WHERE organization_id = ? AND offer_id = ? AND ${key.column} = ?
            ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(advertiserOrganizationId, offerId, key.value)
        .first<{ id: string }>();
    }
    return row?.id ?? null;
  }

  /**
   * Record a conversion together with its attribution decision (and any
   * caller-supplied audit statements) in ONE batch. The always-on UNIQUE
   * (organization_id, offer_id, external_conversion_id) surfaces as
   * `ConversionDuplicateError`; nothing is written in that case.
   */
  async insertConversionWithAttribution(
    advertiserOrganizationId: string,
    conversion: ConversionInsert,
    attribution: AttributionInsert,
    extra: D1PreparedStatement[] = [],
  ): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO conversions
               (organization_id, id, offer_id, offer_version_id, click_id, affiliate_organization_id, external_conversion_id,
                transaction_id, event_id, conversion_event, status, source, sale_amount_minor, currency, occurred_at, request_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            advertiserOrganizationId,
            conversion.id,
            conversion.offer_id,
            conversion.offer_version_id,
            conversion.click_id,
            conversion.affiliate_organization_id,
            conversion.external_conversion_id,
            conversion.transaction_id,
            conversion.event_id,
            conversion.conversion_event,
            conversion.status,
            conversion.source,
            conversion.sale_amount_minor,
            conversion.currency,
            conversion.occurred_at,
            conversion.request_id,
          ),
        this.db
          .prepare(
            `INSERT INTO attributions
               (organization_id, id, conversion_id, click_id, affiliate_organization_id, offer_id, rule_version, decision,
                reason_code, click_to_conversion_seconds, request_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            advertiserOrganizationId,
            attribution.id,
            attribution.conversion_id,
            attribution.click_id,
            attribution.affiliate_organization_id,
            attribution.offer_id,
            attribution.rule_version,
            attribution.decision,
            attribution.reason_code,
            attribution.click_to_conversion_seconds,
            attribution.request_id,
          ),
        ...extra,
      ]);
    } catch (e) {
      if (isUniqueViolation(e, "conversions.organization_id, conversions.offer_id, conversions.external_conversion_id")) {
        throw new ConversionDuplicateError();
      }
      throw e;
    }
  }

  findConversion(tenantId: TenantId, conversionId: string): Promise<ConversionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM conversions WHERE organization_id = ? AND id = ?`,
      tenantId,
      conversionId,
    ).first<ConversionRow>();
  }

  /** Advertiser-side: the tenant's conversions, optionally for one offer, newest first. */
  async listConversions(
    tenantId: TenantId,
    page: PageRequest,
    filter: { offer_id?: string; status?: ConversionStatus },
  ): Promise<Page<ConversionRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.offer_id) {
      where.push("offer_id = ?");
      binds.push(filter.offer_id);
    }
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM conversions WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ConversionRow>();
    return slicePage(res.results, page.limit);
  }

  findAttributionByConversion(tenantId: TenantId, conversionId: string): Promise<AttributionRow | null> {
    return scopedQuery(
      this.db,
      `SELECT * FROM attributions WHERE organization_id = ? AND conversion_id = ?`,
      tenantId,
      conversionId,
    ).first<AttributionRow>();
  }

  /** Advertiser-side: decisions on the tenant's offers, newest first. */
  async listAttributions(
    tenantId: TenantId,
    page: PageRequest,
    filter: { offer_id?: string; decision?: AttributionDecision },
  ): Promise<Page<AttributionRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.offer_id) {
      where.push("offer_id = ?");
      binds.push(filter.offer_id);
    }
    if (filter.decision) {
      where.push("decision = ?");
      binds.push(filter.decision);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM attributions WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<AttributionRow>();
    return slicePage(res.results, page.limit);
  }

  /**
   * Affiliate-side: decisions that credited the tenant (attributions.
   * affiliate_organization_id). The tenant is the AFFILIATE org, so the scope
   * column differs from `scopedQuery`'s check; the branded `TenantId` is still
   * the first and only scope. Only ATTRIBUTED rows can carry an affiliate.
   */
  async listAttributionsForAffiliate(tenantId: TenantId, page: PageRequest, filter: { offer_id?: string }): Promise<Page<AttributionRow>> {
    const binds: unknown[] = [tenantId];
    let extra = "";
    if (filter.offer_id) {
      extra += " AND offer_id = ?";
      binds.push(filter.offer_id);
    }
    if (page.cursor) {
      extra += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await this.db
      .prepare(
        `SELECT * FROM attributions WHERE affiliate_organization_id = ?${extra}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...binds, page.limit + 1)
      .all<AttributionRow>();
    return slicePage(res.results, page.limit);
  }

  // ---- advertiser_postback_secrets -----------------------------------------------

  async listSecrets(tenantId: TenantId): Promise<PostbackSecretRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT ${SECRET_PUBLIC_COLUMNS} FROM advertiser_postback_secrets WHERE organization_id = ? ORDER BY created_at DESC, id DESC`,
      tenantId,
    ).all<PostbackSecretRow>();
    return res.results;
  }

  findSecret(tenantId: TenantId, secretId: string): Promise<PostbackSecretRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${SECRET_PUBLIC_COLUMNS} FROM advertiser_postback_secrets WHERE organization_id = ? AND id = ?`,
      tenantId,
      secretId,
    ).first<PostbackSecretRow>();
  }

  /** Insert an ACTIVE secret (ciphertext only) plus audit statements atomically. */
  async insertSecret(tenantId: TenantId, input: PostbackSecretInsert, extra: D1PreparedStatement[]): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO advertiser_postback_secrets
             (organization_id, id, advertiser_profile_id, label, secret_ciphertext, key_version, secret_hint, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .bind(
          tenantId,
          input.id,
          input.advertiser_profile_id,
          input.label,
          input.secret_ciphertext,
          input.key_version,
          input.secret_hint,
          input.created_by_user_id,
        ),
      ...extra,
    ]);
  }

  /** Rotate: insert the replacement ACTIVE row and retire the old one in one batch. */
  async rotateSecret(
    tenantId: TenantId,
    oldSecretId: string,
    replacement: PostbackSecretInsert,
    expiresAt: string,
    now: string,
    extra: D1PreparedStatement[],
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO advertiser_postback_secrets
             (organization_id, id, advertiser_profile_id, label, secret_ciphertext, key_version, secret_hint, status, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        )
        .bind(
          tenantId,
          replacement.id,
          replacement.advertiser_profile_id,
          replacement.label,
          replacement.secret_ciphertext,
          replacement.key_version,
          replacement.secret_hint,
          replacement.created_by_user_id,
        ),
      // SET-first UPDATE: `organization_id = ?` cannot be the first placeholder, so
      // the branded tenant id is bound explicitly (same pattern as TrackingRepository.setLinkStatus).
      this.db
        .prepare(
          `UPDATE advertiser_postback_secrets SET status = 'ROTATED', expires_at = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status = 'ACTIVE'`,
        )
        .bind(expiresAt, now, tenantId, oldSecretId),
      ...extra,
    ]);
  }

  /** Revoke immediately (terminal). Returns false when the row was not ACTIVE/ROTATED for this tenant. */
  async revokeSecret(tenantId: TenantId, secretId: string, now: string, extra: D1PreparedStatement[]): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE advertiser_postback_secrets SET status = 'REVOKED', revoked_at = ?, updated_at = ?
            WHERE organization_id = ? AND id = ? AND status IN ('ACTIVE','ROTATED')`,
        )
        .bind(now, now, tenantId, secretId),
      ...extra,
    ]);
    const first = results[0];
    return (first?.meta?.changes ?? 0) > 0;
  }

  /**
   * The verifier's ONLY read of key material: the row for `key_id` if it is
   * usable (ACTIVE, or ROTATED and still inside its grace window). REVOKED /
   * expired / unknown → null (the caller answers SIGNATURE_INVALID either way,
   * after computing an HMAC anyway so timing does not leak key existence).
   */
  findActiveSecretForVerification(keyId: string, now: string): Promise<PostbackSecretVerificationRow | null> {
    return this.db
      .prepare(
        `SELECT id, organization_id, status, expires_at, secret_ciphertext, key_version
           FROM advertiser_postback_secrets
          WHERE id = ? AND (status = 'ACTIVE' OR (status = 'ROTATED' AND (expires_at IS NULL OR expires_at > ?)))`,
      )
      .bind(keyId, now)
      .first<PostbackSecretVerificationRow>();
  }

  /** Best-effort usage marker; never on the critical path. */
  async touchSecret(secretId: string, now: string): Promise<void> {
    await this.db.prepare(`UPDATE advertiser_postback_secrets SET last_used_at = ? WHERE id = ?`).bind(now, secretId).run();
  }

  // ---- postback_nonces -------------------------------------------------------------

  /**
   * Replay protection: insert-or-fail. True = first sighting (claimed); false
   * = the nonce was already used by this advertiser org (REPLAY). Any other
   * failure propagates so the caller fails closed.
   */
  async claimNonce(input: {
    organization_id: string;
    nonce: string;
    secret_id: string | null;
    signed_at: string;
    expires_at: string;
  }): Promise<boolean> {
    try {
      await this.db
        .prepare(`INSERT INTO postback_nonces (organization_id, nonce, secret_id, signed_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(input.organization_id, input.nonce, input.secret_id, input.signed_at, input.expires_at)
        .run();
      return true;
    } catch (e) {
      if (isUniqueViolation(e, "postback_nonces")) return false;
      throw e;
    }
  }

  /** Purge nonces past `expires_at` (their timestamps are rejected by the skew check anyway). Returns rows removed. */
  async purgeExpiredNonces(now: string, limit = 1000): Promise<number> {
    const res = await this.db
      .prepare(`DELETE FROM postback_nonces WHERE rowid IN (SELECT rowid FROM postback_nonces WHERE expires_at <= ? LIMIT ?)`)
      .bind(now, limit)
      .run();
    return res.meta?.changes ?? 0;
  }
}

/** How far AFTER `occurred_at` candidate clicks are still loaded (so CLICK_AFTER_CONVERSION is explainable). */
export const CLICK_AFTER_SLACK_SECONDS = 3600;

/** D1 / SQLite surface a UNIQUE violation as an Error whose message names the constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg) && msg.includes(constraint);
}
