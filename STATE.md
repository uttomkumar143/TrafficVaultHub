# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 1 — Identity, Auth & Multi-Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`)

Phase 0 is COMPLETE (verified; see git history `2d4c17f`..`c25f376`). Do not
redo Phase 0.

Phase 1 unit status (verified 2026-09-22 against `main` @ `5930b81`):

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation — email/password (scrypt via `@noble/hashes`, no hand-rolled crypto), email verification, opaque D1 sessions, password reset, MFA stub (never fake-passes). Routes under `/api/v1/auth`: `signup`, `verify-email`, `resend-verification`, `login`, `logout`, `forgot-password`, `reset-password`, `me`, `mfa`. `requireAuth` middleware. ADR-001. | COMPLETE | `39c201b`, `d763870`, `c11abfd`, `298124b`, `178b931` |
| 2 | Session & device management — `GET /api/v1/auth/sessions` (active sessions, `current` flag, safe device fields), `DELETE /api/v1/auth/sessions/:id` (own only; foreign/unknown → 404 `SESSION_NOT_FOUND`), `POST /api/v1/auth/sessions/revoke-others` (idempotent, current kept). No migration needed — reuses `sessions` from 0002. ADR-001 §2 amended. | COMPLETE | `9c0f700` |
| 3 | Organizations CRUD + membership — `migrations/0003_organizations.sql` (`roles.is_owner`, `role_org_types`, PRD §9 role catalogue, append-only `audit_logs`); `modules/organizations/{repository,service}.ts`, `modules/audit/repository.ts`; routes `/api/v1/organizations` (create → creator seated as type owner; list mine; get; PATCH name; `/:orgId/roles`; members list/add-by-email/change-role/remove). Non-member → 404 no-enumeration; non-owner management → 403; `LAST_OWNER`, `SELF_MODIFICATION`, `ROLE_NOT_ALLOWED_FOR_ORG_TYPE`, `ALREADY_MEMBER`, `SLUG_ALREADY_EXISTS`. ADR-002. 16 integration tests in `routes/organizations.test.ts`. | COMPLETE | `0d617a7`, `ab2c6ab`, `f1e7b96`, `5930b81` |
| 4 | RBAC middleware (user → membership → role → permissions) | NOT STARTED | — |
| 5 | Tenant isolation enforcement + cross-tenant rejection test | NOT STARTED | — |
| 6 | `migrations/0002_identity.sql` | DONE (credentials, sessions, auth_tokens, auth_events, `users.mfa_enabled`). `0003_organizations.sql` added for Unit 3. Unit 4 needs additive `0004_*.sql` (permissions + role_permissions catalogue). Never edit applied migrations. | `39c201b`, `0d617a7` |
| 7 | Frontend auth pages + auth context + route guards | NOT STARTED | — |
| 8 | Security tests (unauthorized, expired session, cross-tenant, role escalation) | PARTIAL — unauthorized + revoked/expired + inactive-user (`routes/auth.test.ts`), cross-USER session isolation (`routes/auth-sessions.test.ts`), cross-TENANT org/member access → 404 and non-owner management → 403 (`routes/organizations.test.ts`) covered; permission-key role-escalation tests belong to Units 4–5 | — |
| 9 | STATE.md → Phase 1 complete | pending | — |

### Unit 3 verification (this session, sandbox, Node 22.23, fresh `npm ci`)
- `backend`: `npm run typecheck` ✅ · `npm test` **60/60** ✅ (6 files; 44
  pre-existing + 16 new in `src/routes/organizations.test.ts`) ·
  `npm run build` (wrangler dry-run) ✅
- `wrangler d1 migrations apply --local` on a clean DB → `0001` ✅ `0002` ✅
  `0003` ✅; `SELECT COUNT(*) FROM roles` = 14 (PRD §9 catalogue)
- `scripts/secret-scan.sh` → CLEAN ✅
- Unit 2 verification (43/43 + live `wrangler dev` smoke) recorded in git
  history at `55923e4`.

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
- Org authority (Unit 3): `OrganizationService.requireMembership` (ACTIVE
  member or 404) and `requireOwner` (`roles.is_owner = 1` or 403). Unit 4
  replaces `requireOwner` with permission-key checks on the same tables.
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
Phase 1, Unit 3 — Organizations CRUD + membership (implemented `f1e7b96`,
tested `5930b81`, verified in this session; on `main`).

## Next Planned Unit
Phase 1, Unit 4 — RBAC middleware (user → membership → role → permissions):
- Additive `migrations/0004_permissions.sql`: seed the PRD §10 `permissions`
  catalogue (`offers.read/create/update/approve/pause`,
  `conversions.read/approve/reject`, `ledger.read/adjust`,
  `payouts.read/review/approve/release`, `fraud.read/review`,
  `compliance.read/resolve`, `audit.read`) plus the identity-module keys
  needed now (`organizations.read/update`, `members.read/manage`), and
  `role_permissions` rows mapping the 14 system roles. Fixed ids like 0003.
- `backend/src/middleware/require-org.ts` (name TBD): resolves `:orgId` →
  caller's ACTIVE membership (404 if none) → role → permission set; exposes
  `c.get("tenant")` = `{ organization, membership, role, permissions }` and
  a `requirePermission("key")` guard (403 `FORBIDDEN`). Never reads
  `organization_id` from body/query.
- Refactor `routes/organizations.ts` to use the middleware instead of
  `requireOwner` (keep behaviour: owner roles hold `organizations.update`
  + `members.manage`; VIEWER etc. hold `*.read` only).
- Tests: role escalation (VIEWER calling manage endpoints → 403; member
  assigning a role their org type does not allow → 400), permission
  resolution per role, cross-tenant still 404.
- Then Unit 5 (generic tenant-scoping helper + explicit cross-tenant suite),
  Unit 7 (frontend auth pages, org switcher), Unit 8, Unit 9.

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
2026-09-22 18:20 UTC — Phase 1 Unit 3 (organizations CRUD + membership) complete & verified; next = Phase 1 Unit 4 (RBAC middleware)
