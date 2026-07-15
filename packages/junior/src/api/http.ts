import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** Parse route parameters and return a 400 response contract for invalid input. */
export function parseParams<TSchema extends z.ZodType>(
  schema: TSchema,
  params: Record<string, string>,
): z.infer<TSchema> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  throw new HTTPException(400, {
    cause: result.error,
    message: "Invalid route parameters.",
  });
}

/** Parse an HTTP query and return a 400 response contract for invalid input. */
export function parseQuery<TSchema extends z.ZodType>(
  schema: TSchema,
  query: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(query);
  if (result.success) return result.data;
  throw new HTTPException(400, {
    cause: result.error,
    message: "Invalid query parameters.",
  });
}
