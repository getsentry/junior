import { Hono } from "hono";
import { registerApiRoutes, type ApiRoute, type JuniorApiEnv } from "../route";
import archiveRoute from "./archive";
import detailRoute from "./detail";
import eventListRoute from "./event-list";
import listRoute from "./list";
import statsRoute from "./stats";
import updatesRoute from "./updates";

const routes: ApiRoute[] = [
  listRoute,
  statsRoute,
  archiveRoute,
  eventListRoute,
  updatesRoute,
  detailRoute,
];

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  registerApiRoutes(app, routes);
  return app;
}
