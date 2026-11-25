import { Hono } from "hono";
import { getChatConfig } from "@/chat/config";
import { emptyResponse, jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  VERSIONS_STREAM_HEADER,
  versionsQuerySchema,
  versionsSchema,
} from "../schema/versions";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { createVersionChanges } from "./changes";
import { readVersions } from "./read";
import { openVersionsStream } from "./stream";

/**
 * Create the routes of the dashboard change tokens: one poll, and one SSE
 * stream that pushes the same tokens. The streams of this API share one
 * Postgres `LISTEN` session.
 */
export function createVersionsRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  const changes = createVersionChanges();
  const query = validateRequest(
    "query",
    versionsQuerySchema,
    "Invalid query parameters.",
  );

  app.get("/", requireViewer, query, async (context) => {
    const headers: Record<string, string> = {
      "cache-control": "private, no-store",
    };
    if (getChatConfig().versionsStreamEnabled) {
      headers[VERSIONS_STREAM_HEADER] = "1";
    }
    return jsonResponse(
      versionsSchema,
      await readVersions(context.get("viewer"), context.req.valid("query")),
      { headers },
    );
  });

  // With the stream off, a 204 stops `EventSource`, and the client polls.
  app.get("/stream", requireViewer, query, async (context) => {
    if (!getChatConfig().versionsStreamEnabled) return emptyResponse();
    return await openVersionsStream({
      changes,
      conversationIds: context.req.valid("query").conversationIds,
      viewer: context.get("viewer"),
    });
  });

  return app;
}
