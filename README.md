TrafficVaultHub — Master Product Requirements Document + Architecture Constitution

Version: 10.0 · Status: Master Production Blueprint / Architecture Baseline

Product: Performance Marketing / CPA Affiliate Network · Primary Models: CPA, CPL, CPI, CPS

Architecture: Cloudflare-first, modular and migration-ready

LayerChoiceFrontendReact + Vite + TypeScriptUITailwind CSS + shadcn/uiRoutingReact RouterServer StateTanStack QueryFormsReact Hook Form + ZodChartsRechartsBackendCloudflare Workers + HonoPrimary DatabaseCloudflare D1CoordinationDurable ObjectsCacheCloudflare KVObject StorageCloudflare R2Async ProcessingCloudflare QueuesFrontend HostingCloudflare PagesRepositoryGitHubAPIREST /api/v1

Architecture Goal: Production-ready, auditable, scalable and extensible.

This version supersedes v3.1. Two sections carried forward and appended at the end (§189 Competitive Benchmarking, §190 Glossary) since v10.0 doesn't yet include them and they remain useful reference material. Everything else below is the v10.0 baseline as provided, reorganized into markdown for readability — content and numbering preserved.

1. Executive Summary

TrafficVaultHub is a technology platform connecting Advertisers, Affiliates/Publishers, Network Operations, Finance, Compliance, and Support.

The platform provides: offer marketplace, advertiser management, affiliate management, tracking, attribution, SmartLinks, conversion validation, fraud detection, compliance, financial ledger, advertiser billing, affiliate payouts, reporting, APIs, webhooks, disputes, support, audit, notifications, and partner integrations.

The platform must be designed so that future expansion does not require rewriting the core business model.

2. Product Objective

Advertisers can: launch performance campaigns, control traffic sources, manage budgets, monitor conversions, validate tracking, detect suspicious traffic, manage affiliates, understand financial liability, resolve disputes.

Affiliates can: discover offers, understand requirements, generate tracking links, use SmartLinks, monitor traffic, see conversion status, understand rejected conversions, track earnings, request payouts, appeal decisions.

Network operators can: manage supply and demand, protect advertisers, protect legitimate affiliates, maintain financial integrity, investigate risk, enforce policies, manage payouts, audit critical activity.

3. Core Architecture Principles — No Fake Production Data

Production must never contain invented clicks, conversions, earnings, revenue, payouts, balances, EPC, CVR, advertiser statistics, or affiliate statistics. Demo data must be isolated from production.

4. Financial Authority

Financial truth belongs to the backend. Frontend cannot determine balance, commission, payout eligibility, payout amount, revenue, profit, or ledger state. Every financial result must originate from authoritative backend records.

5. Security Authority

The frontend is never trusted for authorization, tenant ownership, financial calculations, offer eligibility, fraud decisions, payout approval, or compliance decisions. Every sensitive operation is validated server-side.

6. Architecture Philosophy

Use a modular monolith first — do not prematurely create dozens of microservices.

Logical modules: Identity, Organizations, Advertisers, Affiliates, Offers, Marketplace, Tracking, Attribution, Conversions, SmartLinks, Fraud, Compliance, Finance, Billing, Payouts, Reporting, Support, Notifications, Integrations, Audit, System.

Each module has clear boundaries. Future modules may become independent services without changing public business contracts.

7. Global Multi-Tenant Model

Every organization is a tenant. Resources must have ownership (organization_id) — advertiser, offer, affiliate, traffic_source, creative, billing_account must always be associated with an appropriate organization. Cross-tenant access must be rejected server-side.

8. Organization Types

PLATFORM · ADVERTISER · AFFILIATE · PARTNER · AGENCY

Future organization types must not require redesigning the identity system.

9. User Roles

Platform: SUPER_ADMIN, OPERATIONS_ADMIN, FINANCE_MANAGER, COMPLIANCE_MANAGER, SUPPORT_AGENT, ANALYST

Advertiser: ADVERTISER_OWNER, ADVERTISER_ADMIN, CAMPAIGN_MANAGER, BILLING_MANAGER, VIEWER

