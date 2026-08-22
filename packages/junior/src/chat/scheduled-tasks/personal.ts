/** Viewer-scoped scheduled-task queries and mutations. */
import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { JuniorDatabase } from "@/db/db";
import { juniorSchedulerTasks } from "@/db/schema/scheduled-tasks";
import {
  isListedScheduledTask,
  parseScheduledTaskRow,
  readScheduledTask,
  saveScheduledTask,
} from "./tasks";
import type { ScheduledTask } from "./types";

const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: z.string().min(1),
    query: z.string().max(200).optional(),
    version: z.literal(1),
  })
  .strict();

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

/** Delete one scheduled task created by the viewer. */
export async function deleteViewerScheduledTask(
  db: JuniorDatabase,
  user: User,
  id: string,
  nowMs = Date.now(),
): Promise<void> {
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const task = await readScheduledTask(db, id);
  if (
    !task ||
    task.status === "deleted" ||
    !identityIds.has(task.creatorIdentityId)
  ) {
    throw new PersonalScheduledTaskNotFoundError();
  }
  await saveScheduledTask(db, {
    ...task,
    nextRunAtMs: undefined,
    runNowAtMs: undefined,
    status: "deleted",
    updatedAtMs: nowMs,
  });
}

/** List scheduled tasks created by the viewer with a stable SQL cursor. */
export async function listViewerScheduledTasks(
  db: JuniorDatabase,
  user: User,
  input: ViewerScheduledTaskPageInput,
): Promise<ViewerScheduledTaskPage> {
  const identityIds = user.identities.map((identity) => identity.id);
  if (identityIds.length === 0) return { tasks: [] };
  const query = normalizeQuery(input.query);
  const cursor = decodeCursor(input.cursor, query);
  const tasks: ScheduledTask[] = [];
  let before = cursor;
  const fetchLimit = input.limit + 1;
  while (tasks.length < fetchLimit) {
    const cursorFilter = before
      ? or(
          lt(juniorSchedulerTasks.createdAtMs, before.createdAtMs),
          and(
            eq(juniorSchedulerTasks.createdAtMs, before.createdAtMs),
            lt(juniorSchedulerTasks.id, before.id),
          ),
        )
      : undefined;
    const search = query
      ? or(
          sql<boolean>`strpos(lower(${juniorSchedulerTasks.title}), ${query}) > 0`,
          sql<boolean>`strpos(lower(${juniorSchedulerTasks.record}->'task'->>'text'), ${query}) > 0`,
          sql<boolean>`strpos(lower(${juniorSchedulerTasks.record}->'schedule'->>'description'), ${query}) > 0`,
          sql<boolean>`strpos(lower(${juniorSchedulerTasks.record}->'schedule'->>'timezone'), ${query}) > 0`,
          sql<boolean>`strpos(lower(${juniorSchedulerTasks.status}), ${query}) > 0`,
        )
      : undefined;
    const rows = await db
      .select({
        createdAtMs: juniorSchedulerTasks.createdAtMs,
        creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
        id: juniorSchedulerTasks.id,
        record: juniorSchedulerTasks.record,
        title: juniorSchedulerTasks.title,
      })
      .from(juniorSchedulerTasks)
      .where(
        and(
          notInArray(juniorSchedulerTasks.status, ["deleted", "paused"]),
          inArray(juniorSchedulerTasks.creatorIdentityId, identityIds),
          cursorFilter,
          search,
        ),
      )
      .orderBy(
        desc(juniorSchedulerTasks.createdAtMs),
        desc(juniorSchedulerTasks.id),
      )
      .limit(fetchLimit);
    tasks.push(
      ...rows.map(parseScheduledTaskRow).filter(isListedScheduledTask),
    );
    if (rows.length < fetchLimit) break;
    const last = rows.at(-1)!;
    before = { createdAtMs: last.createdAtMs, id: last.id };
  }
  const page = tasks.slice(0, input.limit);
  return {
    tasks: page,
    ...(tasks.length > input.limit && page.length > 0
      ? { nextCursor: encodeCursor(page.at(-1)!, query) }
      : {}),
  };
}
