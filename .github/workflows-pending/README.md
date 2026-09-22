# Pending workflow — manual activation required

`ci.yml` in this directory is the complete, validated GitHub Actions CI
workflow for TrafficVaultHub (Phase 0, Unit 6). It is **not active** here:
GitHub only runs workflows from `.github/workflows/`.

It lives in this holding directory because the GitHub App token used by the
AI build sessions is rejected when it tries to create or update anything under
`.github/workflows/`:

```
! [remote rejected] main -> main (refusing to allow a GitHub App to create or
  update workflow `.github/workflows/ci.yml` without `workflows` permission)
```

## Activate it (one of the following, done by a human with repo access)

**Option A — move the file (recommended):**

```bash
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
git rm .github/workflows-pending/README.md
git commit -m "chore(ci): activate GitHub Actions workflow"
git push origin main
```

**Option B — grant the permission and let the next AI session push:**
GitHub → repository *Settings* → *GitHub Apps* → the Genspark app → grant
**Workflows: Read and write**. The next session will then push the parked
commit and remove this directory.

**Option C — GitHub web UI:** *Add file → Create new file* at
`.github/workflows/ci.yml`, paste the contents of `ci.yml`, commit to `main`.

## What the workflow does

On every push / pull request, three jobs run in parallel:

| Job | Steps |
|-----|-------|
| `backend` | `npm ci` → `npm run typecheck` → `npm test` → `npm run build` (`wrangler deploy --dry-run`, no Cloudflare access needed) |
| `frontend` | `npm ci` → `npm run typecheck` → `npm test` → `npm run build` |
| `secret-scan` | `bash scripts/secret-scan.sh` |

Node.js 22, npm cache keyed on each project's `package-lock.json`. No secrets
are required. The exact sequence has been reproduced locally and passes.
