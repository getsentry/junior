import { Hono } from "hono";
import { createConversationRoutes } from "./api/conversations/routes";
import healthRoute from "./api/health";
import { jsonResponse } from "./api/http";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import pluginReportsRoute from "./api/plugin-reports";
import pluginsRoute from "./api/plugins";
import {
  registerApiRoutes,
  type ApiRoute,
  type JuniorApiEnv,
  type JuniorApiVariables,
} from "./api/route";
import runtimeRoute from "./api/runtime";
import { apiErrorSchema } from "./api/schema/common";
import skillsRoute from "./api/skills";

export type { JuniorApiVariables };
export { jsonResponse };

const routes = [
  healthRoute,
  runtimeRoute,
  pluginsRoute,
  skillsRoute,
  pluginReportsRoute,
] satisfies readonly ApiRoute[];

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  registerApiRoutes(app, routes);

  app.route("/api/conversations", createConversationRoutes());
  app.route("/api/people", createPeopleRoutes());
  app.route("/api/locations", createLocationRoutes());
  app.notFound(() =>
    jsonResponse(
      apiErrorSchema,
      { error: "Resource not found." },
      {
        status: 404,
      },
    ),
  );

  return app;
}
