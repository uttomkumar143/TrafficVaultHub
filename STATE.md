# TrafficVaultHub — STATE

Version: 1.0
Status: BOOTSTRAP_PENDING

## Project
Product: TrafficVaultHub
Type: Performance Marketing / CPA Affiliate Network
Models: CPA, CPL, CPI, CPS

## Architecture
Frontend: React + Vite + TypeScript
Backend: Cloudflare Workers + Hono
Database: Cloudflare D1
Storage: Cloudflare R2
Cache: Cloudflare KV
Coordination: Durable Objects
Async Jobs: Cloudflare Queues
Hosting: Cloudflare Pages

## Repository
Canonical Repository: GitHub
Repository URL: TBD

## Current Phase
Phase: 0 — Bootstrap
Status: NOT STARTED

## Ground Truth
The repository must be inspected before any implementation changes.

Do not assume that any feature is implemented unless verified in the repository.

## Rules
- No fake production data.
- No fake financial balances.
- No client-side financial authority.
- No secrets in frontend code.
- No destructive database changes without explicit authorization.
- Preserve existing working code unless a change is required.
- Inspect before modifying.
- Run appropriate tests, typecheck, lint, and build after implementation.
- Keep commits small and traceable.
- Update this STATE.md after meaningful phase progress.

## Financial Safety
All financial truth must be server-side.

Money must use integer minor units plus currency.

Financial records must be append-only with compensating events.

Money movement and tracking operations must support idempotency.

## Security
All tenant-scoped access must verify:
1. Authentication
2. Organization membership
3. Resource ownership / authorization

Client-supplied IDs must never be trusted as authorization.

## AI Safety
AI may assist with analysis and workflow support.

AI must not independently authorize:
- payouts
- ledger changes
- compliance decisions
- financial approvals

## Deployment
Deployment target: Cloudflare

Production Cloudflare account configuration:
STATUS: NOT CONFIGURED

## Completed Work
- Master system prompt provided to coding agent.
- Repository implementation status not yet verified.

## Current Blockers
- PRD must be available to the coding agent.
- Repository structure must be inspected.
- Cloudflare production bindings must be verified/configured before production deployment.

## Next Action
Execute Phase 0 bootstrap only after inspecting the repository and available project documents.
