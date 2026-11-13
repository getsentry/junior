import { Hono } from "hono";
import {
  breakerStates,
  closeBreaker,
  connectedState,
} from "@/chat/cache-warming/request";
import { logInfo } from "@/chat/logging";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  cacheWarmingBreakerListSchema,
  cacheWarmingBreakerParamsSchema,
  closeCacheWarmingBreakerResponseSchema,
} from "../schema/cache-warming";
import { validateRequest } from "../validation";
import { requireAdmin } from "../viewer";

/**
 * Create admin-only routes that show and close the cache warming breakers.
 *
 * A breaker stops warming for every Conversation, so only a Junior admin can
 * close one before it closes by itself.
 */
export function createCacheWarmingRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/breakers", requireAdmin, async () =>
    jsonResponse(cacheWarmingBreakerListSchema, {
      breakers: await breakerStates(await connectedState()),
    }),
  );

  app.delete(
    "/breakers/:provider",
    requireAdmin,
    validateRequest(
      "param",
      cacheWarmingBreakerParamsSchema,
      "Invalid provider.",
    ),
    async (context) => {
      const { provider } = context.req.valid("param");
      if (!(await closeBreaker(await connectedState(), provider))) {
        throwApiError(404, "Breaker not found.");
      }
      logInfo("dashboard.cache_warming.breaker_closed", {
        "app.cache_warming.provider": provider,
      });
      return jsonResponse(closeCacheWarmingBreakerResponseSchema, {
        closed: true,
      });
    },
  );

  return app;
}
