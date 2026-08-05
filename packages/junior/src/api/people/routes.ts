import { Hono } from "hono";
import { registerApiRoutes, type ApiRoute, type JuniorApiEnv } from "../route";
import listRoute from "./list";
import profileRoute from "./profile";
import { createPersonalSpendRoute } from "./spend";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  const routes: ApiRoute[] = [
    createPersonalSpendRoute(),
    listRoute,
    profileRoute,
  ];
  registerApiRoutes(app, routes);
  return app;
}