Affiliate: AFFILIATE_OWNER, AFFILIATE_MANAGER, AFFILIATE_USER, VIEWER

10. Permission Architecture

RBAC + resource ownership + organization scope + action authorization.

offers.read / offers.create / offers.update / offers.approve / offers.pause conversions.read / conversions.approve / conversions.reject ledger.read / ledger.adjust payouts.read / payouts.review / payouts.approve / payouts.release fraud.read / fraud.review compliance.read / compliance.resolve audit.read

11. Separation of Duties

High-risk operations may require two-person approval: large payout, large ledger adjustment, mass conversion approval/rejection, account termination, bulk offer changes, financial corrections. The person preparing an operation should not automatically be able to approve it. Thresholds must be configurable.

12. Identity Architecture

Authentication must support: email verification, secure sessions, password reset, MFA, session revocation, device/session visibility, login monitoring, recovery procedures. Use a proven authentication implementation/provider — do not invent custom cryptographic protocols.

13. Internationalization

Architecture must support multiple languages, currencies, time zones, regional formatting, and regional policies. UI strings must not be hardcoded into business logic.

14. Currency Model

Every monetary record contains amount_minor + currency. Never use floating-point money — e.g. $10.25 → 1025 USD cents. Currency conversion, if introduced, must preserve source_currency, target_currency, rate, source, timestamp.

15. Time Model

Store timestamps in UTC; display using the user's configured timezone. Financial and audit ordering must never depend on browser local time.

16. Advertiser Lifecycle

REGISTERED → EMAIL_VERIFIED → BUSINESS_REVIEW → COMPLIANCE_REVIEW → BILLING_SETUP → APPROVED → ACTIVE

Alternative: MORE_INFORMATION_REQUIRED, RESTRICTED, SUSPENDED, TERMINATED. Every state transition is audited.

17. Advertiser Onboarding

Collect only information required for identity, business verification, billing, compliance, and campaign operations: company, website, contact, business category, legal information, billing information, required documents.

18. Advertiser CRM

Future-ready CRM entities: leads, accounts, contacts, sales_activities, sales_notes, contracts, onboarding_tasks.

Pipeline: LEAD → QUALIFIED → CONTACTED → NEGOTIATION → ONBOARDING → ACTIVE → RETAINED

19. Affiliate Lifecycle

APPLIED → EMAIL_VERIFIED → UNDER_REVIEW → APPROVED → ACTIVE

Alternative: MORE_INFORMATION_REQUIRED, RESTRICTED, SUSPENDED, APPEAL, TERMINATED

20. Affiliate Acquisition

Support direct applications, invitations, affiliate referrals, affiliate manager invitations, partner referrals. Future: affiliate referral rewards, affiliate manager CRM, private recruitment.

21. Affiliate Quality

Review signals: declared traffic sources, website/app information, promotional methods, compliance history, account behavior, traffic quality. Automated scoring is advisory unless an explicit policy makes it determinative.

22. Offer Lifecycle

DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → LIVE

Other states: PAUSED, CAP_REACHED, BUDGET_EXHAUSTED, TRACKING_ISSUE, COMPLIANCE_HOLD, EXPIRED, ARCHIVED

23. Offer Versioning

Every material offer change creates a version (v1, v2, v3…). Versioned attributes: payout, targeting, caps, traffic rules, attribution window, conversion event, allowed traffic sources. Historical conversions reference the applicable version.

24. Offer Economics

Separate advertiser_payout, affiliate_commission, network_margin, fees, adjustments.

Conceptually: Network economics = Advertiser liability − Affiliate commission − Applicable costs/fees/adjustments. Exact accounting treatment must be defined by the network's accounting policy.

25. Offer Access

PUBLIC · APPLICATION_REQUIRED · PRIVATE · INVITE_ONLY · AFFILIATE_SPECIFIC — access determined server-side.

26. Offer Targeting

Support: country, region, device, OS, browser, language, traffic_source, affiliate, time_window. Future: carrier, connection_type, custom targeting rules. Targeting rules must be explicit and versioned.

27. Traffic Source System

