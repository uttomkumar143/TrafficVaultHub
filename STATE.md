# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
**Phase 4 — Conversions, Fraud & Compliance** (`07-PHASE4-CONVERSIONS-FRAUD-COMPLIANCE.md`)
is **COMPLETE, all 11 units, as of `40e0213` (code) + this docs commit (2026-09-30, Session 38)**;
see "Phase 4 — unit status", "Phase 4 verification" and "Phase 4 known gaps" below. Do not redo it.
**Phase 5 (`08-PHASE5-FINANCE-LEDGER-PAYOUTS.md`) is NOT STARTED** — wait for the user's instruction.

Phase 3 — Tracking, Attribution & SmartLinks (`06-PHASE3-TRACKING-SMARTLINKS-ATTRIBUTION.md`)
is **COMPLETE, all 10 units, as of `61fdeaa` (2026-09-29, Session 25)**; see "Phase 3 — unit
status" and "Phase 3 verification — 2026-09-29" below. Do not redo it.

## Phase 4 — unit status

| Unit | Scope | Status |
|------|-------|--------|
| P4-1 | Migration `0009_conversions_fraud_compliance.sql` + `conversions.*` / `fraud.*` / `compliance.*` / `reconciliation.*` permission keys + grants | **COMPLETE** — `a9d4a15` (repo-root `migrations/0009_…`; lifecycle CHECK extended to the 12-state machine, `conversion_status_history`, `conversion_reversals`, `conversion_holds`, fraud / compliance / reconciliation tables) |
| P4-2 | Conversion state machine (`modules/conversions/state-machine.ts`) | **COMPLETE** — `e553314` + `state-machine.test.ts` (5) |
| P4-3 | Conversion validation (`modules/conversions/validation.ts`) | **COMPLETE** — `5f3bb34` + `validation.test.ts` (6) |
| P4-4 | Deduplication (`idempotency_key`, duplicate postback → no downstream effect) | **COMPLETE** — `5fe6ef0`; `tracking/attribution-service.test.ts` "duplicate postback creates no duplicate conversion or downstream effect" |
| P4-5a | `modules/conversions/repository.ts` | **COMPLETE** — `cff2821` + `repository.test.ts` (5) |
| P4-5b | `modules/conversions/service.ts` (approve / reject / dispute / fraud-review / reverse, holds) | **COMPLETE** — `a703bb7` + `service.test.ts` (7) |
| P4-6 | Fraud risk engine (`modules/fraud/risk-engine.ts`, pure scoring) | **COMPLETE** — `4676194` + `risk-engine.test.ts` (6) |
| P4-7a | `modules/fraud/repository.ts` | **COMPLETE** — `7860988` + `repository.test.ts` (3) |
| P4-7b | `modules/fraud/service.ts` (cases, evidence, actions, assessments) | **COMPLETE** — `c38a352` + `service.test.ts` (5) |
| P4-8a | Compliance rules (`modules/compliance/rules.ts`, pure evaluation) | **COMPLETE** — `d94495c` + `rules.test.ts` (4) |
| P4-8b | `modules/compliance/repository.ts` | **COMPLETE** — `2687bda` + `repository.test.ts` (3) |
| P4-8c | `modules/compliance/service.ts` | **COMPLETE** — `becd5bf` (service) + `b718216` (`service.test.ts`, 4) |
| P4-9 | Reconciliation (`modules/reconciliation/service.ts`) | **COMPLETE (service only)** — `2387f78` (service) + `4b33c54` (`service.test.ts`, 7). No HTTP routes, no `scheduled()` wiring — see known gaps |
| P4-10a | `routes/conversions.ts` (lifecycle face under `/organizations/:orgId/conversions`) | **COMPLETE** — `cd0b685` + `src/test/conversions-http.test.ts` (6) |
| P4-10b | `routes/fraud.ts` (under `/organizations/:orgId/fraud`) | **COMPLETE** — `533704e` (routes) + `bb204e9` (`src/test/fraud-http.test.ts`, 5) |
| P4-10c | `routes/compliance.ts` (under `/organizations/:orgId/compliance`) | **COMPLETE** — `0493286` (routes) + `40e0213` (`src/test/compliance-http.test.ts`, 5) |
| P4-11 | STATE.md + docs/CHECKLIST.md | **COMPLETE** — this commit (Session 38) |

Phase 4 added 14 test files / 71 tests (module: conversions 23, fraud 14, compliance 11,
reconciliation 7; HTTP: conversions 6, fraud 5, compliance 5). No new public entry points and no
new Worker secrets. All Phase 4 HTTP routes sit under session auth + tenant scoping at
`/api/v1/organizations/:orgId/{conversions,fraud,compliance}`.

## Phase 4 verification — verified Session 37 at `40e0213` (2026-09-30)

The Session 38 docs commit changes only `STATE.md` and `docs/CHECKLIST.md`; no source, test,
migration or config file differs from `40e0213`, so these results still apply:

