import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Application error carrying the PRD §72 envelope fields.
 * Thrown by services/middleware; converted to a JSON response by
 * `app.onError`. Internal details never leave the server.
 */
export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function requestId(c: Context): string | null {
  return c.req.header("cf-ray") ?? null;
}

/** Serialise any error into the uniform envelope. Unknown errors become 500. */
export function errorResponse(err: unknown, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, request_id: requestId(c) } },
      err.status,
    );
  }
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        request_id: requestId(c),
      },
    },
    500,
  );
}
