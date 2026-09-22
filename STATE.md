# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 1 — Identity, Auth & Multi-Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`)

Phase 0 is COMPLETE (verified; see git history `2d4c17f`..`c25f376`). Do not
redo Phase 0.

Phase 1 unit status (verified 2026-09-22 against `main` @ `c1e0d8f`):

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation — email/password (scrypt via `@noble/hashes`, no hand-rolled crypto), email verification, opaque D1 sessions, password reset, MFA stub (never fake-passes). Routes under `/api/v1/auth`: `signup`, `verify-email`, `resend-verification`, `login`, `logout`, `forgot-password`, `reset-password`, `me`, `mfa`. `requireAuth` middleware. ADR-001. | COMPLETE | `39c201b`, `d763870`, `c11abfd`, `298124b`, `178b931` |
| 2 | Session & device management — `GET /api/v1/auth/sessions` (active sessions, `current` flag, safe device fields), `DELETE /api/v1/auth/sessions/:id` (own only; foreign/unknown → 404 `SESSION_NOT_FOUND`), `POST /api/v1/auth/sessions/revoke-others` (idempotent, current kept). No migration needed — reuses `sessions` from 0002. ADR-001 §2 amended. | COMPLETE | `9c0f700` |
| 3 | Organizations CRUD + membership — `migrations/0003_organizations.sql` (`roles.is_owner`, `role_org_types`, PRD §9 role catalogue, append-only `audit_logs`); `modules/organizations/{repository,service}.ts`, `modules/audit/repository.ts`; routes `/api/v1/organizations` (create → creator seated as type owner; list mine; get; PATCH name; `/:orgId/roles`; members list/add-by-email/change-role/remove). Non-member → 404 no-enumeration; non-owner management → 403; `LAST_OWNER`, `SELF_MODIFICATION`, `ROLE_NOT_ALLOWED_FOR_ORG_TYPE`, `ALREADY_MEMBER`, `SLUG_ALREADY_EXISTS`. ADR-002. 16 integration tests in `routes/organizations.test.ts`. | COMPLETE | `0d617a7`, `ab2c6ab`, `f1e7b96`, `5930b81` |
| 4 | RBAC middleware — `migrations/0004_permissions.sql` (PRD §10 catalogue + `organizations.*`/`members.*`, `role_permissions` for 14 roles); `middleware/require-org.ts` (`requireOrg`: `:orgId` → ACTIVE membership → role → permission keys as `c.get("tenant")`, non-member → 404; `requirePermission(key)` → 403); `modules/rbac/permissions.ts` typed keys (parity test vs DB); `OrganizationService.resolveTenant`; organizations routes now permission-keyed (`organizations.read/update`, `members.read/manage`) + owner-seat guard (`assertOwner`); `GET /:orgId/me`. ADR-002 §5. 10 tests in `routes/rbac.test.ts`. | COMPLETE | `745a062`, `39433eb` |
| 5 | Tenant isolation enforcement — `lib/tenant-scope.ts` (branded `TenantId` via `tenantIdOf(TenantContext)` only; `scopedQuery()` throws `UnscopedQueryError` unless first placeholder is `organization_id = ?`) + 7 unit tests; explicit PRD §116 suite `routes/tenant-isolation.test.ts` (7 tests, two tenants A/B). ADR-002 §6. Phase 2 repositories MUST accept `TenantId` and use `scopedQuery`. | COMPLETE | `c1e0d8f` |
| 6 | Migrations | DONE — `0002_identity.sql`, `0003_organizations.sql`, `0004_permissions.sql` (all additive; never edit applied migrations). | `39c201b`, `0d617a7`, `745a062` |
| 7 | Frontend auth pages + auth context + route guards | NOT STARTED | — |
| 8 | Security tests (unauthorized, expired session, cross-tenant, role escalation) | PARTIAL — unauthorized + revoked/expired + inactive-user (`routes/auth.test.ts`), cross-USER session isolation (`routes/auth-sessions.test.ts`), cross-TENANT → 404 + body `organization_id` ignored + removed membership (`routes/rbac.test.ts`, `routes/organizations.test.ts`), ROLE ESCALATION → 403 for VIEWER/AFFILIATE_USER and manager-mints-owner (`routes/rbac.test.ts`). Cross-tenant explicit suite `routes/tenant-isolation.test.ts` (Unit 5). Still open for Unit 8: invalid API key / replayed webhook (Phase 6 scope), secret-never-returned-to-frontend assertion once frontend exists (Unit 7). | `39433eb`, `c1e0d8f` |
| 9 | STATE.md → Phase 1 complete | pending | — |

