/**
 * LedgerService — Phase 5 Unit 4 (PRD §56–§58, §114, §131).
 *
 * Orchestrates the pure layer (journal.ts) and the repositories:
 *
 *   postConversionCommission
 *     1. load the conversion, its PINNED offer version (by id, never
 *        "current") and the posting facts (already posted? reversed?)
 *     2. verifyConversionPosting FIRST — every stored amount is recomputed
 *        from the pinned version and must match exactly
 *     3. on reject: write ONE financial_processing_errors row (+ audit) and
 *        post NOTHING to the ledger (§131 fail-safe)
 *     4. on success: journal + legs + commissions row + ledger audit +
 *        the conversion's guarded APPROVED→LEDGER_POSTED transition (with its
 *        own history + audit rows) in ONE db.batch. Either everything lands
 *        or nothing does.
 *
 *   postReversal
 *     Builds the compensating journal for the original CONVERSION_COMMISSION
 *     journal (mirrored legs, same total) and posts it as a NEW journal that
 *     references the original. Original rows are never touched — the 0010
 *     triggers make that impossible anyway.
 *
 * Authorization: HTTP callers pass a TenantContext and must hold the
 * permission (403 FORBIDDEN otherwise). Trusted internal callers use
 * `internal.*` which takes no TenantContext and must never be mounted on a
 * route.
 */

