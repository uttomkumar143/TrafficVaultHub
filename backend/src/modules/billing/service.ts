/**
 * BillingService — Phase 5 Unit 8b (PRD §62): advertiser funding protection
 * over migration 0011 (`advertiser_billing_profiles`, `advertiser_funding_events`,
 * `funding_alerts`).
 *
 * evaluateFunding(advertiser org):
 *   1. Load the billing profile; measure the facts the pure `capacity()` needs
 *      (PREPAID: ADVERTISER_PREPAID ledger balance in the profile currency,
 *      computed from ledger_entries via LedgerRepository — never stored).
 *   2. `required_minor` = caller override, else the largest single-conversion
 *      `advertiser_payout_minor` across the advertiser's LIVE offers whose
 *      current version is in the profile currency (other-currency versions are
 *      never mixed in — they cannot be funded by this profile and are reported
 *      in `ignored_other_currency_offer_ids`). No LIVE offers → 0.
 *   3. Sufficient → return the decision; NOTHING is written (no auto-clear:
 *      resuming paused offers is an explicit human action, Unit 9+).
 *   4. Insufficient → funding protection, all idempotent:
 *        - ONE db.batch: guarded UPDATE setting funding_protection_active=1
 *          (+ since) only if it was 0; FUNDING_PROTECTION_TRIGGERED funding
 *          event (only when newly activated); funding_alerts rows for
 *          ADVERTISER and OPERATIONS with INSERT OR IGNORE on the UNIQUE
 *          (audience, dedupe_key) where dedupe_key =
 *          INSUFFICIENT_CAPACITY:<profile>:<since> — stable for the whole
 *          protection episode, so a second run adds no alert; audit row
 *          `billing.funding_protection_evaluated` in the SAME batch.
 *        - Then every LIVE offer of the advertiser is paused through
 *          OfferService.platformTransition (LIVE → PAUSED, PLATFORM actor,
 *          reason FUNDING_PROTECTION) — the existing audited, cache-
 *          invalidating path; offers.status is never written here. A second
 *          run finds no LIVE offer → no second pause.
 *      Alerts are audit/notification rows only; nothing is sent from here.
 *
 * Permissions (checked synchronously before any async work, 403 FORBIDDEN):
 *   evaluateFunding — PLATFORM org with `billing.manage` AND `offers.pause`
 *                     (the pause goes through OfferService, which demands it).
 *   getMyProfile     — `billing.read`, the caller's OWN org only (advertisers).
 *   getProfileFor    — PLATFORM org with `billing.read`, any advertiser.
 */

