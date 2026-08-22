import { Hono } from "hono";
import { z } from "zod";
import {
  pluginUserPageContentSchema,
  pluginUserPageInputSchema,
  pluginUserPageLinksSchema,
} from "@sentry/junior-plugin-api";
import {
  readPluginUserPage,
  readPluginUserPageLinks,
} from "@/chat/plugins/user-pages";
import type { JuniorApiEnv } from "../route";
import { apiErrorSchema } from "../schema/common";
import { jsonResponse } from "../http";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

const userPageQuerySchema = z.object({
  cursor: z.preprocess(
    (value) => value || undefined,
    pluginUserPageInputSchema.shape.cursor,
  ),
  filter: z.preprocess(
    (value) => value || undefined,
    pluginUserPageInputSchema.shape.filter,
  ),
  limit: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(50).default(20),
  ),
  q: z.preprocess(
    (value) => value || undefined,
    pluginUserPageInputSchema.shape.query,
  ),
});

/** Create authenticated discovery and read routes for plugin user pages. */
export function createUserPageRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", () =>
    jsonResponse(pluginUserPageLinksSchema, readPluginUserPageLinks()),
  );
  app.get(
    "/:pluginName/:pageId",
    requireViewer,
    validateRequest("query", userPageQuerySchema, "Invalid user page query."),
    async (context) => {
      const viewer = context.get("viewer");
      const { q, ...query } = context.req.valid("query");
      const page = await readPluginUserPage({
        email: viewer.email,
        pageId: context.req.param("pageId"),
        pluginName: context.req.param("pluginName"),
        query: { ...query, ...(q === undefined ? undefined : { query: q }) },
      });
      return page
        ? jsonResponse(pluginUserPageContentSchema, page)
        : jsonResponse(
            apiErrorSchema,
            { error: "User page not found." },
            { status: 404 },
          );
    },
  );

  return app;
}
