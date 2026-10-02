/**
 * TrackingAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * Phase 3 owns the tracking truth: clicks, conversions, attribution, caps all
 * live in OUR tables. This port is the seam for forwarding the resulting
 * tracking signals to an EXTERNAL tracking / analytics / S2S system (an
 * advertiser's own tracker, a third-party attribution platform, a data
 * warehouse) — never for deciding anything. Nothing here is read back into
 * attribution; a vendor outage can only lose a mirror copy.
 *
 * Privacy (PRD §34): the signals exported are the already-coarse `ClickSignals`
 * columns (country / device family / hashed-and-salted ip, ua) — never a raw IP,
 * never a raw user agent, never a version string.
 *
 * Money: `payout_minor` / `revenue_minor` are INTEGER minor units + ISO-4217.
 * Isolation: no D1 / KV / Hono imports; the adapter only re-exports Phase 3's
 * pure signal types so a vendor maps from one stable shape.
 */

import type { ClickSignals } from "../modules/tracking/repository";

export type { ClickSignals } from "../modules/tracking/repository";

/** Mirror of one recorded click. `click_id` is our opaque id (modules/tracking/ids). */
export interface TrackingClickEvent {
  readonly click_id: string;
  readonly organization_id: string;
  readonly offer_id: string;
  readonly affiliate_id: string;
  /** Pass-through affiliate sub-ids already validated upstream. */
  readonly sub_ids: Readonly<Record<string, string>>;
  readonly signals: ClickSignals;
  /** ISO-8601 UTC. */
  readonly occurred_at: string;
}

export const TRACKING_CONVERSION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REVERSED"] as const;
export type TrackingConversionStatus = (typeof TRACKING_CONVERSION_STATUSES)[number];

/** Mirror of one conversion state (created or updated). */
export interface TrackingConversionEvent {
  readonly conversion_id: string;
  readonly organization_id: string;
  readonly offer_id: string;
  readonly affiliate_id: string;
  /** Attributed click, when attribution found one. */
  readonly click_id: string | null;
  readonly status: TrackingConversionStatus;
  /** Advertiser-side transaction id, when supplied. */
  readonly transaction_id: string | null;
  /** INTEGER minor units; null when the offer has no payout/revenue on this event. */
  readonly payout_minor: number | null;
  readonly revenue_minor: number | null;
  readonly currency: string | null;
  readonly occurred_at: string;
}

export const TRACKING_FORWARD_STATUSES = ["ACCEPTED", "DUPLICATE", "FAILED"] as const;
export type TrackingForwardStatus = (typeof TRACKING_FORWARD_STATUSES)[number];

export interface TrackingForwardResult {
  readonly provider: string;
  readonly status: TrackingForwardStatus;
  /** Vendor's own id when it issues one. */
  readonly provider_reference?: string;
  /** Present when FAILED. GLOB [A-Z0-9_]*, 1..64 chars. */
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface TrackingAdapter {
  readonly name: string;
  /** Idempotent on click_id: a vendor MUST answer DUPLICATE (not a second record) for a repeated id. */
  forwardClick(event: TrackingClickEvent): Promise<TrackingForwardResult>;
  /** Idempotent on (conversion_id, status): the same transition forwarded twice is a DUPLICATE. */
  forwardConversion(event: TrackingConversionEvent): Promise<TrackingForwardResult>;
}

// ---- implementations -----------------------------------------------------------------

/** Default: discards everything. The platform is correct with no external tracker at all. */
export class NullTrackingAdapter implements TrackingAdapter {
  readonly name = "null";
  async forwardClick(_event: TrackingClickEvent): Promise<TrackingForwardResult> {
    return { provider: this.name, status: "ACCEPTED" };
  }
  async forwardConversion(_event: TrackingConversionEvent): Promise<TrackingForwardResult> {
    return { provider: this.name, status: "ACCEPTED" };
  }
}

/** Test adapter — records forwarded events and enforces the idempotency contract so callers can assert on it. */
export class MemoryTrackingAdapter implements TrackingAdapter {
  readonly name = "memory";
  readonly clicks: TrackingClickEvent[] = [];
  readonly conversions: TrackingConversionEvent[] = [];
  private readonly seenClicks = new Set<string>();
  private readonly seenConversions = new Set<string>();

  async forwardClick(event: TrackingClickEvent): Promise<TrackingForwardResult> {
    if (this.seenClicks.has(event.click_id)) return { provider: this.name, status: "DUPLICATE", provider_reference: `mem_${event.click_id}` };
    this.seenClicks.add(event.click_id);
    this.clicks.push(event);
    return { provider: this.name, status: "ACCEPTED", provider_reference: `mem_${event.click_id}` };
  }

  async forwardConversion(event: TrackingConversionEvent): Promise<TrackingForwardResult> {
    const key = `${event.conversion_id}:${event.status}`;
    if (this.seenConversions.has(key)) return { provider: this.name, status: "DUPLICATE", provider_reference: `mem_${key}` };
    this.seenConversions.add(key);
    this.conversions.push(event);
    return { provider: this.name, status: "ACCEPTED", provider_reference: `mem_${key}` };
  }
}
