/** Viewer-scoped scheduled-automation queries and mutations. */
import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { JuniorDatabase } from "@/db/db";
import { juniorSchedulerTasks } from "@/db/schema/scheduled-automations";
import {
  isListedScheduledAutomation,
  parseScheduledAutomationRow,
  readScheduledAutomation,
  saveScheduledAutomation,
} from "./tasks";
import type { ScheduledAutomation } from "./types";

const cursorSchema = z
  .object({
    createdAtMs: z.number().finite(),
    id: z.string().min(1),
    query: z.string().max(200).optional(),
    version: z.literal(1),
  })
  .strict();

export interface ViewerScheduledAutomationPage {
  nextCursor?: string;
  automations: ScheduledAutomation[];
}

export interface ViewerScheduledAutomationPageInput {
  cursor?: string;
  limit: number;
  query?: string;
}

export class InvalidScheduledAutomationCursorError extends Error {
  constructor() {
    super("Scheduled automation cursor is invalid.");
    this.name = "InvalidScheduledAutomationCursorError";
  }
}

export class PersonalScheduledAutomationNotFoundError extends Error {
  constructor() {
    super("Scheduled automation was not found.");
    this.name = "PersonalScheduledAutomationNotFoundError";
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
      throw new InvalidScheduledAutomationCursorError();
    }
    return { createdAtMs: parsed.createdAtMs, id: parsed.id };
  } catch {
    throw new InvalidScheduledAutomationCursorError();
  }
}

function encodeCursor(
  task: Pick<ScheduledAutomation, "createdAtMs" | "id">,
  query: string | undefined,
): string {
  return Buffer.from(
    JSON.stringify({
      createdAtMs: task.createdAtMs,
      id: task.id,
      ...(query ? { query } : undefined),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

/** Delete one scheduled automation created by the viewer. */
export async function deleteViewerScheduledAutomation(
  db: JuniorDatabase,
  user: User,
  id: string,
  nowMs = Date.now(),
): Promise<void> {
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const task = await readScheduledAutomation(db, id);
  if (
    !task ||
    task.status === "deleted" ||
    !identityIds.has(task.creatorIdentityId)
  ) {
    throw new PersonalScheduledAutomationNotFoundError();
  }
  await saveScheduledAutomation(db, {
    ...task,
    nextRunAtMs: undefined,
    runNowAtMs: undefined,
    status: "deleted",
    updatedAtMs: nowMs,
  });
}

/** List scheduled automations created by the viewer with a stable SQL cursor. */
export async function listViewerScheduledAutomations(
  db: JuniorDatabase,
  user: User,
  input: ViewerScheduledAutomationPageInput,
): Promise<ViewerScheduledAutomationPage> {
  const identityIds = user.identities.map((identity) => identity.id);
  if (identityIds.length === 0) return { automations: [] };
  const query = normalizeQuery(input.query);
  const cursor = decodeCursor(input.cursor, query);
  const automations: ScheduledAutomation[] = [];
  let before = cursor;
  const fetchLimit = input.limit + 1;
  while (automations.length < fetchLimit) {
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
      ? sql<boolean>`strpos(lower(coalesce(${juniorSchedulerTasks.title}, ${juniorSchedulerTasks.record}->'task'->>'text')), ${query}) > 0`
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
    automations.push(
      ...rows
        .map(parseScheduledAutomationRow)
        .filter(isListedScheduledAutomation),
    );
    if (rows.length < fetchLimit) break;
    const last = rows.at(-1)!;
    before = { createdAtMs: last.createdAtMs, id: last.id };
  }
  const page = automations.slice(0, input.limit);
  return {
    automations: page,
    ...(automations.length > input.limit && page.length > 0
      ? { nextCursor: encodeCursor(page.at(-1)!, query) }
      : undefined),
  };
}
