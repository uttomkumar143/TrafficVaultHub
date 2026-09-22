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
| 6 | CI skeleton (`.github/workflows/ci.yml`) | MISSING |
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
Unit 6 — CI skeleton: `.github/workflows/ci.yml` running `npm ci`,
`npm run typecheck`, `npm test`, `npm run build` for `frontend/` and `backend/`
on push + pull_request (Node 22, no production secrets).

Remaining after Unit 6: Unit 7 (docs), Unit 2 Durable Object placeholder,
Unit 8 (final STATE.md).

## Open Questions / Blockers
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
2026-09-22 12:22 UTC — Unit 5 testing setup complete
