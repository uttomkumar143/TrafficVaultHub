# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 1 — Identity, Auth & Multi-Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`)

Phase 0 is COMPLETE (verified; see git history `2d4c17f`..`c25f376`). Do not
redo Phase 0.

Phase 1 unit status (verified 2026-09-22 against `main` @ `39433eb`):

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation — email/password (scrypt via `@noble/hashes`, no hand-rolled crypto), email verification, opaque D1 sessions, password reset, MFA stub (never fake-passes). Routes under `/api/v1/auth`: `signup`, `verify-email`, `resend-verification`, `login`, `logout`, `forgot-password`, `reset-password`, `me`, `mfa`. `requireAuth` middleware. ADR-001. | COMPLETE | `39c201b`, `d763870`, `c11abfd`, `298124b`, `178b931` |
| 2 | Session & device management — `GET /api/v1/auth/sessions` (active sessions, `current` flag, safe device fields), `DELETE /api/v1/auth/sessions/:id` (own only; foreign/unknown → 404 `SESSION_NOT_FOUND`), `POST /api/v1/auth/sessions/revoke-others` (idempotent, current kept). No migration needed — reuses `sessions` from 0002. ADR-001 §2 amended. | COMPLETE | `9c0f700` |
| 3 | Organizations CRUD + membership — `migrations/0003_organizations.sql` (`roles.is_owner`, `role_org_types`, PRD §9 role catalogue, append-only `audit_logs`); `modules/organizations/{repository,service}.ts`, `modules/audit/repository.ts`; routes `/api/v1/organizations` (create → creator seated as type owner; list mine; get; PATCH name; `/:orgId/roles`; members list/add-by-email/change-role/remove). Non-member → 404 no-enumeration; non-owner management → 403; `LAST_OWNER`, `SELF_MODIFICATION`, `ROLE_NOT_ALLOWED_FOR_ORG_TYPE`, `ALREADY_MEMBER`, `SLUG_ALREADY_EXISTS`. ADR-002. 16 integration tests in `routes/organizations.test.ts`. | COMPLETE | `0d617a7`, `ab2c6ab`, `f1e7b96`, `5930b81` |
| 4 | RBAC middleware — `migrations/0004_permissions.sql` (PRD §10 catalogue + `organizations.*`/`members.*`, `role_permissions` for 14 roles); `middleware/require-org.ts` (`requireOrg`: `:orgId` → ACTIVE membership → role → permission keys as `c.get("tenant")`, non-member → 404; `requirePermission(key)` → 403); `modules/rbac/permissions.ts` typed keys (parity test vs DB); `OrganizationService.resolveTenant`; organizations routes now permission-keyed (`organizations.read/update`, `members.read/manage`) + owner-seat guard (`assertOwner`); `GET /:orgId/me`. ADR-002 §5. 10 tests in `routes/rbac.test.ts`. | COMPLETE | `745a062`, `39433eb` |
| 5 | Tenant isolation enforcement + cross-tenant rejection test | NOT STARTED | — |
| 6 | Migrations | DONE — `0002_identity.sql`, `0003_organizations.sql`, `0004_permissions.sql` (all additive; never edit applied migrations). | `39c201b`, `0d617a7`, `745a062` |
| 7 | Frontend auth pages + auth context + route guards | NOT STARTED | — |
| 8 | Security tests (unauthorized, expired session, cross-tenant, role escalation) | PARTIAL — unauthorized + revoked/expired + inactive-user (`routes/auth.test.ts`), cross-USER session isolation (`routes/auth-sessions.test.ts`), cross-TENANT → 404 + body `organization_id` ignored + removed membership (`routes/rbac.test.ts`, `routes/organizations.test.ts`), ROLE ESCALATION → 403 for VIEWER/AFFILIATE_USER and manager-mints-owner (`routes/rbac.test.ts`). Remaining for Unit 5: generic helper for `organization_id`-owned business resources (none exist yet) + a dedicated cross-tenant suite file. | `39433eb` |
| 9 | STATE.md → Phase 1 complete | pending | — |

