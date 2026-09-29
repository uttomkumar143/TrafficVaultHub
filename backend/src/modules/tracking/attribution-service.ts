/**
 * Attribution module — policy layer (Phase 3 Unit 7d; PRD §35–§37, §39, §74,
 * §94, §115). SQL lives in `attribution-repository.ts`, the decision rules in
 * `attribution.ts`, signature crypto + the secret vault in `postback-auth.ts`.
 * Mirrors `modules/tracking/service.ts`: it decides WHO may do WHAT and records
 * every accepted mutation in `audit_logs` in the same D1 batch as the change.
 *
 * Two faces, both enforced SERVER-SIDE:
 *   Advertiser/agency tenant (`attribution.read` / `attribution.manage`):
 *     policy versions (append-only) · conversions + attributions on the
 *     tenant's OWN offers · postback secrets (create / rotate / revoke / list).
 *   Affiliate/partner tenant (`attribution.read`):
 *     attributions where the tenant is the attributed affiliate (read-only).
 *   Public S2S postback (no session): `processPostback` — the advertiser is
 *     identified ONLY by `key_id` → D1 → `organization_id`. Nothing in the
 *     request body can pick the tenant, the affiliate or the click's owner.
 *
 * Postback pipeline (order matters — each step is a hard stop):
 *   1. headers parsed strictly (SIGNATURE_MALFORMED)
 *   2. timestamp skew ±tolerance checked BEFORE any key read (TIMESTAMP_SKEW)
 *   3. key_id → usable secret row; unwrap from the vault; verify HMAC over the
 *      canonical string. An HMAC is ALWAYS computed (dummy key on unknown
 *      key_id) so timing does not reveal key existence (SIGNATURE_INVALID).
 *      Vault misconfiguration (POSTBACK_SECRET_KEY missing / wrong) fails
 *      CLOSED with 503 — never "unsigned accepted".
 *   4. nonce claimed (INSERT-or-fail on the (org, nonce) PK) → REPLAY_DETECTED
 *   5. body validated (offer_id, external_conversion_id, occurred_at, …) — the
 *      offer must belong to the key's organization (OFFER_NOT_FOUND, no leak)
 *   6. current policy (default LAST_CLICK / 7d / EXTERNAL_CONVERSION_ID /
 *      REJECT when the advertiser never configured one — deterministic)
 *   7. dedup probe under the policy scope → click candidates → `decide()`
 *   8. conversion + attribution written in ONE batch; the always-on UNIQUE
 *      (org, offer, external_conversion_id) is the last line of defence and
 *      answers 200 DUPLICATE without writing anything.
 *
 * Secrets: plaintext is generated server-side, returned to the caller EXACTLY
 * ONCE (create / rotate response), wrapped with AES-256-GCM under
 * POSTBACK_SECRET_KEY before it reaches D1, never audited, never logged, never
 * selected by any tenant read (`SECRET_PUBLIC_COLUMNS`).
 *
 * Error codes: FORBIDDEN 403 · ORG_TYPE_NOT_ADVERTISER 400 ·
 *   ORG_TYPE_NOT_AFFILIATE 400 · OFFER_NOT_FOUND 404 · POLICY_INVALID 400 ·
 *   CONVERSION_NOT_FOUND 404 · ADVERTISER_PROFILE_REQUIRED 400 ·
 *   POSTBACK_SECRET_NOT_FOUND 404 · POSTBACK_SECRET_NOT_ACTIVE 409 ·
 *   POSTBACK_VAULT_UNAVAILABLE 503 · SIGNATURE_MALFORMED 401 ·
 *   TIMESTAMP_SKEW 401 · SIGNATURE_INVALID 401 · REPLAY_DETECTED 409 ·
 *   POSTBACK_INVALID 400
 */
import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AdvertiserRepository } from "../advertisers/repository";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { OfferRepository } from "../offers/repository";
import type { PermissionKey } from "../rbac/permissions";
import {
  ATTRIBUTION_MODELS,
  DEDUP_SCOPES,
  FALLBACK_RULES,
  decide,
  dedupKey,
  type AttributionDecision,
  type AttributionModel,
  type DedupScope,
  type FallbackRule,
} from "./attribution";
import {
  ConversionDuplicateError,
  type AttributionPolicyRow,
  type AttributionRepository,
  type AttributionRow,
  type ConversionRow,
  type ConversionStatus,
  type PostbackSecretRow,
} from "./attribution-repository";
import {
  CURRENT_KEY_VERSION,
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  PostbackVaultError,
  generatePostbackSecret,
  isTimestampFresh,
  nonceExpiresAt,
  parsePostbackHeaders,
  secretHint,
  unwrapPostbackSecret,
  verifyPostbackSignature,
  wrapPostbackSecret,
  type PostbackAuthFailure,
} from "./postback-auth";

