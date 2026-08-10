import { Hono } from "hono";
import { registerApiRoutes, type ApiRoute, type JuniorApiEnv } from "../route";
import archiveRoute from "./archive";
import {
  createConversationMessageRoute,
  createConversationRoute,
} from "./create";
import detailRoute from "./detail";
import eventListRoute from "./event-list";
import listRoute from "./list";
import statsRoute from "./stats";

const routes: ApiRoute[] = [
  listRoute,
  statsRoute,
  createConversationRoute,
  createConversationMessageRoute,
  archiveRoute,
  eventListRoute,
  detailRoute,
];

/** Create the HTTP routes owned by the conversations API. */
export function createConversationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  registerApiRoutes(app, routes);
  return app;
}
