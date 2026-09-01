import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createVercelAttachmentStorage } from "./chat/attachments/vercel";
import { createConversationRoutes } from "./api/conversations/routes";
import { createCodeRoutes } from "./api/code/routes";
import { jsonResponse } from "./api/http";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import { createPersonalTokenRoutes } from "./api/personal-tokens/routes";
import { createUserPageRoutes } from "./api/user-pages/routes";
import { createTaskRoutes } from "./api/tasks/routes";
import { createWorkspaceRoutes } from "./api/workspaces/routes";
import type { JuniorApiEnv, JuniorApiVariables } from "./api/route";
import { apiErrorSchema } from "./api/schema/common";
import {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  runtimeInfoReportSchema,
  skillReportsSchema,
  statsReportSchema,
} from "./api/schema";
import { readStatsReport } from "./api/stats";
import { logException } from "./chat/logging";
import {
  readHealthReport,
  readPluginOperationalReportFeed,
  readPlugins,
  readRuntimeInfoReport,
  readSkillReports,
} from "./reporting";

export { authenticatePersonalToken } from "./personal-tokens/store";
export {
  resolveViewerUser,
  updateViewerDisplayName,
} from "./chat/plugins/viewer";
export type { JuniorApiVariables };
export { jsonResponse };

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/api/health", async () =>
    jsonResponse(healthReportSchema, readHealthReport()),
  );
  app.get("/api/runtime", async () =>
    jsonResponse(runtimeInfoReportSchema, await readRuntimeInfoReport()),
  );
  app.get("/api/plugins", async () =>
    jsonResponse(pluginsSchema, await readPlugins()),
  );
  app.get("/api/skills", async () =>
    jsonResponse(skillReportsSchema, await readSkillReports()),
  );
  app.get("/api/plugin-reports", async () =>
    jsonResponse(
      pluginOperationalReportFeedSchema,
      await readPluginOperationalReportFeed(),
    ),
  );
  app.get("/api/stats", async () =>
    jsonResponse(statsReportSchema, await readStatsReport()),
  );

  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: createVercelAttachmentStorage(),
    }),
  );
  app.route("/api/code", createCodeRoutes());
  app.route("/api/personal-tokens", createPersonalTokenRoutes());
  app.route("/api/people", createPeopleRoutes());
  app.route("/api/locations", createLocationRoutes());
  app.route("/api/user-pages", createUserPageRoutes());
  app.route("/api/tasks", createTaskRoutes());
  app.route("/api/workspaces", createWorkspaceRoutes());
  app.notFound(() =>
    jsonResponse(
      apiErrorSchema,
      { error: "Resource not found." },
      {
        status: 404,
      },
    ),
  );
  app.onError((error, _context) => {
    if (error instanceof HTTPException) {
      if (error.res) return error.res;
      return jsonResponse(
        apiErrorSchema,
        { error: error.message || "Request failed." },
        { status: error.status },
      );
    }
    logException(error, "api.unhandled.exception");
    return jsonResponse(
      apiErrorSchema,
      { error: "Internal Server Error" },
      { status: 500 },
    );
  });

  return app;
}
