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

/** Legacy plugin prefix kept as an alias for one compatibility window. */
export const LEGACY_MEMORY_API_PREFIX = "/api/plugins/memory";
export const MEMORY_API_PREFIX = "/api/memory";

/** Strip the mount prefix so the Memory REST app sees its own paths. */
function memoryRequest(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const nextPath =
    pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";
  url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return new Request(url, request);
}

/**
 * Authenticated Memory REST routes for one mount prefix.
 *
 * Core serves them at `/api/memory` and keeps `/api/plugins/memory` as an
 * alias. Personal API tokens reach the read routes; the dashboard only
 * accepts a browser session for `DELETE`.
 */
export function createMemoryRoutes(prefix: string): Hono<JuniorApiEnv> {
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
      memoryRequest(context.req.raw, prefix),
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
