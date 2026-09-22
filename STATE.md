# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 0 — Bootstrap

Status: COMPLETE (with one human-action blocker: CI file activation, see
below). All eight units are implemented, verified and pushed to
`origin/main`. Next work is Phase 1.

Phase 0 unit status (verified 2026-09-22 against `origin/main` @ `1758dd8`
from a fresh clone):

| Unit | Scope | Status | Commit |
|------|-------|--------|--------|
| 1 | Repo scaffolding, `docs/PRD.md`, `.gitignore` | COMPLETE | `2d4c17f` |
| 2 | Backend skeleton — Workers + Hono, `GET /api/v1/health` → `{status:"ok"}`, `wrangler.jsonc` placeholders for D1/KV/R2/Queues + Durable Object `COORDINATOR` → `CoordinatorObject` (placeholder class, no logic) | COMPLETE | `ce313d9`, `97ece02` |
| 3 | Frontend skeleton — React 19 + Vite 7 + TS, Tailwind 4, shadcn/ui, React Router 7, TanStack Query 5, AppShell | COMPLETE | `9a8b993` |
| 4 | `migrations/0001_initial.sql` — 6 tables (organizations, users, organization_members, roles, permissions, role_permissions), UTC timestamps, no money fields | COMPLETE — immutable | `722f9bb` |
| 5 | Vitest smoke tests — backend `health.test.ts` (2 pass), frontend `app.test.tsx` (2 pass, jsdom + Testing Library) | COMPLETE | `d4d52c9`, `ce96416` |
| 6 | CI — `ci.yml` (backend + frontend: `npm ci` → typecheck → test → build; plus secret-scan job) | COMPLETE, NOT ACTIVE — valid YAML, sequence reproduced locally; committed at `.github/workflows-pending/ci.yml` because GitHub rejects App-token pushes to `.github/workflows/` | `aa8f2ee` |
| 7 | Docs — root `README.md` (project, stack, local run), `docs/architecture/overview.md`; prompt-kit guide preserved at `docs/runbooks/ai-build-kit.md` | COMPLETE | `b954b35`, `1758dd8` |
| 8 | STATE.md reflecting Phase 0 complete, next = Phase 1 | COMPLETE | this commit |

Definition-of-done verification (fresh clone of `origin/main`):
- `backend`: `npm ci` ✅ · `typecheck` ✅ · `test` 2/2 ✅ · `build` (wrangler dry-run, lists `COORDINATOR` DO) ✅
- `frontend`: `typecheck` ✅ · `test` 2/2 ✅ · `build` ✅ (source byte-identical to sandbox tree)
- `wrangler dev` → `GET /api/v1/health` → HTTP 200 `{"status":"ok"}` ✅
- `wrangler d1 migrations apply --local` on a clean DB → `0001_initial.sql` ✅, exactly 6 tables ✅
- CI YAML parses; jobs: `backend`, `frontend`, `secret-scan` ✅
- Secret scan CLEAN ✅ · working tree clean · `HEAD == origin/main` ✅

## Last Completed Unit
Phase 0, Unit 8 — final STATE.md. Phase 0 closed.

## Next Planned Unit
Phase 1, Unit 1 — Auth foundation (`04-PHASE1-IDENTITY-TENANCY.md`):
email/password auth via a proven library (no hand-rolled crypto), email
verification, password hashing, secure session issuance, password reset,
clearly-stubbed MFA hook. PRD §7–§10, §12. Requires deciding session store
(D1 vs KV) — record in `docs/adr/`. Migration goes in `0002_identity.sql`
(additive; never edit `0001`).

## Open Questions / Blockers
- **CI activation needs a human (only Phase 0 leftover).** The GitHub App
  token cannot write `.github/workflows/` ("refusing to allow a GitHub App to
  create or update workflow ... without `workflows` permission"; Contents API
  → 403). The validated workflow is in the repo at
  `.github/workflows-pending/ci.yml`. Fix — one of:
  (a) `git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml && git rm .github/workflows-pending/README.md`, commit, push;
  (b) grant the Genspark GitHub App *Workflows: read & write* on this repo so a
  session can do (a);
  (c) create the file via the GitHub web UI.
- `docs/PRD.md` ends mid-sentence at line 581 ("Advertiser experience shoul").
  Present in every historical version; PRD is not edited.
- Cloudflare: NOT CONFIGURED. Deployment target (Genspark-hosted vs. own
  account) undecided. All `wrangler.jsonc` resource IDs are placeholders.
- Package manager strategy: separate `frontend/` and `backend/` npm projects
  (no monorepo tooling).

## Notes for the Next Session
- Read `docs/PRD.md` §7–§10, §12 before Phase 1 Unit 1.
- Loop after every unit: WORK → VALIDATE → SECRET SCAN (`scripts/secret-scan.sh`)
  → UPDATE STATE.md → COMMIT → PUSH → VERIFY → NEXT UNIT.
- `docs/BUILD_PROGRESS.md` is a STALE historical snapshot; this file is the only
  current-state source.
- Prompt-kit files `01-…13-*.md` and `STATE-TEMPLATE.md` live in the repo root.
- Local dev: `cd backend && npm run dev` (port 8787); `cd frontend && npm run dev`.

## Last Updated
2026-09-22 13:10 UTC — Phase 0 complete; Unit 8 final STATE.md
