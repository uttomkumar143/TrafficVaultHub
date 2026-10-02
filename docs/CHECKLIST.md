# TrafficVaultHub — Master Requirement Checklist

One row per phase/unit from the project prompt files `03-…12-*.md` (units are
the authoritative granularity; PRD § references are given per row). Statuses
are assigned ONLY from repository inspection + actually-run verification.

Allowed statuses: `COMPLETE` · `PARTIAL` · `BLOCKED` · `NOT STARTED`.

`COMPLETE` = acceptance criteria satisfied AND implementation exists AND tests
exist AND tests pass AND security requirements verified AND typecheck/build
pass AND committed AND pushed. Anything less is `PARTIAL`.

## Completion

```
Total required units : 96
COMPLETE             : 29
PARTIAL              : 1
BLOCKED              : 0
NOT STARTED          : 66
Completion           : 29 / 96 = 30.2 %  (see note)
```

Note (Session 58): this block was last fully re-audited at `d416b4c`; Session 58 only added Phase 5's
12 DONE rows to it. Phases 3 and 4 state their own totals (10/10, 11/11) in their sections and are
NOT yet folded into this block; the Phase 2 section's row statuses are stale relative to its heading.

Calculation basis: unit rows below; documentation-only rows (STATE.md units)
count as one unit each exactly as the prompts list them.

Last verified: 2026-09-24 against `main` @ `d416b4c` (backend 104/104 in 13
files, frontend 42/42, both typechecks, both builds, migrations 0001–0005
apply clean, secret scan CLEAN; CI run 36027269698 on the audit commit
`7975776` success). Phase 1 re-audited unit-by-unit in that session (see its
section); the verification was re-executed once more after a sandbox test-runner
hang, with identical results. Unit counts are unchanged since `6cb294c`; the 8 extra
backend tests come from the shared `lib/pagination.ts` and `lib/request-meta.ts`
helpers (not phase units — see STATE.md).

## Master prompt 01 — architecture constitution (`01-MASTER-SYSTEM-PROMPT.md`)

`01` defines rules, stack and repository shape rather than features; its
final instruction is to acknowledge and *wait* for `02` and a phase prompt
before writing code. Rows below are therefore judged against the code that
exists at `ae79927`. "Vacuous" = no code of that kind exists yet, and nothing
present contradicts the rule. **24 / 24 applicable COMPLETE; 2 rows out of
scope.**