- `npm run typecheck` → 0 errors.
- `npx vitest run` → **48 files / 434 tests pass**, 0 failed, 0 skipped.
- `npm run build` → OK.
- `bash scripts/secret-scan.sh` → CLEAN (238 files scanned).
- `npx wrangler d1 migrations apply trafficvaulthub-db --local` from an empty `.wrangler` → 0001–0009 apply.
- `HEAD == origin/main == 40e0213` after push.

Phase 4 Definition-of-Done checks, each pinned to a real test name (grep-confirmed Session 38):

| DoD check | Test (file → `it(...)`) |
|-----------|-------------------------|
| Reversal keeps the original conversion row and writes a compensating record | `modules/conversions/service.test.ts` → "reversal keeps original and creates compensating record" |
| An active fraud / compliance hold blocks `PAYOUT_ELIGIBLE` | `modules/conversions/service.test.ts` → "fraud/compliance hold blocks PAYOUT_ELIGIBLE" |
| Duplicate postback is deduplicated with no downstream effect | `modules/tracking/attribution-service.test.ts` → "duplicate postback creates no duplicate conversion or downstream effect" |
| Fraud action creates a conversion hold in the same batch and blocks payout | `modules/fraud/service.test.ts` → "fraud action CONVERSION_HOLD/PAYOUT_HOLD creates a conversion hold in the same batch and blocks payout" |
| PAYOUT_HOLD / account-level actions need `fraud.manage`; account actions are recorded only | `modules/fraud/service.test.ts` → "PAYOUT_HOLD and account-level actions require fraud.manage; account actions are recorded only" |
| Missing required facts → `INSUFFICIENT_INFORMATION`, never `PASS` (pure rules) | `modules/compliance/rules.test.ts` → "missing required information yields INSUFFICIENT_INFORMATION, never PASS" |
| Compliance BLOCKING failure opens a case + `COMPLIANCE_BLOCK` hold (payout blocked) in one batch | `modules/compliance/service.test.ts` → "missing required information yields INSUFFICIENT_INFORMATION (never PASS) and a BLOCKING rule opens a case with a COMPLIANCE_BLOCK hold in the same batch" (hold release on COMPLIANT: "resolving COMPLIANT releases the COMPLIANCE_BLOCK hold in the same batch; NON_COMPLIANT keeps it and only compliance.resolve can release it manually") |
| Reconciliation run is one atomic batch | `modules/reconciliation/service.test.ts` → "the batch is atomic: a failing statement inside the run batch leaves no run, no cases and no audit" |
| Reconciliation ledger side reports `NOT_AVAILABLE` (no ledger before Phase 5) | `modules/reconciliation/service.test.ts` → "a run persists the run row, one case per mismatch and the audit row in one batch; ledger_status is NOT_AVAILABLE; permission and input are checked before any write" |
| `resolveCase` on an already / concurrently decided case → 409, nothing written | `modules/reconciliation/service.test.ts` → "resolveCase: OPEN → RESOLVED \| IGNORED with a reason code, audited; needs reconciliation.manage; already-decided or concurrently-decided case → 409 and nothing written" |
| No HTTP path reaches `LEDGER_POSTED` / `EARNED` / `PAYOUT_ELIGIBLE` / `PAID` | `src/test/conversions-http.test.ts`, `fraud-http.test.ts`, `compliance-http.test.ts` (candidate paths → 404/403, smuggled state fields → 400, history never holds a ledger state) |

## Phase 4 known gaps (carried into Phase 5 / later)

- **No ledger.** `LEDGER_POSTED`, `EARNED`, `PAYOUT_ELIGIBLE`, `PAID` exist in the state machine and
  CHECK constraint but are reachable only via `service.internal` (never referenced by any route);
  the ledger and payout flow is Phase 5 (`08-PHASE5-FINANCE-LEDGER-PAYOUTS.md`).
- **`ACCOUNT_RESTRICTION` / `ACCOUNT_SUSPENSION` fraud actions are recorded only** — an action row +
  event + audit is written; `organizations.status` is NOT mutated.
- **Reconciliation ledger side is `NOT_AVAILABLE`** by construction; `LEDGER_MISMATCH` is never emitted.
- **Reconciliation has no HTTP routes and no `scheduled()` wiring** — `runScheduled()` exists in the
  service but nothing in `app.ts` / the Worker export calls it; no cron `triggers` in `wrangler.jsonc`.
- **HTTP never reaches `LEDGER_POSTED` / `EARNED` / `PAYOUT_ELIGIBLE` / `PAID`** (by design for this
  phase; proven by the three HTTP test files).

Phase 2 — Advertisers, Affiliates, Offers & Marketplace (`05-PHASE2-OFFERS-MARKETPLACE.md`)
is **COMPLETE, all 10 units, as of `d73756b` (2026-09-26)**; see "Phase 2 — unit status" and
"Phase 2 verification — 2026-09-26" below. Do not redo it.

