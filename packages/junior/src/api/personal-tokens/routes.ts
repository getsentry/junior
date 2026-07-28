import { Hono } from "hono";
import { registerApiRoutes, type ApiRoute, type JuniorApiEnv } from "../route";
import createRoute from "./create";
import listRoute from "./list";
import revokeRoute from "./revoke";

const routes: ApiRoute[] = [listRoute, createRoute, revokeRoute];

/** Create the HTTP routes owned by the personal tokens API. */
export function createPersonalTokenRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  registerApiRoutes(app, routes);
  return app;
}
