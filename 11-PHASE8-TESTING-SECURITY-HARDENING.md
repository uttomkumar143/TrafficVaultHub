# PHASE 8 — Testing, Security & Reliability Hardening
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 7 complete.

Reference PRD sections: 92–101 (Database architecture/rules, Data ownership, Soft deletion, Data retention, Privacy controls, Security architecture, Threat model, File security, Secret management), 102–113 (Logging, Incident management, Disaster recovery, Business continuity, Reliability architecture, Performance targets, Scalability, Migration strategy, Feature flags, Kill switches, Testing pyramid, Contract testing), 116 (Critical Security Tests, in full this time).

Goal: this phase doesn't add features — it proves the platform is safe to put real money and real user data through. Commit after each unit.

## Units of work

1. **Full critical security test suite (PRD §116)** — go through every item and confirm each has a real, passing test: unauthorized user rejected, cross-tenant request rejected, role escalation rejected, expired session rejected, invalid API key rejected, replayed webhook rejected, secret never returned to frontend. Fill any gaps left from earlier phases.

2. **Data ownership audit** — grep/review every query touching a tenant-owned table and confirm it enforces authenticated user + org membership + resource ownership server-side. Fix anything that trusts a client-supplied ID.

3. **Soft deletion & retention** — confirm business-critical records use `status`/`archived_at`/`deleted_at` rather than hard deletes; document retention categories (financial, audit, tracking, fraud, compliance, support, security, analytics) in `docs/architecture/data-retention.md`.

4. **Logging pass** — confirm structured logs include `request_id, timestamp, service, severity, event, user_id, organization_id` where appropriate, and confirm passwords/secrets/full payment data are never logged.

5. **File security (R2)** — MIME validation, file-size limits, safe filenames, private/public access policy, signed URLs where appropriate for any uploaded document/creative.

6. **Reliability pass** — idempotency review on every financial and webhook path (should already be true from earlier phases — verify, don't re-implement), retry/dead-letter handling on queues, health checks for each subsystem.

7. **Feature flags & kill switches** — implement server-side-controlled flags/switches for at least: SmartLinks, Tracking, a given Offer, Affiliate traffic, Postbacks, Payout processing, a given integration — with every emergency action audited.

8. **ADRs** — write the architecture decision records listed in PRD §122 (ADR-001 through ADR-010) reflecting decisions actually made in Phases 1–7, in `docs/adr/`.

9. **Load/perf sanity check** — verify the tracking redirect and standard API paths are structured to meet PRD §107 targets (p95 < 100ms tracking, < 500ms standard API) — this can be a documented review + basic benchmark rather than a full load-testing setup, but be honest about what was actually measured versus assumed.

10. **STATE.md** update — mark the project feature-complete per PRD baseline and note what (if anything) was deferred and why.

## Definition of done

- Every test named in PRD §112–116 that applies to what's been built actually exists and passes — not just planned.
- No known cross-tenant or auth bypass remains open.