SEO, PAID_SEARCH, SOCIAL, CONTENT, EMAIL, APP, INFLUENCER, WEBSITE, DIRECT, OTHER — affiliate must declare applicable sources.

28. Traffic Restrictions

Offer rules can specify: allowed_sources, blocked_sources, allowed_geo, blocked_geo, allowed_device, blocked_device, brand_rules, keyword_rules, incentive_rules, email_rules, social_rules, coupon_rules. Rules must be visible before promotion whenever appropriate.

29. Marketplace

Search/filter by vertical, country, payout, payout type, device, traffic source, approval mode, offer status. Do not expose confidential advertiser data.

30. Offer Reliability

Marketplace can show factual operational indicators: Tracking Status, Offer Status, Last Tracking Test, Availability, Cap Status, Funding Status. Do not manufacture reliability scores without sufficient data.

31. Tracking Infrastructure

Affiliate → Tracking URL → TrafficVaultHub → Click ID → Validation → Eligibility → Risk Signals → Advertiser → Conversion → Postback/API → Attribution → Validation → Ledger

32. Click ID

Each click receives a globally unique identifier: click_id, affiliate_id, offer_id, smartlink_id, traffic_source_id, creative_id, timestamp, sub1–sub5. Sub IDs must have clear security and privacy boundaries.

33. Tracking IDs

Support click_id, conversion_id, transaction_id, event_id, external_conversion_id. IDs must have defined uniqueness and lifetime rules.

34. Privacy-Preserving Tracking

Tracking must avoid collecting unnecessary personal information. Do not require invasive fingerprinting when less intrusive signals can achieve the legitimate security purpose. Raw IP access should be restricted and audited.

35. Attribution Engine

Architecture must support click attribution, configurable windows, first-party identifiers, S2S, advertiser APIs, deduplication, fallback rules, versioned attribution policies. Every attribution decision must be explainable internally.

36. Attribution Record

attribution_id, conversion_id, click_id, rule_version, decision, reason_code, timestamp

37. Conversion Engine

RECEIVED → VALIDATING → PENDING → APPROVED → LEDGER_POSTED → EARNED → PAYOUT_ELIGIBLE → PAID

Alternative: REJECTED, FRAUD_REVIEW, DISPUTED

38. Conversion Validation

Validate advertiser identity, offer, click, affiliate, conversion event, timestamp, attribution, deduplication, traffic rules, fraud signals, conversion requirements.

39. Conversion Deduplication

Repeated events must not create duplicate financial effects. Idempotency keys may include advertiser_id, offer_id, external_conversion_id per provider-specific requirements.

40. Conversion Reconciliation

Regularly compare advertiser events, TrafficVaultHub conversions, approved conversions, rejected conversions, and ledger records. Mismatch generates reconciliation cases.

41. Conversion Reversal

APPROVED → REVERSED — a reversal must create a compensating financial event. Never delete the original financial history.

42. SmartLink Engine

SmartLink evaluates offer status, affiliate eligibility, geo, device, OS, traffic source, cap, budget, tracking health, compliance, risk, routing rules. Only eligible offers can be selected.

43. SmartLink Routing Modes

RULE_BASED, WEIGHTED, PERFORMANCE_BASED, GEO_BASED, DEVICE_BASED, HYBRID — routing algorithm version must be recorded.

44. SmartLink Cap Protection

Counters must be concurrency-safe. Support daily click cap, daily conversion cap, monthly cap, total cap, budget cap. Exact semantics must be documented per offer.

45. SmartLink Cache

Use KV for appropriate cached data, Durable Objects for coordination/hot state where needed. Cache must be invalidated when: offer paused, cap exhausted, budget exhausted, tracking degraded, affiliate access revoked, compliance restriction added.

46. SmartLink Failover

Primary Offer → Unavailable → Recalculate Eligibility → Alternative Offer → Redirect

Never blindly redirect to an inactive offer.

47. Fraud Architecture

Fraud detection consists of: Click Risk, Conversion Risk, Affiliate Risk, Advertiser Risk, Offer Risk, Payment Risk.

48. Fraud Signals

Abnormal velocity, duplicate patterns, suspicious conversion timing, unexpected geo distribution, unusual traffic source behavior, automation indicators, inconsistent event relationships. Signals must be evidence-based.

