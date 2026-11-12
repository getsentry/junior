import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getAttachmentStorage } from "./chat/attachments/storage";
import { createConversationRoutes } from "./api/conversations/routes";
import { createCodeRoutes } from "./api/code/routes";
import { createConnectionRoutes } from "./api/connections/routes";
import { createNotificationRoutes } from "./api/notifications/routes";
import { createObjectRoutes } from "./api/objects/routes";
import { jsonResponse, throwApiError } from "./api/http";
import { createLocationRoutes } from "./api/locations/routes";
import { createPeopleRoutes } from "./api/people/routes";
import { createPersonalTokenRoutes } from "./api/personal-tokens/routes";
import { createServiceAccountRoutes } from "./api/service-accounts/routes";
import { createUserPageRoutes } from "./api/user-pages/routes";
import { createAutomationRoutes } from "./api/automations/routes";
import { createUserCustomizationRoutes } from "./api/user-customization/routes";
import { createReviewItemRoutes } from "./api/review-items/routes";
import { createWorkspaceRoutes } from "./api/workspaces/routes";
import type { JuniorApiEnv, JuniorApiVariables } from "./api/route";
import { apiErrorSchema } from "./api/schema/common";
import {
  healthReportSchema,
  pluginOperationalReportFeedSchema,
  pluginsSchema,
  runtimeInfoReportSchema,
  skillDetailReportSchema,
  skillReportsSchema,
  statsReportSchema,
} from "./api/schema";
import { readReplyTimeSegments } from "./api/reply-times";
import { replyTimeSegmentsReportSchema } from "./api/schema/reply-times";
import { readStatsReport } from "./api/stats";
import { validateRequest } from "./api/validation";
import { readVersions } from "./api/versions";
import { requireViewer } from "./api/viewer";
import { versionsQuerySchema, versionsSchema } from "./api/schema/versions";
import { getProductionSlackAdapter } from "./chat/app/production";
import { logException } from "./chat/logging";
import { createSlackReviewItemShow } from "./chat/slack/review-item-card-sync";
import type { ConversationWorkQueue } from "./chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "./chat/task-execution/vercel-queue";
import {
  readHealthReport,
  readPluginOperationalReportFeed,
  readPlugins,
  readRuntimeInfoReport,
  readSkillDetailReport,
  readSkillReports,
} from "./reporting";

export { authenticatePersonalToken } from "./personal-tokens/store";
export { isAllowedSignInEmail } from "./chat/sign-in/allowlist";
export {
  DEFAULT_AUTO_ARCHIVE_SETTINGS,
  readUserAutoArchiveSettings,
  updateUserAutoArchiveSettings,
  type AutoArchiveSettings,
} from "./api/conversations/auto-archive";
export {
  readViewerAvatarUrl,
  resolveViewerUser,
  updateViewerDisplayName,
} from "./chat/plugins/viewer";
export type { ConversationWorkQueue, JuniorApiVariables };
export { jsonResponse };

/** Options that `createApp()` passes through the dashboard. */
export interface JuniorApiOptions {
  /** Queue for accepted web input. Defaults to Vercel Queues. */
  conversationWorkQueue?: ConversationWorkQueue;
}

/** Create Junior's production REST API for authenticated dashboard consumers. */
export function createJuniorApi(
  options: JuniorApiOptions = {},
): Hono<JuniorApiEnv> {
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
  app.get("/api/skills/:name", async (context) => {
    const skill = await readSkillDetailReport(context.req.param("name"));
    if (!skill) throwApiError(404, "Skill not found.");
    return jsonResponse(skillDetailReportSchema, skill);
  });
  app.get("/api/plugin-reports", async () =>
    jsonResponse(
      pluginOperationalReportFeedSchema,
      await readPluginOperationalReportFeed(),
    ),
  );
  app.get("/api/stats", async () =>
    jsonResponse(statsReportSchema, await readStatsReport()),
  );
  app.get("/api/reply-times", async () =>
    jsonResponse(replyTimeSegmentsReportSchema, await readReplyTimeSegments()),
  );
  app.get(
    "/api/versions",
    requireViewer,
    validateRequest("query", versionsQuerySchema, "Invalid query parameters."),
    async (context) =>
      jsonResponse(
        versionsSchema,
        await readVersions(context.get("viewer"), context.req.valid("query")),
        { headers: { "cache-control": "private, no-store" } },
      ),
  );

  const queue =
    options.conversationWorkQueue ?? getVercelConversationWorkQueue();
  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: getAttachmentStorage(),
      queue,
    }),
  );
  app.route(
    "/api/review-items",
    createReviewItemRoutes({
      delivery: {
        queue,
        show: createSlackReviewItemShow(getProductionSlackAdapter),
      },
    }),
  );
  app.route("/api/code", createCodeRoutes());
  app.route("/api/connections", createConnectionRoutes());
  app.route("/api/notifications", createNotificationRoutes());
  app.route("/api/personal-tokens", createPersonalTokenRoutes());
  app.route("/api/service-accounts", createServiceAccountRoutes());
  app.route("/api/objects", createObjectRoutes());
  app.route("/api/people", createPeopleRoutes());
  app.route("/api/locations", createLocationRoutes());
  app.route("/api/user-pages", createUserPageRoutes());
  app.route("/api/user-customization", createUserCustomizationRoutes());
  app.route("/api/automations", createAutomationRoutes());
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