## Phase 3 — unit status

| Unit | Scope | Status |
|------|-------|--------|
| 1 | Click ID & tracking links (module + routes) | **COMPLETE** — `f6a641c` ids.ts + repository.ts, `f57100b` service.ts, `ea341fb` routes/tracking.ts (`trackingLinkRoutes` + `offerClickRoutes` under `/:orgId`), `bcfa3d0` `src/test/tracking.test.ts` |
| 2 | Public tracking redirect endpoint (`/t/:code`, `/s/:code`) | **COMPLETE** — `f8ea365` public-path reads, `5ce051b` signals.ts (coarse PRD §34 signals, salted hashes via `CLICK_SIGNAL_SALT`), `b096f05` redirect.ts (RedirectService), `e4d7225` routes/redirect.ts mounted at the ROOT outside `/api/v1` + `src/test/redirect.test.ts` |
| 3 | SmartLink engine (eligibility + routing modes, algorithm version recorded) | **COMPLETE** — `12f4793` smartlink-engine.ts (+ `cb36493` noUncheckedIndexedAccess fix); eligibility.ts shared with Unit 1 |
| 4 | Cap protection (Durable Object counters → `offer_cap_counters` snapshot) | **COMPLETE** — `ffa5cff` caps.ts, `0ca3e76` cap-store.ts, `3baf865` cap-object.ts, `e464f05` cap-ledger.ts (DurableCapLedger over `COORDINATOR`), `31584f5` CoordinatorObject = per-offer cap DO |
| 5 | KV cache + invalidation | **COMPLETE** — `373102f` eligibility-cache.ts, `e1dcd1d` OfferService hooks (every status transition / cap exhaustion invalidates), `641785e` wired over the `CACHE` binding (optional) |
| 6 | Failover (re-evaluate, alternative offer, never an inactive one) | **COMPLETE** — inside `12f4793` (`failover()` in smartlink-engine.ts, exercised by redirect.ts bounded failover on cap denial) |
| 7 | Attribution engine + S2S postback | **COMPLETE** — `1999e24` attribution.ts (pure `decide()`), `65404cd` postback-auth.ts (HMAC-SHA-256 envelope `X-TVH-Timestamp/Nonce/Key-Id/Signature`, AES-256-GCM secret vault under `POSTBACK_SECRET_KEY`), `4b337db` attribution-repository.ts, `aa8e230` attribution-service.ts, `61fdeaa` routes/attribution.ts (tenant routes under `/:orgId` + public `POST /postback/v1/conversions` at the ROOT) + `src/test/attribution.test.ts` |
| 8 | Migration `0008_tracking.sql` | **COMPLETE** — `453da7c`. 10 tables: `tracking_links`, `smartlinks`, `smartlink_offers`, `clicks`, `conversions`, `attributions`, `attribution_policies`, `offer_cap_counters`, `postback_nonces`, `advertiser_postback_secrets`; keys `tracking.read/manage`, `attribution.read/manage` (…1101–1104) + grants |
| 9 | Critical tracking tests (PRD §115) | **COMPLETE — audit Session 25, no gap found**: unique click id (`ids.test.ts` 10 000-sample set + `redirect.test.ts` "two clicks → two distinct click ids"); invalid offer rejected (`tracking.test.ts` 404 ungranted PRIVATE / 409 PAUSED+DRAFT; `redirect.test.ts` generic 404 for non-LIVE); inactive offer never gets SmartLink traffic incl. failover (`smartlink-engine.test.ts` ×4, `redirect.test.ts` HTTP ×2); duplicate conversions deduplicated (`attribution-service.test.ts`, `attribution.test.ts` DUPLICATE + single row); invalid signature rejected (`postback-auth.test.ts`, service + HTTP 401 tampered/unknown key/swapped body); replay rejected (service + HTTP 409 REPLAY_DETECTED); attribution recorded correctly (service + HTTP: attributions row with click_id / affiliate org / rule_version FK) |
| 10 | STATE.md + docs/CHECKLIST.md | this update (Session 25) |

Public entry points added in Phase 3 (all outside `/api/v1` and outside session auth):
`GET /t/:code`, `GET /s/:code` (302 + `Cache-Control: no-store`, generic 404),
`POST /postback/v1/conversions` (HMAC over raw body; 401 / 409 / 404 / 400 / 503 fail-closed).
Worker secrets introduced: `CLICK_SIGNAL_SALT` (optional), `POSTBACK_SECRET_KEY` (base64url 32 bytes;
absent ⇒ secret issuance and postback verification return 503 `POSTBACK_VAULT_UNAVAILABLE`).

## Phase 3 verification — 2026-09-29 (Session 25, at `61fdeaa`)
- `npm run typecheck` exit 0 · `npx vitest run` **362/362** (34 files) · `npm run build` exit 0
- `bash scripts/secret-scan.sh` → CLEAN (209 files)
- `wrangler d1 migrations apply trafficvaulthub-db --local` from empty state → 0001–0008 all ✅
- `git push origin main` OK; `HEAD == origin/main == 61fdeaa`

