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
| 2 | Backend skeleton (Workers + Hono, `/api/v1/health`, wrangler bindings) | PARTIAL — Durable Object binding is only a commented example in `backend/wrangler.jsonc`; no `CoordinatorObject` class exported. D1/KV/R2/Queues placeholders are present. |
| 3 | Frontend skeleton (React + Vite + TS, Tailwind, shadcn/ui, Router, TanStack Query, shell) | COMPLETE |
| 4 | `migrations/0001_initial.sql` (six foundational tables) | COMPLETE — applied locally; immutable |
| 5 | Testing setup (Vitest smoke tests, backend + frontend) | COMPLETE — backend: `backend/vitest.config.ts`, `src/routes/health.test.ts` (2 pass). Frontend: `frontend/vitest.config.ts`, `src/test/setup.ts`, `src/app/app.test.tsx` (2 pass, jsdom + Testing Library). Typecheck + build pass on both sides. |
| 6 | CI skeleton (`.github/workflows/ci.yml`) | BLOCKED (push) — workflow written, YAML validated, full sequence reproduced locally, committed as `89b8d87` on LOCAL branch `ci/github-actions-workflow`. GitHub rejects the push: GitHub App token lacks `workflows` permission. Not on `origin/main`. |
| 7 | Docs (root `README.md`, `docs/architecture/overview.md`) | PARTIAL — root README is the prompt-kit usage guide, not a project README; `docs/architecture/` is empty |
| 8 | STATE.md reflecting Phase 0 complete, next unit = Phase 1 | PARTIAL — this file exists and is maintained, but Phase 0 is not complete |

## Last Completed Unit
Unit 5 — Testing Setup. Backend: `npm test` (Vitest) runs
`GET /api/v1/health` via `createApp().request()` → 200 `{"status":"ok"}`.
Frontend: `npm test` (Vitest + jsdom + Testing Library) renders the real route
table under `createMemoryRouter` + `QueryClientProvider`, asserts AppShell
landmarks, HomePage heading, stubbed health result, and NotFound route.
`npm run typecheck` and `npm run build` pass in both `backend/` and `frontend/`.

## Next Planned Unit
Unit 7 — Docs: `docs/architecture/overview.md`; move prompt-kit guide from
root `README.md` to `docs/runbooks/ai-build-kit.md`; write project `README.md`.

Remaining after Unit 7: Unit 2 Durable Object placeholder, Unit 8 (final
STATE.md), and landing Unit 6 on `origin/main` once the permission is fixed.

## Open Questions / Blockers
- **Unit 6 push blocked.** `git push` of any commit containing
  `.github/workflows/ci.yml` is rejected by GitHub: "refusing to allow a
  GitHub App to create or update workflow ... without `workflows` permission".
  The Contents API returns 403 for the same path. Fix: grant the Genspark
  GitHub App the *Workflows* permission on this repo (GitHub → Settings →
  Applications), then push local branch `ci/github-actions-workflow` (or
  cherry-pick `89b8d87`) onto `main`. Alternatively add the file manually.
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
2026-09-22 12:26 UTC — Unit 6 written; push blocked by GitHub App workflows permission
