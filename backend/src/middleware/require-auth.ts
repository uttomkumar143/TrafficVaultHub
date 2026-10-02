/**
 * Authentication middleware (Phase 1 Unit 1; API keys added in Phase 6 Unit 4).
 *
 * Resolves `Authorization: Bearer …` to an authenticated principal and stores
 * it on the context as `auth` (`AuthenticatedContext`):
 *
 *   * `tvh_s_…` — a user session (AuthService.authenticate). Missing,
 *     malformed, unknown, revoked or expired → 401 UNAUTHENTICATED.
 *   * `tvh_k_…` — an organization API key (PRD §76/§77). The hashed key is
 *     looked up by ApiKeyService.authenticate (revoked / expired / unknown →
 *     null → 401), `last_used_at` is touched, and the principal is bound to
 *     the key's creator (must still be ACTIVE) with `auth.api_key` set.
 *     `requireOrg` then pins the tenant to `api_key.organization_id` and
 *     intersects the role's permissions with the key's scopes; `requireScope`
 *     adds explicit scope checks.
 *
 * Every failure is the SAME 401 envelope — the response never reveals whether
 * the token was a session or a key, nor why it was refused (PRD §116). The
 * secret is never logged, never placed on the context and never echoed.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { ApiKeyRepository } from "../modules/api-keys/repository";
import { ApiKeyService } from "../modules/api-keys/service";
import type { AuthenticatedContext } from "../modules/auth/service";
import { extractBearerToken } from "../modules/auth/tokens";

function unauthenticated(): AppError {
  return new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired");
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bearer = extractBearerToken(c.req.header("authorization"));
  if (!bearer) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  let auth: AuthenticatedContext | null;
  if (bearer.kind === "session") {
    auth = await c.get("authService").authenticate(bearer.raw);
  } else {
    const principal = await new ApiKeyService(new ApiKeyRepository(c.env.DB), c.env.DB).authenticate(bearer.raw);
    auth = principal ? await c.get("authService").authenticateApiKey(principal) : null;
  }
  if (!auth) throw unauthenticated();

  c.set("auth", auth);
  await next();
};

/**
 * Guard: the principal must be a real user session, not an API key. Used on
 * session-management routes (logout, device list) where a key has no
 * meaningful session to act on. 403 FORBIDDEN, standard envelope.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  if (auth.api_key) throw new AppError(403, "FORBIDDEN", "This endpoint requires a user session, not an API key");
  await next();
};

/**
 * Guard factory (PRD §77): when the principal is an API key, it must carry
 * `scope`; user sessions pass through untouched (their authority is the role,
 * enforced by `requirePermission`). 403 INSUFFICIENT_SCOPE, standard envelope.
 *
 * Place after `requireAuth`. Independent of `requireOrg` so it can also guard
 * non-tenant routes.
 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    if (auth.api_key && !auth.api_key.scopes.includes(scope)) {
      throw new AppError(403, "INSUFFICIENT_SCOPE", `API key lacks required scope: ${scope}`);
    }
    await next();
  };
}
