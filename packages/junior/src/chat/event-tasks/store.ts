import { type ResourceEvent } from "@sentry/junior-plugin-api";
import { and, asc, eq, ne } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorEventTasks } from "@/db/schema/event-tasks";
import { eventTaskSchema, type EventTask } from "./types";

function parseTask(value: unknown): EventTask {
  return eventTaskSchema.parse(value);
}

/** Read one event task by id. */
export async function getEventTask(
  db: JuniorDatabase,
  id: string,
): Promise<EventTask | undefined> {
  const rows = await db
    .select({ task: juniorEventTasks.task })
    .from(juniorEventTasks)
    .where(eq(juniorEventTasks.id, id))
    .limit(1);
  return rows[0] ? parseTask(rows[0].task) : undefined;
}

/** Create one retry-stable event task or return its existing record. */
export async function createEventTask(
  db: JuniorDatabase,
  task: EventTask,
): Promise<EventTask> {
  const parsed = eventTaskSchema.parse(task);
  await db
    .insert(juniorEventTasks)
    .values({
      id: parsed.id,
      teamId: parsed.destination.teamId,
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      status: parsed.status,
      createdAtMs: parsed.createdAtMs,
      task: parsed,
    })
    .onConflictDoNothing();
  return (await getEventTask(db, parsed.id)) ?? parsed;
}

/** Replace or delete an event task only while it remains active. */
export async function saveActiveEventTask(
  db: JuniorDatabase,
  task: EventTask,
): Promise<EventTask | undefined> {
  const parsed = eventTaskSchema.parse(task);
  const rows = await db
    .update(juniorEventTasks)
    .set({
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      status: parsed.status,
      task: parsed,
    })
    .where(
      and(
        eq(juniorEventTasks.id, parsed.id),
        eq(juniorEventTasks.status, "active"),
      ),
    )
    .returning({ task: juniorEventTasks.task });
  return rows[0] ? parseTask(rows[0].task) : undefined;
}

/** List active event tasks in one Slack workspace. */
export async function listEventTasksForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<EventTask[]> {
  const rows = await db
    .select({ task: juniorEventTasks.task })
    .from(juniorEventTasks)
    .where(
      and(
        eq(juniorEventTasks.teamId, teamId),
        ne(juniorEventTasks.status, "deleted"),
      ),
    )
    .orderBy(asc(juniorEventTasks.createdAtMs), asc(juniorEventTasks.id));
  return rows.map((row) => parseTask(row.task));
}

/** Find every active task matching one normalized resource event. */
export async function findMatchingEventTasks(
  db: JuniorDatabase,
  event: ResourceEvent,
): Promise<EventTask[]> {
  const rows = await db
    .select({ task: juniorEventTasks.task })
    .from(juniorEventTasks)
    .where(
      and(
        eq(juniorEventTasks.status, "active"),
        eq(juniorEventTasks.namespace, event.namespace),
        eq(juniorEventTasks.identifier, event.identifier),
      ),
    )
    .orderBy(asc(juniorEventTasks.createdAtMs), asc(juniorEventTasks.id));
  return rows
    .map((row) => parseTask(row.task))
    .filter((task) => task.trigger.events.includes(event.eventType));
}
