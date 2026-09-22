# PHASE 6 — API Platform, Webhooks, Integrations, Notifications & Support
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 5 complete.

Reference PRD sections: 70–83 (API platform/standards/error format, Webhook architecture/security/replay, API keys, OAuth-ready architecture, Integration adapters, Notification architecture/preferences, Support system, Disputes, Appeals).

Goal: make the platform safely talk to the outside world. Commit after each unit.

## Units of work

1. **API standards pass** — for every existing `/api/v1` endpoint from prior phases, confirm it defines: request schema (Zod), response schema, auth requirement, authorization rule, error cases, pagination (cursor-based, never full-table-in-memory per PRD §127), rate limit tier, idempotency where relevant, version. Fix any gaps found rather than only checking new endpoints.

2. **Standard error format** — enforce `{ "error": { "code", "message", "request_id" } }` everywhere, with no internal stack traces ever reaching a client.

3. **API keys** — create/rotate/revoke/expire/scope/last_used tracking; secrets never returned after initial creation, never logged, never sent to the frontend bundle.

4. **Webhook delivery system** — `QUEUED → DELIVERING → DELIVERED`, with `RETRY → DEAD_LETTER` on failure. Signed payloads, timestamp validation, replay protection. Authorized operators can replay a failed delivery using the original event ID, and replay must remain idempotent.

5. **Integration adapters** — `TrackingAdapter, PaymentAdapter, PayoutAdapter, NotificationAdapter, CRMAdapter, FraudAdapter` as real interfaces with at least one implementation each, so a new vendor never requires touching core business logic.

6. **Notifications** — in-app, email, and webhook channels for `offer_status_changed, conversion_updated, payout_status_changed, billing_alert, compliance_action, security_event, tracking_issue`; user-configurable preferences, with security-critical notifications not fully disable-able.

7. **Support & disputes** — support ticket state machine `OPEN → IN_PROGRESS → WAITING_FOR_USER → WAITING_INTERNAL → RESOLVED → CLOSED` with tenant-restricted agent access; dispute categories `CONVERSION, TRACKING, COMMISSION, PAYOUT, BILLING, TRAFFIC, OFFER, COMPLIANCE`, each decision recording `decision, reason, evidence, actor, timestamp`; appeals for restrictions/suspensions/conversion decisions/payout holds/compliance decisions, outcomes audited.

8. **Migration** — `migrations/0007_api_webhooks_notifications_support.sql`.

9. **Critical security tests relevant here (subset of §116)** — expired session rejected, invalid API key rejected, replayed webhook rejected, secret never returned to frontend.

10. **STATE.md** update.

## Definition of done

- A webhook can be replayed exactly once in effect even if delivered twice.
- No response anywhere leaks a stack trace or a secret.
