/**
 * Authentication middleware (Phase 1 Unit 1).
 *
 * Resolves `Authorization: Bearer tvh_s_…` to an authenticated user + session
 * via AuthService and stores it on the context as `auth`. Missing, malformed,
 * unknown, revoked or expired sessions → 401 UNAUTHENTICATED.
 *
 * Organization / role / permission resolution (RBAC, tenant isolation) is
 * Phase 1 Unit 4 and will build on top of this middleware.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/bindings";
import { AppError } from "../lib/errors";
import { extractBearerSession } from "../modules/auth/tokens";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = extractBearerSession(c.req.header("authorization"));
  if (!raw) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }
  const auth = await c.get("authService").authenticate(raw);
  if (!auth) {
    throw new AppError(401, "UNAUTHENTICATED", "Session is invalid or has expired");
  }
  c.set("auth", auth);
  await next();
};
