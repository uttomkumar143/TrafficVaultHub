# ADR-001 — Authentication

- **Status:** Accepted (Phase 1, Unit 1)
- **Date:** 2026-09-22
- **PRD references:** §12 Identity Architecture, §77 OAuth-ready, §98 Security
  Architecture, §101 Secret Management, §116 Critical Security Tests

## Context

PRD §12 requires email verification, secure sessions, password reset, MFA,
session revocation and login monitoring, and states: *"Use a proven
authentication implementation/provider — do not invent custom cryptographic
protocols."* The backend runs on Cloudflare Workers (no Node `crypto.scrypt`,
no long-lived process, 10–30 ms CPU budget per request). Persistence available
today: D1 (SQLite), KV (placeholder), R2, Durable Objects (placeholder).

## Decision

### 1. First-party email/password auth built from audited primitives

We implement the auth *flows* ourselves in `backend/src/modules/auth/`, but
**every cryptographic operation is delegated to an audited library or the Web
Crypto API** — no bespoke algorithms, no custom protocols:

| Concern | Implementation | Why |
|---------|----------------|-----|
| Password hashing | `scrypt` from [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (audited, zero-dependency, pure JS, runs on Workers). Params `N=2^14, r=8, p=1, dkLen=32`, 16-byte random salt, self-describing hash string `$scrypt$N=…,r=…,p=…$<salt-b64>$<hash-b64>`. | Argon2id is the ideal, but has no Workers-safe, audited pure-JS implementation without WASM. bcrypt's 72-byte limit and WASM dependency are avoided. scrypt at these parameters is an OWASP-accepted choice and stays within Workers CPU limits. Self-describing format allows raising parameters later. |
| Randomness | `crypto.getRandomValues` / `crypto.randomUUID` (Web Crypto) | Platform CSPRNG. |
| Token / session digests | SHA-256 via `crypto.subtle.digest` | Only digests of session secrets and one-time tokens are stored; a DB read cannot be replayed. |
| Constant-time comparison | `@noble/hashes/utils` `equalBytes` on derived keys | Avoids timing side-channels on verification. |

A third-party IdP (Auth0/Clerk/etc.) was rejected for Unit 1: it would add a
paid external dependency for the core flow, complicate multi-tenant RBAC that
must live in our D1 schema anyway, and PRD §77 requires the platform not to
couple to one authentication mechanism. The `users.auth_provider /
auth_subject` columns from migration 0001 remain available for OAuth/SSO
providers later.

### 2. Sessions: server-side, opaque, stored in D1

- The client receives a random 256-bit bearer secret
  (`Authorization: Bearer tvh_s_<base64url>`). The server stores
  `SHA-256(secret)` in `sessions.token_hash` together with `expires_at`,
  `revoked_at`, `last_seen_at`, IP and user agent.
- **D1, not KV**, is the session store: sessions must be listable per user,
  revocable individually and in bulk, and joined with users/memberships in one
  query for RBAC (Unit 4). KV is eventually consistent and cannot list or join;
  its role (PRD §45) is cache only. A KV read-through cache can be added later
  without changing the contract.
- Stateless JWTs were rejected: PRD §12 requires revocation and device
  visibility, which JWTs cannot provide without a server-side deny-list — at
  which point the server-side session is simpler and safer.
- Lifetime: 30 days absolute (`SESSION_TTL_SECONDS`, configurable via vars);
  sliding `last_seen_at` update on each authenticated request. No idle
  timeout (not introduced in Unit 2; revisit with rate limiting in Phase 8).
- **Session & device management (Unit 2, 2026-09-22):** implemented on this
  same table with no schema change. `GET /auth/sessions` lists the caller's
  *active* rows (`revoked_at IS NULL AND expires_at > now`) with the safe
  fields only (`id, created_at, last_seen_at, expires_at, ip_address,
  user_agent, current`); `DELETE /auth/sessions/:id` and
  `POST /auth/sessions/revoke-others` are UPDATEs whose predicate always
  includes `user_id = <authenticated user>`, so a foreign or unknown id is
  indistinguishable (`404 SESSION_NOT_FOUND`, never 403) and other users'
  rows can never be touched. Revocation reasons: `LOGOUT`, `USER_REVOKED`,
  `REVOKE_OTHERS`, `PASSWORD_RESET`. Each user-initiated revocation is
  recorded as a `LOGOUT` auth event for the affected session. "Device" is
  the stored `ip_address` + `user_agent` captured at login — no
  fingerprinting; a user-editable device label would need an additive
  migration and is not in scope.

### 3. Email verification & password reset

- Single-use, hashed, time-limited tokens in `auth_tokens`
  (`EMAIL_VERIFICATION` 24 h, `PASSWORD_RESET` 1 h). Issuing a new token
  invalidates previous unconsumed tokens of the same purpose.
- Login is refused until `users.email_verified_at` is set
  (`EMAIL_NOT_VERIFIED`, HTTP 403).
- Password reset **revokes all existing sessions** for the user.
- `POST /auth/forgot-password` always returns `202 Accepted` regardless of
  whether the email exists (no account enumeration).

### 4. Email delivery is a port, not a provider

`EmailSender` is an interface in `modules/auth/email.ts`. Unit 1 ships a
`LogEmailSender` (writes a redacted line via `console.log` — **the token is
never logged**) and an in-memory sender for tests. In `APP_ENV=development`
only, the API response includes the raw token under `debug` so local flows
can be exercised end-to-end. A real transactional provider is wired in
Phase 6 (Notifications) behind the same interface.

### 5. MFA — explicit stub, never fake-passing

`users.mfa_enabled` exists (migration 0002). `modules/auth/mfa.ts` exposes
`getMfaStatus()` returning `{ enabled: false, available: false }` and
`beginMfaChallenge()` which **throws `NotImplemented`**. Login never consults
MFA yet, and the frontend can display "MFA not yet available". Wiring TOTP /
WebAuthn is a later Phase 1 / Phase 8 task and will require an additive
migration for secrets/recovery codes.

## Consequences

- Passwords are verifiable in tests without network or Workers runtime; the
  backend test suite runs the D1 shape against `node:sqlite`
  (`src/test/d1-sqlite.ts`) so SQL is exercised for real.
- All secrets remain server-side; the API never returns hashes or digests.
- `SESSION_TTL_SECONDS`, token TTLs and scrypt parameters are single
  constants in `modules/auth/constants.ts` and `wrangler.jsonc` vars — no
  secrets are required for Unit 1 (nothing to `wrangler secret put` yet).
- Rate limiting for login/reset endpoints (PRD §110) is **not** in this unit;
  `user_credentials.failed_attempts / locked_until` columns exist for the
  lockout policy to be implemented alongside rate limiting in Phase 8.
