import { Hono } from "hono";
import { createConversationRoutes } from "./api/conversations/routes";
import { jsonResponse } from "./api/http";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import {
  defineApiRoute,
  registerApiRoutes,
  type ApiRoute,
  type JuniorApiEnv,
  type JuniorApiVariables,
} from "./api/route";
import { apiErrorSchema } from "./api/schema/common";
import {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginReportsSchema,
  readHealthReport,
  readPluginOperationalReportFeed,
  readPluginReports,
  readRuntimeInfoReport,
  readSkillReports,
  runtimeInfoReportSchema,
  skillReportsSchema,
} from "./reporting";

export type { JuniorApiVariables };
export { jsonResponse };

const routes = [
  defineApiRoute({
    method: "get",
    path: "/api/health",
    responseSchema: healthReportSchema,
    handler: readHealthReport,
  }),
  defineApiRoute({
    method: "get",
    path: "/api/runtime",
    responseSchema: runtimeInfoReportSchema,
    handler: readRuntimeInfoReport,
  }),
  defineApiRoute({
    method: "get",
    path: "/api/plugins",
    responseSchema: pluginReportsSchema,
    handler: readPluginReports,
  }),
  defineApiRoute({
    method: "get",
    path: "/api/skills",
    responseSchema: skillReportsSchema,
    handler: readSkillReports,
  }),
  defineApiRoute({
    method: "get",
    path: "/api/plugin-reports",
    responseSchema: pluginOperationalReportFeedSchema,
    handler: readPluginOperationalReportFeed,
  }),
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
