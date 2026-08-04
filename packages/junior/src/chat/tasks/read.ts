import type { User } from "@sentry/junior-plugin-api";
import type { TaskList, TaskSummary } from "@/api/schema/task";
import { getDb } from "@/chat/db";
import {
  deleteEventTask,
  eventTaskBelongsToUser,
  getEventTask,
  listEventTasksCreatedBy,
} from "@/chat/event-tasks/store";
import { eventTaskTriggerAvailable } from "@/chat/event-tasks/tool-support";
import { getResourceEventCatalog } from "@/chat/resource-events/runtime-catalog";
import {
  createViewerScheduledTasks,
  PersonalScheduledTaskNotFoundError,
} from "@/chat/scheduled-tasks/personal";
import { createSchedulerSqlStore } from "@/chat/scheduled-tasks/store";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";

const TASK_LIST_LIMIT = 100;

function scheduledTaskSummary(task: ScheduledTask): TaskSummary {
  if (task.status === "deleted") {
    throw new Error("Deleted scheduled tasks cannot enter the Tasks view");
  }
  const nextRunAtMs = task.runNowAtMs ?? task.nextRunAtMs;
  return {
    createdAt: new Date(task.createdAtMs).toISOString(),
    destination: {
      channelId: task.destination.channelId,
      teamId: task.destination.teamId,
    },
    id: task.id,
    instruction: task.task.text,
    kind: "scheduled",
    ...(nextRunAtMs !== undefined
      ? { nextRunAt: new Date(nextRunAtMs).toISOString() }
      : {}),
    schedule: task.schedule.description,
    status: task.status,
  };
}

/** Read one bounded, newest-first Tasks projection for a signed-in user. */
export async function readViewerTasks(user: User): Promise<TaskList> {
  const db = getDb();
  const [scheduledPage, eventTasks] = await Promise.all([
    createViewerScheduledTasks(createSchedulerSqlStore(db), user).list({
      limit: TASK_LIST_LIMIT + 1,
    }),
    listEventTasksCreatedBy(db, user, TASK_LIST_LIMIT + 1),
  ]);
  const eventCatalog = getResourceEventCatalog();
  const tasks: TaskSummary[] = [
    ...scheduledPage.tasks.map(scheduledTaskSummary),
    ...eventTasks.map(
      (task): TaskSummary => ({
        createdAt: new Date(task.createdAtMs).toISOString(),
        destination: {
          channelId: task.destination.channelId,
          teamId: task.destination.teamId,
        },
        events: task.trigger.events,
        id: task.id,
        instruction: task.task.text,
        kind: "event",
        resource: `${task.trigger.label} · ${task.trigger.identifier}`,
        triggerAvailable: eventTaskTriggerAvailable(task, eventCatalog),
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    tasks: tasks.slice(0, TASK_LIST_LIMIT),
    truncated:
      Boolean(scheduledPage.nextCursor) ||
      eventTasks.length > TASK_LIST_LIMIT ||
      tasks.length > TASK_LIST_LIMIT,
  };
}

export class ViewerTaskNotFoundError extends Error {
  constructor() {
    super("Task was not found.");
    this.name = "ViewerTaskNotFoundError";
  }
}

/** Delete one viewer-owned scheduled or event task. */
export async function deleteViewerTask(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<void> {
  if (kind === "scheduled") {
    try {
      await createViewerScheduledTasks(
        createSchedulerSqlStore(getDb()),
        user,
      ).delete(id);
      return;
    } catch (error) {
      if (error instanceof PersonalScheduledTaskNotFoundError) {
        throw new ViewerTaskNotFoundError();
      }
      throw error;
    }
  }
  const task = await getEventTask(getDb(), id);
  if (!task || !eventTaskBelongsToUser(task, user)) {
    throw new ViewerTaskNotFoundError();
  }
  await deleteEventTask(getDb(), id);
}
