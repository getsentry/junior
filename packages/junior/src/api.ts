import { Hono } from "hono";
import { createConversationRoutes } from "./api/conversations/routes";
import healthRoute from "./api/health";
import { jsonResponse } from "./api/http";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import pluginReportsRoute from "./api/plugin-reports";
import { createPersonalTokenRoutes } from "./api/personal-tokens/routes";
import { createUserPageRoutes } from "./api/user-pages/routes";
import { createTaskRoutes } from "./api/tasks/routes";
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
import statsRoute from "./api/stats";

export { authenticatePersonalToken } from "./personal-tokens/store";
export { resolveViewerUser } from "./chat/plugins/viewer";
export type { JuniorApiVariables };
export { jsonResponse };

const routes = [
  healthRoute,
  runtimeRoute,
  pluginsRoute,
  skillsRoute,
  pluginReportsRoute,
  statsRoute,
] satisfies readonly ApiRoute[];

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  registerApiRoutes(app, routes);

  app.route("/api/conversations", createConversationRoutes());
  app.route("/api/personal-tokens", createPersonalTokenRoutes());
  app.route("/api/people", createPeopleRoutes());
  app.route("/api/locations", createLocationRoutes());
  app.route("/api/user-pages", createUserPageRoutes());
  app.route("/api/tasks", createTaskRoutes());
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
