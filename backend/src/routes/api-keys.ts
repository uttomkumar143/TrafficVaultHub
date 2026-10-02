/**
 * API-key routes (Phase 6 Unit 3; PRD §73, §115, §116, §127). Mounted by
 * `routes/organizations.ts` UNDER `/:orgId/api-keys`, so every route inherits
 * `requireAuth → requireOrg` and adds `requirePermission`.
 *
 *   GET    /organizations/:orgId/api-keys                     api_keys.read    → 200 { items, next_cursor }  ?status=&limit=&cursor=
 *   POST   /organizations/:orgId/api-keys                     api_keys.manage  → 201 { api_key }   (`api_key.key` = full secret, shown ONCE)
 *   GET    /organizations/:orgId/api-keys/:keyId              api_keys.read    → 200 { api_key }   (never the hash, never the secret)
 *   POST   /organizations/:orgId/api-keys/:keyId/rotate       api_keys.manage  → 201 { api_key }   (successor; `key` shown ONCE; old → ROTATED)
 *   POST   /organizations/:orgId/api-keys/:keyId/revoke       api_keys.manage  → 200 { api_key }   (→ REVOKED, terminal)
 *
 * Illegal transitions are 409 (API_KEY_NOT_ACTIVE / API_KEY_FINAL) from the
 * service — the 0012 triggers never get to abort. Malformed ids → 404.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { parsePageRequest } from "../lib/pagination";
import { requestMeta as meta } from "../lib/request-meta";
import { parseJsonBody } from "../lib/validation";
import { requireSession } from "../middleware/require-auth";
import { requirePermission } from "../middleware/require-org";
import { ApiKeyRepository } from "../modules/api-keys/repository";
import { ApiKeyService, NAME_MAX_LENGTH, SCOPE_MAX_COUNT } from "../modules/api-keys/service";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
    scopes: z.array(z.string().min(1).max(64)).max(SCOPE_MAX_COUNT).optional(),
    expires_at: z.string().min(1).max(40).nullable().optional(),
  })
  .strict();

const idSchema = z.string().uuid();
type Ctx = Context<AppEnv>;

function keyId(c: Ctx): string {
  const parsed = idSchema.safeParse(c.req.param("keyId"));
  if (!parsed.success) throw new AppError(404, "API_KEY_NOT_FOUND", "API key not found");
  return parsed.data;
}

/** Per-request service over the bound D1 (same pattern as `routes/ledger.ts`). */
export function buildApiKeyService(c: Ctx): ApiKeyService {
  return new ApiKeyService(new ApiKeyRepository(c.env.DB), c.env.DB);
}

export const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.get("/", requirePermission("api_keys.read"), async (c) => {
  const page = parsePageRequest((n) => c.req.query(n));
  const result = await buildApiKeyService(c).list(c.get("tenant"), page, c.req.query("status"));
  return c.json(result, 200);
});

apiKeyRoutes.post("/", requireSession, requirePermission("api_keys.manage"), async (c) => {
  const body = await parseJsonBody(c, createSchema);
  const api_key = await buildApiKeyService(c).create(c.get("auth"), c.get("tenant"), body, meta(c));
  c.header("cache-control", "no-store");
  return c.json({ api_key }, 201);
});

apiKeyRoutes.get("/:keyId", requirePermission("api_keys.read"), async (c) => {
  const api_key = await buildApiKeyService(c).get(c.get("tenant"), keyId(c));
  return c.json({ api_key }, 200);
});

apiKeyRoutes.post("/:keyId/rotate", requireSession, requirePermission("api_keys.manage"), async (c) => {
  const api_key = await buildApiKeyService(c).rotate(c.get("auth"), c.get("tenant"), keyId(c), meta(c));
  c.header("cache-control", "no-store");
  return c.json({ api_key }, 201);
});

apiKeyRoutes.post("/:keyId/revoke", requireSession, requirePermission("api_keys.manage"), async (c) => {
  const api_key = await buildApiKeyService(c).revoke(c.get("auth"), c.get("tenant"), keyId(c), meta(c));
  return c.json({ api_key }, 200);
});
