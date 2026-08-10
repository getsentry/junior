import { Hono } from "hono";
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
import { requireViewer } from "../viewer";

/** Create authenticated discovery and read routes for plugin user pages. */
export function createUserPageRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", () =>
    jsonResponse(pluginUserPageLinksSchema, readPluginUserPageLinks()),
  );
  app.get("/:pluginName/:pageId", async (context) => {
    const viewer = requireViewer(context);
    const pageInput = pluginUserPageInputSchema.safeParse({
      cursor: context.req.query("cursor") || undefined,
      filter: context.req.query("filter") || undefined,
      limit: context.req.query("limit")
        ? Number(context.req.query("limit"))
        : 20,
      query: context.req.query("q") || undefined,
    });
    if (!pageInput.success) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid user page query." },
        { status: 400 },
      );
    }
    const page = await readPluginUserPage({
      email: viewer.email,
      pageId: context.req.param("pageId"),
      pluginName: context.req.param("pluginName"),
      query: pageInput.data,
    });
    return page
      ? jsonResponse(pluginUserPageContentSchema, page)
      : jsonResponse(
          apiErrorSchema,
          { error: "User page not found." },
          { status: 404 },
        );
  });

  return app;
}
