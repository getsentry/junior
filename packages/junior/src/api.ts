import { Hono } from "hono";
import { createConversationRoutes } from "./api/conversations/routes";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import type { JuniorApiEnv, JuniorApiVariables } from "./api/route";
import {
  readHealthReport,
  readPluginOperationalReportFeed,
  readPluginReports,
  readRuntimeInfoReport,
  readSkillReports,
} from "./reporting";

export type { JuniorApiVariables };

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/api/health", async () => {
    return Response.json(await readHealthReport());
  });
  app.get("/api/runtime", async () => {
    return Response.json(await readRuntimeInfoReport());
  });
  app.get("/api/plugins", async () => {
    return Response.json(await readPluginReports());
  });
  app.get("/api/skills", async () => {
    return Response.json(await readSkillReports());
  });
  app.get("/api/plugin-reports", async () => {
    return Response.json(await readPluginOperationalReportFeed());
  });

  app.route("/api/conversations", createConversationRoutes());
  app.route("/api/people", createPeopleRoutes());
  app.route("/api/locations", createLocationRoutes());

  return app;
}
