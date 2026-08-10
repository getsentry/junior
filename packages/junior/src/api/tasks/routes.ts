import { Hono } from "hono";
import { jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
import { apiErrorSchema } from "@/api/schema/common";
import {
  taskExecutionListSchema,
  taskListSchema,
  taskParamsSchema,
  taskRunListSchema,
} from "@/api/schema/task";
import { validateRequest } from "@/api/validation";
import { requireViewer } from "@/api/viewer";
import {
  deleteViewerTask,
  readViewerTaskExecutions,
  readViewerTaskRuns,
  readViewerTasks,
  ViewerTaskNotFoundError,
} from "@/chat/tasks/read";

/** Create authenticated native task list and action routes. */
export function createTaskRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", requireViewer, async (context) => {
    const user = context.get("viewer");
    return jsonResponse(taskListSchema, await readViewerTasks(user));
  });
  app.get("/runs", requireViewer, async (context) => {
    const user = context.get("viewer");
    return jsonResponse(taskRunListSchema, await readViewerTaskRuns(user));
  });
  app.get(
    "/:kind/:id/executions",
    requireViewer,
    validateRequest("param", taskParamsSchema, "Invalid task."),
    async (context) => {
      const user = context.get("viewer");
      const params = context.req.valid("param");
      try {
        return jsonResponse(
          taskExecutionListSchema,
          await readViewerTaskExecutions(user, params.kind, params.id),
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
    validateRequest("param", taskParamsSchema, "Invalid task."),
    async (context) => {
      const user = context.get("viewer");
      const params = context.req.valid("param");
      try {
        await deleteViewerTask(user, params.kind, params.id);
        return new Response(null, {
          headers: { "cache-control": "no-store" },
          status: 204,
        });
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