Schema decisions baked into 0008 that later units MUST honour:
- `clicks` is INSERT-only; `clicks.id` IS the `click_id`; exactly one of `tracking_link_id`/`smartlink_id`
  (XOR CHECK); `offer_version_id` pins the version current at click time; PRD §34 → coarse signals only
  (`country_code`, `region_code`, `device_type`, `os_family`, `browser_family`, `language`, salted
  `ip_hash`, `user_agent_hash`) — NEVER store the raw IP or fingerprint data in this table.
- `conversions` dedup = `UNIQUE (organization_id, offer_id, external_conversion_id)` (advertiser org);
  Phase-3 states only (`RECEIVED`,`VALIDATING`,`PENDING`,`REJECTED`,`FRAUD_REVIEW`) — Phase 4 extends
  the CHECK via a NEW migration.
- `attributions` INSERT-only, `UNIQUE conversion_id`, `rule_version` is an FK to the exact
  `attribution_policies` row (versioned per offer, INSERT-only, one `is_current` per offer).
- `postback_nonces` PK `(organization_id, nonce)` IS the replay check (atomic insert-or-fail).
- `advertiser_postback_secrets.secret_ciphertext` = HMAC key encrypted at rest (AES-GCM under a Worker
  master key named by `key_version`); plaintext returned once at creation, never SELECTed by list/read
  routes, never logged; `secret_hint` = last 4 chars. Implemented in Unit 7 as the `POSTBACK_SECRET_KEY` Worker secret
  (`key_version` = `POSTBACK_SECRET_KEY:v1`; `.dev.vars.example` documents it).
- `offer_cap_counters` is the durable snapshot the Durable Object flushes to; `period_key` =
  `YYYY-MM-DD` / `YYYY-MM` / `TOTAL`; `exhausted_at` set once → KV invalidation trigger (Unit 5).

Phase 0 is COMPLETE (`2d4c17f`..`c25f376`; CI activated later at `22b13e9`,
green since `748c3f7`) — re-audited unit-by-unit against `03-PHASE0-BOOTSTRAP.md`
on 2026-09-23 at `9244833` (see "Phase 0 re-audit" block below). Phase 1 is
COMPLETE — first verified 2026-09-23 at `2c30922`; **re-audited unit-by-unit
against `04-PHASE1-IDENTITY-TENANCY.md` on 2026-09-24 at `d416b4c`** (see
"Phase 1 re-audit" block below: 9/9 COMPLETE, live DoD flow + 8-case security
matrix executed, no gap, no code changed). Do not redo either.

## Phase 1 — COMPLETE (all 9 units)

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation (scrypt via `@noble/hashes`, email verification, opaque D1 sessions, password reset, MFA stub). `/api/v1/auth/*`, `requireAuth`. ADR-001. | COMPLETE | `39c201b`..`178b931` |
| 2 | Session & device management (`GET/DELETE /auth/sessions`, `revoke-others`). | COMPLETE | `9c0f700` |
| 3 | Organizations CRUD + membership, `0003_organizations.sql`, append-only `audit_logs`. ADR-002. | COMPLETE | `0d617a7`..`5930b81` |
| 4 | RBAC middleware `requireOrg`/`requirePermission`, `0004_permissions.sql`, typed `PERMISSION_KEYS`. | COMPLETE | `745a062`, `39433eb` |
| 5 | Tenant isolation: `lib/tenant-scope.ts` (`TenantId`, `scopedQuery`) + PRD §116 suite `routes/tenant-isolation.test.ts`. | COMPLETE | `c1e0d8f` |
| 6 | Migrations 0002–0004 (additive). | COMPLETE | — |
| 7 | Frontend: API client + session store, auth context, auth pages, `features/organizations/` (hooks, switcher), guards `require-auth`/`require-permission`, `/app` shell + `/app/:orgId`, `/app/:orgId/members`, `/app/organizations/new`. 42 frontend tests. | COMPLETE | `69fcf51`, `ed1bfcb`, `0b023eb`, `938a1f5`, `c54eb3f` |
| 8 | Security tests: unauthorized, revoked/expired session, cross-user, cross-tenant, role escalation (`rbac.test.ts`, `tenant-isolation.test.ts`), secret-never-returned (`routes/secret-exposure.test.ts`). Invalid API key / replayed webhook belong to Phase 6 (no such surface exists yet). | COMPLETE | `2c30922` |
| 9 | STATE.md → Phase 1 complete | COMPLETE | this commit |

