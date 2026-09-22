# ADR-002 — D1 data model: organizations, roles and membership

- **Status:** Accepted (Phase 1, Unit 3)
- **Date:** 2026-09-22
- **PRD references:** §7 Multi-Tenant Model, §8 Organization Types, §9 User
  Roles, §10 Permission Architecture, §92 Database Architecture, §93 Database
  Rules, §94 Data Ownership, §95 Soft Deletion, §109 Migration Strategy,
  §124 Admin Safety
- **Migrations:** `0001_initial.sql` (tables), `0003_organizations.sql`
  (owner flag, role/org-type matrix, role catalogue, audit log)

## Context

Every tenant-scoped resource in TrafficVaultHub is owned by an
`organization_id` and every authorization decision joins *authenticated user →
organization membership → role → permissions* (PRD §7, §10, §94). Migration
0001 created `organizations`, `users`, `roles`, `permissions`,
`role_permissions` and `organization_members`, but left three questions open
that Unit 3 (Organizations CRUD + membership) must answer before any code
touches them:

1. How does the server know which role to give the *creator* of a new
   organization, and how do we prevent an organization from losing its last
   owner (PRD §124 "dangerous actions")?
2. PRD §9 groups roles by tenant kind (Platform / Advertiser / Affiliate).
   Which roles may be assigned inside `PARTNER` and `AGENCY` organizations,
   which §9 does not list?
3. Where do organization and membership changes get audited (PRD §92
   `audit_logs`, §16 "every state transition is audited")?

## Decision

### 1. System role catalogue lives in the database, seeded by migration

The fourteen PRD §9 role keys are inserted by `0003_organizations.sql` as
**system roles** (`organization_id IS NULL`, `is_system = 1`) with fixed
UUID-format ids (`…-0000000001xx` platform, `…-02xx` advertiser, `…-03xx`
affiliate, `…-0401` shared `VIEWER`). Rationale:

- `organization_members.role_id` is a foreign key; the target rows must exist
  in every environment before the first organization is created.
- Fixed ids make the rows identical across local, preview and production, so
  no environment-specific lookup table is needed and `INSERT OR IGNORE` keeps
  the migration idempotent.
- This is PRD-defined **reference data**, not business or demo data — it is
  the one exception to the "no seed data in migrations" rule and is documented
  as such in `migrations/README.md`.
- `VIEWER` appears once (system role keys are globally unique per the
  `ux_roles_system_key` index); its tenant applicability is expressed through
  `role_org_types`, not by duplicating the row.

Tenant-defined custom roles (`organization_id NOT NULL`) remain possible under
the 0001 schema but are **not** exposed by any API in Phase 1.

### 2. `roles.is_owner` + `role_org_types` drive creator seating and guards

- `roles.is_owner = 1` marks exactly one role per organization type:
  `SUPER_ADMIN` (PLATFORM), `ADVERTISER_OWNER` (ADVERTISER, AGENCY),
  `AFFILIATE_OWNER` (AFFILIATE, PARTNER). Uniqueness per type is asserted by
  a test over the migration (`src/test/d1-sqlite.test.ts`).
- `role_org_types (role_id, org_type)` is the allow-list of organization types
  a role may be granted in. The service rejects any role assignment whose
  `(role, organization.type)` pair is absent (`ROLE_NOT_ALLOWED_FOR_ORG_TYPE`).
- On `POST /organizations` the server looks up the owner role for the given
  `type` and seats the creator with it. The client never supplies a role for
  itself.
- **Last-owner guard:** a member holding the owner role cannot be removed, and
  their role cannot be changed, if they are the only `ACTIVE` owner of that
  organization (`LAST_OWNER`). This prevents orphaned tenants.
- **PARTNER / AGENCY mapping (open question resolved provisionally):** PRD §8
  lists these types but §9 defines no roles for them. We map AGENCY → the
  advertiser role family (agencies operate advertiser accounts) and PARTNER →
  the affiliate role family (partners supply traffic); `VIEWER` is available
  to all four tenant types. If the product later defines dedicated
  PARTNER/AGENCY roles, they are added by a new migration inserting roles +
  `role_org_types` rows — no schema change, no code change in the guards.
- **PLATFORM organizations cannot be self-created.** `POST /organizations`
  accepts `ADVERTISER | AFFILIATE | PARTNER | AGENCY` only; creating the
  platform tenant and seating the first `SUPER_ADMIN` is an operator
  bootstrap procedure (Phase 9 deployment) and would otherwise be a trivial
  privilege-escalation path (PRD §116).

### 3. Membership semantics

- One row per `(organization_id, user_id)` (unique index from 0001). Removing
  a member sets `status = 'REMOVED'`, `removed_at = now` — soft deletion (PRD
  §95). Re-adding a removed user **reactivates the same row** with the new
  role rather than inserting a second one.
- Members are added by *email* of an already-registered user. The server
  resolves the email to `users.id`; the client never sends a `user_id`.
  Invitation of not-yet-registered users (`status = 'INVITED'`, a token flow)
  is deferred; the status value already exists in the 0001 check constraint.
- Only `ACTIVE` memberships confer access. `SUSPENDED` is reserved for
  compliance actions in Phase 4.
- Any request for an organization the caller is not an `ACTIVE` member of —
  including a non-existent id — answers `404 ORGANIZATION_NOT_FOUND`, never
  403, so tenant ids cannot be enumerated (PRD §99 IDOR).
