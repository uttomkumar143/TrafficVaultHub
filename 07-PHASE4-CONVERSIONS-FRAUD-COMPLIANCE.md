# PHASE 4 — Conversions, Fraud & Compliance
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 3 complete.

Reference PRD sections: 37–41 (Conversion engine/validation/dedup/reconciliation/reversal), 47–52 (Fraud architecture/signals/risk engine/evidence/actions/false-positive controls), 53–55 (Compliance architecture/case state/rules).

Goal: this is where trust and money-safety are decided before anything hits the ledger. Commit after each unit.

## Units of work

1. **Conversion engine state machine** — `RECEIVED → VALIDATING → PENDING → APPROVED → LEDGER_POSTED → EARNED → PAYOUT_ELIGIBLE → PAID`, with alternates `REJECTED, FRAUD_REVIEW, DISPUTED`. Every transition audited.

2. **Conversion validation** — validate advertiser identity, offer, click, affiliate, conversion event, timestamp, attribution, deduplication, traffic rules, fraud signals, and offer-specific conversion requirements, in that order of cheap-to-expensive checks.

3. **Deduplication** — idempotency keys incorporating `advertiser_id, offer_id, external_conversion_id` (or provider-specific equivalents) so repeated postbacks never double-count.

4. **Reconciliation** — a scheduled job comparing advertiser-reported events, TrafficVaultHub conversions, approved/rejected conversions, and ledger records; any mismatch creates a reconciliation case rather than silently resolving itself.

5. **Reversal** — `APPROVED → REVERSED` creates a compensating financial event; the original record is never deleted or edited.

6. **Fraud: risk engine** — produce `risk_score, risk_level (LOW/MEDIUM/HIGH/CRITICAL), signals, rule/model_version, review_status` per click/conversion/affiliate/advertiser/offer/payment as relevant. Signals must be evidence-based (abnormal velocity, duplicate patterns, suspicious timing, geo anomalies, traffic-source anomalies, automation indicators) — a score alone is never treated as proof of wrongdoing.

7. **Fraud: evidence & actions** — `fraud_cases` with `case_id, event_ids, signals, rules, timestamps, context, reviewer, decision, reason`; actions `MONITOR, MANUAL_REVIEW, CONVERSION_HOLD, TRAFFIC_RESTRICTION, PAYOUT_HOLD, ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION` gated by proper authorization for the high-impact ones. Include false-positive controls: manual review, reason codes, appeal path, reviewer assignment, decision history.

8. **Compliance** — case state `OPEN → INVESTIGATING → WAITING_FOR_INFORMATION → ESCALATED → RESOLVED → CLOSED`; versioned rules evaluating traffic source, geography, brand usage, keywords, incentives, landing pages, creatives, promotional method, account status. Compliance fail-safe: if required info is missing, never auto-approve restricted access (PRD §132).

9. **Migration** — `migrations/0005_conversions_fraud_compliance.sql`.

10. **Critical financial-adjacent tests relevant here** — duplicate conversion produces no duplicate commission downstream; reversal produces a compensating entry, not a silent edit.

11. **STATE.md** update.

## Definition of done

- A duplicate postback cannot create a duplicate conversion or downstream financial effect, proven by a test.
- A reversed conversion leaves the original record intact plus a compensating event.
- Compliance/fraud holds actually block the relevant downstream action (e.g. payout) rather than being informational only.
