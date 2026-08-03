import type { PluginUserPageDefinition } from "@sentry/junior-plugin-api";
import { createViewerScheduledTasks } from "./personal";
import { createSchedulerSqlStore, type SchedulerDb } from "./store";
import type { ScheduledTask } from "./types";

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function formattedRun(task: ScheduledTask): string {
  const nextRunAtMs = task.runNowAtMs ?? task.nextRunAtMs;
  if (nextRunAtMs === undefined) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone: task.schedule.timezone,
      timeZoneName: "short",
      year: "numeric",
    }).format(new Date(nextRunAtMs));
  } catch {
    return new Date(nextRunAtMs).toISOString();
  }
}

/** Create the personal Scheduled tasks dashboard page. */
export function createSchedulerUserPage(): PluginUserPageDefinition {
  return {
    id: "scheduled-tasks",
    label: "Scheduled tasks",
    description: "Junior tasks you created across your linked workspaces.",
    async read(ctx, input) {
      const page = await createViewerScheduledTasks(
        createSchedulerSqlStore(ctx.db as SchedulerDb),
        ctx.viewer,
      ).list({
        cursor: input.cursor,
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
      });
      return {
        type: "list",
        emptyText: input.query
          ? "No scheduled tasks matched your search."
          : "You have not created any scheduled tasks.",
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        searchPlaceholder: "Search scheduled tasks",
        records: page.tasks.map((task) => {
          const description = bounded(task.schedule.description, 1_000);
          return {
            actions: [
              {
                confirmation: "Delete this scheduled task?",
                href: `/api/plugins/scheduler/tasks/${encodeURIComponent(task.id)}`,
                label: "Delete",
                method: "DELETE" as const,
                tone: "danger" as const,
              },
            ],
            ...(description ? { description } : {}),
            id: task.id,
            metadata: [
              { label: "Status", value: sentenceCase(task.status) },
              { label: "Next run", value: formattedRun(task) },
            ],
            title: bounded(task.task.text, 4_000) || "Untitled scheduled task",
          };
        }),
      };
    },
  };
}
