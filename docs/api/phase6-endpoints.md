# Phase 6 endpoint reference — API keys, webhooks, notifications, support, disputes, appeals

All paths are under `/api/v1`. Every route runs `requireAuth → requireOrg → requirePermission`;
API-key bearers (`tvh_k_…`) additionally pass `requireScope` (scope ∩ role) and are refused on
`requireSession` routes (403). Errors are always `{ "error": { "code", "message", "request_id" } }`
and `x-request-id` is echoed on every response. Lists are cursor-paginated: `?limit=&cursor=` →
`{ items, next_cursor }`. Malformed or foreign ids → 404 (no existence oracle). Tenant and platform
faces are mounted in `backend/src/routes/organizations.ts`.

Platform faces use `/organizations/:platformOrgId/platform/...`; the caller's org must be the
PLATFORM org (otherwise 403). `SUPPORT_AGENT` members only see tenants granted to them via the agent
grant routes (ungranted tenant → 404); `SUPER_ADMIN` / `OPERATIONS_ADMIN` are unrestricted.

## API keys — `routes/api-keys.ts` (PRD §76/§77)

Base: `/organizations/:orgId/api-keys`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `api_keys.read` | `?status=` filter; never includes hash or secret |
| POST | `/` | `api_keys.manage` (session) | `{ name, scopes[], expires_at? }` → 201 `{ api_key }` — `key` (`tvh_k_<prefix>.<secret>`) is returned ONCE, `Cache-Control: no-store` |
| GET | `/:keyId` | `api_keys.read` | |
| POST | `/:keyId/rotate` | `api_keys.manage` (session) | ACTIVE → ROTATED, 201 successor (new key once), 24h grace; non-ACTIVE → 409 `API_KEY_NOT_ACTIVE` |
| POST | `/:keyId/revoke` | `api_keys.manage` (session) | ACTIVE/ROTATED → REVOKED; REVOKED/EXPIRED → 409 `API_KEY_FINAL` |

Expiry is settled at read time (`expires_at` → EXPIRED). Invalid, revoked or expired keys → 401
`UNAUTHENTICATED`; wrong scope → 403 `INSUFFICIENT_SCOPE`.

## Webhooks — `routes/webhooks.ts` (PRD §73–§75)

Tenant base: `/organizations/:orgId/webhooks`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `webhooks.read` | `?status=` |
| POST | `/` | `webhooks.manage` | `{ url (https only), description?, event_types? ("*" or list) }` → 201 `{ subscription }` with `secret` ONCE |
| GET | `/deliveries` | `webhooks.read` | `?status=` |
| GET | `/deliveries/:deliveryId` | `webhooks.read` | delivery + event + attempt rows (signed headers, never the secret) |
| POST | `/deliveries/:deliveryId/attempt` | `webhooks.manage` | QUEUED/RETRY → DELIVERING → DELIVERED / RETRY / DEAD_LETTER; DELIVERED → 409 `WEBHOOK_DELIVERY_FINAL` |
| POST | `/deliveries/:deliveryId/replay` | `webhooks.replay` (platform roles only) | RETRY/DEAD_LETTER → same row re-queued and attempted |
| GET | `/:subscriptionId` | `webhooks.read` | |
| PATCH | `/:subscriptionId` | `webhooks.manage` | url / description / event_types |
| POST | `/:subscriptionId/pause` · `/resume` · `/disable` | `webhooks.manage` | DISABLED is final → 409 `WEBHOOK_SUBSCRIPTION_FINAL` |
| POST | `/:subscriptionId/rotate-secret` | `webhooks.manage` | 201, new `secret` ONCE |

