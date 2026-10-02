/**
 * Reconciliation — Phase 4 Unit 9 (PRD §48, §115, §127).
 *
 * Compares what an advertiser reports for a period against what TVH recorded
 * and against the approved/rejected outcomes, keyed by external_conversion_id.
 *
 * Pure core: diffConversions(reported, tvh) → Mismatch[] with the types
 *   MISSING_IN_TVH          reported by the advertiser, no TVH conversion
 *   MISSING_AT_ADVERTISER   TVH conversion the advertiser did not report
 *   CURRENCY_MISMATCH       both sides carry a currency and they differ
 *                           (amounts are then not comparable → no AMOUNT check)
 *   AMOUNT_MISMATCH         sale amounts differ (null vs a number counts as a
 *                           difference; both null is a match)
 *   STATUS_MISMATCH         advertiser status ≠ TVH lifecycle folded to
 *                           APPROVED / REJECTED / PENDING
 *   Lifecycle fold: APPROVED, LEDGER_POSTED, EARNED, PAYOUT_ELIGIBLE, PAID → APPROVED;
 *                   REJECTED, REVERSED → REJECTED; everything else → PENDING.
 *   A matched pair may yield several mismatches (one case per type) so the
 *   reviewer sees every discrepancy, not only the first.
 *
 * Ledger side (Phase 5 Unit 15, §114 #6): the run also compares, for the SAME
 *   tenant and period and in integer minor units of ONE currency per pair,
 *     conversions (occurred_at in period) ↔ commissions ↔ posted journal
 *       (journal_entries, reference_type CONVERSION, reference_id = conversion)
 *     PAID payouts (paid_at in period) ↔ PAYOUT journals (reference_id = payout)
 *   and writes ledger_status MATCHED | MISMATCHED plus one LEDGER_MISMATCH case
 *   per discrepancy (detail code in tvh_status, see LEDGER_DETAIL):
 *     COMMISSION_MISSING          ledger-bearing lifecycle, no commissions row
 *     JOURNAL_MISSING             commission whose journal is not a CONVERSION
 *                                 journal of that conversion (tampered / missing)
 *     JOURNAL_AMOUNT_MISMATCH     journal total ≠ commission debit total
 *     JOURNAL_CURRENCY_MISMATCH   journal currency ≠ commission currency
 *     COMMISSION_WITHOUT_POSTING  commission on a conversion that never reached
 *                                 LEDGER_POSTED (pre-posting lifecycle)
 *     JOURNAL_WITHOUT_COMMISSION  CONVERSION journal no commission points at
 *     PAYOUT_JOURNAL_MISSING      PAID payout with no PAYOUT journal
 *     PAYOUT_JOURNAL_MISMATCH     PAYOUT journal amount / currency ≠ payout
 *   For LEDGER_MISMATCH cases reported_* carries the JOURNAL side and tvh_*
 *   the commission / payout side; payout cases carry `payout:<id>` in
 *   external_conversion_id (conversion_id NULL). NOT_AVAILABLE is no longer
 *   written by this service (still the column default for legacy rows).
 *
 * Persistence (repository in this file, migration 0009): a run writes the
 *   reconciliation_runs row + every reconciliation_cases row + the audit row in
 *   ONE db.batch — either the whole run exists or nothing does. The run is
 *   computed in memory first, so the row is written COMPLETED (a RUNNING row
 *   would never be observable inside an atomic batch).
 *
 * Permissions: run() needs reconciliation.manage; reads need
 *   reconciliation.read; runScheduled(tenantId, input) is for internal
 *   schedulers only (no TenantContext, no route): trigger SCHEDULED,
 *   started_by_user_id NULL, audit actor NULL.
 *
 * resolveCase(): OPEN → RESOLVED | IGNORED with a reason_code through a
 *   guarded UPDATE (out-of-CHECK sentinel when the row is no longer OPEN →
 *   SQLite rejects, the batch rolls back, 409 CASE_STATE_CONFLICT, nothing
 *   written — not even the audit row).
 */

import { AppError } from "../../lib/errors";
import type { Page, PageRequest } from "../../lib/pagination";
import { slicePage } from "../../lib/pagination";
import { scopedQuery, tenantIdOf, type TenantId } from "../../lib/tenant-scope";
import { hasPermission, type TenantContext } from "../../middleware/require-org";
import { AuditRepository } from "../audit/repository";
import type { RequestMeta } from "../auth/repository";
import type { AuthenticatedContext } from "../auth/service";
import type { ConversionStatus } from "../conversions/state-machine";
import type { PermissionKey } from "../rbac/permissions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mismatch types the advertiser-report diff emits. */
export const MISMATCH_TYPES = ["MISSING_IN_TVH", "MISSING_AT_ADVERTISER", "CURRENCY_MISMATCH", "AMOUNT_MISMATCH", "STATUS_MISMATCH"] as const;
export type MismatchType = (typeof MISMATCH_TYPES)[number];
/** Every value the reconciliation_cases.mismatch_type CHECK admits (LEDGER_MISMATCH comes from the ledger side, Phase 5 Unit 15). */
export type StoredMismatchType = MismatchType | "LEDGER_MISMATCH";