/** Organization types that own offers and therefore attribution policies / secrets (PRD §8). */
export const ATTRIBUTION_OWNER_ORG_TYPES = ["ADVERTISER", "AGENCY"] as const;
/** Organization types that may read attributions made in their favour. */
const AFFILIATE_ORG_TYPES = ["AFFILIATE", "PARTNER"] as const;

/** Policy applied when an advertiser never configured one (PRD §35: last-click, 7 days). */
export const DEFAULT_POLICY: Readonly<{
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
  require_signature: boolean;
}> = {
  model: "LAST_CLICK",
  window_seconds: 7 * 24 * 3600,
  dedup_scope: "EXTERNAL_CONVERSION_ID",
  fallback_rule: "REJECT",
  require_signature: true,
};

/** Bounds for `window_seconds` (1 minute … 90 days). */
export const WINDOW_SECONDS_MIN = 60;
export const WINDOW_SECONDS_MAX = 90 * 24 * 3600;
/** Grace period during which a ROTATED secret still verifies (PRD §74). */
export const ROTATION_GRACE_SECONDS = 24 * 3600;
export const EXTERNAL_ID_MAX_LENGTH = 128;
const ID_MAX_LENGTH = 128;
const EVENT_MAX_LENGTH = 64;
const LABEL_MAX_LENGTH = 100;
/** Fallback key material so an HMAC is computed even when key_id is unknown (timing parity). */
const DUMMY_SECRET = "0".repeat(64);

// ---- public shapes ---------------------------------------------------------------

export interface PublicAttributionPolicy {
  id: string;
  offer_id: string;
  organization_id: string;
  version_number: number;
  is_current: boolean;
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
  require_signature: boolean;
  change_summary: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

/** What `getCurrentPolicy` returns before the advertiser has configured anything. */
export interface DefaultPolicyView {
  default: true;
  model: AttributionModel;
  window_seconds: number;
  dedup_scope: DedupScope;
  fallback_rule: FallbackRule;
  require_signature: boolean;
}

export interface CreatePolicyInput {
  model?: unknown;
  window_seconds?: unknown;
  dedup_scope?: unknown;
  fallback_rule?: unknown;
  require_signature?: unknown;
  change_summary?: unknown;
}

export interface PublicConversion {
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
  source: string;
  sale_amount_minor: number | null;
  currency: string | null;
  occurred_at: string;
  received_at: string;
  created_at: string;
}

export interface PublicAttribution {
  id: string;
  conversion_id: string;
  click_id: string | null;
  organization_id: string;
  affiliate_organization_id: string | null;
  offer_id: string;
  rule_version: string;
  decision: AttributionDecision;
  reason_code: string;
  click_to_conversion_seconds: number | null;
  decided_at: string;
}

export interface PublicPostbackSecret {
  id: string;
  organization_id: string;
  label: string | null;
  secret_hint: string;
  status: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Returned by create / rotate ONLY — the single time plaintext leaves the server. */
export interface IssuedPostbackSecret extends PublicPostbackSecret {
  /** Plaintext shared secret; shown once, never retrievable again. */
  secret: string;
  /** Canonical `X-TVH-Key-Id` value (= `id`). */
  key_id: string;
}

export interface PostbackRequest {
  method: string;
  /** Path only (no host, no query) — exactly what the advertiser signed. */
  path: string;
  /** Raw request body as received (signed bytes). */
  body: string;
  header: (name: string) => string | undefined | null;
  meta: RequestMeta;
}

export interface PostbackOutcome {
  conversion_id: string;
  attribution_id: string | null;
  decision: AttributionDecision;
  reason_code: string;
  /** True when this postback was recognised as a repeat of an earlier conversion. */
  duplicate: boolean;
  /** The earlier conversion this one duplicates (set only when `duplicate`). */
  duplicate_of: string | null;
}

export interface AttributionServiceOptions {
  /** POSTBACK_SECRET_KEY (base64, 32 bytes). Absent ⇒ every secret operation fails CLOSED. */
  masterKey?: string | undefined;
  timestampToleranceSeconds?: number;
  now?: () => Date;
}

// ---- service ---------------------------------------------------------------------

export class AttributionService {
  private readonly audit: AuditRepository;
  private readonly masterKey: string | undefined;
  private readonly tolerance: number;
  private readonly clock: () => Date;

