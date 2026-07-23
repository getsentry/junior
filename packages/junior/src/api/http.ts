import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { apiErrorSchema } from "./schema/common";

/** Serialize a REST response only after it satisfies its declared schema. */
export function jsonResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: z.input<TSchema>,
  init?: ResponseInit,
): Response {
  return Response.json(schema.parse(value), init);
}

/** Stop a request with Junior's stable JSON error contract. */
export function throwApiError(
  status: ContentfulStatusCode,
  message: string,
  cause?: unknown,
): never {
  throw new HTTPException(status, {
    ...(cause === undefined ? {} : { cause }),
    message,
    res: jsonResponse(apiErrorSchema, { error: message }, { status }),
  });
}

/** Parse route parameters and return a 400 response contract for invalid input. */
export function parseParams<TSchema extends z.ZodType>(
  schema: TSchema,
  params: Record<string, string>,
): z.infer<TSchema> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  return throwApiError(400, "Invalid route parameters.", result.error);
}

/** Parse an HTTP query and return a 400 response contract for invalid input. */
export function parseQuery<TSchema extends z.ZodType>(
  schema: TSchema,
  query: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(query);
  if (result.success) return result.data;
  return throwApiError(400, "Invalid query parameters.", result.error);
}

/** Parse a JSON request body and return a 400 response contract on failure. */
export function parseBody<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  return throwApiError(400, "Invalid request body.", result.error);
}
