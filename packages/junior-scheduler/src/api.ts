import {
  pluginApiRouteRequestContextSchema,
  type PluginApiRouteRequestContext,
  type PluginRouteApp,
  type PluginUserPageActor,
} from "@sentry/junior-plugin-api";
import {
  createViewerScheduledTasks,
  PersonalScheduledTaskNotFoundError,
} from "./personal";
import { createSchedulerSqlStore, type SchedulerDb } from "./store";

interface SchedulerApiOptions {
  actors(email: string): Promise<PluginUserPageActor[]>;
  db: SchedulerDb;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function viewerEmail(
  context: PluginApiRouteRequestContext | undefined,
): string | undefined {
  const parsed = pluginApiRouteRequestContextSchema.safeParse(context);
  if (!parsed.success || parsed.data.auth.user.emailVerified !== true) {
    return undefined;
  }
  return parsed.data.auth.user.email?.trim().toLowerCase() || undefined;
}

/** Create authenticated API routes for personal scheduled-task actions. */
export function createSchedulerApi(
  options: SchedulerApiOptions,
): PluginRouteApp {
  return {
    async fetch(request, context) {
      const email = viewerEmail(context);
      if (!email) {
        return json({ error: "Authentication required." }, 401);
      }

      const taskPath = /^\/tasks\/([^/]+)$/.exec(new URL(request.url).pathname);
      if (!taskPath) {
        return json({ error: "Not found." }, 404);
      }
      if (request.method !== "DELETE") {
        return json({ error: "Method not allowed." }, 405);
      }

      const actors = await options.actors(email);
      try {
        await createViewerScheduledTasks(
          createSchedulerSqlStore(options.db),
          actors,
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
