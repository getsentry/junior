import { Hono } from "hono";
import type { ApiRoute } from "../route";
import listRoute from "./list";
import profileRoute from "./profile";

const routes: ApiRoute[] = [listRoute, profileRoute];

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono {
  const app = new Hono();
  for (const route of routes) app.on(route.method, route.path, route.handler);
  return app;
}
