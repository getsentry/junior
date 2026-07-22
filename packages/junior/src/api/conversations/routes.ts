import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiRoute } from "../route";
import archiveRoute from "./archive";
import { createConversationDetailRoute } from "./detail";
import listRoute from "./list";
import statsRoute from "./stats";

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(
  options: {
    getVerifiedViewerEmail?: (context: Context) => string | undefined;
  } = {},
): Hono {
  const app = new Hono();
  const routes: ApiRoute[] = [
    listRoute,
    statsRoute,
    archiveRoute,
    createConversationDetailRoute(options),
  ];
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