### Unit 4 verification (this session, sandbox, Node 22.23, fresh `npm ci`)
- `backend`: `npm run typecheck` ✅ · `npm test` **71/71** ✅ (7 files; 61
  pre-existing incl. 0004 migration assertions + 10 new in
  `src/routes/rbac.test.ts`) · `npm run build` (wrangler dry-run) ✅
- `scripts/secret-scan.sh` → CLEAN ✅ (94 files)
- Migrations 0001–0004 applied by the node:sqlite shim in every test run;
  `d1-sqlite.test.ts` asserts the permission catalogue and grant policy.
- Unit 3 verification (60/60) recorded at `150d51d`; Unit 2 (43/43 + live
  `wrangler dev` smoke) at `55923e4`.

### Key implementation facts (for the next session)
- Backend layout: `backend/src/modules/auth/{constants,crypto-utils,email,mfa,password,repository,service,tokens}.ts`,
  `backend/src/modules/organizations/{repository,service}.ts`,
  `backend/src/modules/audit/repository.ts`,
  `backend/src/middleware/require-auth.ts`,
  `backend/src/routes/{auth,organizations,health}.ts`,
  `backend/src/lib/{errors,validation,time,bindings}.ts`.
- `createApp()` (`backend/src/app.ts`) has a `wireServices` middleware that
  constructs `AuthService` + `OrganizationService` per request and is mounted
  on `/api/v1/auth/*` and `/api/v1/organizations(/*)`. Every new protected
  module prefix MUST be added there (unknown paths stay 404, never 503).
- **RBAC chain for every tenant-scoped route (Unit 4, mandatory from now on):**
  `routes.use("*", requireAuth)` → `routes.use("/:orgId", requireOrg)` +
  `routes.use("/:orgId/*", requireOrg)` → per route
  `requirePermission("<key>")`. Handlers read `c.get("tenant")`
  (`TenantContext { organization, membership, role, permissions:Set }`) and
  pass it to services; services never re-resolve the tenant from client data.
  Typed keys: `modules/rbac/permissions.ts` (`PermissionKey`). New permission
  keys = new additive migration + extend `PERMISSION_KEYS` in the same commit
  (parity test enforces it).
- Owner-seat rule: `members.manage` covers non-owner seats; granting/changing/
  removing an OWNER seat additionally requires `tenant.role.is_owner`
  (`OrganizationService.assertOwner`).
- Audit: `AuditRepository.statement(entry)` returns a D1 prepared statement so
  the audit row is batched atomically with the mutation. Actions so far:
  `organization.created|updated`, `member.added|role_changed|removed`.
- Tests use `node:sqlite` shim (`backend/src/test/d1-sqlite.ts`) executing the
  real migration SQL; `d1-sqlite.test.ts` asserts the expected table list —
  update it when adding tables in a migration.
