# migrations/

Cloudflare D1 (SQLite) schema migrations, applied in filename order.

| File | Scope |
|------|-------|
| `0001_initial.sql` | Foundational identity & tenancy: `organizations`, `users`, `roles`, `permissions`, `role_permissions`, `organization_members` |
| `0002_identity.sql` | Auth foundation (Phase 1 U1): `user_credentials`, `sessions`, `auth_tokens`, `auth_events`; adds `users.mfa_enabled` flag |

Rules (PRD §109):
- Applied migrations are immutable — never edit; add a new numbered file.
- Timestamps are UTC ISO-8601 TEXT; ids are application-generated TEXT UUIDs.
- No seed/production data in migrations.

Apply locally (from `backend/`, where `wrangler.jsonc` points `migrations_dir` here):

```bash
npx wrangler d1 migrations apply trafficvaulthub-db --local
```
