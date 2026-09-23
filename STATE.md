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

## Key implementation facts (for the next session)
- Backend layout: `backend/src/modules/{auth,organizations,audit,rbac}`,
  `middleware/{require-auth,require-org}.ts`, `routes/{auth,organizations,health}.ts`,
  `lib/{errors,validation,time,bindings,tenant-scope}.ts`, test shim `test/d1-sqlite.ts`.
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
- Audit: `AuditRepository.statement(entry)` → batched atomically with the mutation.
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
- `.github/workflows-pending/` is a stale duplicate of the active CI file (safe to delete).

## Notes for the Next Session
- Loop: WORK → VALIDATE (typecheck, test, build) → SECRET SCAN → STATE.md → COMMIT → PUSH.
- `docs/BUILD_PROGRESS.md` is a STALE historical snapshot; this file is the source of truth.
- Local dev: `cd backend && npm ci && npx wrangler d1 migrations apply trafficvaulthub-db --local && npm run dev` (port 8787); `cd frontend && npm ci && npm run dev`.

## Last Updated
2026-09-23 08:35 UTC — re-verified at `6cb294c` (backend 96/96 incl. 8 state-machine tests, frontend 42/42, both typechecks, CI green). Phase 2 Unit 1 PARTIAL; next = advertiser repository/service/routes/tests.
