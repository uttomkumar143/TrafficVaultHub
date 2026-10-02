/**
 * PayoutAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * Outbound money: disbursing earned commission to an affiliate's payout method.
 * This port ALREADY EXISTS in substance as Phase 5 Unit 9's `PaymentProvider`
 * (`createPayout / getStatus / cancelPayout / verifyWebhook`), which the payout
 * service has been built and tested against. Defining a second interface with
 * the same four methods would only give a new vendor two names to satisfy, so
 * `PayoutAdapter` is that contract under the PRD's name.
 *
 * Rules carried over unchanged from `modules/payouts/provider.ts`:
 *   - INTEGER minor units + upper-case ISO-4217 code; no floats, no FX.
 *   - same `idempotency_key` ⇒ same `provider_reference` (a retry is a replay,
 *     never a second payment).
 *   - adapters never import from the ledger.
 *
 * Reference implementation: `StubPaymentAdapter` (deterministic, no network).
 */

export type {
  PaymentProvider as PayoutAdapter,
  CreatePayoutRequest,
  CreatePayoutResult,
  PayoutStatusResult,
  CancelPayoutResult,
  WebhookEvent as PayoutWebhookEvent,
  VerifyWebhookResult as PayoutVerifyWebhookResult,
  ProviderPayoutStatus,
  ProviderErrorCode,
} from "../modules/payouts/provider";

export { ProviderError, PROVIDER_PAYOUT_STATUSES, PROVIDER_ERROR_CODES, assertCreatePayoutRequest } from "../modules/payouts/provider";

/** The one shipped implementation. A real vendor adapter replaces this and nothing else. */
export { StubPaymentAdapter as StubPayoutAdapter, STUB_PROVIDER_NAME as STUB_PAYOUT_ADAPTER_NAME } from "../modules/payouts/stub-adapter";
