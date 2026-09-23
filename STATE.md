# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 2 — Advertisers, Affiliates, Offers & Marketplace (`05-PHASE2-OFFERS-MARKETPLACE.md`)

Phase 0 is COMPLETE (`2d4c17f`..`c25f376`). Phase 1 is COMPLETE (verified
2026-09-23 against `main` @ `2c30922`; see table). Do not redo either.

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

### Verification at `2c30922` (sandbox, Node 22.23.2, fresh `npm ci`, 2026-09-23)
- backend: `npm run typecheck` ✅ · `npm test` **88/88** (10 files) ✅ · `npm run build` (wrangler dry-run) ✅
- frontend: `npm run typecheck` ✅ · `npm test` **42/42** (5 files) ✅ · `npm run build` ✅
- `scripts/secret-scan.sh` → CLEAN (131 files) ✅
- CI `.github/workflows/ci.yml` ACTIVE; runs for `2c30922`, `c54eb3f`, `db61895` all success.

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
Phase 1 Unit 9 — Phase 1 recorded complete (`e808930`). Phase 2 Unit 1 in progress (see table).

Master requirement map: `docs/CHECKLIST.md` (one row per prompt unit; verified statuses).

## Next Planned Unit
Phase 2 Unit 1 — Advertiser module (PRD §16, §17, §92 `advertiser_profiles`):
migration `0005_advertisers.sql` (+ `advertisers.read/manage/review` keys),
`modules/advertisers/{state-machine,repository,service}.ts`, tenant routes
`/api/v1/organizations/:orgId/advertiser` (get/upsert/submit) and platform review
routes `/api/v1/platform/:orgId/advertisers` (cursor list, get, transition with
reason), integration + tenant-isolation tests, ADR-003.

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

## Master prompt audit (`01-MASTER-SYSTEM-PROMPT.md`) — handoff block

```
CURRENT MASTER PROMPT:   01-MASTER-SYSTEM-PROMPT.md
MASTER PROMPT STATUS:    24 completed / 24 applicable requirements
                         (26 rows total: §1 "Cloudflare Pages hosting" and §6
                         "follow 02-AUTO-COMMIT-PROTOCOL" are out of scope —
                         deployment = Phase 9; 02 not yet issued)
CURRENT REQUIREMENT:     §6 "keep STATE.md continuously up to date" (this block)
STATUS:                  COMPLETE
LAST VERIFIED COMMIT:    ae79927 = code baseline (all tests/builds above ran here);
                         626c914 = this audit's docs/hygiene commit (no src change)
LAST VERIFIED origin/main: 626c914 (pushed and fetched back this session)
TESTS (run this session, sandbox Node 22.23.2, fresh `npm ci`):
  backend:  npm run typecheck PASS · npm test 104/104 (13 files) PASS ·
            npm run build (wrangler --dry-run) PASS
  frontend: npm run typecheck PASS · npm test 42/42 (5 files) PASS ·
            npm run build PASS
  bash scripts/secret-scan.sh → CLEAN (139 files)
  migrations 0001–0005: exactly one commit each (never edited after landing)
  CI on origin/main ae79927: success (run 35900069638)
FILES CHANGED (this session): STATE.md, docs/CHECKLIST.md, README.md,
  .github/workflows-pending/ (deleted — duplicate of .github/workflows/ci.yml)
BUGS FIXED: none required (no §2/§5 violation found in existing code)
BLOCKERS: none for 01. Cloudflare resource IDs / credentials remain a Phase 9
  blocker and are NOT a 01 requirement.
NEXT EXACT ACTION: wait for 02-AUTO-COMMIT-PROTOCOL.md. Do NOT start Phase 0+
  work under the 01-only instruction. When phase work resumes: Phase 2 Unit 1
  advertiser repository (`modules/advertisers/repository.ts`, TenantId +
  scopedQuery), then service, routes, tests.
```

Requirement-by-requirement matrix for 01 lives in `docs/CHECKLIST.md`
(section "Master prompt 01 — architecture constitution").

## Last Updated
2026-09-23 18:40 UTC — master-prompt (01) audit session: re-verified at `ae79927`
(backend 104/104, frontend 42/42, both typechecks, both builds, secret scan CLEAN,
CI green). Recorded the 4 lib commits (`993e577`..`ae79927`) that earlier
STATE.md revisions missed. Phase 2 Unit 1 remains PARTIAL; no phase work done.
