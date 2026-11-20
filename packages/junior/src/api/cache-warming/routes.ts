import { Hono } from "hono";
import { closeBreaker, connectedState } from "@/chat/cache-warming/request";
import { logInfo } from "@/chat/logging";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  cacheHealthQuerySchema,
  cacheHealthReportSchema,
  cacheWarmingBreakerListSchema,
  cacheWarmingBreakerParamsSchema,
  cacheWarmingSavingsQuerySchema,
  cacheWarmingSavingsRefillResponseSchema,
  cacheWarmingSavingsReportSchema,
  closeCacheWarmingBreakerResponseSchema,
} from "../schema/cache-warming";
import {
  readSavingsRefill,
  startSavingsRefill,
} from "@/chat/cache-warming/savings-refill";
import { readCacheHealth, warmedBreakerStates } from "./health";
import { readCacheWarmingSavings } from "./savings";
import { validateRequest } from "../validation";
import { requireAdmin } from "../viewer";

/**
 * Create the cache warming routes: its savings and cache health for the
 * System page, and admin-only routes that re-fill the savings from history and
 * show and close the breakers.
 *
 * A breaker stops warming for every Conversation, so only a Junior admin can
 * close one before it closes by itself. A re-fill replaces counters that
 * everyone sees, so only a Junior admin can start one.
 */
export function createCacheWarmingRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/savings",
    validateRequest(
      "query",
      cacheWarmingSavingsQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) =>
      jsonResponse(
        cacheWarmingSavingsReportSchema,
        await readCacheWarmingSavings(context.req.valid("query").days),
      ),
  );

  app.get(
    "/health",
    validateRequest(
      "query",
      cacheHealthQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) =>
      jsonResponse(
        cacheHealthReportSchema,
        await readCacheHealth(context.req.valid("query").window),
      ),
  );

  app.get("/savings/refill", requireAdmin, async () =>
    jsonResponse(cacheWarmingSavingsRefillResponseSchema, {
      refill: await readSavingsRefill(),
    }),
  );

  app.post("/savings/refill", requireAdmin, async () => {
    const { started, refill } = await startSavingsRefill();
    return jsonResponse(
      cacheWarmingSavingsRefillResponseSchema,
      { refill },
      { status: started ? 202 : 409 },
    );
  });

  app.get("/breakers", requireAdmin, async () =>
    jsonResponse(cacheWarmingBreakerListSchema, {
      breakers: await warmedBreakerStates(),
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
