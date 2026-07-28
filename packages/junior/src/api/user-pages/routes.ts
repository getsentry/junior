import { Hono } from "hono";
import {
  pluginUserPageContentSchema,
  pluginUserPageLinksSchema,
} from "@sentry/junior-plugin-api";
import {
  readPluginUserPage,
  readPluginUserPageLinks,
} from "@/chat/plugins/user-pages";
import type { JuniorApiEnv } from "../route";
import { apiErrorSchema } from "../schema/common";
import { jsonResponse } from "../http";

/** Create authenticated discovery and read routes for plugin user pages. */
export function createUserPageRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", () =>
    jsonResponse(pluginUserPageLinksSchema, readPluginUserPageLinks()),
  );
  app.get("/:pluginName/:pageId", async (context) => {
    const email = context.get("verifiedViewerEmail")?.trim();
    if (!email) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
    const page = await readPluginUserPage({
      email,
      pageId: context.req.param("pageId"),
      pluginName: context.req.param("pluginName"),
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
