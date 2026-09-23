import { Hono } from "hono";
import { pluginApiRouteRequestContextSchema } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createMemoryApi } from "@/chat/memory/api";
import { MEMORY_FEATURE_NAME } from "@/chat/memory/feature";
import { createPluginConversationEventReader } from "@/chat/plugins/conversation-event-reader";
import { createPluginConversationEventStats } from "@/chat/plugins/conversation-event-stats";
import { getCoreFeatures } from "@/chat/plugins/core-features";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { apiErrorSchema } from "../schema/common";
import { requireViewer } from "../viewer";

/** Mount path for the core Memory REST routes. */
export const MEMORY_API_PREFIX = "/api/memory";

/** Strip the mount prefix so the Memory REST app sees its own paths. */
function memoryRequest(request: Request): Request {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const nextPath =
    pathname === MEMORY_API_PREFIX
      ? "/"
      : pathname.slice(MEMORY_API_PREFIX.length) || "/";
  url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return new Request(url, request);
}

/**
 * Authenticated Memory REST routes mounted at `/api/memory`.
 *
 * Personal API tokens reach the read routes; the dashboard only accepts a
 * browser session for `DELETE`.
 */
export function createMemoryRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.all("/*", requireViewer, async (context) => {
    const memory = getCoreFeatures().find(
      (feature) => feature.manifest.name === MEMORY_FEATURE_NAME,
    );
    if (!memory?.hooks) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Memory is disabled." },
        { status: 404 },
      );
    }
    const viewer = context.get("viewer");
    const api = createMemoryApi({
      conversationEvents: createPluginConversationEventReader(memory),
      db: getDb(),
      eventStats: createPluginConversationEventStats(memory),
      users: { resolve: async () => viewer },
    });
    return await api.fetch(
      memoryRequest(context.req.raw),
      pluginApiRouteRequestContextSchema.parse({
        auth: {
          user: {
            email: viewer.email,
            emailVerified: true,
            ...(viewer.displayName ? { name: viewer.displayName } : undefined),
          },
        },
        pluginName: MEMORY_FEATURE_NAME,
      }),
    );
  });

  return app;
}
