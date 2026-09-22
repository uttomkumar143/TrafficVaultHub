# PHASE 9 — Cloudflare Deployment & CI/CD
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 8 complete. Use alongside `13-DEPLOYMENT-GUIDE-BN.md` for the human-side setup steps (creating accounts, tokens, etc. — you cannot do those parts yourself).

Goal: a real, working deployment pipeline, so every push to the main branch (or a chosen release branch) deploys automatically — this is what makes the auto-commit protocol actually valuable end-to-end. Commit after each unit.

## Units of work

1. **wrangler.toml finalization** — fill in real binding names (D1 database, KV namespaces, R2 buckets, Queues, Durable Object classes) as placeholders that reference GitHub/Cloudflare secrets, not hardcoded IDs. Document in `docs/runbooks/deployment.md` exactly which secret/variable name maps to which binding, in English, so the human operator can fill in real values in Cloudflare's dashboard or GitHub Actions secrets — never ask for the actual secret values in chat.

2. **D1 migration deployment step** — a script (`scripts/deploy-migrations.sh` or similar) that applies pending migrations to the target D1 database in order, refuses to run if a migration file has been edited after being applied (compare checksums), and is called from CI, never run ad hoc against production.

3. **GitHub Actions deploy workflow** — extend `.github/workflows/ci.yml` (or add `deploy.yml`) so that on push to the release branch, after tests/typecheck/build pass: deploy `backend/` to Cloudflare Workers, deploy `frontend/` to Cloudflare Pages, run the migration step above. Use `secrets.CLOUDFLARE_API_TOKEN` and `secrets.CLOUDFLARE_ACCOUNT_ID` — reference them by name only, never a literal value.

4. **Environments** — separate staging and production configuration (either via wrangler environments or separate Cloudflare projects), so untested changes never reach production directly. Document which branch maps to which environment.

5. **Rollback plan** — document, in `docs/runbooks/rollback.md`, how to roll back a bad deploy (Workers version rollback, Pages deployment rollback, and what to do if a migration needs reverting — per PRD §109, that means a new corrective migration, never editing an applied one).

6. **Post-deploy smoke test** — a script or CI step that hits `GET /api/v1/health` and a couple of critical read endpoints against the just-deployed environment and fails the pipeline loudly if they don't respond correctly. Never report "deployment succeeded" without this actually passing.

7. **STATE.md** update, noting the deployment pipeline is live and how to trigger it.

## Definition of done

- A push to the release branch results in a real, verified deployment with no manual steps beyond the initial one-time secret setup (covered in the Bangla deployment guide).
- Rolling back is a documented, tested procedure, not a hope.
