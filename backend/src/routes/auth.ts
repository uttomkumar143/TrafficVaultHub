/**
 * /api/v1/auth — email/password authentication (Phase 1 Unit 1, ADR-001).
 *
 * POST /signup               → 201 { user, debug? }
 * POST /verify-email         → 200 { user }
 * POST /resend-verification  → 202 {}            (no enumeration)
 * POST /login                → 200 { token, expires_at, user, session }
 * POST /logout               → 204                (auth required)
 * POST /forgot-password      → 202 {}            (no enumeration)
 * POST /reset-password       → 204
 * GET  /me                   → 200 { user, session } (auth required)
 * GET  /mfa                  → 200 { mfa }        (auth required; stub status)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../lib/bindings";
import { requestId } from "../lib/errors";
import { parseJsonBody } from "../lib/validation";
import { requireAuth } from "../middleware/require-auth";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../modules/auth/constants";
import type { RequestMeta } from "../modules/auth/repository";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const tokenSchema = z.string().min(16).max(512);

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  display_name: z.string().trim().min(1).max(120).optional(),
});
const emailOnlySchema = z.object({ email: emailSchema });
const tokenOnlySchema = z.object({ token: tokenSchema });
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
const resetSchema = z.object({ token: tokenSchema, password: passwordSchema });

function meta(c: { req: { header(name: string): string | undefined } }): RequestMeta {
  return {
    ip_address: c.req.header("cf-connecting-ip") ?? null,
    user_agent: c.req.header("user-agent")?.slice(0, 512) ?? null,
    request_id: requestId(c as never),
  };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/signup", async (c) => {
  const body = await parseJsonBody(c, signupSchema);
  const result = await c.get("authService").signup(body, meta(c));
  return c.json(result, 201);
});

authRoutes.post("/verify-email", async (c) => {
  const { token } = await parseJsonBody(c, tokenOnlySchema);
  const result = await c.get("authService").verifyEmail(token, meta(c));
  return c.json(result, 200);
});

authRoutes.post("/resend-verification", async (c) => {
  const { email } = await parseJsonBody(c, emailOnlySchema);
  const result = await c.get("authService").resendVerification(email);
  return c.json(result, 202);
});

authRoutes.post("/login", async (c) => {
  const body = await parseJsonBody(c, loginSchema);
  const result = await c.get("authService").login(body, meta(c));
  return c.json(result, 200);
});

authRoutes.post("/forgot-password", async (c) => {
  const { email } = await parseJsonBody(c, emailOnlySchema);
  const result = await c.get("authService").forgotPassword(email, meta(c));
  return c.json(result, 202);
});

authRoutes.post("/reset-password", async (c) => {
  const body = await parseJsonBody(c, resetSchema);
  await c.get("authService").resetPassword(body, meta(c));
  return c.body(null, 204);
});

authRoutes.post("/logout", requireAuth, async (c) => {
  await c.get("authService").logout(c.get("auth"), meta(c));
  return c.body(null, 204);
});

authRoutes.get("/me", requireAuth, (c) => {
  const { user, session } = c.get("auth");
  return c.json({ user, session }, 200);
});

authRoutes.get("/mfa", requireAuth, (c) => {
  // Explicit stub: reports MFA as not yet available (ADR-001 §5).
  return c.json({ mfa: c.get("auth").user.mfa }, 200);
});