/** Detail codes of LEDGER_MISMATCH cases (stored in reconciliation_cases.tvh_status). */
export const LEDGER_DETAIL = [
  "COMMISSION_MISSING",
  "JOURNAL_MISSING",
  "JOURNAL_AMOUNT_MISMATCH",
  "JOURNAL_CURRENCY_MISMATCH",
  "COMMISSION_WITHOUT_POSTING",
  "JOURNAL_WITHOUT_COMMISSION",
  "PAYOUT_JOURNAL_MISSING",
  "PAYOUT_JOURNAL_MISMATCH",
] as const;
export type LedgerDetail = (typeof LEDGER_DETAIL)[number];

export interface LedgerMismatch {
  mismatch_type: "LEDGER_MISMATCH";
  conversion_id: string | null;
  /** conversion external id, or `payout:<payoutId>` for payout cases. */
  external_conversion_id: string | null;
  /** Journal side (what the ledger holds). */
  reported_amount_minor: number | null;
  /** Commission / payout side (what should have been posted). */
  tvh_amount_minor: number | null;
  reported_status: null;
  tvh_status: LedgerDetail;
}

/** Any row insertable into reconciliation_cases. */
export type CaseInsert = Mismatch | LedgerMismatch;

export const RECONCILED_STATUSES = ["APPROVED", "REJECTED", "PENDING"] as const;
export type ReconciledStatus = (typeof RECONCILED_STATUSES)[number];

export const RECONCILIATION_CASE_STATUSES = ["OPEN", "RESOLVED", "IGNORED"] as const;
export type ReconciliationCaseStatus = (typeof RECONCILIATION_CASE_STATUSES)[number];
export type ReconciliationCaseOutcome = Exclude<ReconciliationCaseStatus, "OPEN">;

export type ReconciliationTrigger = "MANUAL" | "SCHEDULED";
export type LedgerStatus = "NOT_AVAILABLE" | "MATCHED" | "MISMATCHED";

/** One conversion as the advertiser reports it (untrusted input; validated by the service). */
export interface ReportedConversion {
  external_conversion_id: string;
  status: ReconciledStatus;
  amount_minor?: number | null;
  currency?: string | null;
}

/** The TVH side of the comparison — the subset of a conversions row the diff needs. */
export interface TvhConversion {
  id: string;
  external_conversion_id: string;
  lifecycle_status: ConversionStatus;
  sale_amount_minor: number | null;
  currency: string | null;
}

export interface Mismatch {
  mismatch_type: MismatchType;
  conversion_id: string | null;
  external_conversion_id: string;
  reported_amount_minor: number | null;
  tvh_amount_minor: number | null;
  reported_status: ReconciledStatus | null;
  tvh_status: ReconciledStatus | null;
}

export interface DiffResult {
  mismatches: Mismatch[];
  reported_count: number;
  tvh_count: number;
  /** TVH conversions whose lifecycle folds to APPROVED. */
  approved_count: number;
  /** TVH conversions whose lifecycle folds to REJECTED. */
  rejected_count: number;
}

