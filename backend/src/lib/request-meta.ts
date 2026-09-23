/**
 * Request metadata captured for audit / auth-event rows (PRD §102, §124):
 * client IP (Cloudflare `cf-connecting-ip`), truncated user agent and the
 * request id (`cf-ray`). Single implementation shared by every route module
 * so new modules never copy-paste it (master prompt: no duplicate
 * implementations). Never captures headers that carry credentials.
 */
import type { Context } from "hono";
import type { RequestMeta } from "../modules/auth/repository";
import { requestId } from "./errors";

/** Upper bound for stored user agents — keeps audit rows small and bounded. */
export const USER_AGENT_MAX_LENGTH = 512;

export function requestMeta(c: Context): RequestMeta {
  return {
    ip_address: c.req.header("cf-connecting-ip") ?? null,
    user_agent: c.req.header("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
    request_id: requestId(c),
  };
}
