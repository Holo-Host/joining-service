import { timingSafeEqual } from 'node:crypto';
import * as v from 'valibot';

/** Build a JSON error response matching the standard ErrorResponse shape. */
export function errorJson(code: string, message: string, status: number) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Timing-safe string comparison.
 * Returns true if both strings are equal, using constant-time comparison
 * to prevent timing side-channel attacks on secret values.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Parse a JSON request body and validate it against a Valibot schema.
 * Returns the typed data on success, or a 400 Response on parse/validation failure.
 */
export async function safeParseJson<T>(
  req: Request,
  schema: v.GenericSchema<unknown, T>,
): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: errorJson('invalid_json', 'Request body must be valid JSON', 400) };
  }
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    const issue = result.issues[0];
    const path = issue.path?.map((p) => p.key).join('.') ?? '';
    const message = path ? `${path}: ${issue.message}` : issue.message;
    return { error: errorJson('invalid_request', message, 400) };
  }
  return { data: result.output };
}
