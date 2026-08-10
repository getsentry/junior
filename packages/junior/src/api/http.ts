import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { apiErrorSchema } from "./schema/common";

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

/** Build response init that keeps personalized API payloads out of shared caches. */
function noStoreInit(init?: ResponseInit): ResponseInit {
  if (!init) return { headers: NO_STORE_HEADERS };
  const headers = new Headers(init.headers);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  return { ...init, headers };
}

/** Serialize a REST response only after it satisfies its declared schema. */
export function jsonResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: z.input<TSchema>,
  init?: ResponseInit,
): Response {
  return Response.json(schema.parse(value), noStoreInit(init));
}

/** Return an empty personalized API response with no-store caching. */
export function emptyResponse(status: 204 | 200 = 204): Response {
  return new Response(null, noStoreInit({ status }));
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
