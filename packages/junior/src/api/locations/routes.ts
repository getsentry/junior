import { Hono } from "hono";
import type { ApiRoute, JuniorApiEnv } from "../route";
import detailRoute from "./detail";
import listRoute from "./list";

const routes: ApiRoute[] = [listRoute, detailRoute];

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
