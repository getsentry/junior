import { Hono } from "hono";
import type { ApiRoute } from "../route";
import archiveRoute from "./archive";
import detailRoute from "./detail";
import listRoute from "./list";
import statsRoute from "./stats";
import subagentRoute from "./subagent";

const routes: ApiRoute[] = [
  listRoute,
  statsRoute,
  archiveRoute,
  detailRoute,
  subagentRoute,
];

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(): Hono {
  const app = new Hono();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