- Debug tokens are echoed in responses only when `APP_ENV=development`.
- Error envelope per PRD §72: `{ error: { code, message, request_id } }`.
  Codes so far: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`,
  `EMAIL_NOT_VERIFIED`, `ACCOUNT_INACTIVE`, `EMAIL_ALREADY_REGISTERED`,
  `INVALID_TOKEN`, `SESSION_NOT_FOUND`, `NOT_FOUND`, `SERVICE_UNAVAILABLE`,
  `INTERNAL_ERROR`, `ORGANIZATION_NOT_FOUND`, `MEMBER_NOT_FOUND`,
  `USER_NOT_FOUND`, `SLUG_ALREADY_EXISTS`, `ALREADY_MEMBER`, `FORBIDDEN`,
  `ROLE_NOT_ALLOWED_FOR_ORG_TYPE`, `LAST_OWNER`, `SELF_MODIFICATION`.
- No secrets required yet; `.dev.vars.example` documents vars.

## Last Completed Unit
Phase 1, Unit 4 — RBAC middleware + permission-keyed organizations routes
(migration `745a062`, implementation + tests + ADR `39433eb`; on `main`).

## Next Planned Unit
Phase 1, Unit 5 — Tenant isolation enforcement helper + explicit cross-tenant
suite (PRD §94, §116; phase prompt unit 5):
- Add `backend/src/lib/tenant-scope.ts` (name TBD): a small helper used by
  repositories of `organization_id`-owned resources so every query is bound
  to `tenant.organization.id` from `TenantContext` — e.g.
  `scopedFirst/scopedAll(db, sql, tenantId, ...params)` that REQUIRES the
  tenant id as a positional bind and refuses SQL without an
  `organization_id = ?` predicate (guard against forgotten scoping). Keep it
  minimal; it will be adopted by Phase 2 (`offers`, `advertiser_profiles`,
  `affiliate_profiles`) — do not create business tables in Unit 5.
- Add `backend/src/routes/tenant-isolation.test.ts`: a dedicated, clearly
  named PRD §116 "cross-tenant request rejected" suite — member of A
  addressing B on every route family (orgs, members, /me), member-id from B
  under A's path (`MEMBER_NOT_FOUND`), body/query `organization_id`
  smuggling, PLATFORM org cannot be self-created, and the helper's unit tests
  (refuses unscoped SQL).
- Update ADR-002 §6 (tenant-scoping helper), STATE.md, commit, push.
- Then Unit 7 (frontend: login/signup/verify/reset pages, auth context on
  TanStack Query, org switcher, role/permission route guards using
  `GET /organizations/:orgId/me`), Unit 8 (remaining security tests), Unit 9
  (STATE.md → Phase 1 complete, next Phase 2).

## Open Questions / Blockers
- **CI activation still needs a human.** Last attempt 2026-09-22 16:15 UTC:
  GitHub rejected the push —
  `refusing to allow a GitHub App to create or update workflow
  .github/workflows/ci.yml without workflows permission`. Not retried in the
  Unit 2 session (out of scope). Validated workflow remains at
  `.github/workflows-pending/ci.yml` (jobs `backend`, `frontend`,
  `secret-scan`). Fix — one of:
  (a) human runs `git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml && git rm .github/workflows-pending/README.md`, commit, push;
  (b) grant the Genspark GitHub App *Workflows: read & write* on this repo;
  (c) create the file via the GitHub web UI.
- Device metadata is limited to `ip_address` + `user_agent` captured at
  login (PRD §12 "device/session visibility" satisfied at that level). A
  user-editable device label / idle timeout would need an additive migration
  + ADR-001 amendment — not scheduled.
- Rate limiting / login lockout (PRD §110) deferred to Phase 8; columns
  `user_credentials.failed_attempts/locked_until` already exist and are updated.
- Real email provider deferred to Phase 6; `EmailSender` port in place.
- `docs/PRD.md` ends mid-sentence at line 581 (historical; PRD is not edited).
- Cloudflare: resource IDs in `backend/wrangler.jsonc` are placeholders;
  deployment target (Genspark-hosted vs. own account) undecided. Note: hosted
  deploy does not support `kv_namespaces` — revisit before first deploy.
- Package manager strategy: separate `frontend/` and `backend/` npm projects.

## Notes for the Next Session
- Loop after every unit: WORK → VALIDATE (typecheck, test, build) → SECRET SCAN
  (`scripts/secret-scan.sh`) → UPDATE STATE.md → COMMIT → PUSH → VERIFY → NEXT.
- `docs/BUILD_PROGRESS.md` is a STALE historical snapshot; this file is the only
  current-state source.
- Prompt-kit files `01-…13-*.md` and `STATE-TEMPLATE.md` live in the repo root.
- Local dev: `cd backend && npm ci && npx wrangler d1 migrations apply trafficvaulthub-db --local && npm run dev` (port 8787); `cd frontend && npm ci && npm run dev`.

## Last Updated
2026-09-22 18:50 UTC — Phase 1 Unit 4 (RBAC middleware, permission-keyed routes, 71/71 tests) complete & verified & pushed (`39433eb`); next = Phase 1 Unit 5 (tenant-scoping helper + cross-tenant suite)