49. Risk Engine

Output: risk_score, risk_level, signals, model/rule_version, review_status. Risk level: LOW, MEDIUM, HIGH, CRITICAL. Risk score alone does not necessarily establish wrongdoing.

50. Fraud Evidence

case_id, event_ids, signals, rules, timestamps, context, reviewer, decision, reason. Sensitive evidence must have restricted access.

51. Fraud Actions

MONITOR, MANUAL_REVIEW, CONVERSION_HOLD, TRAFFIC_RESTRICTION, PAYOUT_HOLD, ACCOUNT_RESTRICTION, ACCOUNT_SUSPENSION — high-impact actions require proper authorization.

52. False Positive Controls

Manual review, evidence, reason codes, appeal, reviewer assignment, decision history.

53. Compliance Architecture

Modules: KYC/KYB, Traffic Compliance, Offer Compliance, Policy Rules, Document Management, Case Management, Appeals, Audit. Requirements depend on jurisdiction and applicable laws/contracts.

54. Compliance Case State

OPEN → INVESTIGATING → WAITING_FOR_INFORMATION → ESCALATED → RESOLVED → CLOSED

55. Compliance Rules

Versioned rules may evaluate traffic source, geography, brand usage, keywords, incentives, landing pages, creatives, promotional method, account status.

56. Financial Architecture

Core: Chart of Accounts, Journal Entries, Ledger Entries, Balances, Commission Records, Payouts, Invoices, Payments, Adjustments, Chargebacks, Reserves, Reconciliation.

57. Immutable Ledger

Financial events must be append-only. Corrections use original_event + compensating_event. Never silently modify historical financial records.

58. Financial Event Example

Conversion Approved → Commission Created → Journal Entry → Affiliate Payable → Holding Period → Payout Eligible → Payout

59. Financial Adjustment

Manual adjustment requires: reason, actor, reference, amount, currency, before_state, after_state, approval, timestamp.

60. Reserve Architecture

Support configurable affiliate reserve, advertiser reserve, chargeback reserve, risk reserve. Reserve logic must be independent from available balance.

61. Advertiser Funding

Modes: PREPAID, POSTPAID, CREDIT. Credit controls: credit_limit, used_credit, available_credit, risk_status, billing_status.

62. Funding Protection

If advertiser financial capacity becomes insufficient: Offer → PAUSED, SmartLink → exclude offer, Advertiser → alert, Operations → alert. Exact policy is configurable.

63. Billing

Support invoices, payments, credits, adjustments, billing history, account balance, campaign liability. Future-ready for tax documents without hardcoding one country's tax system.

64. Payout Architecture

Payout provider abstraction: createPayout(), getStatus(), verifyWebhook(), cancelPayout(). Provider-specific logic must remain inside adapters.

65. Payout Eligibility

Check available balance, minimum threshold, holding period, compliance, account status, payout method, reserve, disputes, manual holds.

66. Payout State Machine

REQUESTED → ELIGIBILITY_CHECK → UNDER_REVIEW → APPROVED → PROCESSING → PAID

Failure: FAILED. Cancellation: CANCELLED.

67. Payout Idempotency

Retrying a payout job must not create a second payout. Every payout receives an immutable internal ID and provider reference.

68. Payment Provider Architecture

PaymentProvider ├── Provider A ├── Provider B └── Provider C

Adding a new provider must not require changing the ledger.

69. Reconciliation Engine

Daily/scheduled reconciliation compares Ledger, Balances, Conversions, Payouts, Payments, Invoices, Advertiser liabilities, Affiliate payables. Any discrepancy creates a case.

70. API Platform

/api/v1 now; /api/v2 future. Existing API contracts must not be silently broken.

71. API Standards

Every endpoint should define: request schema, response schema, authentication, authorization, errors, pagination, rate limit, idempotency, version.

72. API Error Format

{ "error": { "code": "ERROR_CODE", "message": "Human-readable message", "request_id": "..." } }

Do not expose internal stack traces.

73. Webhook Architecture

QUEUED → DELIVERING → DELIVERED

