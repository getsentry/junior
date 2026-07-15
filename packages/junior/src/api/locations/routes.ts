import { Hono } from "hono";
import type { ApiRoute } from "../route";
import { locationDetailRoute } from "./detail";
import { locationListRoute } from "./list";

const routes: ApiRoute[] = [locationListRoute, locationDetailRoute];

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono {
  const app = new Hono();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
