import type { Context } from "hono";
import type { ZodType } from "zod";
import { AppError } from "./errors";

/**
 * Parse and validate a JSON request body against a Zod schema (PRD §71
 * request schema, §98 input validation). Malformed JSON or schema failures
 * become a 400 VALIDATION_ERROR in the uniform envelope; field-level details
 * are summarised in the message without echoing submitted values.
 */
export async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const fields = Array.from(
      new Set(result.error.issues.map((i) => i.path.map(String).join(".") || "(root)")),
    );
    throw new AppError(400, "VALIDATION_ERROR", `Invalid request: ${fields.join(", ")}`);
  }
  return result.data;
}
