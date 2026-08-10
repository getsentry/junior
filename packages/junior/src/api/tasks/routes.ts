import { Hono } from "hono";
import { apiErrorSchema } from "@/api/schema/common";
import {
  taskExecutionListSchema,
  taskListSchema,
  taskParamsSchema,
  taskRunListSchema,
} from "@/api/schema/task";
import { jsonResponse } from "@/api/http";
import type { JuniorApiEnv } from "@/api/route";
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
  app.get("/:kind/:id/executions", requireViewer, async (context) => {
    const user = context.get("viewer");
    const params = taskParamsSchema.safeParse(context.req.param());
    if (!params.success) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid task." },
        { status: 400 },
      );
    }
    try {
      return jsonResponse(
        taskExecutionListSchema,
        await readViewerTaskExecutions(user, params.data.kind, params.data.id),
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
  });
  app.delete("/:kind/:id", requireViewer, async (context) => {
    const user = context.get("viewer");
    const params = taskParamsSchema.safeParse(context.req.param());
    if (!params.success) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid task." },
        { status: 400 },
      );
    }
    try {
      await deleteViewerTask(user, params.data.kind, params.data.id);
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
  });
  return app;
}