  constructor(
    private readonly repo: AttributionRepository,
    private readonly offers: OfferRepository,
    private readonly advertisers: AdvertiserRepository,
    db: D1Database,
    options: AttributionServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.masterKey = options.masterKey;
    this.tolerance = options.timestampToleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
    this.clock = options.now ?? (() => new Date());
  }

  // ---- policies (advertiser tenant) ------------------------------------------------

  /** `attribution.read`. Current policy for one of the tenant's offers (the default when none was ever configured). */
  async getCurrentPolicy(tenant: TenantContext, offerId: string): Promise<PublicAttributionPolicy | DefaultPolicyView> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    await this.requireOwnOffer(tenant, offerId);
    const row = await this.repo.findCurrentPolicy(tenantIdOf(tenant), offerId);
    return row ? toPolicy(row) : { default: true, ...DEFAULT_POLICY };
  }

  /** `attribution.read`. Every version, newest first. */
  async listPolicyVersions(tenant: TenantContext, offerId: string): Promise<PublicAttributionPolicy[]> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    await this.requireOwnOffer(tenant, offerId);
    const rows = await this.repo.listPolicyVersions(tenantIdOf(tenant), offerId);
    return rows.map(toPolicy);
  }

  /**
   * `attribution.manage`. Append a new policy version (never edits an old one)
   * and make it current in the same batch as its audit row. Omitted fields
   * inherit from the current version (or the default).
   */
  async createPolicyVersion(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    offerId: string,
    input: CreatePolicyInput,
    meta: RequestMeta,
  ): Promise<PublicAttributionPolicy> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.manage");
    const tid = tenantIdOf(tenant);
    await this.requireOwnOffer(tenant, offerId);
    const current = await this.repo.findCurrentPolicy(tid, offerId);
    const base = current
      ? {
          model: current.model,
          window_seconds: current.window_seconds,
          dedup_scope: current.dedup_scope,
          fallback_rule: current.fallback_rule,
          require_signature: current.require_signature === 1,
        }
      : DEFAULT_POLICY;
    const parsed = parsePolicyInput(input, base);
    const id = crypto.randomUUID();
    await this.repo.insertPolicyVersion(tid, { id, offer_id: offerId, ...parsed, created_by_user_id: ctx.user.id }, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "attribution.policy.created",
        target_type: "attribution_policy",
        target_id: id,
        metadata: {
          offer_id: offerId,
          model: parsed.model,
          window_seconds: parsed.window_seconds,
          dedup_scope: parsed.dedup_scope,
          fallback_rule: parsed.fallback_rule,
          require_signature: parsed.require_signature,
          previous_policy_id: current?.id ?? null,
        },
        meta,
      }),
    ]);
    const row = await this.repo.findCurrentPolicy(tid, offerId);
    if (!row || row.id !== id) throw new AppError(500, "INTERNAL_ERROR", "Policy version was not persisted");
    return toPolicy(row);
  }

  // ---- conversions & attributions (advertiser tenant) ------------------------------

  /** `attribution.read`. Conversions received on the tenant's own offers, newest first. */
  async listConversions(
    tenant: TenantContext,
    page: PageRequest,
    filter: { offer_id?: string; status?: ConversionStatus },
  ): Promise<Page<PublicConversion>> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    const result = await this.repo.listConversions(tenantIdOf(tenant), page, filter);
    return { items: result.items.map(toConversion), next_cursor: result.next_cursor };
  }

  /** `attribution.read`. One conversion with its (explainable) attribution decision. */
  async getConversion(
    tenant: TenantContext,
    conversionId: string,
  ): Promise<{ conversion: PublicConversion; attribution: PublicAttribution | null }> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    const tid = tenantIdOf(tenant);
    const conversion = await this.repo.findConversion(tid, conversionId);
    if (!conversion) throw new AppError(404, "CONVERSION_NOT_FOUND", "Conversion not found");
    const attribution = await this.repo.findAttributionByConversion(tid, conversionId);
    return { conversion: toConversion(conversion), attribution: attribution ? toAttribution(attribution) : null };
  }

  /** `attribution.read`. Decisions on the tenant's own offers, newest first. */
  async listAttributions(
    tenant: TenantContext,
    page: PageRequest,
    filter: { offer_id?: string; decision?: AttributionDecision },
  ): Promise<Page<PublicAttribution>> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    const result = await this.repo.listAttributions(tenantIdOf(tenant), page, filter);
    return { items: result.items.map(toAttribution), next_cursor: result.next_cursor };
  }

  /** `attribution.read` (affiliate face). Decisions attributed TO the tenant, newest first. */
  async listAttributionsForAffiliate(
    tenant: TenantContext,
    page: PageRequest,
    filter: { offer_id?: string },
  ): Promise<Page<PublicAttribution>> {
    this.assertAffiliateOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    const result = await this.repo.listAttributionsForAffiliate(tenantIdOf(tenant), page, filter);
    return { items: result.items.map(toAttribution), next_cursor: result.next_cursor };
  }

  // ---- postback secrets (advertiser tenant) ----------------------------------------

  /** `attribution.read`. Public columns only — no ciphertext, no plaintext. */
  async listSecrets(tenant: TenantContext): Promise<PublicPostbackSecret[]> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.read");
    const rows = await this.repo.listSecrets(tenantIdOf(tenant));
    return rows.map(toSecret);
  }

  /** `attribution.manage`. Mint a new ACTIVE secret; the plaintext is returned once. */
  async createSecret(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    input: { label?: unknown },
    meta: RequestMeta,
  ): Promise<IssuedPostbackSecret> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.manage");
    const tid = tenantIdOf(tenant);
    const profile = await this.advertisers.findByTenant(tid);
    if (!profile) throw new AppError(400, "ADVERTISER_PROFILE_REQUIRED", "Create the advertiser profile first");
    const label = parseLabel(input.label);
    const { id, secret, insert } = await this.mintSecret(profile.id, label, ctx.user.id);
    await this.repo.insertSecret(tid, insert, [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "attribution.postback_secret.created",
        target_type: "advertiser_postback_secret",
        target_id: id,
        metadata: { label, secret_hint: insert.secret_hint },
        meta,
      }),
    ]);
    const row = await this.repo.findSecret(tid, id);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "Secret was not persisted");
    return { ...toSecret(row), secret, key_id: id };
  }

  /**
   * `attribution.manage`. Replace an ACTIVE secret: the new one is ACTIVE at
   * once, the old one keeps verifying for `ROTATION_GRACE_SECONDS`, then dies.
   */
  async rotateSecret(ctx: AuthenticatedContext, tenant: TenantContext, secretId: string, meta: RequestMeta): Promise<IssuedPostbackSecret> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.manage");
    const tid = tenantIdOf(tenant);
    const old = await this.repo.findSecret(tid, secretId);
    if (!old) throw new AppError(404, "POSTBACK_SECRET_NOT_FOUND", "Postback secret not found");
    if (old.status !== "ACTIVE") throw new AppError(409, "POSTBACK_SECRET_NOT_ACTIVE", `Cannot rotate a ${old.status} secret`);
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + ROTATION_GRACE_SECONDS * 1000).toISOString();
    const { id, secret, insert } = await this.mintSecret(old.advertiser_profile_id, old.label, ctx.user.id);
    await this.repo.rotateSecret(tid, secretId, insert, expiresAt, now.toISOString(), [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "attribution.postback_secret.rotated",
        target_type: "advertiser_postback_secret",
        target_id: id,
        metadata: { previous_secret_id: secretId, previous_expires_at: expiresAt, secret_hint: insert.secret_hint },
        meta,
      }),
    ]);
    const row = await this.repo.findSecret(tid, id);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "Secret was not persisted");
    return { ...toSecret(row), secret, key_id: id };
  }

  /** `attribution.manage`. Immediate, terminal revocation. */
  async revokeSecret(ctx: AuthenticatedContext, tenant: TenantContext, secretId: string, meta: RequestMeta): Promise<PublicPostbackSecret> {
    this.assertOfferOrg(tenant);
    this.ensurePermission(tenant, "attribution.manage");
    const tid = tenantIdOf(tenant);
    const existing = await this.repo.findSecret(tid, secretId);
    if (!existing) throw new AppError(404, "POSTBACK_SECRET_NOT_FOUND", "Postback secret not found");
    if (existing.status === "REVOKED") throw new AppError(409, "POSTBACK_SECRET_NOT_ACTIVE", "Secret is already revoked");
    const ok = await this.repo.revokeSecret(tid, secretId, this.clock().toISOString(), [
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: "attribution.postback_secret.revoked",
        target_type: "advertiser_postback_secret",
        target_id: secretId,
        metadata: { previous_status: existing.status },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "POSTBACK_SECRET_NOT_ACTIVE", "Secret is already revoked");
    const row = await this.repo.findSecret(tid, secretId);
    if (!row) throw new AppError(404, "POSTBACK_SECRET_NOT_FOUND", "Postback secret not found");
    return toSecret(row);
  }

  // ---- public S2S postback -----------------------------------------------------------

  /**
   * Authenticate, deduplicate and attribute one S2S postback. No session, no
   * tenant context: the organization comes from the key row alone.
   */
  async processPostback(req: PostbackRequest): Promise<PostbackOutcome> {
    const now = this.clock();
    const nowIso = now.toISOString();

    // 1. strict header parse
    const parsed = parsePostbackHeaders(req.header);
    if (!parsed.ok) throw authError(parsed.failure);
    const h = parsed.headers;

    // 2. skew before any key read
    if (!isTimestampFresh(h.timestamp, Math.floor(now.getTime() / 1000), this.tolerance)) throw authError("TIMESTAMP_SKEW");

    // 3. key → secret → HMAC (always computed)
    const keyRow = await this.repo.findActiveSecretForVerification(h.key_id, nowIso);
    let secret = DUMMY_SECRET;
    if (keyRow) {
      try {
        secret = await unwrapPostbackSecret(this.masterKey, keyRow.secret_ciphertext);
      } catch (err) {
        if (err instanceof PostbackVaultError)
          throw new AppError(503, "POSTBACK_VAULT_UNAVAILABLE", "Postback verification is unavailable");
        throw err;
      }
    }
    const canonical = { method: req.method, path: req.path, timestamp: h.timestamp, nonce: h.nonce, body: req.body };
    const valid = await verifyPostbackSignature(secret, canonical, h.signature);
    if (!keyRow || !valid) throw authError("SIGNATURE_INVALID");
    const advertiserOrgId = keyRow.organization_id;

    // 4. replay check — the (org, nonce) PK is the guard
    const fresh = await this.repo.claimNonce({
      organization_id: advertiserOrgId,
      nonce: h.nonce,
      secret_id: keyRow.id,
      signed_at: new Date(h.timestamp * 1000).toISOString(),
      expires_at: nonceExpiresAt(h.timestamp, this.tolerance),
    });
    if (!fresh) throw new AppError(409, "REPLAY_DETECTED", "This postback was already received");

    // 5. body — the offer must be the key holder's own
    const body = parsePostbackBody(req.body);
    const offer = await this.offers.findById(advertiserOrgId as TenantId, body.offer_id);
    if (!offer) throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");

    // 6. policy (persisted or default)
    const policyRow = await this.repo.findCurrentPolicyForOffer(advertiserOrgId, offer.id);
    const policy = policyRow ?? (await this.materializeDefaultPolicy(advertiserOrgId, offer.id));

    // 7. dedup probe + candidates + decision
    const key = dedupKey(policy.dedup_scope, {
      external_conversion_id: body.external_conversion_id,
      transaction_id: body.transaction_id,
      click_id: body.click_id,
      conversion_event: body.conversion_event,
    });
    const duplicateOf = key ? await this.repo.findDuplicateConversion(advertiserOrgId, offer.id, key) : null;
    const candidates = duplicateOf
      ? []
      : await this.repo.listClickCandidates({
          advertiser_organization_id: advertiserOrgId,
          offer_id: offer.id,
          occurred_at: body.occurred_at,
          window_seconds: policy.window_seconds,
          echoed_click_id: body.click_id,
        });
    const result = decide({
      policy: {
        id: policy.id,
        model: policy.model,
        window_seconds: policy.window_seconds,
        dedup_scope: policy.dedup_scope,
        fallback_rule: policy.fallback_rule,
      },
      conversion: { offer_id: offer.id, occurred_at: body.occurred_at, click_id: body.click_id },
      candidates,
      duplicateOf: duplicateOf !== null,
    });

    // 8. write conversion + attribution atomically
    const conversionId = crypto.randomUUID();
    const attributionId = crypto.randomUUID();
    const status: ConversionStatus =
      result.decision === "ATTRIBUTED" ? "PENDING" : result.decision === "HELD" ? "FRAUD_REVIEW" : "REJECTED";
    try {
      await this.repo.insertConversionWithAttribution(
        advertiserOrgId,
        {
          id: conversionId,
          offer_id: offer.id,
          offer_version_id: offer.current_version_id,
          click_id: result.click_id,
          affiliate_organization_id: result.affiliate_organization_id,
          external_conversion_id: body.external_conversion_id,
          transaction_id: body.transaction_id,
          event_id: body.event_id,
          conversion_event: body.conversion_event,
          status,
          source: "S2S_POSTBACK",
          sale_amount_minor: body.sale_amount_minor,
          currency: body.currency,
          occurred_at: body.occurred_at,
          request_id: req.meta.request_id,
          // Canonical records carry the dedup identity; DUPLICATE evidence rows do not (partial UNIQUE, 0009).
          idempotency_key: key && result.decision !== "DUPLICATE" ? `${offer.id}|${key.column}|${key.value}` : null,
        },
        {
          id: attributionId,
          conversion_id: conversionId,
          click_id: result.click_id,
          affiliate_organization_id: result.affiliate_organization_id,
          offer_id: offer.id,
          rule_version: policy.id,
          decision: result.decision,
          reason_code: result.reason_code,
          click_to_conversion_seconds: result.click_to_conversion_seconds,
          request_id: req.meta.request_id,
        },
      );
    } catch (err) {
      if (err instanceof ConversionDuplicateError) {
        const existing = await this.repo.findDuplicateConversion(advertiserOrgId, offer.id, {
          column: "external_conversion_id",
          value: body.external_conversion_id,
        });
        return {
          conversion_id: existing ?? conversionId,
          attribution_id: null,
          decision: "DUPLICATE",
          reason_code: "DUPLICATE_EXTERNAL_ID",
          duplicate: true,
          duplicate_of: existing,
        };
      }
      throw err;
    }
    await this.repo.touchSecret(keyRow.id, nowIso);
    return {
      conversion_id: conversionId,
      attribution_id: attributionId,
      decision: result.decision,
      reason_code: result.reason_code,
      duplicate: result.decision === "DUPLICATE",
      duplicate_of: duplicateOf,
    };
  }

  // ---- internals -----------------------------------------------------------------

  private async mintSecret(advertiserProfileId: string, label: string | null, actorUserId: string) {
    const secret = generatePostbackSecret();
    let ciphertext: string;
    try {
      ciphertext = await wrapPostbackSecret(this.masterKey, secret);
    } catch (err) {
      if (err instanceof PostbackVaultError)
        throw new AppError(503, "POSTBACK_VAULT_UNAVAILABLE", "Postback secret vault is not configured");
      throw err;
    }
    const id = crypto.randomUUID();
    return {
      id,
      secret,
      insert: {
        id,
        advertiser_profile_id: advertiserProfileId,
        label,
        secret_ciphertext: ciphertext,
        key_version: CURRENT_KEY_VERSION,
        secret_hint: secretHint(secret),
        created_by_user_id: actorUserId,
      },
    };
  }

  /** First postback on an offer without a policy: persist the default as version 1 so `rule_version` is a real row. */
  private async materializeDefaultPolicy(advertiserOrgId: string, offerId: string): Promise<AttributionPolicyRow> {
    const tid = advertiserOrgId as TenantId;
    await this.repo.insertPolicyVersion(
      tid,
      { id: crypto.randomUUID(), offer_id: offerId, ...DEFAULT_POLICY, change_summary: "system default", created_by_user_id: null },
      [],
    );
    const row = await this.repo.findCurrentPolicyForOffer(advertiserOrgId, offerId);
    if (!row) throw new AppError(500, "INTERNAL_ERROR", "Default policy was not persisted");
    return row;
  }

  private async requireOwnOffer(tenant: TenantContext, offerId: string) {
    const offer = await this.offers.findById(tenantIdOf(tenant), offerId);
    if (!offer) throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found");
    return offer;
  }

  private assertOfferOrg(tenant: TenantContext): void {
    if (!(ATTRIBUTION_OWNER_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_ADVERTISER", "Only advertiser or agency organizations can manage attribution");
    }
  }

  private assertAffiliateOrg(tenant: TenantContext): void {
    if (!(AFFILIATE_ORG_TYPES as readonly string[]).includes(tenant.organization.type)) {
      throw new AppError(400, "ORG_TYPE_NOT_AFFILIATE", "Only affiliate or partner organizations can read their attributions");
    }
  }

  private ensurePermission(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) {
      throw new AppError(403, "FORBIDDEN", `Missing required permission: ${key}`);
    }
  }
}

