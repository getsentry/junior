import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { SchedulerStore } from "./store";
import type { ScheduledTask } from "./types";

const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: z.string().min(1),
    query: z.string().max(200).optional(),
    version: z.literal(1),
  })
  .strict();

type PersonalScheduledTaskStore = Pick<
  SchedulerStore,
  "getTask" | "listTasksCreatedBy" | "saveTask"
>;

export interface ViewerScheduledTaskPage {
  nextCursor?: string;
  tasks: ScheduledTask[];
}

export interface ViewerScheduledTaskPageInput {
  cursor?: string;
  limit: number;
  query?: string;
}

export class InvalidScheduledTaskCursorError extends Error {
  constructor() {
    super("Scheduled task cursor is invalid.");
    this.name = "InvalidScheduledTaskCursorError";
  }
}

export class PersonalScheduledTaskNotFoundError extends Error {
  constructor() {
    super("Scheduled task was not found.");
    this.name = "PersonalScheduledTaskNotFoundError";
  }
}

function normalizeQuery(query: string | undefined): string | undefined {
  return query?.trim().toLowerCase() || undefined;
}

function decodeCursor(value: string | undefined, query: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.query !== query) {
      throw new InvalidScheduledTaskCursorError();
    }
    return { createdAtMs: parsed.createdAtMs, id: parsed.id };
  } catch {
    throw new InvalidScheduledTaskCursorError();
  }
}

function encodeCursor(
  task: Pick<ScheduledTask, "createdAtMs" | "id">,
  query: string | undefined,
): string {
  return Buffer.from(
    JSON.stringify({
      createdAtMs: task.createdAtMs,
      id: task.id,
      ...(query ? { query } : {}),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Build scheduled-task operations limited to tasks created by one user. */
export function createViewerScheduledTasks(
  store: PersonalScheduledTaskStore,
  user: User,
) {
  const identityIds = new Set(user.identities.map((identity) => identity.id));

  return {
    async delete(id: string, nowMs = Date.now()): Promise<void> {
      const task = await store.getTask(id);
      if (
        !task ||
        task.status === "deleted" ||
        !identityIds.has(task.creatorIdentityId)
      ) {
        throw new PersonalScheduledTaskNotFoundError();
      }
      await store.saveTask({
        ...task,
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
        status: "deleted",
        updatedAtMs: nowMs,
      });
    },

    async list(
      input: ViewerScheduledTaskPageInput,
    ): Promise<ViewerScheduledTaskPage> {
      const query = normalizeQuery(input.query);
      const cursor = decodeCursor(input.cursor, query);
      const matching = await store.listTasksCreatedBy({
        ...(cursor ? { before: cursor } : {}),
        identityIds: [...identityIds],
        limit: input.limit + 1,
        ...(query ? { query } : {}),
      });
      const tasks = matching.slice(0, input.limit);
      return {
        tasks,
        ...(matching.length > input.limit && tasks.length > 0
          ? { nextCursor: encodeCursor(tasks.at(-1)!, query) }
          : {}),
      };
    },
  };
}