### Phase 1 re-audit — 2026-09-24 against `04-PHASE1-IDENTITY-TENANCY.md` at `d416b4c`
Every unit re-checked from the repository (not from this file), sandbox Node 22.23.2 / npm 10.9.8, fresh `npm ci`:
- backend: `npm run typecheck` PASS · `npm test` **104/104** (13 files) PASS · `npm run build` (dry-run) PASS
- frontend: `npm run typecheck` PASS · `npm test` **42/42** (5 files) PASS · `npm run build` PASS
- `wrangler d1 migrations apply trafficvaulthub-db --local` from empty state → 0001–0005 all ✅ (14 commands)
- `scripts/secret-scan.sh` → CLEAN (137 files)
- **DoD bullet 1 executed live** (`wrangler dev` :8787, curl): signup 201 → login before verify **403 EMAIL_NOT_VERIFIED** → verify-email 200 → login 200 (opaque `tvh_s_…` token) → POST /organizations 201 (creator seated AFFILIATE_OWNER) → GET /organizations/:orgId/me 200 returns organization + membership + role + permission set.
- **DoD bullet 2**: every `:orgId` route in `routes/organizations.ts` sits behind `use("*", requireAuth)` + `use("/:orgId"|"/:orgId/*", requireOrg)` + per-route `requirePermission` (only `/:orgId/me` is member-only by design); all mutating `/auth/*` routes carry `requireAuth`; public auth routes are exactly signup/verify/resend/login/forgot/reset. No 501/TODO/bypass in non-test src (MFA stub throws NOT_IMPLEMENTED, never passes).
- **DoD bullet 3**: `routes/auth.test.ts` (unauthorized 401, expired 401, revoked 401, inactive user 401), `routes/rbac.test.ts` (role escalation 403; body `organization_id` ignored; REMOVED membership 404), `routes/tenant-isolation.test.ts` (cross-tenant read/mutate 404, member ids not addressable across tenants, body/query smuggling ignored, PLATFORM self-create 400) — all pass.
- **Live security matrix (8/8 denied correctly)**: own-tenant read 200 · cross-tenant read/PATCH/members 404 ORGANIZATION_NOT_FOUND · unauthenticated 401 · garbage bearer 401 · body `organization_id` smuggling ignored (path tenant acted on, other tenant unchanged) · query-string `organization_id` ignored · foreign member id under own path 404 MEMBER_NOT_FOUND · VIEWER PATCH org / add owner / self-promote 403 FORBIDDEN · PLATFORM org self-create 400 · removed member → 404 on `/me` · path variants (trailing slash, case, `//`, `..`) 404 · logout then reuse 401.
- **Recovery re-run (same session, after a hung frontend vitest worker was killed)**: every command above re-executed with hard timeouts — identical results (104/104, 42/42, typechecks, builds, migrations, secret scan CLEAN). Extra live proofs added: DB-level **expired session** (`UPDATE sessions SET expires_at='2000-01-01…'`) → 401 on `/auth/me` and `/organizations`; `revoke-others` → the other session's next request 401; VIEWER demote-owner / remove-owner 403; PLATFORM role key (`SUPER_ADMIN`) in an ADVERTISER org → 400 `ROLE_NOT_ALLOWED_FOR_ORG_TYPE`; `/auth/sessions` body contains no `token_hash`/`password`/`revoked*` fields. Second tenant seated as `ADVERTISER_OWNER`; first as `AFFILIATE_OWNER` — owner role follows org type.
- Note for future sessions: `npm test` in `frontend/` can leave a vitest worker hanging in this sandbox after all 42 tests pass; run `CI=true timeout 300 npx vitest run --no-file-parallelism` (exits cleanly).
- CI `.github/workflows/ci.yml` ACTIVE; run 36027269698 on `7975776` (this audit's commit) = success. No code changed in this audit.

## Phase 2 — unit status

| Unit | Scope | Status |
|------|-------|--------|
| 1 | Advertiser module — `advertiser_profiles`, onboarding fields, lifecycle state machine, audited transitions, tenant routes + platform review routes | COMPLETE — 0005 (`3b1b20a`), state machine (`6cb294c`), repository/service/routes + `test/fixtures.ts` + 9 route tests |
| 2 | Affiliate module — profile, traffic-source declarations, lifecycle | COMPLETE — 0006, `modules/affiliates/{state-machine,repository,service}.ts`, `routes/affiliates.ts`, tests |
| 3 | Offers core + lifecycle | COMPLETE — 0007, `modules/offers/{state-machine,repository,service}.ts`, `routes/offers.ts`; DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED→LIVE + PAUSED/holds, server-side, no advertiser self-approval |
| 4 | Offer versioning | COMPLETE — immutable `offer_versions` (INSERT-only), `createVersion` (MAX+1), version history queryable, current pointer moves |
| 5 | Offer economics (`amount_minor` + `currency`) | COMPLETE — integer minor units + 3-letter currency at every boundary; `validateEconomics` (commission ≤ payout, REVSHARE bps 1..10000); float rejected by zod |
| 6 | Offer access & targeting | COMPLETE — `affiliate_offer_access` (INVITED/REQUESTED/APPROVED/REJECTED/REVOKED), `offer_version_targeting` allow-list; access modes enforced server-side (repo WHERE + service) |
| 7 | Marketplace API + UI | COMPLETE — API: `marketplaceRoutes` (search w/ 8 filters incl. `min_commission_minor` + status narrowing, detail, apply), confidential-safe `PublicMarketplaceOffer` (payout/margin/budget never selected). Frontend (`daa8675`..`d73756b`): `types/api.ts` catalogues, `features/offers/{api,hooks,schemas,presentation,version-form-fields}`, `lib/money.ts` (string-math minor↔major, no floats); advertiser pages `offers-page`, `create-offer-page`, `offer-detail-page` (lifecycle FROM `allowed_transitions`, reason for §124 targets, immutable new-version form, access grants, histories); affiliate pages `marketplace-page` (all 8 filters in URL, cursor Load more, confidential-safe cards), `marketplace-offer-page` (AccessPanel per server `can_join/can_apply/my_access`); routes + nav in `routes/index.tsx` / `authenticated-shell.tsx` (`31ec8df`). Route tests: `offers-routes` 9, `offer-detail-routes` 24, `marketplace-routes` 18 (+ 11 unit tests money/schemas) |
| 8 | Migration(s) | COMPLETE — `0007_offers.sql` (additive: offers, offer_versions, offer_version_targeting, affiliate_offer_access, offer_status_transitions) |
| 9 | Tests (version immutability, access modes, cross-tenant marketplace) | COMPLETE — `src/test/offers.test.ts` (15 tests): version-1 immutability + pointer move, integer economics + rejections, full lifecycle + no self-approval, marketplace confidentiality (no economics leak), PRIVATE/APPLICATION_REQUIRED access enforcement, cross-tenant + cross-affiliate isolation |
| 10 | STATE.md | COMPLETE — this update |

### Phase 2 verification — 2026-09-26 (Session 6, real toolchain)
npm registry AND GitHub reachable this session; fresh `npm ci` both sides (Node 22.23.2 / npm 10.9.8):
- backend: `npm run typecheck` PASS · **vitest 153/153** (17 files) PASS — first time the backend
  suite ran under vitest itself since the offers/affiliates units landed (previous sessions used
  the node:test harness, which reported 149; the 4 extra are the `6dfb4fa` marketplace filter suites).
- frontend: `npm run typecheck` PASS · **vitest 104/104** (10 files) PASS · `npm run build` PASS.
- `scripts/secret-scan.sh` → CLEAN (172 files).
- `git push origin main` succeeded (`2689116..d73756b`); `HEAD == origin/main`.
- Session 5's uncommitted `offer-detail-routes.test.tsx` draft (28 tests, 3 failing, with a
  `sed`-injected debug line) was NOT present in the sandbox — the file was rebuilt from the page
  source and committed as 24 passing tests (`d73756b`); no debug lines exist in the repo
  (`grep -rn "console.log" frontend/src/routes/app/*.test.tsx` → none).
