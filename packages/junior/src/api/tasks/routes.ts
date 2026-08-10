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
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  deleteViewerTask,
  readViewerTaskExecutions,
  readViewerTaskRuns,
  readViewerTasks,
  ViewerTaskNotFoundError,
} from "@/chat/tasks/read";

async function viewer(context: {
  get(key: "verifiedViewerEmail"): string | undefined;
}) {
  const email = context.get("verifiedViewerEmail")?.trim();
  return email ? await resolveViewerUser(email) : undefined;
}

/** Create authenticated native task list and action routes. */
export function createTaskRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get("/", async (context) => {
    const user = await viewer(context);
    return user
      ? jsonResponse(taskListSchema, await readViewerTasks(user))
      : jsonResponse(
          apiErrorSchema,
          { error: "Authentication required." },
          { status: 401 },
        );
  });
  app.get("/runs", async (context) => {
    const user = await viewer(context);
    return user
      ? jsonResponse(taskRunListSchema, await readViewerTaskRuns(user))
      : jsonResponse(
          apiErrorSchema,
          { error: "Authentication required." },
          { status: 401 },
        );
  });
  app.get("/:kind/:id/executions", async (context) => {
    const user = await viewer(context);
    if (!user) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
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
  app.delete("/:kind/:id", async (context) => {
    const user = await viewer(context);
    if (!user) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
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
