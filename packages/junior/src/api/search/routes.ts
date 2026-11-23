import { Hono } from "hono";
import { jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
import { searchQuerySchema, searchReportSchema } from "@/api/schema/search";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import { omniSearch } from "@/chat/omni-search/search";

/**
 * Create the search route that the command palette reads while a person
 * types: one request, one group for each named source.
 */
export function createSearchRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    requireViewer,
    validateRequest("query", searchQuerySchema, "Invalid search query."),
    async (context) => {
      const { q, sources } = context.req.valid("query");
      return jsonResponse(
        searchReportSchema,
        await omniSearch({ sources, text: q, viewer: context.get("viewer") }),
      );
    },
  );
  return app;
}