- Frontend vitest note: run `CI=true timeout 300 npx vitest run --no-file-parallelism` (exits cleanly).

### Phase 2 verification — 2026-09-25 (historical — superseded above)
Run in the Linux sandbox where **vitest itself cannot start** (its `rolldown` needs a
native binding absent from the Windows-only `node_modules`; npm registry is 403-blocked
so nothing can be installed). The suite is pure-JS + built-in `node:sqlite`, so it was run
faithfully via `node --test` + a vitest-compatible shim (`outputs/harness/`):
- backend tests: **149/149** pass, 41 suites (was 134/37; +15 offers tests). Command:
  `node --test --experimental-transform-types --experimental-sqlite --import <harness>/register.mjs 'src/**/*.test.ts'`.
- `tsc --noEmit` (app) exit 0 · `tsc --noEmit -p tsconfig.test.json` exit 0.
- NOT verified: vitest itself, `npm run build`, frontend (all blocked by the sandbox
  npm/native-binding block); `git push` / `HEAD==origin/main` blocked (proxy 403 on GitHub).

### Shared library units landed after `6cb294c` (not tied to a phase unit)
- `993e577` (+ fixes `da395af`, `e16adcc`): `lib/pagination.ts` — opaque base64url
  cursors over `(created_at, id)`, limit 1..100 default 25 (PRD §127). 4 tests.
  Not yet consumed by any route; intended for the Phase 2 Unit 1 platform list route.
- `ae79927`: `lib/request-meta.ts` `requestMeta(c)` — single implementation of the
  audit/auth-event request metadata (`cf-connecting-ip`, UA ≤512 chars, `cf-ray`),
  now imported by `routes/auth.ts` and `routes/organizations.ts` (removed the two
  copy-pasted `meta()` helpers). 4 tests. New route modules MUST import it, never
  re-implement it.

