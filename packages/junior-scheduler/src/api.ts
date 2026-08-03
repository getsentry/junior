import {
  pluginApiRouteRequestContextSchema,
  type PluginRouteApp,
} from "@sentry/junior-plugin-api";
import {
  createViewerScheduledTasks,
  PersonalScheduledTaskNotFoundError,
} from "./personal";
import { createSchedulerSqlStore, type SchedulerDb } from "./store";

interface SchedulerApiOptions {
  db: SchedulerDb;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

/** Create authenticated API routes for personal scheduled-task actions. */
export function createSchedulerApi(
  options: SchedulerApiOptions,
): PluginRouteApp {
  return {
    async fetch(request, context) {
      const parsed = pluginApiRouteRequestContextSchema.safeParse(context);
      if (!parsed.success || !parsed.data.viewer) {
        return json({ error: "Authentication required." }, 401);
      }

      const taskPath = /^\/tasks\/([^/]+)$/.exec(new URL(request.url).pathname);
      if (!taskPath) {
        return json({ error: "Not found." }, 404);
      }
      if (request.method !== "DELETE") {
        return json({ error: "Method not allowed." }, 405);
      }

      try {
        await createViewerScheduledTasks(
          createSchedulerSqlStore(options.db),
          parsed.data.viewer,
        ).delete(decodeURIComponent(taskPath[1]!));
        return new Response(null, {
          headers: { "cache-control": "no-store" },
          status: 204,
        });
      } catch (error) {
        if (error instanceof PersonalScheduledTaskNotFoundError) {
          return json({ error: error.message }, 404);
        }
        throw error;
      }
    },
  };
}
