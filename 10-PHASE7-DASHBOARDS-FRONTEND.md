# PHASE 7 — Dashboards & Frontend Experience
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 6 complete.

Reference PRD sections: 84–91 (Reporting architecture, Event-based analytics, Dashboards per role, System health), 126–127 (Search, Pagination).

Goal: surface everything built in Phases 1–6 through role-appropriate dashboards, with real backend data only — no mocked numbers. Commit after each dashboard section, not all at once.

## Units of work (one dashboard section per commit is fine-grained enough)

1. **Affiliate dashboard** — Overview, Offers, My Links, SmartLinks, Clicks, Conversions, Earnings, Payouts, Creatives, Traffic Sources, Reports, Notifications, Support, API, Settings.

2. **Advertiser dashboard** — Overview, Offers, Affiliates, Traffic, Conversions, Tracking, Fraud, Billing, Invoices, Reports, Creatives, Webhooks, API, Support, Settings.

3. **Admin dashboard** — Overview, Affiliates, Advertisers, Offers, Tracking, Fraud, Compliance, Finance, Billing, Payouts, Reports, Disputes, Support, Audit, System Health, Settings.

4. **Finance dashboard** — Ledger, Receivables, Payables, Balances, Invoices, Payments, Payouts, Adjustments, Chargebacks, Reserves, Reconciliation.

5. **Compliance dashboard** — Verification, Affiliates, Advertisers, Traffic Reviews, Fraud Cases, Compliance Cases, Appeals, Documents, Policies, Audit.

For each dashboard: build the backend read endpoints first (paginated, cursor-based, tenant/role scoped — never load a full dataset into browser memory per PRD §127), then the frontend views with TanStack Query + Recharts. Every number shown must come from a real backend query against real schema built in earlier phases — if a metric's backend isn't built yet, show an honest "not yet available" state rather than a placeholder number.

6. **Global search** — across offers, affiliates, advertisers, conversions, tickets, cases, invoices, payouts, respecting tenant and permission boundaries per result type.

7. **System health view** — surface real status for API, Tracking, SmartLinks, D1, KV, R2, Durable Objects, Queues, Postbacks, Webhooks, Payout Jobs, Reconciliation (Admin dashboard only).

8. **Migration** — only if a new read-optimized table/view is genuinely needed; prefer querying existing tables correctly over adding redundant ones.

9. **STATE.md** update.

## Definition of done

- Every dashboard number is traceable to a real backend query, and that's verifiable by reading the code — no `Math.random()`, no hardcoded demo numbers left in non-demo code paths.
