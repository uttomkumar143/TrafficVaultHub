# PHASE 0 — Bootstrap & Foundations
### Paste after the Master System Prompt and Auto-Commit Protocol.

Goal: get an empty-but-correct, deployable skeleton committed to GitHub before any real feature work begins. Every unit below is its own commit+push per the auto-commit protocol.

## Units of work (commit after each)

1. **Repo scaffolding** — create the exact folder structure from the Master System Prompt (`frontend/`, `backend/`, `migrations/`, `tests/`, `docs/{adr,api,architecture,runbooks}`, `scripts/`). Add `docs/PRD.md` (already provided — do not modify its content). Add `.gitignore` covering `node_modules`, `.env`, `.dev.vars`, `dist`, `.wrangler`.

2. **Backend skeleton** — initialize a Cloudflare Workers + Hono project in `backend/`. Add a minimal `GET /api/v1/health` route returning `{ status: "ok" }`. Add `wrangler.toml` with placeholders for D1, KV, R2, Queues, and Durable Object bindings (no real IDs yet — those come from the deployment guide).

3. **Frontend skeleton** — initialize React + Vite + TypeScript in `frontend/`. Add Tailwind CSS + shadcn/ui, React Router with a placeholder home route, TanStack Query provider, and a basic layout shell. It should build with `npm run build` with zero errors.

4. **First migration** — create `migrations/0001_initial.sql` with only the truly foundational tables: `organizations`, `users`, `organization_members`, `roles`, `permissions`, `role_permissions`. Follow the currency/time model rules (UTC timestamps; no money fields yet in this migration).

5. **Testing setup** — add a minimal test runner config (whatever fits the stack, e.g. Vitest) with one passing smoke test on each side (backend health route, frontend renders).

6. **CI skeleton** — add a GitHub Actions workflow (`.github/workflows/ci.yml`) that on every push: installs deps, runs typecheck, runs tests, runs build, for both `frontend/` and `backend/`. This becomes your safety net independent of any chat session.

7. **Docs** — create `README.md` at repo root describing the project in one paragraph, the tech stack, and how to run it locally. Create `docs/architecture/overview.md` summarizing the module list and multi-tenant model from the PRD (link to `docs/PRD.md` for full detail, don't duplicate it).

8. **STATE.md** — create from `STATE-TEMPLATE.md`, set Current Phase to "Phase 0 — Bootstrap", fill in what was actually completed.

## Definition of done for Phase 0

- `npm run build` succeeds in both `frontend/` and `backend/`.
- CI workflow file exists and is valid YAML.
- `GET /api/v1/health` works locally via `wrangler dev`.
- All 8 units above are separate commits, pushed, and `STATE.md` reflects Phase 0 as complete with Next Planned Unit pointing to Phase 1.
