# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 2 — Advertisers, Affiliates, Offers & Marketplace (`05-PHASE2-OFFERS-MARKETPLACE.md`)

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
- CI `.github/workflows/ci.yml` ACTIVE; last observed run 35902166461 (on `9244833`) success. No code changed in this audit.

## Phase 2 — unit status

| Unit | Scope | Status |
|------|-------|--------|
| 1 | Advertiser module — `advertiser_profiles`, onboarding fields, lifecycle state machine, audited transitions, tenant routes + platform review routes | PARTIAL — migration 0005 (`3b1b20a`) + state machine (`6cb294c`) done; repository/service/routes/tests remaining |
| 2 | Affiliate module — profile, traffic-source declarations, lifecycle | NOT STARTED |
| 3 | Offers core + lifecycle | NOT STARTED |
| 4 | Offer versioning | NOT STARTED |
| 5 | Offer economics (`amount_minor` + `currency`) | NOT STARTED |
| 6 | Offer access & targeting | NOT STARTED |
| 7 | Marketplace API + UI | NOT STARTED |
| 8 | Migration(s) — next file is `0005_…` (0003/0004 already used by identity; PRD §109 numbering is illustrative) | NOT STARTED |
| 9 | Tests (version immutability, access modes, cross-tenant marketplace) | NOT STARTED |
| 10 | STATE.md | NOT STARTED |

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
Docs-only: Phase 1 re-audited against `04-PHASE1-IDENTITY-TENANCY.md` (9/9
COMPLETE, DoD executed live, 8-case security matrix, no gaps, no duplicates,
no code changed). Last code unit: Phase 2 Unit 1 partial (`6cb294c`) + shared libs (`ae79927`).

Master requirement map: `docs/CHECKLIST.md` (one row per prompt unit; verified statuses).

## Next Planned Unit
WAITING for the next phase instruction (hard stop after the 04 Phase 1 audit
session; Phase 2 must not be started without an explicit prompt).
When phase work resumes, the exact next unit is Phase 2 Unit 1 (continued) —
Advertiser module (PRD §16, §17, §92): `modules/advertisers/repository.ts`
(TenantId + `scopedQuery`), then `service.ts`, tenant routes
`/api/v1/organizations/:orgId/advertiser` (get/upsert/submit), platform review
routes `/api/v1/platform/:orgId/advertisers` (cursor list, get, transition with
reason), integration + tenant-isolation tests, ADR-003. Migration `0005` and
`state-machine.ts` already exist — do not recreate them.

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
2026-09-24 16:30 UTC — 04 Phase 1 audit session at `d416b4c`: all 9 units
re-verified against the actual 04 DoD, including a live `wrangler dev`
signup→verify→login→org→`/me` flow and an 8-case cross-tenant / role-escalation
matrix; backend 104/104, frontend 42/42, both typechecks, both builds,
migrations 0001–0005 apply clean, secret scan CLEAN. No source code changed;
no Phase 2+ work started.
