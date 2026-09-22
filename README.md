# TrafficVaultHub

TrafficVaultHub is a performance-marketing / CPA affiliate network platform
(CPA, CPL, CPI, CPS) that connects advertisers, affiliates/publishers, network
operations, finance, compliance and support. It provides an offer marketplace,
tracking and attribution, SmartLinks, conversion validation, fraud detection,
compliance, an immutable financial ledger, advertiser billing, affiliate
payouts, reporting, APIs and webhooks. The complete specification is
[`docs/PRD.md`](docs/PRD.md); a short architecture summary is in
[`docs/architecture/overview.md`](docs/architecture/overview.md).

**Project status:** Phase 0 (bootstrap skeleton). See
[`STATE.md`](STATE.md) for the current phase, last completed unit and next
planned unit — that file is the single source of truth for progress.

## Technology stack

| Layer | Choice |
|-------|--------|
| Frontend | React 19 + Vite 7 + TypeScript, Tailwind CSS 4 + shadcn/ui, React Router 7, TanStack Query 5, React Hook Form + Zod, Recharts |
| Backend | Cloudflare Workers + Hono 4 |
| Database | Cloudflare D1 (SQLite), SQL migrations in `migrations/` |
| Coordination / cache / storage / async | Durable Objects, Cloudflare KV, Cloudflare R2, Cloudflare Queues |
| API | REST, versioned under `/api/v1` |
| Testing | Vitest (backend: Hono `app.request()`; frontend: jsdom + Testing Library) |
| CI | GitHub Actions (`.github/workflows/ci.yml`) |

## Repository structure

```
.
├── frontend/                 React + Vite SPA (own package.json)
│   └── src/{app,components,features,hooks,lib,routes,types,test}/
├── backend/                  Cloudflare Worker + Hono API (own package.json)
│   ├── src/{modules,middleware,integrations,workers,lib,routes}/
│   └── wrangler.jsonc        Worker config + placeholder bindings
├── migrations/               D1 SQL migrations (0001_initial.sql, …)
├── tests/                    Cross-cutting / e2e tests (empty in Phase 0)
├── docs/
│   ├── PRD.md                Master product requirements (source of truth)
│   ├── architecture/         Architecture overview
│   ├── adr/  api/            Decision records, API docs (as they are written)
│   └── runbooks/             Operational guides, incl. the AI build-kit guide
├── scripts/                  Helper scripts (secret-scan.sh)
├── .github/workflows/ci.yml  CI pipeline
├── STATE.md                  Project memory: current phase / next unit
├── 01-…13-*.md               AI build-kit prompt files (see docs/runbooks/ai-build-kit.md)
└── README.md
```

`frontend/` and `backend/` are independent npm projects; there is no
monorepo tooling. Run commands from inside each directory.

## Local development

Prerequisites: Node.js 22 and npm 10.

### Backend (Cloudflare Worker)

```bash
cd backend
npm ci
npm run dev          # wrangler dev on http://127.0.0.1:8787
curl http://127.0.0.1:8787/api/v1/health   # → {"status":"ok"}
```

Local secrets (none required in Phase 0) go in `backend/.dev.vars`, which is
git-ignored; see `backend/.dev.vars.example`. All resource IDs in
`backend/wrangler.jsonc` are placeholders — no Cloudflare account is
configured yet.

### Frontend (React + Vite)

```bash
cd frontend
npm ci
npm run dev          # Vite on http://localhost:5173, proxies /api → :8787
```

Start the backend first so the home page's backend connectivity probe
succeeds.

### Local D1 migrations

Migrations live in `migrations/` and are applied through Wrangler from the
`backend/` directory (its `wrangler.jsonc` points `migrations_dir` at
`../migrations`). Local mode uses an automatic SQLite database under
`backend/.wrangler/` and needs no Cloudflare credentials.

```bash
cd backend
npx wrangler d1 migrations apply trafficvaulthub-db --local
npx wrangler d1 execute trafficvaulthub-db --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Applied migrations are immutable — never edit an existing file; add a new
numbered one (see `migrations/README.md`).

## Testing

```bash
cd backend  && npm test     # Vitest: GET /api/v1/health smoke test
cd frontend && npm test     # Vitest + jsdom: app shell / home page render test
```

Typecheck:

```bash
cd backend  && npm run typecheck
cd frontend && npm run typecheck
```

## Build

```bash
cd backend  && npm run build   # wrangler deploy --dry-run --outdir dist (bundle only, no upload)
cd frontend && npm run build   # vite build → frontend/dist
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `typecheck`, `test` and
`build` for both projects on every push and pull request. It requires no
secrets. (If the workflow file is not yet present on `main`, see the
blockers section of `STATE.md`.)

## Deployment

Not configured in Phase 0. The deployment target (Cloudflare account,
resource IDs, secrets) is an open item tracked in `STATE.md`; see
`12-PHASE9-DEPLOYMENT-CLOUDFLARE.md` and `13-DEPLOYMENT-GUIDE-BN.md` for the
planned procedure.

## Security notes

* Never commit secrets. `.env*`, `.dev.vars*` (except `*.example`) are
  git-ignored; run `scripts/secret-scan.sh` before committing.
* Authorization, tenant ownership and all financial computation are
  server-side only (PRD §4–§5).

## Working on this repository with an AI agent

This project is built incrementally by AI coding sessions following the
prompt kit in the repository root (`01-MASTER-SYSTEM-PROMPT.md`,
`02-AUTO-COMMIT-PROTOCOL.md`, phase prompts `03`–`12`). The usage guide for
that kit is preserved in
[`docs/runbooks/ai-build-kit.md`](docs/runbooks/ai-build-kit.md).
