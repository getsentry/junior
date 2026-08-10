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
