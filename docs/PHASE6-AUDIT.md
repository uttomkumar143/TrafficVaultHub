# Phase 6 audit (working file — folded into CHECKLIST.md at phase end)

Baseline at `ab071e7`: typecheck 0, vitest 624/624 (68 files). Spec: `09-PHASE6-API-WEBHOOKS-INTEGRATIONS-NOTIFICATIONS.md` + PRD §70–§83, §116, §128.

| # | Requirement (spec / PRD) | Status | Evidence / gap |
|---|--------------------------|--------|----------------|
| 1a | §71 request schema (Zod) on every `/api/v1` body | DONE | every `routes/*.ts` with a body uses `parseJsonBody` + zod (health/redirect have no body) |
| 1b | §71 auth + authorization rule on every endpoint | DONE | `requireAuth` → `requireOrg` → `requirePermission` on every org route (`routes/organizations.ts` mounts) |
| 1c | §71/§127 cursor pagination, never full table in memory | PARTIAL | `lib/pagination.ts` used by offers/affiliates/advertisers/tracking/conversions/fraud/compliance/payouts/api-keys/webhooks. Unbounded: `GET /ledger/reserves` (`reserves.list`), `GET /billing/alerts` (`listMyAlerts`), `GET /:orgId/members` (`listMembers`). Bounded by construction (per-user / per-offer): `/auth/sessions`, `/offers/:id/versions`, `/organizations` (mine) |
| 1d | §71/§128 rate limit tier per endpoint (login, API, tracking, postback, webhook, admin, public) | DONE | `middleware/rate-limit.ts` — 7 tiers, `classifyTier` (one tier per request, mounted at app root), memory store default / KV best-effort, 429 `RATE_LIMITED` + `Retry-After`; ip-keyed vs credential-keyed (SHA-256 prefix, raw token never stored); `middleware/rate-limit.test.ts` (8) |
| 1e | §71 idempotency where relevant | DONE | payouts (`Idempotency-Key`), webhooks publish (`idempotency_key`), postback nonce |
| 1f | §70 version `/api/v1` | DONE | `app.ts` mounts `v1` |
| 1g | §72 `request_id` always present | DONE | `middleware/request-id.ts` (`cf-ray` → well-formed inbound `x-request-id` → UUID), `x-request-id` echoed on every response; `middleware/request-id.test.ts` (6) |
| 2 | §72 `{error:{code,message,request_id}}` everywhere, no stack traces | DONE | `errorResponse`, `app.notFound`, `app.onError`; tests `routes/secret-exposure.test.ts` "error envelopes never include a stack trace or internal detail", `test/api-keys-http.test.ts` envelope checks. Only gap is 1g |
| 3a | §76 API keys create/rotate/revoke/expire/scope/last_used | DONE | `modules/api-keys/{repository,service}.ts`, `routes/api-keys.ts`; `test/api-keys-http.test.ts` (11 tests) |
| 3b | §76 secret never returned after creation / never logged | DONE | SHA-256 + 4-char hint stored; `test/api-keys-http.test.ts` "returns the full key ONCE; stores only hash + hint + prefix; list/get never leak it" |
| 3c | §76/§77 key usable as a credential; scopes enforced | DONE | `75ccd34` — `requireAuth` accepts `tvh_k_` API keys as bearer credentials; `requireScope` enforces scope ∩ role; `test/api-key-auth-http.test.ts` |
| 4a | §73 QUEUED→DELIVERING→DELIVERED, RETRY→DEAD_LETTER | DONE | `modules/webhooks/*`, `test/webhooks-http.test.ts` lifecycle tests |
| 4b | §74 signed payloads, secret rotation, delivery logs, idempotency | DONE | `WebhookService.buildRequest` (HMAC canonical), `rotateSecret`, `webhook_delivery_attempts` |
| 4c | §74 timestamp validation / replay protection on the receiver helper | DONE | `643debb` + Unit 5 close-out — `WebhookService.verifySignature(secret, headers, body, { now?, toleranceSeconds?, seenEventIds? })` uses `isTimestampFresh` / `DEFAULT_TIMESTAMP_TOLERANCE_SECONDS` (300s) from `tracking/postback-auth`; `WebhookService.isReplay(headers, seen)`; `test/webhooks-http.test.ts` "successful attempt → DELIVERED, one attempt row, signed headers verify with the issued secret; second attempt → 409 WEBHOOK_DELIVERY_FINAL" |
| 4d | §75 replay by original event id, idempotent (DoD) | DONE | `test/webhooks-http.test.ts` "DELIVERED → 409 … DEAD_LETTER → same row re-queued → DELIVERED exactly once; row count stays 1" |
| 5 | §78 six adapters, ≥1 implementation each, wired outside core | DONE | `src/integrations/*` (`83f2057`, `2ba1cb7`, `8a0d877`, `ab071e7`); `NotificationAdapter` wraps `EmailSender`; `FraudAdapter` uses `levelFor`; `TrackingAdapter` uses `ClickSignals`; `adapters.test.ts` (21) + `wiring.test.ts` |
| 6a | §79 channels in-app / email / webhook for the 7 events | DONE | Unit 6 — `modules/notifications/{repository,service}.ts`, `routes/notifications.ts` (feed `GET /:orgId/notifications` cursor + `unread_count`, `POST /:id/read`, `POST /read-all`; producer `POST /:orgId/platform/notifications/tenants/:tenantOrgId/events`). IN_APP row / EMAIL via `NotificationAdapter` / WEBHOOK via `WebhookService.publish` (`notification:<dedupe_key>`); per-key dedupe replay; `test/notifications-http.test.ts` "emits one IN_APP + one EMAIL per ACTIVE member + one WEBHOOK row…", "same dedupe_key replays idempotently…" |
| 6b | §80 user preferences; security-critical not fully disable-able | DONE | Unit 6 — `GET/PUT /:orgId/notifications/preferences` (7×3 matrix, `locked` flag); disabled pref ⇒ row SUPPRESSED, no adapter call; `security_event`/`compliance_action` IN_APP → 409 `PREFERENCE_LOCKED` in service + 0012 CHECK; `test/notifications-http.test.ts` "security_event / compliance_action cannot be disabled on IN_APP (409 PREFERENCE_LOCKED) and are always delivered…" |
| 7a | §81 ticket state machine + restricted agent tenant access | MISSING | tables `support_tickets`, `support_ticket_messages`, `support_ticket_events`, `support_agent_tenant_access` (0012); no code |
| 7b | §82 disputes: 8 categories, decision{decision,reason,evidence,actor,timestamp} | MISSING | tables `disputes`, `dispute_evidence`, `dispute_decisions` (0012); no code |
| 7c | §83 appeals for 5 subjects, outcome audited | MISSING | tables `appeals`, `appeal_decisions` (0012); no code |
| 8 | migration `0007_api_webhooks_notifications_support.sql` | DONE (renumbered) | shipped as `migrations/0012_api_webhooks_notifications_support.sql` — numbering continues the repo's sequence (0007 already = offers) |
| 9a | §116 expired session rejected | DONE | `routes/auth.test.ts` "rejects an expired session" |
| 9b | §116 invalid API key rejected | DONE | `75ccd34` — HTTP proof: unknown / revoked / expired / malformed `tvh_k_` bearer → 401 in `test/api-key-auth-http.test.ts` |
| 9c | §116 replayed webhook rejected | DONE | inbound postback: `test/attribution.test.ts` "rejects an invalid signature (401) and a replayed nonce (409)"; receiver-side: stale (±301s) rejected with valid HMAC, in-window accepted, custom tolerance, forged timestamp fails HMAC, `isReplay` — `test/webhooks-http.test.ts` (Unit 5) |
| 9d | §116 secret never returned to frontend | DONE | `routes/secret-exposure.test.ts`, api-keys + webhooks tests |
| 10 | STATE.md update | MISSING | `STATE.md` says Phase 6 NOT STARTED; `docs/CHECKLIST.md` Phase 6 = 0/10 |
| DoD-1 | webhook replayed exactly once in effect even if delivered twice | DONE | 4d |
| DoD-2 | no response leaks a stack trace or secret | DONE (re-verified at final gate) | 2, 9d |

## Build plan (PARTIAL + MISSING only, spec order)
1. 1g/2 — request-id middleware (`cf-ray` or generated), `x-request-id` header, `requestId()` reads context.
2. 1d — rate-limit middleware with tiers (store port: memory default, KV best-effort), 429 `RATE_LIMITED`.
3. 1c — cursor pagination for reserves / funding alerts / members (additive `next_cursor`, LIMIT in SQL).
4. 3c/9b — bearer `tvh_k_` principal in `requireAuth`; `requireOrg` binds the key's org and intersects role permissions with scopes; HTTP tests.
5. 4c/9c — `verifySignature` timestamp tolerance; test.
6. 6 — notifications module (repo, service, routes, preferences, producer hook) + tests.
7. 7 — support tickets, disputes, appeals (repo, services, routes) + tests.
8. 9 — consolidated Phase 6 security test.
9. 10 — STATE.md, CHECKLIST.md, docs/api; delete this file.
