/**
 * Offer eligibility rules shared by every Phase 3 consumer (PRD §28, §31,
 * §42, §46, §130): tracking-link creation (Unit 1), the public redirect
 * (Unit 2) and the SmartLink engine (Units 3/6).
 *
 * Pure module — no I/O. The rules are the SAME ones Phase 2 enforces in
 * `modules/offers/service.ts#toMarketplace` (`can_join`) and in
 * `OfferRepository.findMarketplaceOffer`; they are restated here as a
 * function so the hot path never has to re-derive them from SQL, and so a
 * change to the access model has exactly one place to happen per phase.
 *
 *   * `hasOfferAccess(mode, grant)` — PRD §28 access modes. PUBLIC needs no
 *     grant; EVERY other mode (APPLICATION_REQUIRED, PRIVATE, INVITE_ONLY,
 *     AFFILIATE_SPECIFIC) needs an APPROVED grant to send traffic. An INVITED
 *     grant makes an INVITE_ONLY offer *visible* (Phase 2) but not *joinable*
 *     — the affiliate must accept, which produces APPROVED.
 *   * `offerRoutability(facts, now)` — whether a click may be routed to the
 *     offer right now: LIVE, a current version with a destination, inside the
 *     version's targeting window, and access granted. Returns a reason code
 *     (never a bare boolean) so the caller can explain the decision
 *     (PRD §43 "explainable", §130).
 */
import type { AccessGrantStatus, AccessMode, OfferStatus } from "../offers/state-machine";

/** Offer statuses that may receive traffic. LIVE only — every other state is a halt of some kind. */
export const ROUTABLE_OFFER_STATUSES: ReadonlySet<OfferStatus> = new Set<OfferStatus>(["LIVE"]);

export const INELIGIBILITY_REASONS = [
  "OFFER_NOT_LIVE",
  "OFFER_NO_VERSION",
  "OFFER_NO_DESTINATION",
  "OFFER_NOT_STARTED",
  "OFFER_EXPIRED",
  "ACCESS_DENIED",
] as const;
export type IneligibilityReason = (typeof INELIGIBILITY_REASONS)[number];

export type Routability = { eligible: true } | { eligible: false; reason: IneligibilityReason };

/** PRD §28: may an affiliate with this grant send traffic to an offer in this mode? */
export function hasOfferAccess(mode: AccessMode, grant: AccessGrantStatus | null | undefined): boolean {
  if (mode === "PUBLIC") return true;
  return grant === "APPROVED";
}

export interface OfferRoutingFacts {
  status: OfferStatus;
  access_mode: AccessMode;
  current_version_id: string | null;
  destination_url: string | null;
  targeting_starts_at: string | null;
  targeting_ends_at: string | null;
  grant_status: AccessGrantStatus | null;
}

/**
 * Decide, in a fixed order, whether the offer may be routed to. The order
 * matters for the recorded reason: an offer that is both PAUSED and
 * inaccessible reports OFFER_NOT_LIVE, which is what an operator needs first.
 */
export function offerRoutability(facts: OfferRoutingFacts, now: Date = new Date()): Routability {
  if (!ROUTABLE_OFFER_STATUSES.has(facts.status)) return { eligible: false, reason: "OFFER_NOT_LIVE" };
  if (!facts.current_version_id) return { eligible: false, reason: "OFFER_NO_VERSION" };
  if (!facts.destination_url) return { eligible: false, reason: "OFFER_NO_DESTINATION" };
  const t = now.getTime();
  if (facts.targeting_starts_at && new Date(facts.targeting_starts_at).getTime() > t) {
    return { eligible: false, reason: "OFFER_NOT_STARTED" };
  }
  if (facts.targeting_ends_at && new Date(facts.targeting_ends_at).getTime() <= t) {
    return { eligible: false, reason: "OFFER_EXPIRED" };
  }
  if (!hasOfferAccess(facts.access_mode, facts.grant_status)) return { eligible: false, reason: "ACCESS_DENIED" };
  return { eligible: true };
}
