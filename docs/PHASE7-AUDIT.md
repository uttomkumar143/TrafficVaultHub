# Phase 7 audit — `10-PHASE7-DASHBOARDS-FRONTEND.md` (Session 78 at `2300369`; patched Session 80 at `435c2b6`)

Baseline re-verified: backend typecheck 0 / vitest 700 (77 files) / build OK; frontend typecheck 0 /
vitest 104 (10 files) / build OK. Permission catalogue + table columns extracted from `migrations/`.

| # | Spec requirement | Status | Evidence / plan |
|---|------------------|--------|-----------------|
| 1a | Affiliate dashboard — backend read endpoints (overview / offers / links) | DONE | `modules/affiliate-dashboard/{repository,service}.ts`, `routes/affiliate-dashboard.ts`, `test/affiliate-dashboard-http.test.ts` (7) — commits `650dd88` `d70ba82` `bc67592` `b836729` |
| 1b | Affiliate dashboard — frontend (TanStack Query; sections of §1) | DONE | `frontend/src/features/affiliate-dashboard/{api,hooks}.ts`, `routes/app/affiliate-dashboard-page.tsx` (`/app/:orgId/dashboard`), AFFILIATE-gated nav, `affiliate-dashboard-routes.test.tsx` (10) — commit `b3c2172`. Frontend vitest 114 (11 files) |
| 2 | Advertiser dashboard — backend + frontend | MISSING | no `modules/advertiser-dashboard/`. Scope: `offers.organization_id`, `clicks.offer_organization_id`, `conversions.organization_id`, `commissions.organization_id` (advertiser economics are the advertiser's OWN here), `fraud_cases`, `advertiser_billing_profiles`, `webhook_deliveries`, `support_tickets` — all `organization_id = ?` |
| 3 | Admin dashboard — backend + frontend (PLATFORM) | MISSING | no platform dashboard module. Deliberately unscoped reads (same discipline as `PayoutRepository.listPageAll`), PLATFORM org type → else 404, per-section permission gating |
| 4 | Finance dashboard (PLATFORM) | MISSING | ledger balances via SUM over `ledger_entries` per (account code, currency); payouts, `financial_adjustments`, `reserves`, `reconciliation_runs`. No `invoices`/`payments` tables exist → `{available:false}` |
| 5 | Compliance dashboard (PLATFORM) | MISSING | profile statuses, `fraud_cases`, `compliance_cases`, `appeals`, `compliance_evaluations`, `compliance_rules`. No traffic-review / documents tables → `{available:false}` |
| 6 | Global search (tenant + permission scoped per result type) | MISSING | `GET /organizations/:orgId/search?q=` — offers, affiliates, advertisers, conversions, tickets, cases, payouts; capped per type; LIKE pattern escaped |
| 7 | System health view (Admin only) | MISSING | real probes: D1 `SELECT 1`, binding presence for KV/R2/Queue/DO, last click / last conversion / webhook dead-letters / payouts PROCESSING-FAILED / last reconciliation run. Nothing fabricated |
| 8 | Migration only if genuinely needed | DONE (none needed) | every dashboard reads existing tables; no new migration |
| 9 | STATE.md update | PARTIAL | P7-1 recorded; final update at the end |
| DoD | No `Math.random()` / hardcoded demo numbers in non-demo code | VERIFY at final gate | grep over `frontend/src` + `backend/src` excluding tests |

Permission keys reused (no new keys): `tracking.read`, `offers.read`, `conversions.read`, `ledger.read`,
`payouts.read`, `fraud.read`, `compliance.read`, `billing.read`, `webhooks.read`, `support.read`,
`disputes.read`, `appeals.read`, `audit.read`, `organizations.read`, `affiliates.read`, `advertisers.read`.

Build order: ~~1b~~ → 2 → 3 → 4 → 5 → 7 → 6 → docs. This file is deleted once folded into `docs/CHECKLIST.md`.
