/**
 * Integration adapters (Phase 6 Unit 5; PRD §367).
 *
 * Six ports, one file each, at least one implementation each. Core business
 * logic depends on the interfaces here only; a new vendor is a new file
 * implementing one of them, injected through `CreateAppOptions` — never an edit
 * to a service, repository or route.
 *
 *   TrackingAdapter      — mirror clicks/conversions to an external tracker
 *   PaymentAdapter       — collect funds FROM advertisers (charges / refunds)
 *   PayoutAdapter        — disburse funds TO affiliates (= Phase 5 PaymentProvider)
 *   NotificationAdapter  — deliver rendered notifications over email/SMS/push
 *   CRMAdapter           — upsert party contacts + timeline into a CRM
 *   FraudAdapter         — consult an external fraud scorer as one more signal
 */
export * from "./tracking-adapter";
export * from "./payment-adapter";
export * from "./payout-adapter";
export * from "./notification-adapter";
export * from "./crm-adapter";
export * from "./fraud-adapter";
