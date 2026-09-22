# STATE.md — TrafficVaultHub Project Memory
<!-- Keep this file SHORT and CURRENT. Full history belongs in git log, not here. -->
<!-- Contains ONLY verified information from repository inspection. -->

## Current Phase
Phase 0 — Bootstrap

Status: IN PROGRESS. Phase 0 is NOT complete.

Phase 0 unit status (verified by repository audit, 2026-09-22):

| Unit | Scope | Status |
|------|-------|--------|
| 1 | Repo scaffolding, `docs/PRD.md`, `.gitignore` | COMPLETE |
| 2 | Backend skeleton (Workers + Hono, `/api/v1/health`, wrangler bindings) | COMPLETE — D1/KV/R2/Queues placeholders + Durable Object `COORDINATOR` → `CoordinatorObject` (placeholder class in `src/workers/coordinator-object.ts`, exported from `src/index.ts`, `migrations` tag `v1`). Verified: typecheck, 2 tests, dry-run build lists the DO binding, `wrangler dev` → `/api/v1/health` 200 `{status:"ok"}`. |
| 3 | Frontend skeleton (React + Vite + TS, Tailwind, shadcn/ui, Router, TanStack Query, shell) | COMPLETE |
| 4 | `migrations/0001_initial.sql` (six foundational tables) | COMPLETE — applied locally; immutable |
| 5 | Testing setup (Vitest smoke tests, backend + frontend) | COMPLETE — backend: `backend/vitest.config.ts`, `src/routes/health.test.ts` (2 pass). Frontend: `frontend/vitest.config.ts`, `src/test/setup.ts`, `src/app/app.test.tsx` (2 pass, jsdom + Testing Library). Typecheck + build pass on both sides. |
| 6 | CI skeleton (`.github/workflows/ci.yml`) | BLOCKED (activation) — workflow written, YAML valid, full sequence (`npm ci` → typecheck → test → build, both sides + secret scan) reproduced locally and green. The identical file is committed on `origin/main` at `.github/workflows-pending/ci.yml` with activation instructions in `.github/workflows-pending/README.md`. GitHub rejects any push touching `.github/workflows/` from the GitHub App token (no `workflows` permission); Contents API returns 403 too. A human must move the file (one `git mv`) or grant the permission. |
| 7 | Docs (root `README.md`, `docs/architecture/overview.md`) | COMPLETE — `docs/architecture/overview.md` written (modules, tenancy, authz, Cloudflare, `/api/v1`; links PRD). Prompt-kit guide preserved verbatim at `docs/runbooks/ai-build-kit.md`; root `README.md` is now the project README (stack, structure, local dev, D1 migrations, tests, build). |
| 8 | STATE.md reflecting Phase 0 complete, next unit = Phase 1 | PARTIAL — this file exists and is maintained, but Phase 0 is not complete |

## Last Completed Unit
Unit 6 (as far as the token allows) — CI workflow recreated, validated and
committed to `origin/main` under `.github/workflows-pending/` because pushes
to `.github/workflows/` are rejected. Push retried twice + Contents API; all
rejected with the same permission error.

## Next Planned Unit
Unit 8 — final STATE.md for Phase 0. Phase 0 will be marked COMPLETE-WITH-
BLOCKER: every unit is done and pushed except the *activation* of the CI file,
which requires a human `git mv` (see `.github/workflows-pending/README.md`).
Next Planned Unit after that = Phase 1, Unit 1 (`04-PHASE1-IDENTITY-TENANCY.md`).

## Open Questions / Blockers
- **Unit 6 CI activation blocked (human action needed).** `git push` of any
  commit containing `.github/workflows/ci.yml` is rejected: "refusing to allow
  a GitHub App to create or update workflow ... without `workflows`
  permission". Contents API → 403. The validated workflow IS in the repo at
  `.github/workflows-pending/ci.yml`. Fix (pick one): (a) `git mv
  .github/workflows-pending/ci.yml .github/workflows/ci.yml` and push;
  (b) grant the Genspark GitHub App *Workflows: read & write* on this repo,
  then the next session moves it; (c) create the file via the GitHub web UI.
  Local branch `ci/github-actions-workflow` (commit `4587c7c`) holds the
  properly-placed version but exists only in the sandbox.
- `docs/PRD.md` ends mid-sentence at line 581 ("Advertiser experience shoul").
  This truncation is present in every historical version, so it is the original
  committed content. PRD is not edited.
- Cloudflare: NOT CONFIGURED. Deployment target (Genspark-hosted vs. own
  Cloudflare account) undecided. Phase 0 uses placeholder bindings only.
- Package manager strategy: separate `frontend/` and `backend/` npm projects
  (no monorepo tooling).

## Notes for the Next Session
- Read `docs/PRD.md` — esp. §119–§121.
- Loop after every unit: WORK → VALIDATE → SECRET SCAN → UPDATE STATE.md →
  COMMIT → PUSH → VERIFY → NEXT UNIT.
- `docs/BUILD_PROGRESS.md` is a HISTORICAL snapshot from the 2026-09-22
  recovery session (written before any application code existed). It is
  STALE and must NOT be treated as current project state. This file
  (`STATE.md`) is the only current-state source.
- The prompt-kit files (`01-MASTER-SYSTEM-PROMPT.md` … `13-DEPLOYMENT-GUIDE-BN.md`,
  `STATE-TEMPLATE.md`) now exist in the repository root (added in commits
  `9b18951`, `539be11`).

## Last Updated
2026-09-22 12:52 UTC — Unit 6 CI workflow committed to pending path