- Managing members (add / change role / remove) and updating the organization
  requires the caller to hold an **owner role** in that organization in Unit
  3. Unit 4 replaces this coarse check with permission-key RBAC
  (`organizations.update`, `members.manage`, …) on top of the same tables;
  the owner-role check is the strict subset that is safe today.

### 4. `audit_logs` is the single append-only audit table

`0003` creates `audit_logs (id, organization_id, actor_user_id, action,
target_type, target_id, metadata, ip_address, user_agent, request_id,
created_at)`. Rules:

- Rows are **never** updated or deleted by application code (PRD §57 spirit,
  §92, §124).
- `metadata` is JSON containing non-sensitive before/after values only —
  never passwords, tokens, hashes or secrets (PRD §102).
- Actions written by Unit 3: `organization.created`, `organization.updated`,
  `member.added`, `member.role_changed`, `member.removed`. Later modules
  (offers, finance, compliance) reuse the table with their own action keys.
- `auth_events` (0002) stays separate: it is high-volume login telemetry keyed
  by user, whereas `audit_logs` records privileged mutations keyed by tenant.

### 5. Permission-key RBAC (Unit 4; migration `0004_permissions.sql`)

- `permissions` holds the PRD §10 catalogue plus the identity-module keys
  `organizations.read/update`, `members.read/manage`; `role_permissions` maps
  the 14 system roles to them. Both are reference data seeded by migration
  with fixed ids (same reasoning as §1). A typed mirror lives in
  `backend/src/modules/rbac/permissions.ts`; a test asserts parity with the
  table so the two cannot drift.
- **Middleware chain** (`backend/src/middleware/require-org.ts`):
  `requireAuth` → `requireOrg` (`:orgId` path param → caller's ACTIVE
  membership → role → permission keys, stored as `c.get("tenant")`) →
  `requirePermission("<key>")`. Every tenant-scoped route from Unit 4 onward
  MUST use this chain; services receive the resolved `TenantContext` and
  never re-derive the tenant from client input.
- Non-member / unknown / malformed org id → `404 ORGANIZATION_NOT_FOUND`
  (unchanged no-enumeration rule). Missing key → `403 FORBIDDEN`.
- **Grant policy:** `*.read` keys are broad within a tenant; mutating keys are
  narrow. Network powers (`offers.approve`, `ledger.adjust`,
  `payouts.review/approve/release`, `fraud.review`, `compliance.resolve`) are
  PLATFORM-role only (PRD §11 separation of duties).
- **Owner seats are protected beyond keys:** granting an owner role, or
  changing/removing an existing owner, additionally requires the caller to
  hold the owner role (`OrganizationService.assertOwner`). A role with
  `members.manage` (e.g. `ADVERTISER_ADMIN`, `AFFILIATE_MANAGER`) manages
  non-owner seats only. This closes the escalation path "manager mints
  themselves an owner".
- Authority is read from D1 on every request — no caching of permission sets
  (KV caching may be introduced later with explicit invalidation on role
  change; not before a measured need).
- `GET /api/v1/organizations/:orgId/me` returns the caller's resolved role and
  permission keys for UI gating. It is informational only; the server
  re-checks every request.

### 6. Tenant-scoping helper for `organization_id`-owned resources (Unit 5)

- `backend/src/lib/tenant-scope.ts` defines a branded `TenantId` obtainable
  only via `tenantIdOf(tenant)` from the `TenantContext` that `requireOrg`
  resolved, and `scopedQuery(db, sql, tenantId, ...params)` which throws
  `UnscopedQueryError` unless the SQL's FIRST bind placeholder is an
  `organization_id = ?` predicate. Repositories for business tables (Phase 2:
  offers, advertiser/affiliate profiles, creatives, traffic sources, billing
  accounts …) MUST accept `TenantId`, not `string`, and build their queries
  with `scopedQuery`. A raw client-supplied id therefore fails typecheck, and
  a forgotten predicate fails at runtime before reaching D1.
- The predicate check is textual and conservative by design; it is a guard
  against omission, not a proof. The authority remains the explicit PRD §116
  suite `backend/src/routes/tenant-isolation.test.ts` (two tenants; every
  read/mutation of B by A → 404; B's member ids under A's path → 404;
  body/query `organization_id` ignored; dual-membership authority scoped per
  path; PLATFORM not self-creatable; revoked session → 401), which every
  later phase extends with its own resource family.
- `audit_logs` is currently the only `organization_id`-owned table and is
  used as the fixture for the helper's tests.

## Consequences

- **Positive:** authorization data (role catalogue, owner flag, type matrix)
  is queryable and versioned with the schema; no role names are hardcoded in
  guards beyond `is_owner`; tenant enumeration and last-owner orphaning are
  prevented at the service layer with tests; audit trail exists from the first
  tenant mutation.
- **Negative / accepted:** role catalogue changes require a migration (by
  design — PRD §109 wants schema-level immutability). The owner-only
  management rule is coarser than the §10 permission model until Unit 4 lands.
- **Follow-ups:** Phase 2 repositories adopt `TenantId` + `scopedQuery`
  (§6) and extend `tenant-isolation.test.ts` with offer/profile cases;
  Phase 9 documents the PLATFORM bootstrap runbook.