export interface ReconciliationRunRow {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  trigger: ReconciliationTrigger;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  reported_count: number;
  tvh_count: number;
  approved_count: number;
  rejected_count: number;
  mismatch_count: number;
  ledger_status: LedgerStatus;
  started_by_user_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ReconciliationCaseRow {
  id: string;
  organization_id: string;
  run_id: string;
  conversion_id: string | null;
  external_conversion_id: string | null;
  mismatch_type: StoredMismatchType;
  reported_amount_minor: number | null;
  tvh_amount_minor: number | null;
  reported_status: string | null;
  tvh_status: string | null;
  status: ReconciliationCaseStatus;
  resolution_reason_code: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface RunInput {
  /** ISO-8601 UTC, inclusive. */
  period_start: string;
  /** ISO-8601 UTC, exclusive; must be after period_start. */
  period_end: string;
  /** Optional: restrict the TVH side to one offer (external ids are unique per offer, PRD §38). */
  offer_id?: string | null;
  reported: ReportedConversion[];
}

export interface ScheduledRunInput extends RunInput {
  request_id?: string | null;
}

export interface RunResult {
  run: ReconciliationRunRow;
  cases: ReconciliationCaseRow[];
}

export interface ResolveCaseInput {
  status: ReconciliationCaseOutcome;
  reason_code: string;
}

export interface ReconciliationCaseListFilter {
  run_id?: string;
  status?: ReconciliationCaseStatus;
  mismatch_type?: StoredMismatchType;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

const APPROVED_FOLD: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>(["APPROVED", "LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID"]);
const REJECTED_FOLD: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>(["REJECTED", "REVERSED"]);

/** Folds the 12-state lifecycle to what an advertiser can compare against. */
export function foldLifecycleStatus(status: ConversionStatus): ReconciledStatus {
  if (APPROVED_FOLD.has(status)) return "APPROVED";
  if (REJECTED_FOLD.has(status)) return "REJECTED";
  return "PENDING";
}

/**
 * Pure diff keyed by external_conversion_id. Both inputs must be unique on
 * that key (the service validates the reported list and scopes the TVH side);
 * duplicates are a programming error here and throw.
 */
export function diffConversions(reported: readonly ReportedConversion[], tvh: readonly TvhConversion[]): DiffResult {
  const tvhByExt = new Map<string, TvhConversion>();
  for (const c of tvh) {
    if (tvhByExt.has(c.external_conversion_id)) throw new Error(`diffConversions: duplicate TVH external_conversion_id ${c.external_conversion_id}`);
    tvhByExt.set(c.external_conversion_id, c);
  }
  const seenReported = new Set<string>();
  const mismatches: Mismatch[] = [];

  for (const r of reported) {
    if (seenReported.has(r.external_conversion_id)) throw new Error(`diffConversions: duplicate reported external_conversion_id ${r.external_conversion_id}`);
    seenReported.add(r.external_conversion_id);
    const reportedAmount = r.amount_minor ?? null;
    const reportedCurrency = r.currency ?? null;
    const t = tvhByExt.get(r.external_conversion_id);
    if (!t) {
      mismatches.push({
        mismatch_type: "MISSING_IN_TVH",
        conversion_id: null,
        external_conversion_id: r.external_conversion_id,
        reported_amount_minor: reportedAmount,
        tvh_amount_minor: null,
        reported_status: r.status,
        tvh_status: null,
      });
      continue;
    }
    const tvhStatus = foldLifecycleStatus(t.lifecycle_status);
    const base = {
      conversion_id: t.id,
      external_conversion_id: r.external_conversion_id,
      reported_amount_minor: reportedAmount,
      tvh_amount_minor: t.sale_amount_minor,
      reported_status: r.status,
      tvh_status: tvhStatus,
    };
    if (reportedCurrency !== null && t.currency !== null && reportedCurrency !== t.currency) {
      mismatches.push({ mismatch_type: "CURRENCY_MISMATCH", ...base });
    } else if (reportedAmount !== t.sale_amount_minor) {
      mismatches.push({ mismatch_type: "AMOUNT_MISMATCH", ...base });
    }
    if (r.status !== tvhStatus) {
      mismatches.push({ mismatch_type: "STATUS_MISMATCH", ...base });
    }
  }

  let approved = 0;
  let rejected = 0;
  for (const t of tvh) {
    const folded = foldLifecycleStatus(t.lifecycle_status);
    if (folded === "APPROVED") approved += 1;
    else if (folded === "REJECTED") rejected += 1;
    if (!seenReported.has(t.external_conversion_id)) {
      mismatches.push({
        mismatch_type: "MISSING_AT_ADVERTISER",
        conversion_id: t.id,
        external_conversion_id: t.external_conversion_id,
        reported_amount_minor: null,
        tvh_amount_minor: t.sale_amount_minor,
        reported_status: null,
        tvh_status: folded,
      });
    }
  }

  return { mismatches, reported_count: reported.length, tvh_count: tvh.length, approved_count: approved, rejected_count: rejected };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

const CONFLICT_SENTINEL = "__STATE_CONFLICT__";

export function isCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CHECK constraint failed/i.test(msg);
}

// ---------------------------------------------------------------------------
// Ledger side (Phase 5 Unit 15) — pure core over rows the repository loads
// ---------------------------------------------------------------------------

/** Lifecycle states that MUST carry a commission + posted CONVERSION journal. */
const LEDGER_BEARING: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>(["LEDGER_POSTED", "EARNED", "PAYOUT_ELIGIBLE", "PAID", "REVERSED"]);
/** Lifecycle states that MUST NOT carry a commission yet (posting happens at APPROVED → LEDGER_POSTED). */
const PRE_POSTING: ReadonlySet<ConversionStatus> = new Set<ConversionStatus>(["RECEIVED", "VALIDATING", "PENDING", "APPROVED", "REJECTED"]);

export interface ConversionLedgerRow {
  conversion_id: string;
  external_conversion_id: string;
  lifecycle_status: ConversionStatus;
  commission_id: string | null;
  commission_currency: string | null;
  /** The journal's expected DEBIT total: advertiser_payout_minor ?? affiliate_commission_minor. */
  commission_total_minor: number | null;
  /** Journal matched on id + organization + reference_type CONVERSION + reference_id = conversion; NULL when absent / tampered. */
  journal_id: string | null;
  journal_currency: string | null;
  journal_total_minor: number | null;
}

export interface OrphanJournalRow {
  journal_id: string;
  reference_id: string;
  conversion_id: string | null;
  external_conversion_id: string | null;
  currency: string;
  total_minor: number;
}

export interface PayoutLedgerRow {
  payout_id: string;
  amount_minor: number;
  currency: string;
  journal_id: string | null;
  journal_currency: string | null;
  journal_total_minor: number | null;
}

export interface LedgerFacts {
  conversions: ConversionLedgerRow[];
  orphan_journals: OrphanJournalRow[];
  paid_payouts: PayoutLedgerRow[];
}

function ledgerCase(
  detail: LedgerDetail,
  conversionId: string | null,
  externalId: string | null,
  journalMinor: number | null,
  expectedMinor: number | null,
): LedgerMismatch {
  return {
    mismatch_type: "LEDGER_MISMATCH",
    conversion_id: conversionId,
    external_conversion_id: externalId,
    reported_amount_minor: journalMinor,
    tvh_amount_minor: expectedMinor,
    reported_status: null,
    tvh_status: detail,
  };
}

/** Integer-minor-unit comparison; currencies are compared first so amounts of different currencies are never compared. */
export function diffLedger(facts: LedgerFacts): LedgerMismatch[] {
  const out: LedgerMismatch[] = [];
  for (const r of facts.conversions) {
    if (r.commission_id === null) {
      if (LEDGER_BEARING.has(r.lifecycle_status)) out.push(ledgerCase("COMMISSION_MISSING", r.conversion_id, r.external_conversion_id, null, null));
      continue;
    }
    if (PRE_POSTING.has(r.lifecycle_status)) {
      out.push(ledgerCase("COMMISSION_WITHOUT_POSTING", r.conversion_id, r.external_conversion_id, r.journal_total_minor, r.commission_total_minor));
      continue;
    }
    if (r.journal_id === null) {
      out.push(ledgerCase("JOURNAL_MISSING", r.conversion_id, r.external_conversion_id, null, r.commission_total_minor));
      continue;
    }
    if (r.journal_currency !== r.commission_currency) {
      out.push(ledgerCase("JOURNAL_CURRENCY_MISMATCH", r.conversion_id, r.external_conversion_id, r.journal_total_minor, r.commission_total_minor));
      continue;
    }
    if (r.journal_total_minor !== r.commission_total_minor) {
      out.push(ledgerCase("JOURNAL_AMOUNT_MISMATCH", r.conversion_id, r.external_conversion_id, r.journal_total_minor, r.commission_total_minor));
    }
  }
  for (const j of facts.orphan_journals) {
    out.push(ledgerCase("JOURNAL_WITHOUT_COMMISSION", j.conversion_id, j.external_conversion_id, j.total_minor, null));
  }
  for (const p of facts.paid_payouts) {
    const key = `payout:${p.payout_id}`;
    if (p.journal_id === null) {
      out.push(ledgerCase("PAYOUT_JOURNAL_MISSING", null, key, null, p.amount_minor));
    } else if (p.journal_currency !== p.currency || p.journal_total_minor !== p.amount_minor) {
      out.push(ledgerCase("PAYOUT_JOURNAL_MISMATCH", null, key, p.journal_total_minor, p.amount_minor));
    }
  }
  return out;
}

export interface RunInsert {
  id: string;
  period_start: string;
  period_end: string;
  trigger: ReconciliationTrigger;
  counts: Omit<DiffResult, "mismatches">;
  mismatch_count: number;
  ledger_status: LedgerStatus;
  started_by_user_id: string | null;
}

export class ReconciliationRepository {
  constructor(private readonly db: D1Database) {}

  /** TVH conversions of the tenant whose occurred_at falls in [start, end), optionally for one offer. */
  async loadTvhConversions(tenantId: TenantId, periodStart: string, periodEnd: string, offerId: string | null): Promise<TvhConversion[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT id, external_conversion_id, lifecycle_status, sale_amount_minor, currency
         FROM conversions
        WHERE organization_id = ? AND occurred_at >= ? AND occurred_at < ?${offerId ? " AND offer_id = ?" : ""}
        ORDER BY occurred_at, id`,
      tenantId,
      periodStart,
      periodEnd,
      ...(offerId ? [offerId] : []),
    ).all<TvhConversion>();
    return res.results;
  }

  runStatement(tenantId: TenantId, run: RunInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO reconciliation_runs
           (id, organization_id, period_start, period_end, trigger, status, reported_count, tvh_count, approved_count, rejected_count,
            mismatch_count, ledger_status, started_by_user_id, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        tenantId,
        run.period_start,
        run.period_end,
        run.trigger,
        run.counts.reported_count,
        run.counts.tvh_count,
        run.counts.approved_count,
        run.counts.rejected_count,
        run.mismatch_count,
        run.ledger_status,
        run.started_by_user_id,
        now,
        now,
      );
  }

  /**
   * Ledger facts of the tenant for [start, end): every conversion of the period
   * with its commission and the journal that commission points at (matched on
   * id + organization + reference_type CONVERSION + reference_id = conversion,
   * so a tampered reference reads as "no journal"); CONVERSION journals of the
   * tenant no commission points at; PAID payouts of the tenant (paid_at in the
   * period) with their PAYOUT journal.
   */
  async loadLedgerFacts(tenantId: TenantId, periodStart: string, periodEnd: string, offerId: string | null): Promise<LedgerFacts> {
    const offerFilter = offerId ? " AND cv.offer_id = ?" : "";
    const offerBinds = offerId ? [offerId] : [];
    const conversions = await scopedQuery(
      this.db,
      `SELECT cv.id AS conversion_id, cv.external_conversion_id, cv.lifecycle_status,
              cm.id AS commission_id, cm.currency AS commission_currency,
              COALESCE(cm.advertiser_payout_minor, cm.affiliate_commission_minor) AS commission_total_minor,
              j.id AS journal_id, j.currency AS journal_currency, j.total_minor AS journal_total_minor
         FROM conversions cv
         LEFT JOIN commissions cm ON cm.conversion_id = cv.id AND cm.organization_id = cv.organization_id
         LEFT JOIN journal_entries j ON j.id = cm.journal_id AND j.organization_id = cv.organization_id
              AND j.reference_type = 'CONVERSION' AND j.reference_id = cv.id
        WHERE cv.organization_id = ? AND cv.occurred_at >= ? AND cv.occurred_at < ?${offerFilter}
        ORDER BY cv.occurred_at, cv.id`,
      tenantId,
      periodStart,
      periodEnd,
      ...offerBinds,
    ).all<ConversionLedgerRow>();
    const orphans = await scopedQuery(
      this.db,
      `SELECT j.id AS journal_id, j.reference_id, cv.id AS conversion_id, cv.external_conversion_id, j.currency, j.total_minor
         FROM journal_entries j
         LEFT JOIN conversions cv ON cv.id = j.reference_id AND cv.organization_id = j.organization_id
         LEFT JOIN commissions cm ON cm.journal_id = j.id
        WHERE j.organization_id = ? AND j.reference_type = 'CONVERSION' AND cm.id IS NULL
          AND ((cv.id IS NOT NULL AND cv.occurred_at >= ? AND cv.occurred_at < ?${offerFilter})
            OR (cv.id IS NULL AND j.posted_at >= ? AND j.posted_at < ?))
        ORDER BY j.posted_at, j.id`,
      tenantId,
      periodStart,
      periodEnd,
      ...offerBinds,
      periodStart,
      periodEnd,
    ).all<OrphanJournalRow>();
    const payouts = offerId
      ? { results: [] as PayoutLedgerRow[] }
      : await scopedQuery(
          this.db,
          `SELECT p.id AS payout_id, p.amount_minor, p.currency,
                  j.id AS journal_id, j.currency AS journal_currency, j.total_minor AS journal_total_minor
             FROM payouts p
             LEFT JOIN journal_entries j ON j.id = p.journal_id AND j.organization_id = p.organization_id
                  AND j.reference_type = 'PAYOUT' AND j.reference_id = p.id
            WHERE p.organization_id = ? AND p.status = 'PAID' AND p.paid_at >= ? AND p.paid_at < ?
            ORDER BY p.paid_at, p.id`,
          tenantId,
          periodStart,
          periodEnd,
        ).all<PayoutLedgerRow>();
    return { conversions: conversions.results, orphan_journals: orphans.results, paid_payouts: payouts.results };
  }

  caseStatement(tenantId: TenantId, runId: string, caseId: string, m: CaseInsert, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO reconciliation_cases
           (id, organization_id, run_id, conversion_id, external_conversion_id, mismatch_type, reported_amount_minor, tvh_amount_minor,
            reported_status, tvh_status, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      )
      .bind(caseId, tenantId, runId, m.conversion_id, m.external_conversion_id, m.mismatch_type, m.reported_amount_minor, m.tvh_amount_minor, m.reported_status, m.tvh_status, now);
  }

  /**
   * Guarded OPEN → RESOLVED | IGNORED. When the row is no longer OPEN the CASE
   * writes an out-of-CHECK sentinel, SQLite rejects the statement and the
   * whole batch rolls back (batch() → false).
   */
  resolveStatement(tenantId: TenantId, caseId: string, to: ReconciliationCaseOutcome, reasonCode: string, userId: string | null, now: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE reconciliation_cases
            SET status = CASE WHEN status = 'OPEN' THEN ? ELSE ? END,
                resolution_reason_code = ?, resolved_by_user_id = ?, resolved_at = ?
          WHERE organization_id = ? AND id = ?`,
      )
      .bind(to, CONFLICT_SENTINEL, reasonCode, userId, now, tenantId, caseId);
  }

  async findRun(tenantId: TenantId, runId: string): Promise<ReconciliationRunRow | null> {
    return scopedQuery(this.db, `SELECT * FROM reconciliation_runs WHERE organization_id = ? AND id = ?`, tenantId, runId).first<ReconciliationRunRow>();
  }

  async listRuns(tenantId: TenantId, page: PageRequest): Promise<Page<ReconciliationRunRow & { created_at: string }>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (page.cursor) {
      where.push("(started_at < ? OR (started_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT *, started_at AS created_at FROM reconciliation_runs WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY started_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ReconciliationRunRow & { created_at: string }>();
    return slicePage(res.results, page.limit);
  }

  async findCase(tenantId: TenantId, caseId: string): Promise<ReconciliationCaseRow | null> {
    return scopedQuery(this.db, `SELECT * FROM reconciliation_cases WHERE organization_id = ? AND id = ?`, tenantId, caseId).first<ReconciliationCaseRow>();
  }

  /** Every case of one run in insertion order (all rows of a run share created_at). */
  async listCasesForRun(tenantId: TenantId, runId: string): Promise<ReconciliationCaseRow[]> {
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM reconciliation_cases WHERE organization_id = ? AND run_id = ? ORDER BY created_at, rowid`,
      tenantId,
      runId,
    ).all<ReconciliationCaseRow>();
    return res.results;
  }

  async listCases(tenantId: TenantId, page: PageRequest, filter: ReconciliationCaseListFilter): Promise<Page<ReconciliationCaseRow>> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.run_id) {
      where.push("run_id = ?");
      binds.push(filter.run_id);
    }
    if (filter.status) {
      where.push("status = ?");
      binds.push(filter.status);
    }
    if (filter.mismatch_type) {
      where.push("mismatch_type = ?");
      binds.push(filter.mismatch_type);
    }
    if (page.cursor) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(page.cursor.created_at, page.cursor.created_at, page.cursor.id);
    }
    const res = await scopedQuery(
      this.db,
      `SELECT * FROM reconciliation_cases WHERE organization_id = ?${where.length ? " AND " + where.join(" AND ") : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      tenantId,
      ...binds,
      page.limit + 1,
    ).all<ReconciliationCaseRow>();
    return slicePage(res.results, page.limit);
  }

  /** Runs the batch; a CHECK violation (guarded UPDATE sentinel) → false, anything else rethrows. */
  async batch(statements: D1PreparedStatement[]): Promise<boolean> {
    try {
      await this.db.batch(statements);
      return true;
    } catch (err) {
      if (isCheckViolation(err)) return false;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReconciliationServiceOptions {
  now?: () => Date;
}

const REASON_CODE = /^[A-Z0-9_]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_REPORTED = 10_000;
const EXTERNAL_ID_MAX = 128;
const NO_META: RequestMeta = { ip_address: null, user_agent: null, request_id: null };

export class ReconciliationService {
  private readonly audit: AuditRepository;
  private readonly now: () => Date;

  constructor(
    private readonly repo: ReconciliationRepository,
    private readonly db: D1Database,
    options: ReconciliationServiceOptions = {},
  ) {
    this.audit = new AuditRepository(db);
    this.now = options.now ?? (() => new Date());
  }

  /** Manual run by a tenant/platform user holding reconciliation.manage. */
  async run(ctx: AuthenticatedContext, tenant: TenantContext, input: RunInput, meta: RequestMeta): Promise<RunResult> {
    this.require(tenant, "reconciliation.manage");
    return this.execute(tenantIdOf(tenant), input, "MANUAL", ctx.user.id, meta);
  }

  /**
   * Internal scheduler entry point: no permission check, no TenantContext.
   * Never expose through a route. trigger SCHEDULED, started_by / audit actor NULL.
   */
  async runScheduled(tenantId: TenantId, input: ScheduledRunInput): Promise<RunResult> {
    return this.execute(tenantId, input, "SCHEDULED", null, { ...NO_META, request_id: input.request_id ?? null });
  }

  async getRun(tenant: TenantContext, runId: string): Promise<RunResult> {
    this.require(tenant, "reconciliation.read");
    const tenantId = tenantIdOf(tenant);
    const run = await this.repo.findRun(tenantId, runId);
    if (!run) throw new AppError(404, "NOT_FOUND", "reconciliation run not found");
    const cases = await this.repo.listCasesForRun(tenantId, runId);
    return { run, cases };
  }

  async listRuns(tenant: TenantContext, page: PageRequest): Promise<Page<ReconciliationRunRow>> {
    this.require(tenant, "reconciliation.read");
    return this.repo.listRuns(tenantIdOf(tenant), page);
  }

  async getCase(tenant: TenantContext, caseId: string): Promise<ReconciliationCaseRow> {
    this.require(tenant, "reconciliation.read");
    return this.mustFindCase(tenantIdOf(tenant), caseId);
  }

  async listCases(tenant: TenantContext, page: PageRequest, filter: ReconciliationCaseListFilter = {}): Promise<Page<ReconciliationCaseRow>> {
    this.require(tenant, "reconciliation.read");
    if (filter.status !== undefined && !RECONCILIATION_CASE_STATUSES.includes(filter.status)) {
      throw new AppError(400, "INVALID_STATUS", `status must be one of ${RECONCILIATION_CASE_STATUSES.join(", ")}`);
    }
    return this.repo.listCases(tenantIdOf(tenant), page, filter);
  }

  /** OPEN → RESOLVED | IGNORED with a reason code; stale/foreign state → 409 / 404, nothing written. */
  async resolveCase(ctx: AuthenticatedContext, tenant: TenantContext, caseId: string, input: ResolveCaseInput, meta: RequestMeta): Promise<ReconciliationCaseRow> {
    this.require(tenant, "reconciliation.manage");
    if (input.status !== "RESOLVED" && input.status !== "IGNORED") {
      throw new AppError(400, "INVALID_STATUS", "status must be RESOLVED or IGNORED");
    }
    if (typeof input.reason_code !== "string" || !REASON_CODE.test(input.reason_code)) {
      throw new AppError(400, "INVALID_REASON_CODE", "reason_code must match ^[A-Z0-9_]{1,64}$");
    }
    const tenantId = tenantIdOf(tenant);
    const row = await this.mustFindCase(tenantId, caseId);
    if (row.status !== "OPEN") throw new AppError(409, "CASE_STATE_CONFLICT", `reconciliation case is already ${row.status}`);
    const now = this.now().toISOString();

    const ok = await this.repo.batch([
      this.repo.resolveStatement(tenantId, caseId, input.status, input.reason_code, ctx.user.id, now),
      this.audit.statement({
        organization_id: tenant.organization.id,
        actor_user_id: ctx.user.id,
        action: `reconciliation.case.${input.status.toLowerCase()}`,
        target_type: "reconciliation_case",
        target_id: caseId,
        metadata: { run_id: row.run_id, mismatch_type: row.mismatch_type, reason_code: input.reason_code },
        meta,
      }),
    ]);
    if (!ok) throw new AppError(409, "CASE_STATE_CONFLICT", "reconciliation case is no longer OPEN");
    return this.mustFindCase(tenantId, caseId);
  }

  // ---- internals -----------------------------------------------------------------

  private async execute(tenantId: TenantId, input: RunInput, trigger: ReconciliationTrigger, userId: string | null, meta: RequestMeta): Promise<RunResult> {
    const reported = validateRunInput(input);
    const offerId = input.offer_id ?? null;
    const tvh = await this.repo.loadTvhConversions(tenantId, input.period_start, input.period_end, offerId);
    assertUniqueTvhKeys(tvh);

    const diff = diffConversions(reported, tvh);
    const ledgerFacts = await this.repo.loadLedgerFacts(tenantId, input.period_start, input.period_end, offerId);
    const ledgerMismatches = diffLedger(ledgerFacts);
    const ledgerStatus: LedgerStatus = ledgerMismatches.length === 0 ? "MATCHED" : "MISMATCHED";
    const allCases: CaseInsert[] = [...diff.mismatches, ...ledgerMismatches];
    const now = this.now().toISOString();
    const runId = crypto.randomUUID();
    const caseIds = allCases.map(() => crypto.randomUUID());

    const statements: D1PreparedStatement[] = [
      this.repo.runStatement(
        tenantId,
        {
          id: runId,
          period_start: input.period_start,
          period_end: input.period_end,
          trigger,
          counts: diff,
          mismatch_count: allCases.length,
          ledger_status: ledgerStatus,
          started_by_user_id: userId,
        },
        now,
      ),
    ];
    allCases.forEach((m, i) => {
      statements.push(this.repo.caseStatement(tenantId, runId, caseIds[i] as string, m, now));
    });
    const byType: Partial<Record<StoredMismatchType, number>> = {};
    for (const m of allCases) byType[m.mismatch_type] = (byType[m.mismatch_type] ?? 0) + 1;
    const ledgerByDetail: Partial<Record<LedgerDetail, number>> = {};
    for (const m of ledgerMismatches) ledgerByDetail[m.tvh_status] = (ledgerByDetail[m.tvh_status] ?? 0) + 1;
    statements.push(
      this.audit.statement({
        organization_id: tenantId,
        actor_user_id: userId,
        action: "reconciliation.run.completed",
        target_type: "reconciliation_run",
        target_id: runId,
        metadata: {
          trigger,
          period_start: input.period_start,
          period_end: input.period_end,
          offer_id: offerId,
          reported_count: diff.reported_count,
          tvh_count: diff.tvh_count,
          approved_count: diff.approved_count,
          rejected_count: diff.rejected_count,
          mismatch_count: allCases.length,
          mismatches_by_type: byType,
          ledger_status: ledgerStatus,
          ledger_mismatch_count: ledgerMismatches.length,
          ledger_mismatches_by_detail: ledgerByDetail,
        },
        meta,
      }),
    );
    // Not repo.batch(): nothing here is expected to hit a CHECK sentinel, so any failure must surface.
    await this.db.batch(statements);

    const run = await this.repo.findRun(tenantId, runId);
    if (!run) throw new AppError(500, "RUN_NOT_PERSISTED", "reconciliation run was not persisted");
    const cases = await this.repo.listCasesForRun(tenantId, runId);
    return { run, cases };
  }

  private require(tenant: TenantContext, key: PermissionKey): void {
    if (!hasPermission(tenant, key)) throw new AppError(403, "FORBIDDEN", `missing permission ${key}`);
  }

  private async mustFindCase(tenantId: TenantId, caseId: string): Promise<ReconciliationCaseRow> {
    const row = await this.repo.findCase(tenantId, caseId);
    if (!row) throw new AppError(404, "NOT_FOUND", "reconciliation case not found");
    return row;
  }
}

// ---------------------------------------------------------------------------
// Input validation (untrusted advertiser report)
// ---------------------------------------------------------------------------

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function validateRunInput(input: RunInput): ReportedConversion[] {
  if (!isIsoInstant(input.period_start) || !isIsoInstant(input.period_end)) {
    throw new AppError(400, "INVALID_PERIOD", "period_start and period_end must be ISO-8601 instants");
  }
  if (!(input.period_end > input.period_start)) throw new AppError(400, "INVALID_PERIOD", "period_end must be after period_start");
  if (input.offer_id !== undefined && input.offer_id !== null && (typeof input.offer_id !== "string" || input.offer_id.length === 0)) {
    throw new AppError(400, "INVALID_OFFER_ID", "offer_id must be a non-empty string when provided");
  }
  if (!Array.isArray(input.reported)) throw new AppError(400, "INVALID_REPORTED", "reported must be an array");
  if (input.reported.length > MAX_REPORTED) throw new AppError(400, "TOO_MANY_REPORTED", `reported must contain at most ${MAX_REPORTED} entries`);

  const seen = new Set<string>();
  const out: ReportedConversion[] = [];
  for (const [i, r] of input.reported.entries()) {
    if (typeof r !== "object" || r === null) throw new AppError(400, "INVALID_REPORTED", `reported[${i}] must be an object`);
    const ext = r.external_conversion_id;
    if (typeof ext !== "string" || ext.length < 1 || ext.length > EXTERNAL_ID_MAX) {
      throw new AppError(400, "INVALID_REPORTED", `reported[${i}].external_conversion_id must be 1–${EXTERNAL_ID_MAX} characters`);
    }
    if (seen.has(ext)) throw new AppError(400, "DUPLICATE_REPORTED", `reported contains external_conversion_id ${ext} more than once`);
    seen.add(ext);
    if (!RECONCILED_STATUSES.includes(r.status)) {
      throw new AppError(400, "INVALID_REPORTED", `reported[${i}].status must be one of ${RECONCILED_STATUSES.join(", ")}`);
    }
    const amount = r.amount_minor ?? null;
    if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      throw new AppError(400, "INVALID_REPORTED", `reported[${i}].amount_minor must be a non-negative integer in minor units`);
    }
    const currency = r.currency ?? null;
    if (currency !== null && !CURRENCY.test(currency)) {
      throw new AppError(400, "INVALID_REPORTED", `reported[${i}].currency must be a 3-letter ISO-4217 code`);
    }
    out.push({ external_conversion_id: ext, status: r.status, amount_minor: amount, currency });
  }
  return out;
}

/** external_conversion_id is UNIQUE per (org, offer); across offers a collision makes the diff ambiguous → ask for an offer-scoped run. */
function assertUniqueTvhKeys(tvh: readonly TvhConversion[]): void {
  const seen = new Set<string>();
  for (const c of tvh) {
    if (seen.has(c.external_conversion_id)) {
      throw new AppError(409, "AMBIGUOUS_EXTERNAL_IDS", `external_conversion_id ${c.external_conversion_id} appears on more than one offer in the period; scope the run with offer_id`);
    }
    seen.add(c.external_conversion_id);
  }
}