| # | Requirement | Status | Evidence (verified) |
|---|-------------|--------|---------------------|
| 1.1 | Frontend stack: React+Vite+TS, Tailwind, shadcn/ui, Router, TanStack Query, RHF+Zod, Recharts | COMPLETE | `frontend/package.json`, `components.json`; typecheck/test/build pass |
| 1.2 | Backend: Cloudflare Workers + Hono | COMPLETE | `backend/package.json`, `src/{index,app}.ts`; dry-run build pass |
| 1.3 | D1 / Durable Objects / KV / R2 / Queues declared | COMPLETE (placeholder ids) | `backend/wrangler.jsonc`; real ids are Phase 9 (credentials) |
| 1.4 | Frontend hosting on Cloudflare Pages | OUT OF SCOPE | deployment is Phase 9; 01 forbids deploying now |
| 1.5 | GitHub repository | COMPLETE | `origin` = uttomkumar143/TrafficVaultHub, CI active + green |
| 1.6 | REST versioned at `/api/v1` | COMPLETE | `app.ts` `app.route("/api/v1", v1)` |
| 2.1 | No fake production data | COMPLETE | no random/faker/statistic literals in non-test src; no seed in prod paths |
| 2.2 | Financial authority server-side | COMPLETE (vacuous) | no financial code exists; frontend has no money math |
| 2.3 | Security authority server-side | COMPLETE | `requireAuth→requireOrg→requirePermission`; no client-supplied `organization_id`/`advertiser_id`/`affiliate_id` accepted anywhere |
| 2.4 | Modular monolith with module boundaries | COMPLETE | `modules/{auth,organizations,audit,rbac,advertisers}`; single Worker; `docs/architecture/overview.md` |
| 2.5 | Multi-tenant: org membership + ownership every query | COMPLETE | `lib/tenant-scope.ts`, `routes/tenant-isolation.test.ts`, `0005` `organization_id` |
| 2.6 | Money = `amount_minor` + `currency`, no floats | COMPLETE (vacuous) | no monetary columns; no REAL/FLOAT/DECIMAL in migrations |
| 2.7 | UTC timestamps | COMPLETE | `lib/time.ts`; SQL defaults `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| 2.8 | Immutable ledger (append-only) | COMPLETE (vacuous) | no ledger yet; `audit_logs`, `advertiser_status_transitions` insert-only in code |
| 2.9 | Idempotency on money/tracking | COMPLETE (vacuous) | no money/tracking surfaces yet |
| 2.10 | RBAC with the 14 named roles | COMPLETE | `migrations/0003_organizations.sql` L54–70, keys identical to 01 |
| 3 | Repository structure exactly as listed | COMPLETE | all listed dirs + `docs/PRD.md`, `STATE.md`, `README.md` tracked |
| 4 | Agent protocol steps 1–12 per task | COMPLETE | followed and evidenced per session (tests/typecheck/build actually run) |
| 5.1 | No hardcoded secrets | COMPLETE | `scripts/secret-scan.sh` CLEAN; `.dev.vars*` git-ignored |
| 5.2 | Never edit an applied migration | COMPLETE | `0001`–`0005` each have exactly one commit |
| 5.3 | Never skip authorization | COMPLETE | fail-closed middleware (`require-org.ts`) |
| 5.4 | Never expose secrets to frontend/logs/errors | COMPLETE | no `VITE_*` secrets; `routes/secret-exposure.test.ts`; error envelope has no stack |
| 6.1 | Small independently-committable increments | COMPLETE | git history is one unit per commit |
| 6.2 | Follow `02-AUTO-COMMIT-PROTOCOL.md` | COMPLETE | 02 issued and applied 2026-09-23 (session at `9244833`); history already one unit per commit with `<type>(<module>)` messages, every commit pushed, STATE.md updated alongside |
| 6.3 | STATE.md continuously current | COMPLETE | brought current at this commit (was 4 commits stale) |
| 6.4 | Self-decompose large tasks | COMPLETE | evidenced by history |
| 7 | Acknowledge and wait before coding | COMPLETE | no phase code written in the 01 audit session |

## Phase 0 — Bootstrap (`03-PHASE0-BOOTSTRAP.md`) — COMPLETE 8/8

Re-audited 2026-09-23 at `9244833` against each unit's Definition of Done
(everything below was actually executed in that session, not inferred).

| Unit | Requirement | Status | Evidence (verified) | Tests | Commit(s) |
|------|-------------|--------|---------------------|-------|-----------|
| 0.1 | Repo scaffolding: PRD §121 dirs, `docs/PRD.md` unmodified, `.gitignore` (node_modules/.env/.dev.vars/dist/.wrangler) | COMPLETE | all 20 required dirs present; PRD content unchanged since `c029031` (`2d4c17f` is a pure rename); all 5 ignore patterns present | — | `2d4c17f` |
| 0.2 | Backend skeleton: Workers + Hono, `GET /api/v1/health` → `{status:"ok"}`, wrangler config with placeholder D1/KV/R2/Queues/DO bindings | COMPLETE | `backend/src/{index,app}.ts`, `routes/health.ts`, `wrangler.jsonc` (placeholder ids only); live `wrangler dev` → `curl /api/v1/health` = `200 {"status":"ok"}`; typecheck + dry-run build PASS | `health.test.ts` | `ce313d9`, `97ece02` (DO binding) |
| 0.3 | Frontend skeleton: React+Vite+TS, Tailwind + shadcn/ui, React Router home route, TanStack Query provider, layout shell; `npm run build` zero errors | COMPLETE | `frontend/` (`components.json`, `components/ui/*`, `routes/index.tsx`, `app/providers.tsx`, `components/layout/app-shell.tsx`); typecheck PASS; `vite build` PASS (chunk-size warning only) | `app/app.test.tsx` | `9a8b993` |
| 0.4 | `migrations/0001_initial.sql`: exactly organizations/users/organization_members/roles/permissions/role_permissions; UTC timestamps; no money fields | COMPLETE | file contains exactly those 6 tables, `strftime(...Z)` UTC TEXT defaults, no monetary columns; `wrangler d1 migrations apply trafficvaulthub-db --local` applies 0001–0005 cleanly | `test/d1-sqlite.test.ts` | `722f9bb` |
| 0.5 | Test runner both sides with one passing smoke test each | COMPLETE | backend Vitest 104/104 (13 files); frontend Vitest+jsdom 42/42 (5 files) | `health.test.ts`, `app.test.tsx` | `d4d52c9`, `ce96416` |
| 0.6 | `.github/workflows/ci.yml`: on push, install/typecheck/test/build for frontend and backend | COMPLETE | valid YAML (jobs `backend`, `frontend`, `secret-scan`); run 35902166461 on `9244833` = success | CI runs | `aa8f2ee` → activated `22b13e9`, green from `748c3f7` |
| 0.7 | `README.md` (paragraph, stack, local run) + `docs/architecture/overview.md` (modules, multi-tenant model, links to PRD) | COMPLETE | both exist; every README command re-executed this session (`npm ci`, `typecheck`, `test`, `build`, `wrangler dev`, `d1 migrations apply/execute`) | — | `b954b35` |
| 0.8 | `STATE.md` from template, Phase 0 recorded as complete, next unit → Phase 1 | COMPLETE | `STATE.md` current; Phase 0 marked complete at `c25f376` with next = Phase 1 | — | `c25f376` |

Phase 0 DoD: both builds PASS · CI file valid · `/api/v1/health` works via `wrangler dev` · 8 separate unit commits pushed · STATE.md reflected Phase 0 complete with next = Phase 1 (`c25f376`). **All satisfied.**

## Phase 1 — Identity & Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`) — COMPLETE 9/9

Re-audited 2026-09-24 at `d416b4c` against each unit's wording in `04` and the
three DoD bullets (everything below was actually executed in that session —
backend 104/104, frontend 42/42, both typechecks/builds, `d1 migrations apply
--local` 0001–0005 from empty state, secret scan CLEAN, live `wrangler dev` DoD
flow and 8-case security matrix; details in STATE.md "Phase 1 re-audit").

| Unit | Requirement (from `04`) | Status | Evidence (verified) | Tests | Commits |
|------|-------------------------|--------|---------------------|-------|---------|
| 1.1 | Auth foundation: proven library (no hand-rolled crypto), email verification, password hashing, secure session issuance, password reset, MFA hook stub clearly marked, never fake-passing | COMPLETE | scrypt via `@noble/hashes` + Web Crypto only (`modules/auth/password.ts`, `tokens.ts`); SHA-256 digests stored, raw secrets never persisted; `mfa.ts` reports `available:false, reason:NOT_IMPLEMENTED` and throws 501 on challenge; login refuses unverified (403) — all observed live | `auth.test.ts` (16), `password.test.ts` (10) | `39c201b`..`178b931` |
| 1.2 | Session storage choice documented in ADR; revocation; list active sessions/devices | COMPLETE | `docs/adr/ADR-001-authentication.md` §2 "D1, not KV" with rationale; `GET/DELETE /auth/sessions`, `POST /auth/sessions/revoke-others`; foreign session id → 404 | `auth-sessions.test.ts` (12) | `9c0f700` |
| 1.3 | Organizations CRUD with `type ∈ PLATFORM\|ADVERTISER\|AFFILIATE\|PARTNER\|AGENCY`; membership table user↔org↔role | COMPLETE | `organizations.type` CHECK (0001), `organization_members` (0001), role catalogue + `role_org_types` (0003); create/list/get/patch + member add/change/remove; PLATFORM not self-creatable (400 live) | `organizations.test.ts` | `0d617a7`..`5930b81` |
| 1.4 | Hono middleware user → membership → role → permissions, rejects out of scope; used by every protected route | COMPLETE | `middleware/require-org.ts` (`requireOrg`, `requirePermission`), grants in `0004`; `routes/organizations.ts` `use("*", requireAuth)` + `use("/:orgId"\|"/:orgId/*", requireOrg)`; every route enumerated — none bypass | `rbac.test.ts` (9) | `745a062`, `39433eb` |
| 1.5 | Org derived from session, never client value; explicit cross-tenant rejection test | COMPLETE | `requireOrg` reads only the path param, resolved via caller's ACTIVE membership; `lib/tenant-scope.ts` branded `TenantId` + `scopedQuery`; live: body/query `organization_id` ignored, cross-tenant 404 | `tenant-isolation.test.ts` (8), `tenant-scope.test.ts` (7) | `c1e0d8f` |
| 1.6 | `migrations/0002_identity.sql` additive; never edit `0001` | COMPLETE | `0002_identity.sql` (credentials, sessions, auth_tokens, auth_events, `users.mfa_enabled`); `0001` has one commit only; 0003/0004 also additive; all apply clean | `d1-sqlite.test.ts` table asserts | `39c201b` (0002) |
| 1.7 | Login, signup, email verification, password reset pages; auth context/hook on TanStack Query; role-based route guards | COMPLETE | `routes/auth/{login,signup,verify-email,forgot-password,reset-password}-page.tsx`; `features/auth/auth-context.tsx` + `use-auth.ts` (TanStack Query); `components/auth/require-auth.tsx`, `require-permission.tsx` (UI-only; server authority) | `auth-pages.test.tsx` (12), `auth-context.test.tsx` (5), `app-routes.test.tsx` (13) | `69fcf51`..`c54eb3f` |
| 1.8 | Tests: unauthorized rejected, expired session rejected, cross-tenant rejected, role escalation rejected | COMPLETE | `auth.test.ts` "rejects requests without a session" / "rejects an expired session" / "rejects a revoked session"; `rbac.test.ts` "role escalation is rejected"; `tenant-isolation.test.ts` "cross-tenant request rejected"; plus `secret-exposure.test.ts` | all pass (104/104) | `2c30922` |
| 1.9 | STATE.md reflects Phase 1 completion and next = Phase 2 | COMPLETE | `STATE.md` Phase 1 table + re-audit block | — | `e808930`, this commit |

Phase 1 DoD: (1) sign up → verify → log in → session scoped to org + role — executed live; (2) every protected route passes `requireAuth`→`requireOrg`→`requirePermission` — enumerated, no exceptions; (3) cross-tenant and role-escalation tests exist and pass. **All satisfied.**

## Phase 2 — Advertisers, Affiliates, Offers & Marketplace (`05-PHASE2-OFFERS-MARKETPLACE.md`) — 0/10

| Unit | Requirement | Status | Evidence | Tests | Blocker / Remaining |
|------|-------------|--------|----------|-------|---------------------|
| 2.1 | Advertiser module (§16, §17, §92, §124, §132): profile + onboarding fields, lifecycle state machine, audited transitions, tenant routes, platform review routes | PARTIAL | `migrations/0005_advertisers.sql` (`3b1b20a`), `modules/advertisers/state-machine.ts` (`6cb294c`) | `state-machine.test.ts` 8/8 | Remaining: repository, service, routes, integration + tenant-isolation tests, docs |
| 2.2 | Affiliate module (§19–§21, §27): profile, traffic-source declarations, lifecycle, audit | NOT STARTED | — | — | depends on 2.1 pattern |
| 2.3 | Offers core + lifecycle (§22) | NOT STARTED | — | — | depends on 2.1 (advertiser must be ACTIVE/APPROVED to own offers) |
| 2.4 | Offer versioning (§23) | NOT STARTED | — | — | depends on 2.3 |
| 2.5 | Offer economics `amount_minor` + `currency` (§14, §24) | NOT STARTED | — | — | depends on 2.4 |
| 2.6 | Offer access & targeting (§25, §26, §28) | NOT STARTED | — | — | depends on 2.4 |
| 2.7 | Marketplace API + UI (§29, §30) | NOT STARTED | — | — | depends on 2.2, 2.6 |
| 2.8 | Migration(s) — additive; next file `0006_…` | NOT STARTED | `0005` used by 2.1 | — | per unit |
| 2.9 | Tests: version immutability, access modes, cross-tenant marketplace | NOT STARTED | — | — | depends on 2.4–2.7 |
| 2.10 | STATE.md | NOT STARTED | — | — | — |

## Phase 3 — Tracking, SmartLinks, Attribution (`06-…`) — 10/10 COMPLETE (`61fdeaa`, 2026-09-29)

| Unit | Requirement | Status |
|------|-------------|--------|
| 3.1 | Click ID & tracking links (§31–§33) | COMPLETE — `f6a641c`, `f57100b`, `ea341fb`, `bcfa3d0` |
| 3.2 | Public tracking redirect endpoint (§129, §130) | COMPLETE — `f8ea365`, `5ce051b`, `b096f05`, `e4d7225` (`GET /t/:code`, `GET /s/:code` at the root) |
| 3.3 | SmartLink engine (§42, §43) | COMPLETE — `12f4793` (+ `cb36493`) |
| 3.4 | Cap protection — Durable Objects (§44) | COMPLETE — `ffa5cff`, `0ca3e76`, `3baf865`, `e464f05`, `31584f5` |
| 3.5 | Cache & invalidation — KV (§45) | COMPLETE — `373102f`, `e1dcd1d`, `641785e` |
| 3.6 | Failover (§46, §133) | COMPLETE — in `12f4793` (`failover()`), used by `b096f05` |
| 3.7 | Attribution engine (§35, §36) + S2S postback (§74) | COMPLETE — `1999e24`, `65404cd`, `4b337db`, `aa8e230`, `61fdeaa` (`POST /postback/v1/conversions`) |
| 3.8 | Migration `0008_tracking.sql` | COMPLETE — `453da7c` |
| 3.9 | Critical tracking tests (§115) | COMPLETE — audited Session 25: all seven items covered by existing unit + HTTP tests (see STATE.md table); no additions needed |
| 3.10 | STATE.md | COMPLETE — Session 25 |

Verification at `61fdeaa`: typecheck 0 · vitest 362/362 (34 files) · build 0 · secret scan CLEAN · migrations 0001–0008 apply locally · `HEAD == origin/main`.

## Phase 4 — Conversions, Fraud, Compliance (`07-…`) — 11/11 COMPLETE (code `40e0213`, docs Session 38, 2026-09-30)

| Unit | Requirement | Status |
|------|-------------|--------|
| 4.1 | Conversion state machine (§37) | DONE — `e553314` `modules/conversions/state-machine.ts` + `state-machine.test.ts` (5); service `a703bb7` + `service.test.ts` (7); HTTP `cd0b685` + `src/test/conversions-http.test.ts` (6: invalid edges 409 `INVALID_TRANSITION`, no generic transition route) |
| 4.2 | Conversion validation (§38) | DONE — `5f3bb34` `modules/conversions/validation.ts` + `validation.test.ts` (6) |
| 4.3 | Deduplication (§39) | DONE — `5fe6ef0` (`idempotency_key`); `modules/tracking/attribution-service.test.ts` "duplicate postback creates no duplicate conversion or downstream effect" |
| 4.4 | Reconciliation (§40) | DONE (service level) — `2387f78` `modules/reconciliation/service.ts` + `4b33c54` `service.test.ts` (7). Scope note: no HTTP routes, no `scheduled()` wiring, ledger side `NOT_AVAILABLE` (see known gaps in STATE.md) |
| 4.5 | Reversal (§41) | DONE — in `a703bb7` (`reverse()` + `conversion_reversals`); `modules/conversions/service.test.ts` "reversal keeps original and creates compensating record"; HTTP `POST /:id/reverse` in `cd0b685` (`conversions-http.test.ts`: original row kept, second reverse 409) |
| 4.6 | Fraud: risk engine (§47–§49) | DONE — `4676194` `modules/fraud/risk-engine.ts` + `risk-engine.test.ts` (6); assessments over HTTP `533704e` + `bb204e9` (`fraud-http.test.ts`: assessment never changes `lifecycle_status`) |
| 4.7 | Fraud: evidence & actions (§50–§52) | DONE — `7860988` repository + `repository.test.ts` (3); `c38a352` `modules/fraud/service.ts` + `service.test.ts` (5); routes `533704e` + `bb204e9` (`src/test/fraud-http.test.ts`, 5). Scope note: `ACCOUNT_RESTRICTION` / `ACCOUNT_SUSPENSION` recorded only, `organizations.status` not mutated |
| 4.8 | Compliance (§53–§55) | DONE — `d94495c` `modules/compliance/rules.ts` + `rules.test.ts` (4); `2687bda` repository + `repository.test.ts` (3); `becd5bf` `service.ts` + `b718216` `service.test.ts` (4); routes `0493286` + `40e0213` (`src/test/compliance-http.test.ts`, 5) |
| 4.9 | Migration | DONE — `a9d4a15` `migrations/0009_conversions_fraud_compliance.sql` + `conversions.* / fraud.* / compliance.* / reconciliation.*` permission keys and grants; 0001–0009 apply from empty (verified Session 37) |
| 4.10 | Critical financial-adjacent tests | DONE — every DoD item pinned to an existing test (grep-confirmed Session 38): `conversions/service.test.ts` "reversal keeps original and creates compensating record" and "fraud/compliance hold blocks PAYOUT_ELIGIBLE"; `tracking/attribution-service.test.ts` "duplicate postback creates no duplicate conversion or downstream effect"; `fraud/service.test.ts` "fraud action CONVERSION_HOLD/PAYOUT_HOLD creates a conversion hold in the same batch and blocks payout" and "PAYOUT_HOLD and account-level actions require fraud.manage; account actions are recorded only"; `compliance/rules.test.ts` "missing required information yields INSUFFICIENT_INFORMATION, never PASS"; `compliance/service.test.ts` "missing required information yields INSUFFICIENT_INFORMATION (never PASS) and a BLOCKING rule opens a case with a COMPLIANCE_BLOCK hold in the same batch" (payout-block) + "resolving COMPLIANT releases the COMPLIANCE_BLOCK hold in the same batch; …"; `reconciliation/service.test.ts` "the batch is atomic: …" (atomic batch), "a run persists the run row, … ledger_status is NOT_AVAILABLE; …" (ledger NOT_AVAILABLE), "resolveCase: … already-decided or concurrently-decided case → 409 and nothing written" (resolveCase 409); no-HTTP-path-to-ledger-states in all three `*-http.test.ts` |
| 4.11 | STATE.md | DONE — Session 38 (this commit): STATE.md + this file |

Verification (verified Session 37 at `40e0213`; the Session 38 commit is docs-only): typecheck 0 · vitest 434/434 (48 files) · build OK · secret scan CLEAN (238 files) · migrations 0001–0009 apply locally from empty · `HEAD == origin/main`.

Known gaps carried to Phase 5: no ledger; `ACCOUNT_RESTRICTION`/`ACCOUNT_SUSPENSION` recorded only (`organizations.status` unchanged); reconciliation ledger side `NOT_AVAILABLE`; reconciliation has no HTTP routes and no `scheduled()` wiring; HTTP never reaches `LEDGER_POSTED`/`EARNED`/`PAYOUT_ELIGIBLE`/`PAID`.

## Phase 5 — Finance, Ledger, Payouts (`08-…`) — 12/12 COMPLETE (code `7abbe4a`, docs Session 58, 2026-10-02)

Migrations landed as repo-root `migrations/0010_ledger_core.sql` + `0011_billing_payouts.sql` (the spec's `0006` name was taken). Full unit/hash table: STATE.md "Phase 5 — unit status".

| Unit | Requirement | Status |
|------|-------------|--------|
| 5.1 | Chart of accounts & journal entries (§56, §57) — append-only, balanced double-entry, integer minor units | DONE — `46cd969` (0010), `7d91897` `money.ts`, `8e22e1e`/`b53b53b`/`4f7dbfa` `journal.ts`, `4ba68a1` `LedgerRepository`; tests `49af96d`+`029641e` `journal.test.ts` ("rejects unbalanced, one-sided, too-few, empty, same-account-both-sides", "assertBalanced catches tampered rows (total mismatch, dup index, leg currency)"), `9e26799` `repository.test.ts` (5); HTTP read-only `374c0e2`+`0111236` `ledger-http.test.ts` (7, no route posts a raw journal) |
| 5.2 | Commission records (§58) from APPROVED conversions, pinned offer version, amount_minor + currency | DONE — `f6743e5` `LedgerService.postConversionCommission`, `fd0d015` `markLedgerPosted`; `4a891ad` `ledger/service.test.ts` → "duplicate conversion produces no duplicate commission"; `journal.test.ts` → "accepts an APPROVED, unposted conversion whose stored commission equals the pinned version", "REVSHARE recomputes floor(sale × bps / 10000), never guesses advertiser/margin" |
| 5.3 | Financial adjustments (§59) — reason/actor/reference/amount/currency/before/after/approval/timestamp, approver ≠ requester | DONE — `95da12a`; `fe16809` `adjustments.test.ts` → "manual adjustment is audited and cannot post without approval", "self-approval is refused by the service and by the database", "posting twice is impossible (service guard, guarded UPDATE, terminal trigger, idempotency key)" |
| 5.4 | Reserves (§60) independent from available balance | DONE — `01fdccb`; `7ae79d8` `reserves.test.ts` → "reserve reduces available but NOT the ledger balance; journal_entries count unchanged" |
| 5.5 | Advertiser funding & billing (§61–§63) — PREPAID/POSTPAID/CREDIT, funding protection pauses offers | DONE — `84da24d` (0011), `14f37e2` `funding.ts`, `9b47a00` `BillingService`; `5b13bdd` `billing/service.test.ts` → "insufficient advertiser capacity pauses the offer and it disappears from SmartLink eligibility", "PREPAID: ADVERTISER_PREPAID ledger balance in the profile currency is the capacity (no account → 0 → pause)"; HTTP `e842635`+`111adae` `billing-http.test.ts` (5). Gap: no profile update / alert acknowledge endpoints |
| 5.6 | Payout architecture (§64, §68) — `PaymentProvider` adapter (`createPayout/getStatus/verifyWebhook/cancelPayout`) | DONE (stub provider only) — `78bc6b1` `provider.ts` + `stub-adapter.ts` (`stub-adapter.test.ts`); `6a6b8e9` `createApp` provider seam. Gap: no second real provider, PENDING webhook/polling not wired |
| 5.7 | Payout eligibility & state machine (§65, §66) | DONE — `0011c35` `state-machine.test.ts` → "defines the §65 edges exactly: REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW → APPROVED → PROCESSING → PAID, FAILED recoverable, CANCELLED"; `352bb41` `eligibility.test.ts` → "reasons are collected (not short-circuited), de-duplicated, and emitted in the stable declared order"; `0ee8ec3` `payouts/service.test.ts` → "ineligible payouts are rejected to FAILED with stable reasons in history/audit and nothing is paid". Gaps: `open_dispute_count` always 0 (no disputes table); policy constructor-injected, defaults 0 |
| 5.8 | Payout idempotency (§67) — immutable internal ID + provider reference, retry cannot create a second payout | DONE — `5684ae0`; `payouts/service.test.ts` → "§114 duplicate payout → no duplicate payout: same idempotency key returns the same row; re-processing never calls the provider or posts twice"; `61a41d0` `payouts-platform-http.test.ts` → "process → PAID: exactly ONE PAYOUT journal; duplicate process → 409 with one payout / attempt / journal; history actor PLATFORM; audit on the AFFILIATE org" |
| 5.9 | Critical financial tests (§114, all six) | DONE — see §114 table below |
| 5.10 | Financial fail-safe (§131) — unverifiable → no posting, `financial_processing_error` record | DONE — 0010 `financial_processing_errors`; `adjustments.test.ts` → "fail-safe: an unverifiable adjustment records a processing error and posts nothing (§131)"; `journal.test.ts` → "rejects commission mismatch (amount tampered, missing, wrong currency) — pinned version wins", "refuses: already reversed, reversal-of-reversal, non-reversible type, no legs, tampered total" |
| 5.11 | Migration | DONE — `46cd969` `0010_ledger_core.sql`, `84da24d` `0011_billing_payouts.sql` (additive, IF NOT EXISTS); apply from empty verified Session 58 |
| 5.12 | STATE.md | DONE — Session 58 (this commit) |

§114 Definition-of-done tests (all exist and pass at `7abbe4a`, vitest 574/574):

| §114 test | Commit | Test name |
|-----------|--------|-----------|
| duplicate conversion → no duplicate commission | `4a891ad` | `modules/ledger/service.test.ts` → "duplicate conversion produces no duplicate commission" |
| duplicate payout → no duplicate payout | `0ee8ec3` | `modules/payouts/service.test.ts` → "§114 duplicate payout → no duplicate payout: same idempotency key returns the same row; re-processing never calls the provider or posts twice" |
| reversal → compensating entry | `4a891ad`, `029641e` | `modules/ledger/service.test.ts` → "reversal posts compensating ledger entry"; `modules/ledger/journal.test.ts` → "mirrors every leg, keeps order/total/currency/tenant, points at the original" |
| manual adjustment → audited | `fe16809` | `modules/ledger/adjustments.test.ts` → "manual adjustment is audited and cannot post without approval" |
| failed payout → recoverable | `0ee8ec3`, `61a41d0` | `modules/payouts/service.test.ts` → "§114 failed payout → recoverable: provider FAILED → FAILED (no ledger effect), retry → PROCESSING → PAID"; `src/test/payouts-platform-http.test.ts` → "§114 failed provider → FAILED (no ledger effect) → retry replays the same key → FAILED again; recovering provider → PAID with one journal" |
| reconciliation mismatch → detected (incl. ledger side) | `f2458af`…`7abbe4a` | `modules/reconciliation/service.test.ts` → "(b) tampered/missing journals → MISMATCHED with one LEDGER_MISMATCH case per discrepancy, tenant-scoped, audited and resolvable", "(c) PAID payouts without / with a mismatching PAYOUT journal → PAYOUT_JOURNAL_MISSING / PAYOUT_JOURNAL_MISMATCH keyed payout:<id>; out-of-period and other tenants ignored" |

Known gaps carried to Phase 6: no disputes table (`open_dispute_count = 0`); payout policy constructor-injected (defaults 0, no table); PENDING payout webhook / `getStatus` polling not wired; `PAYOUT_CLEARING` → cash settlement not modelled; no second real payment provider (stub is the default `createApp` provider); no billing profile update / funding-alert acknowledge endpoints; account-level fraud actions record-only (Phase 4); reconciliation has no HTTP routes and no `scheduled()` wiring.

## Phase 6 — API, Webhooks, Integrations, Notifications (`09-…`) — 0/10

| Unit | Requirement | Status |
|------|-------------|--------|
| 6.1 | API standards pass (§71) | NOT STARTED |
| 6.2 | Standard error format (§72) — envelope exists since Phase 0; full pass pending | NOT STARTED |
| 6.3 | API keys (§76) | NOT STARTED |
| 6.4 | Webhook delivery system (§73–§75) | NOT STARTED |
| 6.5 | Integration adapters (§78) — `EmailSender` port exists | NOT STARTED |
| 6.6 | Notifications (§79, §80) | NOT STARTED |
| 6.7 | Support & disputes (§81–§83) | NOT STARTED |
| 6.8 | Migration | NOT STARTED |
| 6.9 | Security tests: invalid API key, replayed webhook (§116) | NOT STARTED |
| 6.10 | STATE.md | NOT STARTED |

## Phase 7 — Dashboards & Frontend (`10-…`) — 0/9

| Unit | Requirement | Status |
|------|-------------|--------|
| 7.1 | Affiliate dashboard (§86–§90) | NOT STARTED |
| 7.2 | Advertiser dashboard | NOT STARTED |
| 7.3 | Admin dashboard | NOT STARTED |
| 7.4 | Finance dashboard | NOT STARTED |
| 7.5 | Compliance dashboard | NOT STARTED |
| 7.6 | Global search (§126) | NOT STARTED |
| 7.7 | System health view (§91) | NOT STARTED |
| 7.8 | Migration | NOT STARTED |
| 7.9 | STATE.md | NOT STARTED |

## Phase 8 — Testing & Security Hardening (`11-…`) — 0/10

| Unit | Requirement | Status |
|------|-------------|--------|
| 8.1 | Full critical security suite (§116) | NOT STARTED (Phase 1 covers 5 of 7 proofs) |
| 8.2 | Data ownership audit (§94) | NOT STARTED |
| 8.3 | Soft deletion & retention (§95–§97) | NOT STARTED |
| 8.4 | Logging pass (§102) | NOT STARTED |
| 8.5 | File security R2 (§100) | NOT STARTED |
| 8.6 | Reliability pass (§106) | NOT STARTED |
| 8.7 | Feature flags & kill switches (§110, §111) | NOT STARTED |
| 8.8 | ADRs 003–010 (§122) | NOT STARTED |
| 8.9 | Load/perf sanity (§107) | NOT STARTED |
| 8.10 | STATE.md | NOT STARTED |

## Phase 9 — Deployment / Cloudflare (`12-…`) — 0/7

| Unit | Requirement | Status | Blocker |
|------|-------------|--------|---------|
| 9.1 | wrangler config finalization (real resource ids) | NOT STARTED | Needs Cloudflare account decision + credentials (see STATE.md) |
| 9.2 | D1 migration deployment step | NOT STARTED | same |
| 9.3 | GitHub Actions deploy workflow | NOT STARTED | Needs `CLOUDFLARE_API_TOKEN` repo secret |
| 9.4 | Environments (staging/production) | NOT STARTED | same |
| 9.5 | Rollback plan | NOT STARTED | — (docs; can be done without credentials) |
| 9.6 | Post-deploy smoke test | NOT STARTED | needs a deployment |
| 9.7 | STATE.md | NOT STARTED | — |

## Known documentation gaps (not invented)

- `docs/PRD.md` is truncated at line 581 (§134–136 Experience Goals cut
  mid-sentence; §137–§190 including §189 Benchmarking and §190 Glossary are
  absent). Work proceeds only on the specified §1–§133.
- PRD §109 migration names are illustrative; the repository sequence is
  authoritative (`0003_organizations`, `0004_permissions`, `0005_advertisers`).
