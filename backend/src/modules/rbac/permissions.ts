/**
 * Permission-key catalogue (Phase 1 Unit 4; PRD §10).
 *
 * This list MIRRORS `migrations/0004_permissions.sql`. The database is the
 * authority at runtime (permissions are resolved per request from
 * `role_permissions`); this constant only gives route code a typed vocabulary
 * so a typo in `requirePermission("offers.raed")` fails at compile time.
 * `src/test/d1-sqlite.test.ts` asserts the two stay identical — when a later
 * migration adds keys, extend this list in the same commit.
 */
export const PERMISSION_KEYS = [
  // identity / organizations module
  "organizations.read",
  "organizations.update",
  "members.read",
  "members.manage",
  // offers (PRD §10)
  "offers.read",
  "offers.create",
  "offers.update",
  "offers.approve",
  "offers.pause",
  // conversions
  "conversions.read",
  "conversions.approve",
  "conversions.reject",
  // ledger
  "ledger.read",
  "ledger.adjust",
  // payouts
  "payouts.read",
  "payouts.review",
  "payouts.approve",
  "payouts.release",
  // fraud
  "fraud.read",
  "fraud.review",
  // compliance
  "compliance.read",
  "compliance.resolve",
  // audit
  "audit.read",
  // advertisers (Phase 2 Unit 1, migration 0005)
  "advertisers.read",
  "advertisers.manage",
  "advertisers.review",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return KEY_SET.has(value);
}
