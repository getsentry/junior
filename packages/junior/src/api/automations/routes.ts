import { Hono } from "hono";
import { emptyResponse, jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/common";
import {
  automationExecutionListSchema,
  automationListQuerySchema,
  automationListSchema,
  automationParamsSchema,
  automationRunListSchema,
} from "@/api/schema/automation";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import {
  deleteViewerTask,
  readViewerAutomationExecutions,
  readViewerAutomationRuns,
  readViewerAutomations,
  ViewerTaskNotFoundError,
} from "@/chat/automations/read";

/** Create authenticated native task list and action routes. */
export function createAutomationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/",
    requireViewer,
    validateRequest(
      "query",
      automationListQuerySchema,
      "Invalid task list query.",
    ),
    async (context) => {
      const user = context.get("viewer");
      const query = context.req.valid("query");
      return jsonResponse(
        automationListSchema,
        await readViewerAutomations(user, query),
      );
    },
  );
  app.get("/runs", requireViewer, async (context) => {
    const user = context.get("viewer");
    return jsonResponse(
      automationRunListSchema,
      await readViewerAutomationRuns(user),
    );
  });
  app.get(
    "/:kind/:id/executions",
    requireViewer,
    validateRequest("param", automationParamsSchema, "Invalid task."),
    async (context) => {
      const user = context.get("viewer");
      const params = context.req.valid("param");
      try {
        return jsonResponse(
          automationExecutionListSchema,
          await readViewerAutomationExecutions(user, params.kind, params.id),
        );
      } catch (error) {
        if (error instanceof ViewerTaskNotFoundError) {
          return jsonResponse(
            apiErrorSchema,
            { error: error.message },
            { status: 404 },
          );
        }
        throw error;
      }
    },
  );
  app.delete(
    "/:kind/:id",
    requireViewer,
    validateRequest("param", automationParamsSchema, "Invalid task."),
    async (context) => {
      const user = context.get("viewer");
      const params = context.req.valid("param");
      try {
        await deleteViewerTask(user, params.kind, params.id);
        return emptyResponse();
      } catch (error) {
        if (error instanceof ViewerTaskNotFoundError) {
          return jsonResponse(
            apiErrorSchema,
            { error: error.message },
            { status: 404 },
          );
        }
        throw error;
      }
    },
  );
  return app;
}
