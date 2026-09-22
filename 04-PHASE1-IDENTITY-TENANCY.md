# PHASE 1 — Identity, Auth & Multi-Tenancy
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 0 complete.

Reference PRD sections: 7 (Multi-Tenant Model), 8 (Organization Types), 9 (User Roles), 10 (Permission Architecture), 12 (Identity Architecture).

Goal: real authentication, real organizations, real RBAC — every later module depends on this being correct. Commit after each unit.

## Units of work

1. **Auth foundation** — implement email/password auth using a proven library/provider (do not hand-roll cryptography). Support: email verification, password hashing, secure session issuance, password reset flow, MFA hook (can be a stub that's clearly marked as not-yet-wired, never fake-passing).

2. **Session & device management** — session storage (D1 or KV, your call, document the choice in an ADR under `docs/adr/`), session revocation, listing active sessions/devices for a user.

3. **Organizations** — CRUD for organizations with `type` in `PLATFORM | ADVERTISER | AFFILIATE | PARTNER | AGENCY`. Organization membership table linking users to organizations with a role.

4. **RBAC middleware** — a Hono middleware that resolves: authenticated user → organization membership → role → permissions, and rejects anything outside scope. This middleware must be used by every protected route from this point forward — do not let later phases skip it "temporarily."

5. **Tenant isolation enforcement** — for any query touching an `organization_id`-owned resource, the middleware/helper must derive the organization from the authenticated session, never trust a client-supplied value. Write an explicit test proving a cross-tenant request is rejected (PRD §116 requires this).

6. **Migration** — `migrations/0002_identity.sql` extending schema as needed for sessions, MFA fields, org types — additive only, never edit `0001`.

7. **Frontend** — login, signup, email verification, password reset pages; an auth context/hook wired to TanStack Query; route guards based on role.

8. **Tests** — unauthorized access rejected, expired session rejected, cross-tenant access rejected, role escalation attempt rejected (PRD §116 Critical Security Tests, the identity-relevant subset).

9. **STATE.md** update reflecting Phase 1 completion and what's next (Phase 2).

## Definition of done

- A user can sign up, verify email, log in, and get a session scoped to their organization and role.
- Every protected backend route in this phase goes through the RBAC + tenant-isolation middleware — no exceptions.
- The cross-tenant and role-escalation tests exist and pass.