Failure: RETRY → DEAD_LETTER

74. Webhook Security

Signatures, timestamp validation, replay protection, endpoint verification, secret rotation, idempotency, delivery logs.

75. Webhook Replay

Authorized operators may replay failed events. Replay must use the original event ID and must remain idempotent.

76. API Key System

create, rotate, revoke, expire, scope, last_used. Never expose secrets in frontend bundle, logs, analytics, or error messages.

77. OAuth-Ready Architecture

Future partner integrations may use OAuth 2.x, API Keys, Signed Requests, Service Credentials. Do not couple the platform to one authentication mechanism.

78. Integration Adapter System

External integrations must use adapters: TrackingAdapter, PaymentAdapter, PayoutAdapter, NotificationAdapter, CRMAdapter, FraudAdapter. This prevents vendor lock-in.

79. Notification Architecture

Channels: in-app, email, webhook. Events: offer_status_changed, conversion_updated, payout_status_changed, billing_alert, compliance_action, security_event, tracking_issue.

80. Notification Preferences

Users can configure email notifications, operational alerts, payout alerts, offer alerts, security alerts. Security-critical notifications cannot always be disabled.

81. Support System

OPEN → IN_PROGRESS → WAITING_FOR_USER → WAITING_INTERNAL → RESOLVED → CLOSED

Support agents must have restricted tenant access.

82. Dispute System

Categories: CONVERSION, TRACKING, COMMISSION, PAYOUT, BILLING, TRAFFIC, OFFER, COMPLIANCE. Every decision must have decision, reason, evidence, actor, timestamp.

83. Appeals

Appeals may apply to account restrictions, suspensions, conversion decisions, payout holds, compliance decisions. Appeal outcomes are audited.

84. Reporting Architecture

Separate Operational Reporting, Financial Reporting, Risk Reporting, Compliance Reporting, Marketing Analytics. Do not mix estimated operational metrics with finalized financial accounting without clear labels.

85. Event-Based Analytics

click.created, conversion.received, conversion.approved, conversion.rejected, payout.requested, payout.paid, offer.paused, fraud.detected, compliance.case_created. Analytics consumers must not modify authoritative business records.

86–90. Dashboards

DashboardSectionsAffiliateOverview, Offers, My Links, SmartLinks, Clicks, Conversions, Earnings, Payouts, Creatives, Traffic Sources, Reports, Notifications, Support, API, SettingsAdvertiserOverview, Offers, Affiliates, Traffic, Conversions, Tracking, Fraud, Billing, Invoices, Reports, Creatives, Webhooks, API, Support, SettingsAdminOverview, Affiliates, Advertisers, Offers, Tracking, Fraud, Compliance, Finance, Billing, Payouts, Reports, Disputes, Support, Audit, System Health, SettingsFinanceLedger, Receivables, Payables, Balances, Invoices, Payments, Payouts, Adjustments, Chargebacks, Reserves, ReconciliationComplianceVerification, Affiliates, Advertisers, Traffic Reviews, Fraud Cases, Compliance Cases, Appeals, Documents, Policies, Audit

91. System Health

Monitor: API, Tracking, SmartLinks, D1, KV, R2, Durable Objects, Queues, Postbacks, Webhooks, Payout Jobs, Reconciliation.

92. Database Architecture

users, organizations, organization_members, roles, permissions, role_permissions affiliate_profiles, affiliate_traffic_sources, affiliate_offer_access advertiser_profiles, advertiser_billing_accounts, advertiser_contacts, advertiser_contracts offers, offer_versions, offer_targeting, offer_caps, offer_budgets, offer_traffic_rules, offer_creatives, offer_access_rules tracking_links, smartlinks, clicks, attributions conversion_events, conversions, conversion_reversals fraud_events, fraud_scores, fraud_cases, fraud_rules compliance_cases, compliance_documents, verification_records ledger_accounts, journal_entries, ledger_entries, balance_snapshots, commission_records, reserves payout_requests, payout_transactions, payout_providers invoices, payments, adjustments, chargebacks disputes, support_tickets, support_messages notifications, notification_preferences webhook_endpoints, webhook_deliveries, api_keys audit_logs, system_events, incidents, feature_flags