### Units 4–5 verification (this session, sandbox, Node 22.23, fresh `npm ci`)
- `backend`: `npm run typecheck` ✅ · `npm test` **85/85** ✅ (9 files: 61
  baseline + 10 `routes/rbac.test.ts` + 7 `lib/tenant-scope.test.ts` + 7
  `routes/tenant-isolation.test.ts`) · `npm run build` (wrangler dry-run) ✅
- `scripts/secret-scan.sh` → CLEAN ✅ (97 files)
- Migrations 0001–0004 applied by the node:sqlite shim in every test run.
- Earlier: Unit 3 (60/60) at `150d51d`; Unit 2 (43/43 + live `wrangler dev`
  smoke) at `55923e4`.

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
- **Tenant-scoped SQL (Unit 5, mandatory for every `organization_id`-owned
  table from Phase 2 on):** repositories take `TenantId` (from
  `tenantIdOf(c.get("tenant"))`), never `string`, and build statements with
  `scopedQuery(db, sql, tenantId, ...params)` — SQL must start its binds with
  `organization_id = ?`. Extend `routes/tenant-isolation.test.ts` with each
  new resource family.
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
Phase 1, Unit 5 — tenant-scoping helper + explicit PRD §116 cross-tenant suite
(`c1e0d8f`; on `main`). Units 1–6 of Phase 1 are now COMPLETE.

## Next Planned Unit
Phase 1, Unit 7 — Frontend auth + org context (phase prompt unit 7; PRD §12,
§86–90 shell). Frontend is currently a Phase 0 skeleton
(`frontend/src/{app,routes/home,components/layout/app-shell,lib/api,hooks/use-health}`,
React 18 + Vite + TS + Tailwind + shadcn `button` + React Router + TanStack
Query; vitest with 1 test). Implement, committing per page:
1. `frontend/src/lib/api.ts`: bearer token support (token kept in memory +
   `sessionStorage`; never log it), uniform `ApiError` from the PRD §72
   envelope, `401` → clear session.
2. `features/auth/`: `auth-context.tsx` (TanStack Query `["auth","me"]` over
   `GET /api/v1/auth/me`; login/logout/signup mutations), `use-auth.ts`.
3. Pages (React Hook Form + Zod, loading/error/empty states, a11y labels):
   `routes/auth/{login,signup,verify-email,forgot-password,reset-password}-page.tsx`
   wired to `POST /auth/login|signup|verify-email|forgot-password|reset-password`
   and `POST /auth/resend-verification`.
4. `features/organizations/`: org list/switcher over `GET /organizations`,
   `useTenant(orgId)` over `GET /organizations/:orgId/me` (role + permission
   keys for UI gating only).
5. Route guards: `components/auth/require-auth.tsx` (redirect to `/login`
   with `from`), `require-permission.tsx` (hide/redirect when the key is
   absent) — UI-only gating; server remains the authority.
6. Minimal authenticated shell: `/app` (org switcher + `/app/:orgId/members`
   page using `GET /organizations/:orgId/members`, add/change/remove buttons
   gated on `members.manage`).
7. Tests: page render + validation + mocked API (vitest + Testing Library),
   guard redirects, `npm run typecheck && npm test && npm run build` in
   `frontend/`; `.github/workflows-pending/ci.yml` already has a `frontend`
   job.
8. Update STATE.md; then Unit 8 (remaining security tests incl. "secret never
   returned to frontend"), Unit 9 (Phase 1 complete → Phase 2 offers).

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
2026-09-22 19:10 UTC — Phase 1 Units 4 (`39433eb`) and 5 (`c1e0d8f`) complete, verified (85/85 tests, typecheck, build, secret scan) and pushed; next = Phase 1 Unit 7 (frontend auth pages + auth context + route guards)