## Key implementation facts (for the next session)
- Backend layout: `backend/src/modules/{auth,organizations,audit,rbac,advertisers}`,
  `middleware/{require-auth,require-org}.ts`, `routes/{auth,organizations,health}.ts`,
  `lib/{errors,validation,time,bindings,tenant-scope,pagination,request-meta}.ts`,
  test shim `test/d1-sqlite.ts`.
- `createApp()` (`backend/src/app.ts`) `wireServices` middleware constructs services
  per request; it is mounted on `/api/v1/auth/*`, `/api/v1/organizations(/*)`.
  Every new protected module prefix MUST be added there (unknown paths stay 404).
- **Mandatory RBAC chain** for tenant routes: `requireAuth` → `requireOrg` (`:orgId`)
  → `requirePermission(key)`; handlers read `c.get("tenant")` (`TenantContext`).
  New permission keys = new additive migration + extend `PERMISSION_KEYS` in the
  same commit (`d1-sqlite.test.ts` parity test enforces it). SUPER_ADMIN grants in
  0004 are a snapshot — every new migration must grant its new keys to SUPER_ADMIN.
- **Tenant-scoped SQL**: repositories take `TenantId` (`tenantIdOf(tenant)`) and use
  `scopedQuery(db, sql, tenantId, ...params)`; SQL must begin its binds with
  `organization_id = ?`. Extend `routes/tenant-isolation.test.ts` per resource family.
- Audit: `AuditRepository.statement(entry)` → batched atomically with the mutation;
  request metadata for audit rows always comes from `lib/request-meta.ts`.
- Cursor lists: use `lib/pagination.ts` (`parsePageRequest`/`slicePage`, `LIMIT limit+1`).
- Tests use the `node:sqlite` shim running the real migrations; `d1-sqlite.test.ts`
  asserts the table list — update when adding tables.
- Error envelope PRD §72 `{ error: { code, message, request_id } }`.
- PLATFORM organizations cannot be self-created via API (by design). No bootstrap
  path exists yet for the first PLATFORM org/SUPER_ADMIN — must be added before
  Phase 9 deploy (seed script or runbook).
- Frontend: `features/{auth,organizations}`, `components/auth/{require-auth,require-permission}.tsx`,
  routes in `frontend/src/routes/index.tsx` (`/app`, `/app/:orgId`, `/app/:orgId/members`).
  Fixture rule: never use fixture passwords/tokens that are ≥16 chars of only
  `[A-Za-z0-9/+_=-]` (secret-scan flags them).

## Last Completed Unit
Phase 4 Unit 11 (P4-11) — this commit (Session 38): STATE.md + docs/CHECKLIST.md brought up to the
Phase 4 code state at `40e0213`. Last code unit: P4-10c `0493286` + `40e0213` (Session 37):
`routes/compliance.ts` + `src/test/compliance-http.test.ts` (5). Verified Session 37 at `40e0213`:
typecheck 0, vitest **434/434** (48 files), build OK, secret scan CLEAN (238 files),
migrations 0001–0009 apply, `HEAD == origin/main`.

## Next Planned Unit
**None in Phase 4 — Phase 4 is COMPLETE.** Phase 5 (`08-PHASE5-FINANCE-LEDGER-PAYOUTS.md`, ledger /
earnings / payouts) is NOT STARTED and must not begin without the user's instruction. Phase 4
known gaps (above) are the natural Phase 5 inputs: ledger posting, payout eligibility, reconciliation
ledger side, reconciliation HTTP + scheduling.
Carry-over items that are NOT blockers: PLATFORM-org bootstrap path (Phase 9), placeholder
Cloudflare IDs (Phase 9), platform-reviewer UI for offer approval, `EVENTS_QUEUE` enrichment
consumer (redirect currently records the coarse signals inline; queue binding unused).

## Open Questions / Blockers
- Device metadata limited to `ip_address` + `user_agent` (PRD §12 satisfied at that level).
- Rate limiting / login lockout (PRD §110) deferred to Phase 8; columns exist.
- Real email provider deferred to Phase 6; `EmailSender` port in place.
- `docs/PRD.md` ends mid-sentence at line 581 (§134–136 truncated; PRD is not edited).
- Cloudflare: resource IDs in `backend/wrangler.jsonc` are placeholders; deploy target
  (Genspark-hosted vs own account) undecided; hosted deploy does not support
  `kv_namespaces` — revisit before first deploy. No credentials available this session.
- `.github/workflows-pending/` (byte-identical stale duplicate of the active CI file)
  was removed in the master-prompt audit session — see "Master prompt audit" below.

## Notes for the Next Session
- Loop: WORK → VALIDATE (typecheck, test, build) → SECRET SCAN → STATE.md → COMMIT → PUSH.
- `docs/BUILD_PROGRESS.md` is a STALE historical snapshot; this file is the source of truth.
- Local dev: `cd backend && npm ci && npx wrangler d1 migrations apply trafficvaulthub-db --local && npm run dev` (port 8787); `cd frontend && npm ci && npm run dev`.

## Prompt-kit status — handoff block

