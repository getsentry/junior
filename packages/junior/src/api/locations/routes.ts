import { Hono } from "hono";
import { registerApiRoutes, type ApiRoute, type JuniorApiEnv } from "../route";
import detailRoute from "./detail";
import listRoute from "./list";

const routes: ApiRoute[] = [listRoute, detailRoute];

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  registerApiRoutes(app, routes);
  return app;
}
