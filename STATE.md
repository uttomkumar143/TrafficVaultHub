# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 1 — Identity, Auth & Multi-Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`)

Phase 0 is COMPLETE (verified; see git history `2d4c17f`..`c25f376`). Do not
redo Phase 0.

Phase 1 unit status (verified 2026-09-22 against `origin/main` @ `178b931`):

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation — email/password (scrypt via `@noble/hashes`, no hand-rolled crypto), email verification, opaque D1 sessions, password reset, MFA stub (never fake-passes). Routes under `/api/v1/auth`: `signup`, `verify-email`, `resend-verification`, `login`, `logout`, `forgot-password`, `reset-password`, `me`, `mfa`. `requireAuth` middleware. ADR-001. | COMPLETE | `39c201b`, `d763870`, `c11abfd`, `298124b`, `178b931` |
| 2 | Session & device management — list active sessions, revoke one / all others | NOT STARTED (schema already supports it: `sessions.revoked_at/revoked_reason/ip_address/user_agent`) | — |
| 3 | Organizations CRUD + membership with role | NOT STARTED (tables exist from 0001) | — |
| 4 | RBAC middleware (user → membership → role → permissions) | NOT STARTED | — |
| 5 | Tenant isolation enforcement + cross-tenant rejection test | NOT STARTED | — |
| 6 | `migrations/0002_identity.sql` | DONE for Unit 1 scope (credentials, sessions, auth_tokens, auth_events, `users.mfa_enabled`). Further Phase 1 needs → new additive `0003_*.sql`; never edit `0001`/`0002` once pushed. | `39c201b` |
| 7 | Frontend auth pages + auth context + route guards | NOT STARTED | — |
| 8 | Security tests (unauthorized, expired session, cross-tenant, role escalation) | PARTIAL — unauthorized + revoked/expired + inactive-user covered in `backend/src/routes/auth.test.ts`; cross-tenant and role-escalation tests belong to Units 4–5 | — |
| 9 | STATE.md → Phase 1 complete | pending | — |

### Unit 1 verification (this session, sandbox, Node 22, fresh `npm ci`)
- `backend`: `npm run typecheck` ✅ · `npm test` 31/31 ✅ (4 files:
  `routes/auth.test.ts`, `routes/health.test.ts`, `modules/auth/password.test.ts`,
  `test/d1-sqlite.test.ts`) · `npm run build` (wrangler dry-run) ✅
- `wrangler d1 migrations apply --local` on a clean DB → `0001` ✅ `0002` ✅
  (10 tables: organizations, users, organization_members, roles, permissions,
  role_permissions, user_credentials, sessions, auth_tokens, auth_events)
- Live `wrangler dev` smoke test ✅: signup 201 → login before verify 403
  `EMAIL_NOT_VERIFIED` → verify-email 200 → login 200 (bearer `tvh_s_…`) →
  `/me` 200 · `/me` without token 401 → `/mfa` reports
  `{enabled:false, available:false, reason:"NOT_IMPLEMENTED"}` → logout 204 →
  `/me` with old token 401 → forgot-password 202 → reset-password 204 →
  login with new password 200.
- `scripts/secret-scan.sh` → CLEAN ✅

### Key implementation facts (for the next session)
- Backend layout: `backend/src/modules/auth/{constants,crypto-utils,email,mfa,password,repository,service,tokens}.ts`,
  `backend/src/middleware/require-auth.ts`, `backend/src/routes/auth.ts`,
  `backend/src/lib/{errors,validation,time,bindings}.ts`.
- `createApp()` in `backend/src/app.ts` wires `AuthService` per request on
  `/api/v1/auth/*`; tests inject `MemoryEmailSender`. `requireAuth` needs
  `authService` on context — when adding protected routes outside `/auth/*`,
  extend that wiring middleware's path (Unit 4 should generalize it).
- Tests use `node:sqlite` shim (`backend/src/test/d1-sqlite.ts`) executing the
  real migration SQL.
- Debug tokens are echoed in responses only when `APP_ENV=development`.
- Error envelope per PRD §72: `{ error: { code, message, request_id } }`.
- No secrets required yet; `.dev.vars.example` documents vars.

## Last Completed Unit
Phase 1, Unit 1 — Auth foundation (implemented in prior session at
`178b931`; verified, smoke-tested and recorded in this session).

## Next Planned Unit
Phase 1, Unit 2 — Session & device management:
- `GET /api/v1/auth/sessions` (list active sessions for the user: id,
  created_at, last_seen_at, expires_at, ip_address, user_agent, `current`
  flag), `DELETE /api/v1/auth/sessions/:id` (revoke one, own only),
  `POST /api/v1/auth/sessions/revoke-others`.
- Repository methods on the existing `sessions` table — no migration needed
  unless a device label is added (then `0003_*.sql`, additive).
- Tests: list excludes revoked/expired; revoking another user's session id →
  404 (no cross-user leak); revoked session → 401.
- Amend ADR-001 §2 if idle timeout is introduced.
Then Unit 3 (organizations) → Unit 4 (RBAC middleware) → Unit 5 (tenant
isolation + cross-tenant test) → Unit 7 (frontend) → Unit 8 → Unit 9.

## Open Questions / Blockers
- **CI activation still needs a human.** Re-attempted 2026-09-22 16:15 UTC on a
  throwaway branch: GitHub rejected the push —
  `refusing to allow a GitHub App to create or update workflow
  .github/workflows/ci.yml without workflows permission`. Not retried (per
  instructions). Validated workflow remains at
  `.github/workflows-pending/ci.yml` (YAML parses; jobs `backend`, `frontend`,
  `secret-scan`). Fix — one of:
  (a) human runs `git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml && git rm .github/workflows-pending/README.md`, commit, push;
  (b) grant the Genspark GitHub App *Workflows: read & write* on this repo;
  (c) create the file via the GitHub web UI.
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
2026-09-22 16:20 UTC — Phase 1 Unit 1 verified & recorded; CI activation re-blocked; next = Phase 1 Unit 2
