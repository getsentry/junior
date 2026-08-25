import {
  resourceEventMatches,
  type ResourceEvent,
  type User,
} from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations } from "@/db/schema/destinations";
import { juniorEventTasks } from "@/db/schema/event-tasks";
import { eventTaskSchema, type EventTask } from "./types";

type EventTaskRow = {
  task: unknown;
  title: string | null;
};

/** JSON task payload must not carry the SQL-backed title column. */
function eventTaskJsonPayload(task: EventTask): EventTask {
  const { title: _title, ...payload } = task;
  return payload as EventTask;
}

function parseTask(row: EventTaskRow): EventTask {
  const raw =
    row.task && typeof row.task === "object"
      ? ({ ...(row.task as Record<string, unknown>) } as Record<string, unknown>)
      : row.task;
  // Title is SQL-column-backed; ignore any legacy JSON title key.
  if (raw && typeof raw === "object" && "title" in raw) {
    delete raw.title;
  }
  const payload = eventTaskSchema.parse(raw);
  const title = row.title?.trim();
  return title ? { ...payload, title } : payload;
}

/** Read one event task by id. */
export async function getEventTask(
  db: JuniorDatabase,
  id: string,
): Promise<EventTask | undefined> {
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .where(eq(juniorEventTasks.id, id))
    .limit(1);
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** Create one retry-stable event task or return its existing record. */
export async function createEventTask(
  db: JuniorDatabase,
  task: EventTask,
): Promise<EventTask> {
  const parsed = eventTaskSchema.parse(eventTaskJsonPayload(task));
  const title = task.title?.trim() || null;
  await db
    .insert(juniorEventTasks)
    .values({
      id: parsed.id,
      teamId: parsed.destination.teamId,
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      createdAtMs: parsed.createdAtMs,
      title,
      task: parsed,
    })
    .onConflictDoNothing();
  return (await getEventTask(db, parsed.id)) ?? { ...parsed, ...(title ? { title } : undefined) };
}

/** Replace an existing event task. */
export async function saveEventTask(
  db: JuniorDatabase,
  task: EventTask,
): Promise<EventTask | undefined> {
  const parsed = eventTaskSchema.parse(eventTaskJsonPayload(task));
  const title = task.title?.trim() || null;
  const rows = await db
    .update(juniorEventTasks)
    .set({
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      title,
      task: parsed,
    })
    .where(eq(juniorEventTasks.id, parsed.id))
    .returning({ task: juniorEventTasks.task, title: juniorEventTasks.title });
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** Delete one existing event task. */
export async function deleteEventTask(
  db: JuniorDatabase,
  id: string,
): Promise<EventTask | undefined> {
  const rows = await db
    .delete(juniorEventTasks)
    .where(eq(juniorEventTasks.id, id))
    .returning({ task: juniorEventTasks.task, title: juniorEventTasks.title });
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** List event tasks in one Slack workspace. */
export async function listEventTasksForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<EventTask[]> {
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .where(eq(juniorEventTasks.teamId, teamId))
    .orderBy(asc(juniorEventTasks.createdAtMs), asc(juniorEventTasks.id));
  return rows.map(parseTask);
}

function viewerSlackIdentities(user: User) {
  return user.identities.filter(
    (identity) =>
      identity.provider === "slack" &&
      Boolean(identity.providerTenantId) &&
      Boolean(identity.providerSubjectId),
  );
}

/** Return whether one event task was created by a viewer-linked Slack identity. */
export function eventTaskBelongsToUser(task: EventTask, user: User): boolean {
  return viewerSlackIdentities(user).some(
    (identity) =>
      identity.providerTenantId === task.destination.teamId &&
      identity.providerSubjectId === task.createdBy.slackUserId,
  );
}

/** List a bounded newest-first page of event tasks created by one user. */
export async function listEventTasksCreatedBy(
  db: JuniorDatabase,
  user: User,
  limit: number,
): Promise<EventTask[]> {
  const identities = viewerSlackIdentities(user);
  const ownership = or(
    ...identities.map((identity) =>
      and(
        eq(juniorEventTasks.teamId, identity.providerTenantId!),
        sql`${juniorEventTasks.task}->'createdBy'->>'slackUserId' = ${identity.providerSubjectId}`,
      ),
    ),
  );
  if (!ownership) return [];
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .where(ownership)
    .orderBy(desc(juniorEventTasks.createdAtMs), desc(juniorEventTasks.id))
    .limit(limit);
  return rows.map(parseTask);
}

/** List event tasks whose current Slack destination is public. */
export async function listPublicEventTasksForTeams(
  db: JuniorDatabase,
  teamIds: string[],
  limit: number,
): Promise<EventTask[]> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .innerJoin(
      juniorDestinations,
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerTenantId, juniorEventTasks.teamId),
        sql`${juniorDestinations.providerDestinationId} = ${juniorEventTasks.task}->'destination'->>'channelId'`,
      ),
    )
    .where(
      and(
        inArray(juniorEventTasks.teamId, teamIds),
        eq(juniorDestinations.visibility, "public"),
      ),
    )
    .orderBy(desc(juniorEventTasks.createdAtMs), desc(juniorEventTasks.id))
    .limit(limit);
  return rows.map(parseTask);
}

/**
 * Collect match keys from event tasks for these identifiers and event types.
 * Does not evaluate match values — only reports keys that filters use.
 */
export async function collectEventTaskMatchKeys(
  db: JuniorDatabase,
  input: {
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
    teamId: string;
  },
): Promise<string[]> {
  const eventTypes = new Set(
    input.eventTypes.map((eventType) => eventType.trim()).filter(Boolean),
  );
  const identifiers = [
    ...new Set(input.identifiers.map((value) => value.trim()).filter(Boolean)),
  ];
  if (eventTypes.size === 0 || identifiers.length === 0) return [];
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .where(
      and(
        eq(juniorEventTasks.teamId, input.teamId),
        eq(juniorEventTasks.namespace, input.namespace),
        inArray(juniorEventTasks.identifier, identifiers),
      ),
    )
    .orderBy(asc(juniorEventTasks.createdAtMs), asc(juniorEventTasks.id));
  const keys = new Set<string>();
  for (const row of rows) {
    const task = parseTask(row);
    if (!task.trigger.events.some((eventType) => eventTypes.has(eventType))) {
      continue;
    }
    for (const key of Object.keys(task.trigger.match ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Find every task matching one normalized resource event. */
export async function findMatchingEventTasks(
  db: JuniorDatabase,
  event: ResourceEvent,
  teamId: string,
): Promise<EventTask[]> {
  const rows = await db
    .select({ task: juniorEventTasks.task, title: juniorEventTasks.title })
    .from(juniorEventTasks)
    .where(
      and(
        eq(juniorEventTasks.teamId, teamId),
        eq(juniorEventTasks.namespace, event.namespace),
        eq(juniorEventTasks.identifier, event.identifier),
      ),
    )
    .orderBy(asc(juniorEventTasks.createdAtMs), asc(juniorEventTasks.id));
  return rows
    .map(parseTask)
    .filter(
      (task) =>
        task.trigger.events.includes(event.eventType) &&
        resourceEventMatches(task.trigger.match, event.data),
    );
}