Platform base: `/organizations/:platformOrgId/platform/webhooks`

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/process-due` | `webhooks.manage` | `{ limit? }` drains due deliveries across tenants (each under its own tenant id) |
| POST | `/tenants/:tenantOrgId/events` | `webhooks.manage` | `{ event_type, payload, idempotency_key, reference_type?, reference_id? }` → 201; same key → 200 `replayed:true`, nothing written |
| GET | `/tenants/:tenantOrgId/deliveries[/:deliveryId]` | `webhooks.read` | |
| POST | `/tenants/:tenantOrgId/deliveries/:deliveryId/replay` | `webhooks.replay` | |

Payload signing: HMAC over `POST/<path>/<ts>/<event_id>/sha256(body)`; receivers verify with
`WebhookService.verifySignature` (±300s tolerance, `isReplay` guard). Secret stored AES-GCM wrapped
under `POSTBACK_SECRET_KEY`; vault absent → 503 `WEBHOOK_VAULT_UNAVAILABLE`.

## Notifications — `routes/notifications.ts` (PRD §79/§80)

Tenant base: `/organizations/:orgId/notifications`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `notifications.read` | feed of SENT IN_APP rows + `unread_count`; `?unread=true` |
| GET | `/preferences` | `notifications.read` | 7 events × 3 channels, `locked` flag |
| PUT | `/preferences` | `notifications.read` (session) | `{ preferences: [{ event_type, channel, enabled }] }`; locked pair → 409 `PREFERENCE_LOCKED` |
| POST | `/read-all` | `notifications.read` (session) | |
| GET | `/:notificationId` | `notifications.read` | |
| POST | `/:notificationId/read` | `notifications.read` (session) | idempotent |

Producer: `POST /organizations/:platformOrgId/platform/notifications/tenants/:tenantOrgId/events`
(`webhooks.manage`) — `{ event_type, title, body, dedupe_key, user_id?, reference_type?, reference_id? }`
→ 201; same `dedupe_key` → 200 `replayed:true`. Fans out IN_APP rows, EMAIL via `NotificationAdapter`,
WEBHOOK via `WebhookService.publish`.

## Support tickets — `routes/support.ts` (PRD §81)

Tenant base: `/organizations/:orgId/support`; platform base:
`/organizations/:platformOrgId/platform/support/tenants/:tenantOrgId`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/tickets` | `support.read` | `?status=` |
| POST | `/tickets` | `support.create` (tenant) | `{ category, subject, body, priority?, reference_type?, reference_id? }` → 201 OPEN |
| GET | `/tickets/:ticketId` · `/messages` · `/events` | `support.read` | requester never sees internal notes |
| POST | `/tickets/:ticketId/messages` | `support.create` / `support.manage` | `{ body, internal? }` — `internal` ignored for requesters |
| POST | `/tickets/:ticketId/transition` | `support.create` / `support.manage` | `{ status, reason? }` — the ONLY status write (no PATCH); illegal edge → 409 `SUPPORT_TICKET_ILLEGAL_TRANSITION`; CLOSED final → 409 `SUPPORT_TICKET_FINAL` |
| GET/POST | platform `/agents` | `support.manage` + unrestricted role | list / `{ user_id, reason? }` grant (201) |
| POST | platform `/agents/:userId/revoke` | `support.manage` + unrestricted role | |

## Disputes — `routes/disputes-appeals.ts` (PRD §82)

Tenant base: `/organizations/:orgId/disputes`; platform base:
`/organizations/:platformOrgId/platform/disputes/tenants/:tenantOrgId`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `disputes.read` | `?status=` (OPEN, UNDER_REVIEW, DECIDED, WITHDRAWN) |
| GET | `/:disputeId` | `disputes.read` | `{ dispute, decision \| null }` |
| GET | `/:disputeId/evidence` | `disputes.read` | |
| POST | `/:disputeId/evidence` | `disputes.create` (tenant) / `disputes.manage` (platform) | `{ kind: TEXT\|URL\|RECORD_REF\|FILE_REF, content }` → 201; final → 409 `DISPUTE_FINAL` |
| POST | `/` (tenant) | `disputes.create` | `{ category, subject_type, subject_id, title, description, disputed_amount_minor?, currency? }` → 201 OPEN; categories CONVERSION, TRACKING, COMMISSION, PAYOUT, BILLING, TRAFFIC, OFFER, COMPLIANCE; open duplicate → 409 `DISPUTE_ALREADY_OPEN` |
| POST | `/:disputeId/withdraw` (tenant) | `disputes.create` | OPEN/UNDER_REVIEW → WITHDRAWN |
| POST | `/:disputeId/review` (platform) | `disputes.manage` | OPEN → UNDER_REVIEW |
| POST | `/:disputeId/decide` (platform) | `disputes.manage` | `{ decision: UPHELD\|PARTIALLY_UPHELD\|REJECTED, reason, evidence?[] }` → `{ dispute, decision: { decision, reason, evidence, actor, timestamp } }`; not UNDER_REVIEW → 409 `DISPUTE_ILLEGAL_TRANSITION`; DECIDED → 409 `DISPUTE_FINAL` |

## Appeals — `routes/disputes-appeals.ts` (PRD §83)

Tenant base: `/organizations/:orgId/appeals`; platform base:
`/organizations/:platformOrgId/platform/appeals/tenants/:tenantOrgId`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `appeals.read` | `?status=` (SUBMITTED, UNDER_REVIEW, DECIDED, WITHDRAWN) |
| GET | `/:appealId` | `appeals.read` | `{ appeal, outcome \| null }` |
| POST | `/` (tenant) | `appeals.create` | `{ appeal_type, subject_type, subject_id, grounds }` → 201 SUBMITTED; types ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION, CONVERSION_DECISION, PAYOUT_HOLD, COMPLIANCE_DECISION; open duplicate → 409 `APPEAL_ALREADY_OPEN` |
| POST | `/:appealId/withdraw` (tenant) | `appeals.create` | not final → WITHDRAWN; final → 409 `APPEAL_FINAL` |
| POST | `/:appealId/review` (platform) | `appeals.manage` | SUBMITTED → UNDER_REVIEW |
| POST | `/:appealId/decide` (platform) | `appeals.manage` | `{ outcome: ACCEPTED\|PARTIALLY_ACCEPTED\|REJECTED, reason, evidence?[] }` → `{ appeal, outcome: { outcome, reason, evidence, actor, timestamp } }`; audited as `appeal.decided` |

No PATCH/PUT status route exists for tickets, disputes or appeals.
