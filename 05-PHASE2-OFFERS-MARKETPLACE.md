# PHASE 2 — Advertisers, Affiliates, Offers & Marketplace
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 1 complete.

Reference PRD sections: 16–30 (Advertiser/Affiliate lifecycle, onboarding, CRM, Offer lifecycle/versioning/economics/access/targeting, Traffic sources, Marketplace, Offer reliability).

Goal: the core business entities that everything else (tracking, conversions, finance) hangs off of. Commit after each unit.

## Units of work

1. **Advertiser module** — profile, onboarding fields (company, website, contact, business category, legal info, billing info, documents), lifecycle state machine `REGISTERED → EMAIL_VERIFIED → BUSINESS_REVIEW → COMPLIANCE_REVIEW → BILLING_SETUP → APPROVED → ACTIVE` plus `MORE_INFORMATION_REQUIRED / RESTRICTED / SUSPENDED / TERMINATED`. Every transition is audited (write to an `audit_logs` table — create it now if not already present).

2. **Affiliate module** — profile, traffic source declarations, lifecycle `APPLIED → EMAIL_VERIFIED → UNDER_REVIEW → APPROVED → ACTIVE` plus alternates. Same audit requirement.

3. **Offers core** — offer entity with lifecycle `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → LIVE` plus `PAUSED / CAP_REACHED / BUDGET_EXHAUSTED / TRACKING_ISSUE / COMPLIANCE_HOLD / EXPIRED / ARCHIVED`.

4. **Offer versioning** — every material change to payout, targeting, caps, traffic rules, attribution window, conversion event, or allowed traffic sources creates a new version row; never overwrite history. This matters later — conversions must reference the version active at click time.

5. **Offer economics** — separate fields for `advertiser_payout`, `affiliate_commission`, `network_margin`, fees, adjustments — all `amount_minor` + `currency`, never combined into one ambiguous number.

6. **Offer access & targeting** — access modes `PUBLIC / APPLICATION_REQUIRED / PRIVATE / INVITE_ONLY / AFFILIATE_SPECIFIC` enforced server-side; targeting by country, region, device, OS, browser, language, traffic_source, affiliate, time_window, versioned.

7. **Marketplace API + UI** — search/filter offers by vertical, country, payout, payout type, device, traffic source, approval mode, status — without leaking confidential advertiser data to affiliates who shouldn't see it (enforce via the access rules above, not by trusting the frontend to hide fields).

8. **Migration(s)** — `migrations/0003_offers.sql` (and a follow-up if needed) — additive only.

9. **Tests** — offer version history is immutable and queryable; access rules correctly block/allow per mode; cross-tenant advertiser data isn't exposed through marketplace search.

10. **STATE.md** update.

## Definition of done

- An advertiser can create and version an offer; an affiliate can browse the marketplace and only see offers/fields they're allowed to see, enforced server-side.
- Offer economics fields are never floats and are never combined ambiguously.