```
01-MASTER-SYSTEM-PROMPT.md   audited COMPLETE (24/24 applicable; matrix in
                             docs/CHECKLIST.md). Code baseline ae79927.
02-AUTO-COMMIT-PROTOCOL.md   ACKNOWLEDGED + APPLIED (this session). Binding
                             rules: one small unit per commit; `git add -A`,
                             `<type>(<module>): <desc>` with type in
                             feat|fix|chore|docs|test|refactor|migration,
                             `git push origin main` after EVERY unit (retry
                             once, then report — never claim); STATE.md
                             updated in the same or an immediate follow-up
                             commit; never commit secrets (.env/.dev.vars
                             git-ignored; `.example` placeholders only).
04-PHASE1-IDENTITY-TENANCY   COMPLETE 9/9 — re-audit 2026-09-24 at d416b4c
                             (evidence: "Phase 1 re-audit" block above).
                             U1 auth `39c201b`..`178b931` · U2 sessions `9c0f700`
                             U3 orgs `0d617a7`..`5930b81` · U4 RBAC `745a062`,`39433eb`
                             U5 isolation `c1e0d8f` · U6 0002_identity `39c201b`
                             (+0003/0004 additive) · U7 frontend `69fcf51`..`c54eb3f`
                             U8 tests `2c30922` · U9 STATE `e808930`.
                             No PARTIAL/BROKEN/BLOCKED. No Phase 2 work started.
03-PHASE0-BOOTSTRAP.md       COMPLETE 8/8 — re-audit 2026-09-23 at 9244833:
  U1 scaffolding   COMPLETE  all PRD §121 dirs present; .gitignore covers
                             node_modules/.env/.dev.vars/dist/.wrangler;
                             docs/PRD.md unmodified since c029031 (rename only)
  U2 backend       COMPLETE  backend/ Workers+Hono; wrangler.jsonc placeholder
                             D1/KV/R2/Queues/DO bindings; `wrangler dev` →
                             curl /api/v1/health = 200 {"status":"ok"} (run live)
  U3 frontend      COMPLETE  React+Vite+TS, Tailwind 4, shadcn (components.json,
                             ui/*), React Router 7, TanStack Query provider,
                             AppShell layout; `npm run build` 0 errors
  U4 migration     COMPLETE  0001_initial.sql = exactly the 6 tables, UTC TEXT
                             timestamps, no money columns; `wrangler d1
                             migrations apply --local` 0001–0005 all ✅
  U5 testing       COMPLETE  vitest both sides; health.test.ts + app.test.tsx
  U6 CI            COMPLETE  .github/workflows/ci.yml valid YAML (jobs backend,
                             frontend, secret-scan); run 35902166461 on 9244833
                             = success
  U7 docs          COMPLETE  README.md (paragraph, stack, local run — every
                             command re-executed this session) +
                             docs/architecture/overview.md (modules, tenancy,
                             links to PRD)
  U8 STATE.md      COMPLETE  exists, current (this file)
  Separate commits per unit: 2d4c17f ce313d9 9a8b993 722f9bb d4d52c9/ce96416
                             aa8f2ee→22b13e9 b954b35 c25f376
VERIFICATION (this session, sandbox Node 22.23.2 / npm 10.9.8, fresh `npm ci`):
  backend:  typecheck PASS · test 104/104 (13 files) PASS · build (dry-run) PASS
  frontend: typecheck PASS · test 42/42 (5 files) PASS · build PASS
  scripts/secret-scan.sh → CLEAN (137 files)
FILES CHANGED (this session): STATE.md, docs/CHECKLIST.md only (docs)
BUGS FIXED / DUPLICATES FOUND: none — no Phase 0 gap, no duplicate work
BLOCKERS: none for Phase 0. Cloudflare IDs/credentials remain a Phase 9 item.
NEXT EXACT ACTION: WAIT for the next phase instruction. Do NOT start
  05-PHASE2 or later automatically. (When resumed: Phase 2 Unit 1 repository.)
```

## Last Updated
2026-09-30 — Session 38 (docs only). Fresh sandbox; resumed from `40e0213` (HEAD == origin/main).
Wrote Phase 4 Unit 11: STATE.md + docs/CHECKLIST.md (Phase 4 unit table, verification, DoD → test
map, known gaps). No source changed. Phase 4: 11/11 units COMPLETE. Results verified Session 37 at
`40e0213`: vitest 434/434 (48 files), typecheck 0, build OK, secret scan CLEAN (238 files),
migrations 0001–0009 apply locally. Phase 5 NOT STARTED.

Session log:
- Session 25 (2026-09-29): Phase 3 complete at `61fdeaa` (362/362).
- Sessions 26–37 (2026-09-29 → 2026-09-30): Phase 4 code, P4-1 `a9d4a15` → P4-10c `40e0213` (434/434).
- Session 38 (2026-09-30): Phase 4 Unit 11 docs (this commit).
