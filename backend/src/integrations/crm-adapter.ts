/**
 * CRMAdapter port (Phase 6 Unit 5; PRD §367).
 *
 * Mirrors the platform's PARTY records (advertiser / affiliate accounts and
 * their primary contacts) and lifecycle events into an external CRM (HubSpot,
 * Salesforce, …) for the network's sales / account-management team. No prior
 * art in the codebase — this is the minimum a vendor can be plugged into.
 *
 * Direction is one-way OUT. The CRM is never the source of truth for anything
 * the platform decides: approval status, tier, billing — all stay in our tables.
 *
 * Isolation: no D1 / KV / Hono / module imports; shapes below are the only
 * contract. Idempotency: `external_ref` is OUR id (advertisers.id / affiliates.id);
 * a vendor MUST upsert on it so a replayed sync never creates a second contact.
 * Privacy: `email` is the business contact address the party gave us; adapters
 * log it redacted (or not at all).
 */

export const CRM_PARTY_TYPES = ["ADVERTISER", "AFFILIATE"] as const;
export type CrmPartyType = (typeof CRM_PARTY_TYPES)[number];

export const CRM_PARTY_STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type CrmPartyStatus = (typeof CRM_PARTY_STATUSES)[number];

export interface CrmContact {
  /** OUR stable id for this party — the vendor upsert key. 1..64 chars. */
  readonly external_ref: string;
  readonly organization_id: string;
  readonly party_type: CrmPartyType;
  readonly company_name: string;
  readonly contact_name: string | null;
  readonly email: string;
  readonly status: CrmPartyStatus;
  /** Flat, string-valued custom fields (tier, vertical, country, …). Vendors map keys to their own properties. */
  readonly attributes: Readonly<Record<string, string>>;
}

export const CRM_ACTIVITY_TYPES = ["SIGNED_UP", "APPROVED", "SUSPENDED", "REINSTATED", "CLOSED", "NOTE"] as const;
export type CrmActivityType = (typeof CRM_ACTIVITY_TYPES)[number];

export interface CrmActivity {
  /** Caller-owned key (audit_log id, event id) — same key ⇒ one timeline entry. 1..256 chars. */
  readonly idempotency_key: string;
  /** The party this activity belongs to (CrmContact.external_ref). */
  readonly external_ref: string;
  readonly type: CrmActivityType;
  readonly summary: string;
  /** ISO-8601 UTC. */
  readonly occurred_at: string;
}

export const CRM_SYNC_STATUSES = ["CREATED", "UPDATED", "UNCHANGED", "FAILED"] as const;
export type CrmSyncStatus = (typeof CRM_SYNC_STATUSES)[number];

export interface CrmSyncResult {
  readonly provider: string;
  readonly status: CrmSyncStatus;
  /** Vendor's record id when it issues one. */
  readonly provider_reference?: string;
  /** Present when FAILED. GLOB [A-Z0-9_]*, 1..64 chars. */
  readonly failure_code?: string;
  readonly failure_reason?: string;
}

export interface CRMAdapter {
  readonly name: string;
  /** Upsert on external_ref. Never throws for a vendor-side failure — returns FAILED. */
  upsertContact(contact: CrmContact): Promise<CrmSyncResult>;
  /** Append a timeline activity; idempotent on idempotency_key (repeat ⇒ UNCHANGED). */
  recordActivity(activity: CrmActivity): Promise<CrmSyncResult>;
}

// ---- implementations -----------------------------------------------------------------

/** Default: no CRM connected. Everything succeeds and nothing is sent anywhere. */
export class NullCRMAdapter implements CRMAdapter {
  readonly name = "null";
  async upsertContact(_contact: CrmContact): Promise<CrmSyncResult> {
    return { provider: this.name, status: "UNCHANGED" };
  }
  async recordActivity(_activity: CrmActivity): Promise<CrmSyncResult> {
    return { provider: this.name, status: "UNCHANGED" };
  }
}

/** Test adapter — an in-memory CRM honouring the upsert / idempotency contract. */
export class MemoryCRMAdapter implements CRMAdapter {
  readonly name = "memory";
  readonly contacts = new Map<string, CrmContact>();
  readonly activities: CrmActivity[] = [];
  private readonly seenActivities = new Set<string>();

  async upsertContact(contact: CrmContact): Promise<CrmSyncResult> {
    const prev = this.contacts.get(contact.external_ref);
    this.contacts.set(contact.external_ref, contact);
    const ref = `mem_${contact.external_ref}`;
    if (!prev) return { provider: this.name, status: "CREATED", provider_reference: ref };
    return { provider: this.name, status: JSON.stringify(prev) === JSON.stringify(contact) ? "UNCHANGED" : "UPDATED", provider_reference: ref };
  }

  async recordActivity(activity: CrmActivity): Promise<CrmSyncResult> {
    if (!this.contacts.has(activity.external_ref)) {
      return { provider: this.name, status: "FAILED", failure_code: "CRM_UNKNOWN_CONTACT", failure_reason: "activity for a contact that was never synced" };
    }
    if (this.seenActivities.has(activity.idempotency_key)) return { provider: this.name, status: "UNCHANGED" };
    this.seenActivities.add(activity.idempotency_key);
    this.activities.push(activity);
    return { provider: this.name, status: "CREATED", provider_reference: `mem_${activity.idempotency_key}` };
  }
}
