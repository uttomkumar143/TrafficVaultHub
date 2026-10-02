# Phase 6 audit (working file — folded into CHECKLIST.md at phase end)

Baseline at `ab071e7`: typecheck 0, vitest 624/624 (68 files). Spec: `09-PHASE6-API-WEBHOOKS-INTEGRATIONS-NOTIFICATIONS.md` + PRD §70–§83, §116, §128.

| # | Requirement (spec / PRD) | Status | Evidence / gap |
|---|--------------------------|--------|----------------|
| 1a | §71 request schema (Zod) on every `/api/v1` body | DONE | every `routes/*.ts` with a body uses `parseJsonBody` + zod (health/redirect have no body) |
| 1b | §71 auth + authorization rule on every endpoint | DONE | `requireAuth` → `requireOrg` → `requirePermission` on every org route (`routes/organizations.ts` mounts) |
| 1c | §71/§127 cursor pagination, never full table in memory | PARTIAL | `lib/pagination.ts` used by offers/affiliates/advertisers/tracking/conversions/fraud/compliance/payouts/api-keys/webhooks. Unbounded: `GET /ledger/reserves` (`reserves.list`), `GET /billing/alerts` (`listMyAlerts`), `GET /:orgId/members` (`listMembers`). Bounded by construction (per-user / per-offer): `/auth/sessions`, `/offers/:id/versions`, `/organizations` (mine) |
| 1d | §71/§128 rate limit tier per endpoint (login, API, tracking, postback, webhook, admin, public) | MISSING | `grep -ril 'rate.?limit' src` → nothing |
| 1e | §71 idempotency where relevant | DONE | payouts (`Idempotency-Key`), webhooks publish (`idempotency_key`), postback nonce |
| 1f | §70 version `/api/v1` | DONE | `app.ts` mounts `v1` |
| 1g | §72 `request_id` always present | DONE | `middleware/request-id.ts` (`cf-ray` → well-formed inbound `x-request-id` → UUID), `x-request-id` echoed on every response; `middleware/request-id.test.ts` (6) |
| 2 | §72 `{error:{code,message,request_id}}` everywhere, no stack traces | DONE | `errorResponse`, `app.notFound`, `app.onError`; tests `routes/secret-exposure.test.ts` "error envelopes never include a stack trace or internal detail", `test/api-keys-http.test.ts` envelope checks. Only gap is 1g |
| 3a | §76 API keys create/rotate/revoke/expire/scope/last_used | DONE | `modules/api-keys/{repository,service}.ts`, `routes/api-keys.ts`; `test/api-keys-http.test.ts` (11 tests) |
| 3b | §76 secret never returned after creation / never logged | DONE | SHA-256 + 4-char hint stored; `test/api-keys-http.test.ts` "returns the full key ONCE; stores only hash + hint + prefix; list/get never leak it" |
| 3c | §76/§77 key usable as a credential; scopes enforced | MISSING | `ApiKeyService.authenticate` exists but `requireAuth` only accepts `tvh_s_` sessions (`modules/auth/tokens.ts`); no `requireScope`/scope intersection anywhere |
| 4a | §73 QUEUED→DELIVERING→DELIVERED, RETRY→DEAD_LETTER | DONE | `modules/webhooks/*`, `test/webhooks-http.test.ts` lifecycle tests |
| 4b | §74 signed payloads, secret rotation, delivery logs, idempotency | DONE | `WebhookService.buildRequest` (HMAC canonical), `rotateSecret`, `webhook_delivery_attempts` |
| 4c | §74 timestamp validation / replay protection on the receiver helper | PARTIAL | `WebhookService.verifySignature` checks HMAC only — no tolerance window (postback side has `DEFAULT_TIMESTAMP_TOLERANCE_SECONDS`) |
| 4d | §75 replay by original event id, idempotent (DoD) | DONE | `test/webhooks-http.test.ts` "DELIVERED → 409 … DEAD_LETTER → same row re-queued → DELIVERED exactly once; row count stays 1" |
| 5 | §78 six adapters, ≥1 implementation each, wired outside core | DONE | `src/integrations/*` (`83f2057`, `2ba1cb7`, `8a0d877`, `ab071e7`); `NotificationAdapter` wraps `EmailSender`; `FraudAdapter` uses `levelFor`; `TrackingAdapter` uses `ClickSignals`; `adapters.test.ts` (21) + `wiring.test.ts` |
| 6a | §79 channels in-app / email / webhook for the 7 events | MISSING | tables `notifications`, `notification_preferences` exist (0012); no module, routes or tests |
| 6b | §80 user preferences; security-critical not fully disable-able | MISSING | DB CHECK exists (0012 `notification_preferences`); no service/route |
| 7a | §81 ticket state machine + restricted agent tenant access | MISSING | tables `support_tickets`, `support_ticket_messages`, `support_ticket_events`, `support_agent_tenant_access` (0012); no code |
| 7b | §82 disputes: 8 categories, decision{decision,reason,evidence,actor,timestamp} | MISSING | tables `disputes`, `dispute_evidence`, `dispute_decisions` (0012); no code |
| 7c | §83 appeals for 5 subjects, outcome audited | MISSING | tables `appeals`, `appeal_decisions` (0012); no code |
| 8 | migration `0007_api_webhooks_notifications_support.sql` | DONE (renumbered) | shipped as `migrations/0012_api_webhooks_notifications_support.sql` — numbering continues the repo's sequence (0007 already = offers) |
| 9a | §116 expired session rejected | DONE | `routes/auth.test.ts` "rejects an expired session" |
| 9b | §116 invalid API key rejected | PARTIAL | service-level only (`authenticate` → null); no HTTP proof because keys are not yet accepted as credentials (3c) |
| 9c | §116 replayed webhook rejected | PARTIAL | inbound postback: `test/attribution.test.ts` "rejects an invalid signature (401) and a replayed nonce (409)"; outbound replay idempotency in webhooks tests; receiver-side stale-timestamp rejection missing (4c) |
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
