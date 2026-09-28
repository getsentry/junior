import { AutomationConflictError } from "@/chat/automations/revision";
import { zValidator } from "@hono/zod-validator";
import {
  readViewerAutomationEdit,
  updateViewerAutomation,
} from "@/chat/automations/edit";
import { AutomationEditError } from "@/chat/automations/edit-rules";
import { Hono } from "hono";
import { emptyResponse, jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/common";
import {
  automationEditSchema,
  automationEditErrorSchema,
  automationUpdateSchema,
  automationExecutionListSchema,
  automationListQuerySchema,
  automationListSchema,
  automationParamsSchema,
  automationRunListSchema,
  automationSummarySchema,
} from "@/api/schema/automation";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import {
  deleteViewerTask,
  readViewerAutomationExecutions,
  readViewerAutomationRuns,
  readViewerAutomations,
  readViewerAutomationSummary,
  ViewerTaskNotFoundError,
} from "@/chat/automations/read";

/** Translate expected edit failures; unexpected failures stay at the API boundary. */
function editErrorResponse(error: unknown): Response {
  if (error instanceof ViewerTaskNotFoundError) {
    return jsonResponse(
      automationEditErrorSchema,
      { error: "Automation was not found.", code: "not_found" },
      { status: 404 },
    );
  }
  if (error instanceof AutomationConflictError) {
    return jsonResponse(
      automationEditErrorSchema,
      { error: error.message, code: "conflict" },
      { status: 409 },
    );
  }
  if (error instanceof AutomationEditError) {
    return jsonResponse(
      automationEditErrorSchema,
      {
        error: error.message,
        code: "invalid_edit",
        ...(error.field
          ? { fields: { [error.field]: [error.message] } }
          : undefined),
      },
      { status: 400 },
    );
  }
  throw error;
}

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
  app.get(
    "/:kind/:id/edit",
    requireViewer,
    validateRequest("param", automationParamsSchema, "Invalid Automation."),
    async (context) => {
      const { kind, id } = context.req.valid("param");
      try {
        return jsonResponse(
          automationEditSchema,
          await readViewerAutomationEdit(context.get("viewer"), kind, id),
        );
      } catch (error) {
        return editErrorResponse(error);
      }
    },
  );
  app.patch(
    "/:kind/:id",
    requireViewer,
    validateRequest("param", automationParamsSchema, "Invalid Automation."),
    zValidator("json", automationUpdateSchema, (result) => {
      if (!result.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of result.error.issues) {
          const field = issue.path.join(".") || "save";
          (fields[field] ??= []).push(issue.message);
        }
        return jsonResponse(
          automationEditErrorSchema,
          { error: "Invalid Automation edit.", code: "invalid_edit", fields },
          { status: 400 },
        );
      }
    }),
    async (context) => {
      const { kind, id } = context.req.valid("param");
      const input = context.req.valid("json");
      try {
        if (input.kind !== kind)
          throw new AutomationEditError(
            "The trigger type cannot change.",
            "kind",
          );
        return jsonResponse(
          automationEditSchema,
          await updateViewerAutomation(context.get("viewer"), id, input),
        );
      } catch (error) {
        return editErrorResponse(error);
      }
    },
  );
  app.get("/:id", requireViewer, async (context) => {
    const automation = await readViewerAutomationSummary(
      context.get("viewer"),
      context.req.param("id"),
    );
    return automation
      ? jsonResponse(automationSummarySchema, automation)
      : jsonResponse(
          apiErrorSchema,
          { error: "Automation was not found." },
          { status: 404 },
        );
  });
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