// ---- parsing ---------------------------------------------------------------------

function authError(failure: PostbackAuthFailure): AppError {
  switch (failure) {
    case "SIGNATURE_MALFORMED":
      return new AppError(401, "SIGNATURE_MALFORMED", "Missing or malformed postback signature headers");
    case "TIMESTAMP_SKEW":
      return new AppError(401, "TIMESTAMP_SKEW", "Postback timestamp is outside the accepted window");
    case "SIGNATURE_INVALID":
      return new AppError(401, "SIGNATURE_INVALID", "Postback signature could not be verified");
  }
}

function parsePolicyInput(
  input: CreatePolicyInput,
  base: {
    model: AttributionModel;
    window_seconds: number;
    dedup_scope: DedupScope;
    fallback_rule: FallbackRule;
    require_signature: boolean;
  },
) {
  const model = input.model === undefined ? base.model : input.model;
  if (!(ATTRIBUTION_MODELS as readonly unknown[]).includes(model)) throw new AppError(400, "POLICY_INVALID", "Invalid request: model");
  const window = input.window_seconds === undefined ? base.window_seconds : input.window_seconds;
  if (typeof window !== "number" || !Number.isInteger(window) || window < WINDOW_SECONDS_MIN || window > WINDOW_SECONDS_MAX) {
    throw new AppError(
      400,
      "POLICY_INVALID",
      `Invalid request: window_seconds must be an integer in [${WINDOW_SECONDS_MIN}, ${WINDOW_SECONDS_MAX}]`,
    );
  }
  const scope = input.dedup_scope === undefined ? base.dedup_scope : input.dedup_scope;
  if (!(DEDUP_SCOPES as readonly unknown[]).includes(scope)) throw new AppError(400, "POLICY_INVALID", "Invalid request: dedup_scope");
  const fallback = input.fallback_rule === undefined ? base.fallback_rule : input.fallback_rule;
  if (!(FALLBACK_RULES as readonly unknown[]).includes(fallback))
    throw new AppError(400, "POLICY_INVALID", "Invalid request: fallback_rule");
  const requireSig = input.require_signature === undefined ? base.require_signature : input.require_signature;
  if (typeof requireSig !== "boolean") throw new AppError(400, "POLICY_INVALID", "Invalid request: require_signature");
  let summary: string | null = null;
  if (input.change_summary !== undefined && input.change_summary !== null) {
    if (typeof input.change_summary !== "string" || input.change_summary.length > 500) {
      throw new AppError(400, "POLICY_INVALID", "Invalid request: change_summary");
    }
    summary = input.change_summary.trim() || null;
  }
  return {
    model: model as AttributionModel,
    window_seconds: window,
    dedup_scope: scope as DedupScope,
    fallback_rule: fallback as FallbackRule,
    require_signature: requireSig,
    change_summary: summary,
  };
}

function parseLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > LABEL_MAX_LENGTH) throw new AppError(400, "VALIDATION_ERROR", "Invalid request: label");
  return raw.trim() || null;
}

export interface ParsedPostbackBody {
  offer_id: string;
  external_conversion_id: string;
  transaction_id: string | null;
  event_id: string | null;
  click_id: string | null;
  conversion_event: string;
  occurred_at: string;
  sale_amount_minor: number | null;
  currency: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

function optionalId(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > ID_MAX_LENGTH || !ID_PATTERN.test(v)) {
    throw new AppError(400, "POSTBACK_INVALID", `Invalid request: ${key}`);
  }
  return v;
}

/** Validate the JSON body. Money is integer minor units only — no floats (PRD §12). */
export function parsePostbackBody(raw: string): ParsedPostbackBody {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: body must be a JSON object");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: body must be a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const offer_id = optionalId(obj, "offer_id");
  if (!offer_id) throw new AppError(400, "POSTBACK_INVALID", "Invalid request: offer_id");
  const external_conversion_id = optionalId(obj, "external_conversion_id");
  if (!external_conversion_id || external_conversion_id.length > EXTERNAL_ID_MAX_LENGTH) {
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: external_conversion_id");
  }
  const eventRaw = obj["conversion_event"];
  const conversion_event = eventRaw === undefined || eventRaw === null ? "conversion" : eventRaw;
  if (typeof conversion_event !== "string" || conversion_event.length === 0 || conversion_event.length > EVENT_MAX_LENGTH) {
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: conversion_event");
  }
  const occurredRaw = obj["occurred_at"];
  if (typeof occurredRaw !== "string" || !Number.isFinite(Date.parse(occurredRaw))) {
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: occurred_at must be an ISO-8601 timestamp");
  }
  const occurred_at = new Date(Date.parse(occurredRaw)).toISOString();
  const amountRaw = obj["sale_amount_minor"];
  let sale_amount_minor: number | null = null;
  if (amountRaw !== undefined && amountRaw !== null) {
    if (typeof amountRaw !== "number" || !Number.isInteger(amountRaw) || amountRaw < 0) {
      throw new AppError(400, "POSTBACK_INVALID", "Invalid request: sale_amount_minor must be a non-negative integer (minor units)");
    }
    sale_amount_minor = amountRaw;
  }
  const currencyRaw = obj["currency"];
  let currency: string | null = null;
  if (currencyRaw !== undefined && currencyRaw !== null) {
    if (typeof currencyRaw !== "string" || !/^[A-Z]{3}$/.test(currencyRaw)) {
      throw new AppError(400, "POSTBACK_INVALID", "Invalid request: currency must be a 3-letter ISO code");
    }
    currency = currencyRaw;
  }
  if (sale_amount_minor !== null && currency === null)
    throw new AppError(400, "POSTBACK_INVALID", "Invalid request: currency is required with sale_amount_minor");
  return {
    offer_id,
    external_conversion_id,
    transaction_id: optionalId(obj, "transaction_id"),
    event_id: optionalId(obj, "event_id"),
    click_id: optionalId(obj, "click_id"),
    conversion_event,
    occurred_at,
    sale_amount_minor,
    currency,
  };
}