import { AppError } from "../../lib/errors";
import { tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import type { AuditRepository } from "../audit/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { RequestMeta } from "../auth/repository";
import type { ConversionRepository } from "../conversions/repository";
import type { InternalConversionOps } from "../conversions/service";
import type { PermissionKey } from "../rbac/permissions";
import {
  buildCompensatingJournal,
  buildConversionCommissionJournal,
  captureLedger,
  conversionReversalIdempotencyKey,
  verifyConversionPosting,
  type CommissionDraft,
  type ConversionForPosting,
} from "./journal";
import {
  classifyLedgerWriteError,
  type CommissionRow,
  type JournalHeader,
  type JournalRow,
  type LedgerRepository,
  type ProcessingErrorRow,
} from "./repository";

export interface LedgerRepositories {
  readonly ledger: LedgerRepository;
  readonly conversions: ConversionRepository;
  /** The conversions module's INTERNAL transition ops (ConversionService.internal). */
  readonly conversionOps: InternalConversionOps;
}

export interface LedgerServiceOptions {
  readonly now?: () => Date;
}

export type PostCommissionResult =
  | { readonly outcome: "POSTED"; readonly journal: JournalRow; readonly commission: CommissionRow }
  | { readonly outcome: "REJECTED"; readonly reason_code: string; readonly processing_error: ProcessingErrorRow };

export interface PostReversalInput {
  readonly conversion_id: string;
  readonly description?: string | null;
}

interface Actor {
  readonly actor_type: "TENANT" | "PLATFORM" | "INTERNAL";
  readonly user_id: string | null;
  readonly meta: RequestMeta;
}

const NO_META: RequestMeta = { ip_address: null, user_agent: null, request_id: null };

export class LedgerService {
  private readonly now: () => Date;
  /** INTERNAL actor entry points — never reachable over HTTP. */
  readonly internal: InternalLedgerOps;

  constructor(
    private readonly repos: LedgerRepositories,
    private readonly audit: AuditRepository,
    options: LedgerServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.internal = new InternalLedgerOps(this);
  }

  // ---- HTTP entry points (permission-checked) ---------------------------------

  postConversionCommission(ctx: AuthenticatedContext, tenant: TenantContext, conversionId: string, meta: RequestMeta): Promise<PostCommissionResult> {
    this.require(tenant, "ledger.adjust");
    return this.postCommission(tenantIdOf(tenant), conversionId, { actor_type: actorOf(tenant), user_id: ctx.user.id, meta });
  }

  postReversal(ctx: AuthenticatedContext, tenant: TenantContext, input: PostReversalInput, meta: RequestMeta): Promise<JournalRow> {
    this.require(tenant, "ledger.adjust");
    return this.reverse(tenantIdOf(tenant), input, { actor_type: actorOf(tenant), user_id: ctx.user.id, meta });
  }

  getJournal(tenant: TenantContext, journalId: string): Promise<JournalRow | null> {
    this.require(tenant, "ledger.read");
    return this.repos.ledger.findJournal(tenantIdOf(tenant), journalId);
  }

  // ---- core ---------------------------------------------------------------------

  /** @internal shared by HTTP and INTERNAL entry points */
  async postCommission(tenantId: TenantId, conversionId: string, actor: Actor): Promise<PostCommissionResult> {
    const { ledger, conversions, conversionOps } = this.repos;
    const requestId = actor.meta.request_id;

    const conversion = await conversions.findById(tenantId, conversionId);
    if (!conversion) throw new AppError(404, "NOT_FOUND", "conversion not found");

    const [facts, version, accounts] = await Promise.all([
      ledger.postingFacts(tenantId, conversionId),
      conversion.offer_version_id ? ledger.pinnedOfferVersion(tenantId, conversion.offer_version_id) : Promise.resolve(null),
      ledger.accountsOf(tenantId),
    ]);

    // Verify FIRST, then build the journal — all pure, nothing written yet.
    const verified = captureLedger<{ commission: CommissionDraft; draft: ReturnType<typeof buildConversionCommissionJournal> }>(() => {
      const commission = verifyConversionPosting(conversion as ConversionForPosting, version, facts);
      const draft = buildConversionCommissionJournal(commission, accounts);
      return { commission, draft };
    });

    if (!verified.ok) {
      const errorId = await ledger.recordProcessingError(
        {
          organization_id: tenantId,
          operation: "POST_CONVERSION_COMMISSION",
          reference_type: "CONVERSION",
          reference_id: conversionId,
          reason_code: verified.reason_code,
          detail: verified.detail ?? null,
          request_id: requestId,
        },
        [
          this.audit.statement({
            organization_id: tenantId,
            actor_user_id: actor.user_id,
            action: "ledger.commission.rejected",
            target_type: "conversion",
            target_id: conversionId,
            metadata: { reason_code: verified.reason_code, detail: verified.detail ?? null, actor: actor.actor_type },
            meta: actor.meta,
          }),
        ],
      );
      const errors = await ledger.listProcessingErrors(tenantId, "CONVERSION", conversionId);
      const processing_error = errors.find((e) => e.id === errorId);
      if (!processing_error) throw new AppError(500, "PROCESSING_ERROR_NOT_WRITTEN", "processing error did not persist");
      return { outcome: "REJECTED", reason_code: verified.reason_code, processing_error };
    }

    const { commission, draft } = verified.value;
    const journalId = crypto.randomUUID();
    const commissionId = crypto.randomUUID();
    const header: JournalHeader = {
      id: journalId,
      actor_type: actor.actor_type,
      posted_by_user_id: actor.user_id,
      request_id: requestId,
      posted_at: this.now().toISOString(),
    };
    const { statements } = ledger.journalStatements(draft, header, [
      ledger.commissionStatement(commission, journalId, commissionId),
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.commission.posted",
        target_type: "journal_entry",
        target_id: journalId,
        metadata: {
          conversion_id: conversionId,
          commission_id: commissionId,
          offer_version_id: commission.offer_version_id,
          currency: commission.currency,
          affiliate_commission_minor: commission.affiliate_commission_minor,
          total_minor: draft.total_minor,
          actor: actor.actor_type,
        },
        meta: actor.meta,
      }),
    ]);

    // ONE batch: guarded APPROVED→LEDGER_POSTED update + history + audit + journal + legs + commission + audit.
    try {
      await conversionOps.markLedgerPosted(tenantId, conversionId, "LEDGER_POSTED", requestId, statements);
    } catch (err) {
      // CONVERSION_STATE_CONFLICT etc. from the conversions repo pass through; raw DB
      // errors (UNIQUE idempotency key / commissions.conversion_id, triggers) get stable codes.
      if (err instanceof AppError) throw err;
      throw classifyLedgerWriteError(err);
    }

    const [journal, commissionRow] = await Promise.all([
      ledger.findJournal(tenantId, journalId),
      ledger.findCommissionByConversion(tenantId, conversionId),
    ]);
    if (!journal || !commissionRow || commissionRow.journal_id !== journalId) {
      throw new AppError(500, "LEDGER_WRITE_FAILED", "commission posting did not persist");
    }
    return { outcome: "POSTED", journal, commission: commissionRow };
  }

  /** @internal shared by HTTP and INTERNAL entry points */
  async reverse(tenantId: TenantId, input: PostReversalInput, actor: Actor): Promise<JournalRow> {
    const { ledger } = this.repos;
    const commission = await ledger.findCommissionByConversion(tenantId, input.conversion_id);
    if (!commission) throw new AppError(404, "COMMISSION_NOT_FOUND", "no commission is posted for this conversion");
    const original = await ledger.getPostedJournal(tenantId, commission.journal_id);
    if (!original) throw new AppError(404, "JOURNAL_NOT_FOUND", "original journal not found");
    const accounts = await ledger.accountsOf(tenantId);

    const built = captureLedger(() =>
      buildCompensatingJournal(
        {
          original,
          reference_type: "CONVERSION_REVERSAL",
          reference_id: input.conversion_id,
          idempotency_key: conversionReversalIdempotencyKey(input.conversion_id),
          description: input.description ?? `reversal of journal ${original.id}`,
        },
        accounts,
      ),
    );
    if (!built.ok) {
      await ledger.recordProcessingError({
        organization_id: tenantId,
        operation: "POST_CONVERSION_REVERSAL",
        reference_type: "CONVERSION_REVERSAL",
        reference_id: input.conversion_id,
        reason_code: built.reason_code,
        detail: built.detail ?? null,
        request_id: actor.meta.request_id,
      });
      throw new AppError(409, built.reason_code, built.detail ?? "compensating journal refused");
    }

    const journalId = crypto.randomUUID();
    const header: JournalHeader = {
      id: journalId,
      actor_type: actor.actor_type,
      posted_by_user_id: actor.user_id,
      request_id: actor.meta.request_id,
      posted_at: this.now().toISOString(),
    };
    await ledger.postJournal(built.value, header, [
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: actor.user_id,
        action: "ledger.commission.reversed",
        target_type: "journal_entry",
        target_id: journalId,
        metadata: { conversion_id: input.conversion_id, reverses_journal_id: original.id, total_minor: original.total_minor, actor: actor.actor_type },
        meta: actor.meta,
      }),
    ]);
    const journal = await ledger.findJournal(tenantId, journalId);
    if (!journal) throw new AppError(500, "LEDGER_WRITE_FAILED", "reversal did not persist");
    return journal;
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }
}

/** INTERNAL actor (money pipeline). No TenantContext, no permission check; never mount on a route. */
export class InternalLedgerOps {
  constructor(private readonly svc: LedgerService) {}

  postConversionCommission(tenantId: TenantId, conversionId: string, requestId: string | null = null): Promise<PostCommissionResult> {
    return this.svc.postCommission(tenantId, conversionId, { actor_type: "INTERNAL", user_id: null, meta: { ...NO_META, request_id: requestId } });
  }

  postReversal(tenantId: TenantId, conversionId: string, requestId: string | null = null): Promise<JournalRow> {
    return this.svc.reverse(tenantId, { conversion_id: conversionId }, { actor_type: "INTERNAL", user_id: null, meta: { ...NO_META, request_id: requestId } });
  }
}

function actorOf(tenant: TenantContext): "TENANT" | "PLATFORM" {
  return tenant.organization.type === "PLATFORM" ? "PLATFORM" : "TENANT";
}
