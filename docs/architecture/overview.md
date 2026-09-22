# TrafficVaultHub — Architecture Overview

This document summarizes the system architecture at the level a new engineer
needs to orient themselves. It intentionally does **not** duplicate the
product requirements. The authoritative and complete specification is
[`docs/PRD.md`](../PRD.md) (v10.0, "Master Product Requirements Document +
Architecture Constitution"); section numbers below (e.g. PRD §7) refer to it.
Current implementation progress is tracked in [`STATE.md`](../../STATE.md).

## 1. What the system is

TrafficVaultHub is a performance-marketing / CPA affiliate network platform
(CPA, CPL, CPI, CPS) connecting Advertisers, Affiliates/Publishers, Network
Operations, Finance, Compliance and Support (PRD §1–§2). Three principles shape
every design decision (PRD §3–§5):

1. **No fake production data** — no invented clicks, conversions, earnings or
   statistics anywhere in production paths. Demo data is isolated in seed
   scripts only.
2. **Financial authority is server-side** — the frontend never computes
   balances, commissions, payouts, revenue or ledger state.
3. **Security authority is server-side** — the frontend is never trusted for
   authorization, tenant ownership, eligibility, fraud or compliance decisions.

## 2. Modular monolith

The backend is a **single deployable Worker organized as a modular monolith**
(PRD §6). Microservices are explicitly deferred. Each module owns its routes,
domain logic and data access behind a clean boundary so that it *could* be
extracted later without breaking public API contracts.

Logical modules (PRD §6):

| Domain | Modules |
|--------|---------|
| Identity & tenancy | Identity, Organizations |
| Supply / demand | Advertisers, Affiliates, Offers, Marketplace |
| Traffic | Tracking, Attribution, SmartLinks, Conversions |
| Risk | Fraud, Compliance |
| Money | Finance (ledger), Billing, Payouts |
| Operations | Reporting, Support, Notifications, Integrations, Audit, System |

Backend source layout (PRD §121): `backend/src/{modules,middleware,integrations,workers,lib,routes}/`.
Module code lives under `backend/src/modules/<module>/`; cross-cutting HTTP
concerns (auth, tenant scoping, rate limiting, error envelope) live in
`middleware/`; queue consumers and scheduled work live in `workers/`; external
adapters (payout providers, email, etc.) live in `integrations/`.

## 3. Multi-tenant model and organization ownership

Every **organization is a tenant** (PRD §7). Organization types are
`PLATFORM`, `ADVERTISER`, `AFFILIATE`, `PARTNER`, `AGENCY` (PRD §8).

* Every tenant-scoped resource — advertiser, offer, affiliate, traffic source,
  creative, billing account, and everything derived from them — carries an
  `organization_id` and is owned by exactly one organization.
* Users belong to organizations through `organization_members`, which binds a
  user to a role *within* an organization. A user may be a member of several
  organizations.
* Roles and permissions are tenant-scoped (PRD §9–§10): platform roles
  (`SUPER_ADMIN`, `OPERATIONS_ADMIN`, `FINANCE_MANAGER`, `COMPLIANCE_MANAGER`,
  `SUPPORT_AGENT`, `ANALYST`), advertiser roles and affiliate roles.

The six foundational tables that implement this model are created by
`migrations/0001_initial.sql`: `organizations`, `users`, `roles`,
`permissions`, `role_permissions`, `organization_members`.

## 4. Server-side authorization

Every protected endpoint applies, in order, on the server (PRD §5, §7, §10):

1. **Authentication** — a valid session/API key identifies the user.
2. **Organization membership** — the user is an active member of the
   organization the request operates on.
3. **RBAC** — the member's role grants the required permission
   (e.g. `offers.approve`, `payouts.release`).
4. **Resource ownership** — the addressed resource's `organization_id` matches
   the authorized organization. Cross-tenant access is rejected.
5. **Action authorization / separation of duties** — high-risk operations may
   require a second approver (PRD §11).

Client-supplied `organization_id`, `affiliate_id` or `advertiser_id` values are
never trusted as authorization inputs; they are only used to *locate* a
resource whose ownership is then verified.

## 5. Frontend / backend separation

* **Frontend** (`frontend/`): React + Vite + TypeScript, Tailwind CSS +
  shadcn/ui, React Router, TanStack Query, React Hook Form + Zod, Recharts.
  It is a pure client of the REST API: it renders server state, collects
  input and validates it for UX only. It holds no business rules, no
  financial arithmetic and no authorization logic.
* **Backend** (`backend/`): Cloudflare Workers + Hono. It owns all domain
  logic, all financial computation (integer `amount_minor` + `currency`,
  PRD §14), all time handling (UTC storage, PRD §15) and all authorization.
* The two are separate npm projects with separate `typecheck`, `test` and
  `build` pipelines; in local development Vite proxies `/api/*` to the Worker.

## 6. Cloudflare architecture

| Concern | Service | Binding (Phase 0 placeholder) |
|---------|---------|-------------------------------|
| API runtime | Cloudflare Workers + Hono | — |
| Primary relational database | Cloudflare D1 (SQLite) | `DB` |
| Coordination / hot state (caps, counters) | Durable Objects | `COORDINATOR` → `CoordinatorObject` |
| Cache (SmartLink eligibility, config) | Cloudflare KV | `CACHE` |
| Object storage (creatives, documents) | Cloudflare R2 | `STORAGE` |
| Async processing (events, webhooks, retries) | Cloudflare Queues | `EVENTS_QUEUE` |
| Frontend hosting | Cloudflare Pages | — |

Bindings are declared in `backend/wrangler.jsonc` and typed in
`backend/src/lib/bindings.ts`. In Phase 0 all resource IDs are placeholders;
no Cloudflare account has been provisioned. Secrets are never committed —
local secrets go in the git-ignored `.dev.vars`, production secrets in
Cloudflare's secret store (PRD §101).

Schema changes are delivered only through numbered SQL migrations in
`migrations/`; applied migrations are immutable (PRD §109).

## 7. REST API under `/api/v1`

All HTTP endpoints are versioned under **`/api/v1`** (PRD §70). Contracts under
a published version are not silently broken; breaking changes go to `/api/v2`.
Every endpoint defines request/response schema, authentication,
authorization, errors, pagination, rate limit and idempotency (PRD §71).

Errors use a uniform envelope with no stack traces (PRD §72):

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable message", "request_id": "..." } }
```

Currently implemented: `GET /api/v1/health` → `200 { "status": "ok" }`
(liveness probe, no external calls).

## 8. Where to read next

* Full requirements, lifecycles, data model and rules: [`docs/PRD.md`](../PRD.md)
* Current phase / next unit of work: [`STATE.md`](../../STATE.md)
* Migration rules and how to apply locally: [`migrations/README.md`](../../migrations/README.md)
* Architecture decisions (as they are made): `docs/adr/`
