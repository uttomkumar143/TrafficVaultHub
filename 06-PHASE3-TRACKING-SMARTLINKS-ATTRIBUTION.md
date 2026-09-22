# PHASE 3 — Tracking, Attribution & SmartLinks
### Paste after the Master System Prompt and Auto-Commit Protocol. Requires Phase 2 complete.

Reference PRD sections: 31–46 (Tracking infrastructure, Click ID, Tracking IDs, Privacy-preserving tracking, Attribution engine/record, SmartLink engine/routing/caps/cache/failover), plus §129–130 (Public tracking endpoint, Tracking fail-safe).

Goal: the highest-traffic, latency-critical part of the system. Keep the public tracking endpoint minimal and fast; keep everything else out of its hot path. Commit after each unit.

## Units of work

1. **Click ID & tracking links** — generate globally unique `click_id`; capture `affiliate_id, offer_id, smartlink_id, traffic_source_id, creative_id, timestamp, sub1–sub5`. Keep sub-ID handling privacy-conscious — no unnecessary personal data, no invasive fingerprinting when a lighter signal will do (PRD §34).

2. **Public tracking redirect endpoint** — this is the one endpoint with a hard performance target (p95 < 100ms per PRD §107). Keep it minimal: validate, log the click, resolve destination, redirect. Push anything non-critical (analytics enrichment, fraud scoring detail) to a queue rather than the request path. If non-critical analytics fails, tracking must still continue (§130).

3. **SmartLink engine** — evaluate offer status, affiliate eligibility, geo, device, OS, traffic source, cap, budget, tracking health, compliance, and risk before selecting an offer. Support routing modes `RULE_BASED, WEIGHTED, PERFORMANCE_BASED, GEO_BASED, DEVICE_BASED, HYBRID`, and record which routing algorithm version made each decision.

4. **Cap protection** — concurrency-safe counters (Durable Objects are the right tool here) for daily click cap, daily conversion cap, monthly cap, total cap, budget cap.

5. **Cache & invalidation** — use KV for cacheable eligibility data; invalidate immediately when an offer is paused, a cap/budget is exhausted, tracking degrades, affiliate access is revoked, or a compliance restriction is added. Stale-cache-serves-inactive-offer is a bug, not an edge case.

6. **Failover** — if the primary offer becomes unavailable mid-flow, recalculate eligibility and route to an alternative rather than ever redirecting to an inactive offer.

7. **Attribution engine** — configurable attribution windows, first-party identifiers, S2S support hook, deduplication, fallback rules, versioned attribution policy; every decision produces an `attribution_id, conversion_id, click_id, rule_version, decision, reason_code, timestamp` record that is internally explainable (not a black box).

8. **Migration** — `migrations/0004_tracking.sql` for `tracking_links, smartlinks, clicks, attributions` and related cap/cache-support tables.

9. **Critical tracking tests (PRD §115)** — prove: click generates a unique ID; an invalid offer is rejected; an inactive offer never receives SmartLink traffic; duplicate conversions are deduplicated; an invalid signature is rejected; a replay is rejected; conversion attribution is recorded correctly.

10. **STATE.md** update.

## Definition of done

- The public tracking redirect path is minimal and meets the latency intent — no heavy synchronous work in that request.
- SmartLink never routes to a paused/capped/ineligible offer, verified by tests, including the failover path.
