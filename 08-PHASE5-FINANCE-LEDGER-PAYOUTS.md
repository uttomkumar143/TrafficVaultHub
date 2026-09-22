# PHASE 5 — Finance, Ledger, Billing & Payouts
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 4 complete.

Reference PRD sections: 56–69 (Financial architecture, immutable ledger, adjustments, reserves, advertiser funding, billing, payout architecture/eligibility/state machine/idempotency, payment provider architecture, reconciliation engine), plus §114 (Critical Financial Tests) and §131 (Financial Fail-Safe).

Goal: this is the highest-stakes phase in the whole project — go slower here, test harder here. Commit after each unit, and do not skip the tests in unit 9.

## Units of work

1. **Chart of accounts & journal entries** — `ledger_accounts, journal_entries, ledger_entries, balance_snapshots` as an append-only structure. No function anywhere should be able to edit a posted `journal_entries` row — only insert compensating entries.

2. **Commission records** — generated from `APPROVED` conversions, referencing the offer version active at click time (from Phase 2/3), with `amount_minor` + `currency`.

3. **Financial adjustments** — every manual adjustment requires `reason, actor, reference, amount, currency, before_state, after_state, approval, timestamp`; require the approval step to actually be enforced, not just recorded.

4. **Reserves** — configurable affiliate reserve, advertiser reserve, chargeback reserve, risk reserve, kept independent from "available balance" calculations.

5. **Advertiser funding & billing** — `PREPAID / POSTPAID / CREDIT` modes with `credit_limit, used_credit, available_credit, risk_status, billing_status`; funding-protection behavior: insufficient capacity pauses the offer, excludes it from SmartLink routing, and alerts the advertiser and operations (PRD §62) — implement this as an actual trigger, not a manual step.

6. **Payout architecture** — a `PaymentProvider`-style adapter interface (`createPayout(), getStatus(), verifyWebhook(), cancelPayout()`) with at least one real or realistic-stub adapter behind it, so adding a second provider later never touches the ledger.

7. **Payout eligibility & state machine** — check available balance, minimum threshold, holding period, compliance status, account status, payout method, reserves, disputes, and manual holds before allowing `REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW → APPROVED → PROCESSING → PAID` (with `FAILED` / `CANCELLED`).

8. **Payout idempotency** — retrying a payout job must be provably incapable of creating a second payout; every payout gets an immutable internal ID plus the provider's reference ID.

9. **Critical financial tests (PRD §114 — implement all of these, don't skip any)**: duplicate conversion → no duplicate commission; duplicate payout → no duplicate payout; reversal → compensating entry; manual adjustment → audited; failed payout → recoverable; reconciliation mismatch → detected.

10. **Financial fail-safe** — if a calculation can't be verified, do not post to the ledger and do not guess; create a `financial_processing_error` record for investigation instead (PRD §131).

11. **Migration** — `migrations/0006_finance_payouts.sql`.

12. **STATE.md** update.

## Definition of done

- All six tests in §114 exist and pass.
- No code path can post an unverified amount to the ledger — verify this by trying to break it, not just by reading the code.