93. Database Rules

Foreign keys, unique constraints, indexes, check constraints, state validation, idempotency keys, transaction boundaries. Critical identifiers must be unique.

94. Data Ownership

Every query involving tenant data must enforce: authenticated user + organization membership + resource ownership. Never trust organization_id, affiliate_id, advertiser_id supplied by the client without server verification.

95. Soft Deletion

For business-critical records, prefer status / archived_at / deleted_at instead of physical deletion. Financial records must remain auditable.

96. Data Retention

Retention categories: financial, audit, tracking, fraud, compliance, support, security, analytics. Retention periods are configurable per legal and operational requirements.

97. Privacy Controls

Data access requests, correction workflows, deletion workflows, retention enforcement, consent records where applicable, privacy notices. Financial/legal retention may override deletion where legally required.

98. Security Architecture

TLS, secure authentication, MFA, RBAC, tenant isolation, rate limiting, input validation, output encoding, secret management, audit logs, secure file access, dependency scanning, security monitoring

99. Threat Model

Account takeover, IDOR, credential theft, postback spoofing, replay attacks, duplicate conversions, financial manipulation, API abuse, webhook abuse, tenant data leakage, malicious uploads, XSS, injection, rate-limit bypass, privilege escalation.

100. File Security

R2 files require MIME validation, file-size limits, safe filenames, malware/security scanning where appropriate, private/public access policy, signed access where appropriate. Never trust file extensions alone.

101. Secret Management

Secrets (API keys, webhook secrets, payment credentials, payout credentials, database credentials, OAuth secrets) must remain server-side and support rotation.

102. Logging

Logs must contain request_id, timestamp, service, severity, event, user_id, organization_id where appropriate. Never log passwords, API secrets, private credentials, full payment secrets, or unnecessary personal data.

103. Incident Management

DETECTED → INVESTIGATING → MITIGATING → RESOLVED → POSTMORTEM

Track severity, impact, root cause, timeline, mitigation, follow-up.

104. Disaster Recovery

Database backup strategy, restoration procedures, infrastructure recreation, secret recovery procedures, DNS recovery, queue recovery, R2 recovery, incident runbooks. Restores must be tested periodically.

105. Business Continuity

Critical services — Tracking, Attribution, Conversion Processing, Ledger, Payouts, Authentication — must have documented recovery procedures.

106. Reliability Architecture

Queues, retries, dead-letter handling, idempotency, timeouts, circuit breakers where appropriate, health checks, monitoring. Never retry financial operations without idempotency.

107. Performance Targets

SystemTargetTracking redirect (p95)< 100msStandard API (p95)< 500msStandard DB query (p95)< 300msCritical tracking availability≥ 99.9%API availability≥ 99.9%

These are engineering targets, not guarantees.

108. Scalability Strategy

Start with Workers + D1 + KV + Durable Objects + Queues + R2. As scale increases, individual modules may be extracted without changing public contracts. Potential future extraction: Tracking Service, Fraud Service, Analytics Service, Financial Service, Notification Service.

109. Database Migration Strategy

Never modify production schema manually. Use migrations (0001_initial, 0002_identity, 0003_offers, 0004_tracking…). Applied migrations must be immutable. Destructive migrations require backup, impact analysis, migration, verification, rollback/recovery plan.

110. Feature Flags

Flags support: new attribution, new SmartLink algorithm, new fraud rules, new payout provider, new dashboard, AI features, 3D UI, experimental APIs. Financial/security features require server-side control.

111. Kill Switches

Authorized administrators can disable SmartLinks, Tracking, an Offer, Affiliate traffic, Postbacks, Payout processing, or a specific integration. Every emergency action is audited.

112. Testing Pyramid

Unit Tests → Integration Tests → Contract Tests → Security Tests → Load Tests → E2E Tests → Production Smoke Tests

113. Contract Testing

Test compatibility between Advertiser API, Affiliate API, Tracking, Postbacks, Webhooks, Payout providers, Payment providers. API contract changes must be versioned.

114. Critical Financial Tests

