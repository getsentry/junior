import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as z from "zod";
import { startSpan } from "@/chat/sentry";
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
  // Validation and serialization run after the last query. Large reports
  // spend real time here, and without this span it is a gap at the end of
  // the request trace.
  return startSpan({ name: "Write API response", op: "serialize" }, (span) => {
    const startedAt = performance.now();
    const parsed = schema.parse(value);
    const parsedAt = performance.now();
    const body = JSON.stringify(parsed);
    span.setAttributes({
      "app.api.response.chars": body.length,
      "app.api.response.json_stringify_ms": Math.round(
        performance.now() - parsedAt,
      ),
      "app.api.response.schema_parse_ms": Math.round(parsedAt - startedAt),
    });
    const responseInit = noStoreInit(init);
    const headers = new Headers(responseInit.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Response(body, { ...responseInit, headers });
  });
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
    ...(cause === undefined ? undefined : { cause }),
    message,
    res: jsonResponse(apiErrorSchema, { error: message }, { status }),
  });
}
