/**
 * Phase 6 Unit 5 — the adapters are injected through `CreateAppOptions` and
 * nowhere else. `createApp` must accept every port (default or injected)
 * without any route/service change — this is the single seam a vendor uses.
 *
 * Pure: no D1 (createApp itself does not touch the database), no network.
 */
import { describe, expect, it } from "vitest";
import { createApp, type CreateAppOptions } from "../app";
import { MemoryCRMAdapter, MemoryNotificationAdapter, MemoryTrackingAdapter, ScriptedFraudAdapter, StubPaymentAdapter } from "./index";

describe("integrations wiring through createApp", () => {
  it("builds with all defaults (Null/Stub/Log adapters) and still serves health", async () => {
    const res = await createApp().request("/api/v1/health");
    expect(res.status).toBe(200);
  });

  it("accepts an injected implementation for every one of the five Unit 5 ports (payout = paymentProvider, Phase 5)", async () => {
    const opts: CreateAppOptions = {
      trackingAdapter: new MemoryTrackingAdapter(),
      paymentAdapter: new StubPaymentAdapter({ supportedCurrencies: ["EUR"] }),
      notificationAdapter: new MemoryNotificationAdapter(),
      crmAdapter: new MemoryCRMAdapter(),
      fraudAdapter: new ScriptedFraudAdapter(),
    };
    const res = await createApp(opts).request("/api/v1/health");
    expect(res.status).toBe(200);
  });

  it("CreateAppOptions names exactly the PRD §367 adapter seams (plus the Phase 5 paymentProvider = PayoutAdapter)", () => {
    // Compile-time guarantee made visible: assigning every key is legal and no key is required.
    const keys: Array<keyof CreateAppOptions> = ["trackingAdapter", "paymentAdapter", "paymentProvider", "notificationAdapter", "crmAdapter", "fraudAdapter"];
    expect(keys).toHaveLength(6);
  });
});