Must prove: duplicate conversion = no duplicate commission; duplicate payout = no duplicate payout; reversal = compensating entry; manual adjustment = audited; failed payout = recoverable; reconciliation mismatch = detected.

115. Critical Tracking Tests

Must prove: click generates unique ID; invalid offer rejected; inactive offer never receives SmartLink traffic; duplicate conversion deduplicated; invalid signature rejected; replay rejected; conversion attribution recorded.

116. Critical Security Tests

Must prove: unauthorized user rejected; cross-tenant request rejected; role escalation rejected; expired session rejected; invalid API key rejected; replayed webhook rejected; secret never returned to frontend.

117. AI Integration Architecture

AI may assist with support, offer discovery, analytics explanation, fraud investigation assistance, compliance case summarization, documentation, operator assistance. AI must not independently alter critical financial records.

118. AI Financial Safety

AI cannot directly create payout, approve payout, modify ledger, change balance, change commission, override compliance, or suspend a user without an explicit authorized workflow. AI recommendations require human/system authorization.

119. AI Coding Agent Protocol

Every coding agent must: 1) inspect repository, 2) identify architecture, 3) read relevant files, 4) identify dependencies, 5) explain proposed change, 6) make minimal changes, 7) preserve working code, 8) run tests, 9) run typecheck, 10) run build, 11) review security, 12) report exact result.

120. AI Coding Agent Forbidden Actions

Never: invent production data, hardcode secrets, skip authorization, modify production DB silently, delete migrations, rewrite architecture unnecessarily, claim tests passed without running them, claim deployment succeeded without verification, create fake financial logic.

121. Repository Structure

trafficvaulthub/ │ ├── frontend/ │ └── src/ │ ├── app/ │ ├── components/ │ ├── features/ │ ├── hooks/ │ ├── lib/ │ ├── routes/ │ └── types/ │ ├── backend/ │ └── src/ │ ├── modules/ │ ├── middleware/ │ ├── integrations/ │ ├── workers/ │ ├── lib/ │ └── routes/ │ ├── migrations/ ├── tests/ ├── docs/ │ ├── adr/ │ ├── api/ │ ├── architecture/ │ └── runbooks/ │ ├── scripts/ └── README.md

122. Architecture Decision Records

ADR-001 Authentication, ADR-002 D1 data model, ADR-003 Tracking architecture, ADR-004 Attribution, ADR-005 Ledger, ADR-006 Payout provider, ADR-007 Fraud architecture, ADR-008 Multi-currency, ADR-009 Data retention, ADR-010 Disaster recovery

123. Documentation Requirements

Every critical subsystem needs: purpose, architecture, data model, API, state machine, failure modes, security, testing, operations.

124. Admin Safety

Dangerous actions require confirmation, reason, permission, audit. Bulk operations require additional confirmation.

125. Bulk Operations

Support safely: bulk offer pause, bulk affiliate review, bulk conversion review, bulk notification. Bulk financial operations require stronger authorization.

126. Search Architecture

Search must support offers, affiliates, advertisers, conversions, tickets, cases, invoices, payouts — results must respect tenant and permission boundaries.

127. Pagination

Large datasets must never load completely into browser memory. Use cursor pagination, server-side filtering, server-side sorting.

128. Rate Limiting

Different limits for login, API, tracking, postback, webhook, admin, public endpoints. Tracking must be optimized for legitimate high-volume traffic while maintaining abuse controls.

129. Public Tracking Endpoint

Public tracking endpoints must be minimal, highly optimized, abuse-resistant, independently monitored, and protected from unnecessary database operations.

130. Tracking Fail-Safe

If non-critical analytics fails: tracking must continue. If attribution-critical infrastructure fails: fail safely + record incident + avoid false conversion.

131. Financial Fail-Safe

If financial calculation cannot be verified: do not post ledger, do not guess. Create a financial_processing_error for investigation/retry.

132. Compliance Fail-Safe

If required compliance information is missing: do not grant restricted access, do not automatically assume approval.

133. Offer Fail-Safe

If offer eligibility cannot be determined reliably: do not route traffic blindly — use configured safe fallback.

134–136. Experience Goals

Advertiser experience shoul