import { AppError } from "../../lib/errors";
import { scopedQuery, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { LedgerRepository } from "../ledger/repository";
import type { OfferService } from "../offers/service";
import type { PermissionKey } from "../rbac/permissions";
import {
  FundingError,
  capacity,
  type BillingProfileFacts,
  type BillingStatus,
  type CapacityDecision,
  type FundingModel,
  type RiskStatus,
} from "./funding";

// ---------------------------------------------------------------------------
// Rows (mirror 0011_billing_payouts.sql)
// ---------------------------------------------------------------------------

export interface BillingProfileRow extends BillingProfileFacts {
  readonly id: string;
  readonly organization_id: string;
  readonly advertiser_profile_id: string;
  readonly funding_model: FundingModel;
  readonly available_credit_minor: number;
  readonly low_balance_threshold_minor: number;
  readonly risk_status: RiskStatus;
  readonly billing_status: BillingStatus;
  /** SQLite boolean 0 | 1. */
  readonly funding_protection_active: number;
  readonly funding_protection_since: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FundingAlertRow {
  readonly id: string;
  readonly organization_id: string;
  readonly billing_profile_id: string;
  readonly audience: "ADVERTISER" | "OPERATIONS";
  readonly alert_type: string;
  readonly severity: string;
  readonly dedupe_key: string;
  readonly payload: string;
  readonly acknowledged_at: string | null;
  readonly created_at: string;
}

interface LiveOfferRow {
  readonly id: string;
  readonly status: string;
  readonly version_currency: string | null;
  readonly advertiser_payout_minor: number | null;
}

const PREPAID_ACCOUNT_CODE = "ADVERTISER_PREPAID";
const PROFILE_COLUMNS = `id, organization_id, advertiser_profile_id, funding_model, currency, credit_limit_minor, used_credit_minor,
  available_credit_minor, payment_terms_days, low_balance_threshold_minor, risk_status, billing_status,
  funding_protection_active, funding_protection_since, created_at, updated_at`;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class BillingRepository {
  constructor(private readonly db: D1Database) {}

  findProfileByOrg(tenantId: TenantId): Promise<BillingProfileRow | null> {
    return scopedQuery(
      this.db,
      `SELECT ${PROFILE_COLUMNS} FROM advertiser_billing_profiles WHERE organization_id = ?`,
      tenantId,
    ).first<BillingProfileRow>();
  }

  /** The advertiser's LIVE offers with their current version's currency and payout. */
  async listLiveOffers(tenantId: TenantId): Promise<LiveOfferRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT o.id, o.status, v.currency AS version_currency, v.advertiser_payout_minor
         FROM offers o
         LEFT JOIN offer_versions v ON v.id = o.current_version_id
        WHERE o.organization_id = ? AND o.status = 'LIVE'
        ORDER BY o.id ASC`,
      tenantId,
    ).all<LiveOfferRow>();
    return res.results;
  }

  listAlerts(tenantId: TenantId): Promise<FundingAlertRow[]> {
    return scopedQuery(
      this.db,
      `SELECT id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload, acknowledged_at, created_at
         FROM funding_alerts WHERE organization_id = ? ORDER BY created_at ASC, audience ASC`,
      tenantId,
    )
      .all<FundingAlertRow>()
      .then((r) => r.results);
  }

  /** Guarded: only flips 0 → 1; a second run matches no row and is a no-op. */
  activateProtectionStatement(profileId: string, since: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE advertiser_billing_profiles
            SET funding_protection_active = 1, funding_protection_since = ?, updated_at = ?
          WHERE id = ? AND funding_protection_active = 0`,
      )
      .bind(since, since, profileId);
  }

  fundingEventStatement(e: {
    profile: BillingProfileRow;
    event_type: "FUNDING_PROTECTION_TRIGGERED";
    before_state: Record<string, unknown>;
    after_state: Record<string, unknown>;
    idempotency_key: string;
    actor_user_id: string | null;
    note: string | null;
    request_id: string | null;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO advertiser_funding_events
           (id, billing_profile_id, organization_id, event_type, amount_minor, currency, before_state, after_state,
            idempotency_key, actor_type, actor_user_id, note, request_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'PLATFORM', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        e.profile.id,
        e.profile.organization_id,
        e.event_type,
        e.profile.currency,
        JSON.stringify(e.before_state),
        JSON.stringify(e.after_state),
        e.idempotency_key,
        e.actor_user_id,
        e.note,
        e.request_id,
      );
  }

  /** INSERT OR IGNORE on UNIQUE (audience, dedupe_key): the idempotency of alerting. */
  alertStatement(a: {
    profile: BillingProfileRow;
    audience: "ADVERTISER" | "OPERATIONS";
    alert_type: "INSUFFICIENT_CAPACITY";
    severity: "CRITICAL";
    dedupe_key: string;
    payload: Record<string, unknown>;
    request_id: string | null;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO funding_alerts
           (id, organization_id, billing_profile_id, audience, alert_type, severity, dedupe_key, payload, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        a.profile.organization_id,
        a.profile.id,
        a.audience,
        a.alert_type,
        a.severity,
        a.dedupe_key,
        JSON.stringify(a.payload),
        a.request_id,
      );
  }

  async batch(statements: D1PreparedStatement[]): Promise<void> {
    await this.db.batch(statements);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface EvaluateFundingInput {
  /** Override the measured requirement (integer minor units ≥ 0, profile currency). */
  readonly required_minor?: number;
}

export interface FundingEvaluation {
  readonly organization_id: string;
  readonly billing_profile_id: string;
  readonly decision: CapacityDecision;
  /** PREPAID only: the measured ADVERTISER_PREPAID balance; null for other models. */
  readonly prepaid_balance_minor: number | null;
  readonly protection_active: boolean;
  readonly protection_since: string | null;
  /** True when THIS call flipped protection on. */
  readonly protection_activated: boolean;
  /** Offers paused by THIS call (empty on a repeat run). */
  readonly paused_offer_ids: string[];
  /** LIVE offers whose current version is in another currency (excluded from `required`, still paused). */
  readonly ignored_other_currency_offer_ids: string[];
  /** Alerts rows inserted by THIS call (0 on a repeat run). */
  readonly alerts_written: number;
}

export interface BillingServiceOptions {
  readonly now?: () => Date;
}

export const FUNDING_PROTECTION_REASON = "FUNDING_PROTECTION: insufficient advertiser funding capacity";

export class BillingService {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingRepository,
    private readonly ledger: LedgerRepository,
    private readonly offers: OfferService,
    private readonly audit: AuditRepository,
    options: BillingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // ---- reads ----------------------------------------------------------------

  /** `billing.read`; the caller's OWN organization only. */
  getMyProfile(tenant: TenantContext): Promise<BillingProfileRow> {
    this.require(tenant, "billing.read");
    return this.mustFindProfile(tenant.organization.id as TenantId);
  }

  /** PLATFORM + `billing.read`; any advertiser organization. */
  getProfileFor(tenant: TenantContext, advertiserOrgId: string): Promise<BillingProfileRow> {
    this.assertPlatform(tenant);
    this.require(tenant, "billing.read");
    return this.mustFindProfile(advertiserOrgId as TenantId);
  }

  /** `billing.read`; the caller's OWN organization's alerts (both audiences are ABOUT this org). */
  listMyAlerts(tenant: TenantContext): Promise<FundingAlertRow[]> {
    this.require(tenant, "billing.read");
    return this.billing.listAlerts(tenant.organization.id as TenantId);
  }

  // ---- funding protection -----------------------------------------------------

  /** PLATFORM + `billing.manage` + `offers.pause`. See module header. */
  evaluateFunding(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    advertiserOrgId: string,
    input: EvaluateFundingInput,
    meta: RequestMeta,
  ): Promise<FundingEvaluation> {
    this.assertPlatform(tenant);
    this.require(tenant, "billing.manage");
    this.require(tenant, "offers.pause");
    if (typeof advertiserOrgId !== "string" || advertiserOrgId.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request: organization_id");
    }
    if (input.required_minor !== undefined && (!Number.isSafeInteger(input.required_minor) || input.required_minor < 0)) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request: required_minor");
    }
    return this.doEvaluate(ctx, tenant, advertiserOrgId as TenantId, input, meta);
  }

  private async doEvaluate(
    ctx: AuthenticatedContext,
    tenant: TenantContext,
    advertiserOrgId: TenantId,
    input: EvaluateFundingInput,
    meta: RequestMeta,
  ): Promise<FundingEvaluation> {
    const profile = await this.mustFindProfile(advertiserOrgId);
    const live = await this.billing.listLiveOffers(advertiserOrgId);

    const sameCurrency = live.filter((o) => o.version_currency === profile.currency);
    const ignored = live.filter((o) => o.version_currency !== profile.currency).map((o) => o.id);
    const measuredRequired = sameCurrency.reduce((max, o) => Math.max(max, o.advertiser_payout_minor ?? 0), 0);
    const required = input.required_minor ?? measuredRequired;

    const prepaidBalance = profile.funding_model === "PREPAID" ? await this.prepaidBalance(advertiserOrgId, profile.currency) : null;

    let decision: CapacityDecision;
    try {
      decision = capacity(profile, {
        currency: profile.currency,
        required_minor: required,
        ...(prepaidBalance === null ? {} : { prepaid_balance_minor: prepaidBalance }),
      });
    } catch (e) {
      if (e instanceof FundingError) throw new AppError(422, e.code, e.message);
      throw e;
    }

    if (decision.ok) {
      return {
        organization_id: profile.organization_id,
        billing_profile_id: profile.id,
        decision,
        prepaid_balance_minor: prepaidBalance,
        protection_active: profile.funding_protection_active === 1,
        protection_since: profile.funding_protection_since,
        protection_activated: false,
        paused_offer_ids: [],
        ignored_other_currency_offer_ids: ignored,
        alerts_written: 0,
      };
    }

    // ---- insufficient: protect (idempotent) -----------------------------------
    const alreadyActive = profile.funding_protection_active === 1 && profile.funding_protection_since !== null;
    const since = alreadyActive ? (profile.funding_protection_since as string) : this.now().toISOString();
    const dedupeKey = `INSUFFICIENT_CAPACITY:${profile.id}:${since}`;
    const payload = {
      alert: "INSUFFICIENT_CAPACITY",
      organization_id: profile.organization_id,
      billing_profile_id: profile.id,
      funding_model: decision.funding_model,
      currency: decision.currency,
      reason: decision.reason,
      capacity_minor: decision.capacity_minor,
      required_minor: decision.required_minor,
      shortfall_minor: decision.shortfall_minor,
      live_offer_ids: live.map((o) => o.id),
      protection_since: since,
    };
    const alertsBefore = (await this.billing.listAlerts(advertiserOrgId)).length;

    const statements: D1PreparedStatement[] = [];
    if (!alreadyActive) {
      statements.push(this.billing.activateProtectionStatement(profile.id, since));
      statements.push(
        this.billing.fundingEventStatement({
          profile,
          event_type: "FUNDING_PROTECTION_TRIGGERED",
          before_state: { funding_protection_active: 0, funding_protection_since: null },
          after_state: { funding_protection_active: 1, funding_protection_since: since, decision },
          idempotency_key: `FUNDING_PROTECTION_TRIGGERED:${profile.id}:${since}`,
          actor_user_id: ctx.user.id,
          note: FUNDING_PROTECTION_REASON,
          request_id: meta.request_id,
        }),
      );
    }
    for (const audience of ["ADVERTISER", "OPERATIONS"] as const) {
      statements.push(
        this.billing.alertStatement({
          profile,
          audience,
          alert_type: "INSUFFICIENT_CAPACITY",
          severity: "CRITICAL",
          dedupe_key: dedupeKey,
          payload: { ...payload, audience },
          request_id: meta.request_id,
        }),
      );
    }
    statements.push(
      this.audit.statement({
        organization_id: profile.organization_id,
        actor_user_id: ctx.user.id,
        action: "billing.funding_protection_evaluated",
        target_type: "advertiser_billing_profile",
        target_id: profile.id,
        metadata: { ...payload, protection_activated: !alreadyActive, actor_organization_id: tenant.organization.id },
        meta,
      }),
    );
    await this.billing.batch(statements);
    const alertsAfter = (await this.billing.listAlerts(advertiserOrgId)).length;

    // Pause through the existing audited, cache-invalidating transition path.
    const paused: string[] = [];
    for (const offer of live) {
      await this.offers.platformTransition(ctx, tenant, offer.id, { to: "PAUSED", reason: FUNDING_PROTECTION_REASON }, meta);
      paused.push(offer.id);
    }

    return {
      organization_id: profile.organization_id,
      billing_profile_id: profile.id,
      decision,
      prepaid_balance_minor: prepaidBalance,
      protection_active: true,
      protection_since: since,
      protection_activated: !alreadyActive,
      paused_offer_ids: paused,
      ignored_other_currency_offer_ids: ignored,
      alerts_written: alertsAfter - alertsBefore,
    };
  }

  // ---- helpers ------------------------------------------------------------------

  /** ADVERTISER_PREPAID balance (credit − debit) in `currency`; 0 when the org has no such account. */
  private async prepaidBalance(tenantId: TenantId, currency: string): Promise<number> {
    const accounts = await this.ledger.accountsOf(tenantId);
    const account = [...accounts.values()].find((a) => a.code === PREPAID_ACCOUNT_CODE && a.currency === currency);
    if (!account) return 0;
    return (await this.ledger.computeBalance(tenantId, account.id)).balance_minor;
  }

  private async mustFindProfile(tenantId: TenantId): Promise<BillingProfileRow> {
    const row = await this.billing.findProfileByOrg(tenantId);
    if (!row) throw new AppError(404, "BILLING_PROFILE_NOT_FOUND", "billing profile not found");
    return row;
  }

  private assertPlatform(tenant: TenantContext): void {
    if (tenant.organization.type !== "PLATFORM") {
      throw new AppError(403, "FORBIDDEN", "Only platform organizations can manage advertiser funding");
    }
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }
}