// ---- mappers ---------------------------------------------------------------------

function toPolicy(r: AttributionPolicyRow): PublicAttributionPolicy {
  return {
    id: r.id,
    offer_id: r.offer_id,
    organization_id: r.organization_id,
    version_number: r.version_number,
    is_current: r.is_current === 1,
    model: r.model,
    window_seconds: r.window_seconds,
    dedup_scope: r.dedup_scope,
    fallback_rule: r.fallback_rule,
    require_signature: r.require_signature === 1,
    change_summary: r.change_summary,
    created_by_user_id: r.created_by_user_id,
    created_at: r.created_at,
  };
}

function toConversion(r: ConversionRow): PublicConversion {
  return {
    id: r.id,
    organization_id: r.organization_id,
    offer_id: r.offer_id,
    offer_version_id: r.offer_version_id,
    click_id: r.click_id,
    affiliate_organization_id: r.affiliate_organization_id,
    external_conversion_id: r.external_conversion_id,
    transaction_id: r.transaction_id,
    event_id: r.event_id,
    conversion_event: r.conversion_event,
    status: r.status,
    source: r.source,
    sale_amount_minor: r.sale_amount_minor,
    currency: r.currency,
    occurred_at: r.occurred_at,
    received_at: r.received_at,
    created_at: r.created_at,
  };
}

function toAttribution(r: AttributionRow): PublicAttribution {
  return {
    id: r.id,
    conversion_id: r.conversion_id,
    click_id: r.click_id,
    organization_id: r.organization_id,
    affiliate_organization_id: r.affiliate_organization_id,
    offer_id: r.offer_id,
    rule_version: r.rule_version,
    decision: r.decision,
    reason_code: r.reason_code,
    click_to_conversion_seconds: r.click_to_conversion_seconds,
    decided_at: r.decided_at,
  };
}

/** Public columns only; `secret_ciphertext` never reaches this mapper (the row type has no such field). */
function toSecret(r: PostbackSecretRow): PublicPostbackSecret {
  return {
    id: r.id,
    organization_id: r.organization_id,
    label: r.label,
    secret_hint: r.secret_hint,
    status: r.status,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    created_at: r.created_at,
  };
}
