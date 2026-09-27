# migrations/

Cloudflare D1 (SQLite) schema migrations, applied in filename order.

| File | Scope |
|------|-------|
| `0001_initial.sql` | Foundational identity & tenancy: `organizations`, `users`, `roles`, `permissions`, `role_permissions`, `organization_members` |
| `0002_identity.sql` | Auth foundation (Phase 1 U1): `user_credentials`, `sessions`, `auth_tokens`, `auth_events`; adds `users.mfa_enabled` flag |
| `0003_organizations.sql` | Organizations (Phase 1 U3): `roles.is_owner`, `role_org_types`, PRD §9 system role catalogue (reference rows, fixed ids), append-only `audit_logs` |
| `0004_permissions.sql` | RBAC (Phase 1 U4): PRD §10 `permissions` catalogue (+ `organizations.*`, `members.*`) and `role_permissions` grants for the 14 system roles (reference rows, fixed ids, key-based INSERT…SELECT) |
| `0005_advertisers.sql` | Advertisers (Phase 2 U1): `advertiser_profiles`, `advertiser_status_transitions`; keys `advertisers.read/manage/review` + grants |
| `0006_affiliates.sql` | Affiliates (Phase 2 U2): `affiliate_profiles`, `affiliate_traffic_sources`, `affiliate_status_transitions`; keys `affiliates.read/manage/review` + grants |
| `0007_offers.sql` | Offers & marketplace (Phase 2 U3–8): `offers`, immutable `offer_versions`, `offer_version_targeting`, `affiliate_offer_access`, `offer_status_transitions` (no new keys) |
| `0008_tracking.sql` | Tracking, SmartLinks & attribution (Phase 3 U8): `tracking_links`, `smartlinks`, `smartlink_offers`, INSERT-only `clicks` (coarse signals only, no raw IP — PRD §34), `conversions` (Phase-3 states, §39 dedup UNIQUE), INSERT-only `attributions` (PRD §36), versioned `attribution_policies`, `offer_cap_counters` (DO snapshot, §44), `postback_nonces` (replay guard, PK is the check), `advertiser_postback_secrets` (HMAC key encrypted at rest, returned once); keys `tracking.read/manage`, `attribution.read/manage` + grants |

Rules (PRD §109):
- Applied migrations are immutable — never edit; add a new numbered file.
- Timestamps are UTC ISO-8601 TEXT; ids are application-generated TEXT UUIDs.
- No seed/production data in migrations. PRD-defined reference catalogues (e.g. the §9 role keys) are the one exception and must be idempotent (`INSERT OR IGNORE`, fixed ids).

Apply locally (from `backend/`, where `wrangler.jsonc` points `migrations_dir` here):

```bash
npx wrangler d1 migrations apply trafficvaulthub-db --local
```
