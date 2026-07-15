import { Hono } from "hono";
import type { ApiRoute } from "../route";
import detailRoute from "./detail";
import listRoute from "./list";

const routes: ApiRoute[] = [listRoute, detailRoute];

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono {
  const app = new Hono();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
