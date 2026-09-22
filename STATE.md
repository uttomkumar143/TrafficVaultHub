# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 1 — Identity, Auth & Multi-Tenancy (`04-PHASE1-IDENTITY-TENANCY.md`)

Phase 0 is COMPLETE (verified; see git history `2d4c17f`..`c25f376`). Do not
redo Phase 0.

Phase 1 unit status (verified 2026-09-22 against working tree at the Unit 2
commit — see "Last Completed Unit"):

| Unit | Scope | Status | Commits |
|------|-------|--------|---------|
| 1 | Auth foundation — email/password (scrypt via `@noble/hashes`, no hand-rolled crypto), email verification, opaque D1 sessions, password reset, MFA stub (never fake-passes). Routes under `/api/v1/auth`: `signup`, `verify-email`, `resend-verification`, `login`, `logout`, `forgot-password`, `reset-password`, `me`, `mfa`. `requireAuth` middleware. ADR-001. | COMPLETE | `39c201b`, `d763870`, `c11abfd`, `298124b`, `178b931` |
| 2 | Session & device management — `GET /api/v1/auth/sessions` (active sessions, `current` flag, safe device fields), `DELETE /api/v1/auth/sessions/:id` (own only; foreign/unknown → 404 `SESSION_NOT_FOUND`), `POST /api/v1/auth/sessions/revoke-others` (idempotent, current kept). No migration needed — reuses `sessions` from 0002. ADR-001 §2 amended. | COMPLETE | see git log: `feat(auth): add session and device management` |
| 3 | Organizations CRUD + membership with role | NOT STARTED (tables exist from 0001) | — |
| 4 | RBAC middleware (user → membership → role → permissions) | NOT STARTED | — |
| 5 | Tenant isolation enforcement + cross-tenant rejection test | NOT STARTED | — |
| 6 | `migrations/0002_identity.sql` | DONE for Unit 1+2 scope (credentials, sessions, auth_tokens, auth_events, `users.mfa_enabled`). Further Phase 1 needs → new additive `0003_*.sql`; never edit `0001`/`0002`. | `39c201b` |
| 7 | Frontend auth pages + auth context + route guards | NOT STARTED | — |
| 8 | Security tests (unauthorized, expired session, cross-tenant, role escalation) | PARTIAL — unauthorized + revoked/expired + inactive-user (`routes/auth.test.ts`) and cross-USER session isolation (`routes/auth-sessions.test.ts`) covered; cross-TENANT and role-escalation tests belong to Units 4–5 | — |
| 9 | STATE.md → Phase 1 complete | pending | — |

### Unit 2 verification (this session, sandbox, Node 22.23, fresh `npm ci`)
- `backend`: `npm run typecheck` ✅ · `npm test` **43/43** ✅ (5 files; 31
  pre-existing + 12 new in `src/routes/auth-sessions.test.ts`) ·
  `npm run build` (wrangler dry-run) ✅
- `wrangler d1 migrations apply --local` on a clean DB → `0001` ✅ `0002` ✅
  (unchanged; no new migration)
- Live `wrangler dev` smoke test ✅ (real D1 local): signup → verify → login A,
  login B → `GET /sessions` from A lists both with A `current:true`, B
  `current:false` → unauthenticated `GET /sessions` 401 → `DELETE /sessions/B`
  204 → `/me` with B 401, with A 200 → login C → `revoke-others` from A
  `{revoked_count:1}` → A 200, C 401 → repeat `revoke-others`
  `{revoked_count:0}`. Cross-user: Alice `DELETE` Bob's session id → 404
  `SESSION_NOT_FOUND`, Bob `/me` still 200, Bob's row `revoked_at IS NULL`;
  Alice's list never includes Bob; Alice `revoke-others` leaves Bob 200.
  List body contains no `token_hash` / `tvh_s_` / `password_hash`.
- `scripts/secret-scan.sh` → CLEAN ✅

### Key implementation facts (for the next session)
- Backend layout: `backend/src/modules/auth/{constants,crypto-utils,email,mfa,password,repository,service,tokens}.ts`,
  `backend/src/middleware/require-auth.ts`, `backend/src/routes/auth.ts`,
  `backend/src/lib/{errors,validation,time,bindings}.ts`.
- Unit 2 repository methods (all `user_id`-scoped, parameterized):
  `listActiveSessions(userId)`, `revokeOwnedSession(userId, sessionId, reason)`
  → boolean, `revokeOtherSessions(userId, currentSessionId, reason)` →
  revoked ids (SELECT+UPDATE in one `db.batch`). Service:
  `listSessions(ctx)`, `revokeSession(ctx, id, meta)`,
  `revokeOtherSessions(ctx, meta)`. Current session id comes from
  `c.get("auth").session.id` (set by `requireAuth`); no token is kept on the
  context.
- `createApp()` in `backend/src/app.ts` wires `AuthService` per request on
  `/api/v1/auth/*`; tests inject `MemoryEmailSender`. `requireAuth` needs
  `authService` on context — when adding protected routes outside `/auth/*`,
  extend that wiring middleware's path (Unit 4 should generalize it).
- Tests use `node:sqlite` shim (`backend/src/test/d1-sqlite.ts`) executing the
  real migration SQL.
- Debug tokens are echoed in responses only when `APP_ENV=development`.
- Error envelope per PRD §72: `{ error: { code, message, request_id } }`.
  Codes so far: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `INVALID_CREDENTIALS`,
  `EMAIL_NOT_VERIFIED`, `ACCOUNT_INACTIVE`, `EMAIL_ALREADY_REGISTERED`,
  `INVALID_TOKEN`, `SESSION_NOT_FOUND`, `NOT_FOUND`, `SERVICE_UNAVAILABLE`,
  `INTERNAL_ERROR`.
- No secrets required yet; `.dev.vars.example` documents vars.

## Last Completed Unit
Phase 1, Unit 2 — Session & device management (implemented, tested,
smoke-tested and recorded in this session; commit
`feat(auth): add session and device management` on `main`).

## Next Planned Unit
Phase 1, Unit 3 — Organizations CRUD + membership with role:
- `organizations` / `organization_members` / `roles` tables already exist
  from `0001_initial.sql` — inspect them first; add `0003_*.sql` only if a
  column is genuinely missing (additive; never edit 0001/0002).
- Module `backend/src/modules/organizations/{repository,service}.ts`, routes
  under `/api/v1/organizations` (create with `type` in
  `PLATFORM|ADVERTISER|AFFILIATE|PARTNER|AGENCY`, get, list mine, update;
  membership add/list/remove with role). Creator becomes owner-role member.
- Every route behind `requireAuth`; membership checks server-side only —
  never trust a client-supplied `organization_id` (PRD §7, §116). This is
  the groundwork Unit 4 (RBAC middleware) and Unit 5 (tenant isolation +
  cross-tenant test) build on.
- Note: `app.ts` wires `authService` only for `/api/v1/auth/*`; extend the
  wiring path (or generalize it) so `requireAuth` works on `/organizations`.
Then Unit 4 (RBAC middleware) → Unit 5 (tenant isolation + cross-tenant
test) → Unit 7 (frontend) → Unit 8 → Unit 9.

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
2026-09-22 17:20 UTC — Phase 1 Unit 2 (session & device management) complete & verified; next = Phase 1 Unit 3 (organizations)
