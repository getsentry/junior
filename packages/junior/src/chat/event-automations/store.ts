import { eventMatches, type Event, type User } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations } from "@/db/schema/destinations";
import {
  juniorEventAutomations,
  type EventAutomationStatus,
} from "@/db/schema/event-automations";
import { eventAutomationSchema, type EventAutomation } from "./types";

type EventAutomationRow = {
  status?: EventAutomationStatus | null;
  task: unknown;
  title: string | null;
};

/** Live event automation plus retained SQL status for history after delete. */
export type StoredEventAutomation = EventAutomation & {
  status: EventAutomationStatus;
};

/** JSON task payload must not carry SQL-backed columns. */
function eventAutomationJsonPayload(
  task: EventAutomation | StoredEventAutomation,
): EventAutomation {
  const {
    status: _status,
    title: _title,
    ...payload
  } = task as StoredEventAutomation;
  return payload;
}

function parseTask(row: EventAutomationRow): StoredEventAutomation {
  const raw =
    row.task && typeof row.task === "object"
      ? ({ ...(row.task as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : row.task;
  // Title is SQL-column-backed; ignore any legacy JSON title key.
  if (raw && typeof raw === "object" && "title" in raw) {
    delete raw.title;
  }
  const payload = eventAutomationSchema.parse(raw);
  const title = row.title?.trim();
  return {
    ...payload,
    status: row.status === "deleted" ? "deleted" : "active",
    ...(title ? { title } : undefined),
  };
}

function activeEventAutomationWhere() {
  return ne(juniorEventAutomations.status, "deleted");
}

/** Read one event automation by id, including deleted rows when present. */
export async function getEventAutomation(
  db: JuniorDatabase,
  id: string,
): Promise<StoredEventAutomation | undefined> {
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(eq(juniorEventAutomations.id, id))
    .limit(1);
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** Create one retry-stable event automation, or revive a deleted row with the new payload. */
export async function createEventAutomation(
  db: JuniorDatabase,
  task: EventAutomation,
): Promise<StoredEventAutomation> {
  const parsed = eventAutomationSchema.parse(eventAutomationJsonPayload(task));
  const title = task.title?.trim() || null;
  await db
    .insert(juniorEventAutomations)
    .values({
      id: parsed.id,
      teamId: parsed.destination.teamId,
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      createdAtMs: parsed.createdAtMs,
      status: "active",
      title,
      task: parsed,
    })
    .onConflictDoNothing();
  const existing = await getEventAutomation(db, parsed.id);
  if (!existing) {
    return {
      ...parsed,
      status: "active",
      ...(title ? { title } : undefined),
    };
  }
  // Live retries keep the original row. Deleted rows reactivate with the new payload.
  if (existing.status !== "deleted") {
    return existing;
  }
  const rows = await db
    .update(juniorEventAutomations)
    .set({
      teamId: parsed.destination.teamId,
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      status: "active",
      title,
      task: parsed,
    })
    .where(
      and(
        eq(juniorEventAutomations.id, parsed.id),
        eq(juniorEventAutomations.status, "deleted"),
      ),
    )
    .returning({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    });
  return rows[0]
    ? parseTask(rows[0])
    : ((await getEventAutomation(db, parsed.id)) ?? {
        ...parsed,
        status: "active",
        ...(title ? { title } : undefined),
      });
}

/** Replace an existing non-deleted event automation. */
export async function saveEventAutomation(
  db: JuniorDatabase,
  task: EventAutomation,
): Promise<StoredEventAutomation | undefined> {
  const parsed = eventAutomationSchema.parse(eventAutomationJsonPayload(task));
  const title = task.title?.trim() || null;
  const rows = await db
    .update(juniorEventAutomations)
    .set({
      namespace: parsed.trigger.namespace,
      identifier: parsed.trigger.identifier,
      title,
      task: parsed,
    })
    .where(
      and(
        eq(juniorEventAutomations.id, parsed.id),
        activeEventAutomationWhere(),
      ),
    )
    .returning({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    });
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** Mark one existing event automation deleted while retaining the row for history. */
export async function deleteEventAutomation(
  db: JuniorDatabase,
  id: string,
): Promise<StoredEventAutomation | undefined> {
  const rows = await db
    .update(juniorEventAutomations)
    .set({ status: "deleted" })
    .where(and(eq(juniorEventAutomations.id, id), activeEventAutomationWhere()))
    .returning({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    });
  return rows[0] ? parseTask(rows[0]) : undefined;
}

/** List live event automations in one Slack workspace. */
export async function listEventAutomationsForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        eq(juniorEventAutomations.teamId, teamId),
        activeEventAutomationWhere(),
      ),
    )
    .orderBy(
      asc(juniorEventAutomations.createdAtMs),
      asc(juniorEventAutomations.id),
    );
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

/** Return whether one event automation was created by a viewer-linked Slack identity. */
export function eventAutomationBelongsToUser(
  task: EventAutomation,
  user: User,
): boolean {
  return viewerSlackIdentities(user).some(
    (identity) =>
      identity.providerTenantId === task.destination.teamId &&
      identity.providerSubjectId === task.createdBy.slackUserId,
  );
}

/** List a bounded newest-first page of live event automations created by one user. */
export async function listEventAutomationsCreatedBy(
  db: JuniorDatabase,
  user: User,
  limit: number,
  query?: string,
): Promise<StoredEventAutomation[]> {
  const identities = viewerSlackIdentities(user);
  const ownership = or(
    ...identities.map((identity) =>
      and(
        eq(juniorEventAutomations.teamId, identity.providerTenantId!),
        sql`${juniorEventAutomations.task}->'createdBy'->>'slackUserId' = ${identity.providerSubjectId}`,
      ),
    ),
  );
  if (!ownership) return [];
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        ownership,
        activeEventAutomationWhere(),
        query
          ? sql<boolean>`strpos(lower(coalesce(${juniorEventAutomations.title}, ${juniorEventAutomations.task}->'task'->>'text')), ${query}) > 0`
          : undefined,
      ),
    )
    .orderBy(
      desc(juniorEventAutomations.createdAtMs),
      desc(juniorEventAutomations.id),
    )
    .limit(limit);
  return rows.map(parseTask);
}

/**
 * List deleted event automations created by one user, newest first.
 * Used only to keep historical runs after the live task list drops the row.
 */
export async function listDeletedEventAutomationsCreatedBy(
  db: JuniorDatabase,
  user: User,
  limit: number,
): Promise<StoredEventAutomation[]> {
  const identities = viewerSlackIdentities(user);
  const ownership = or(
    ...identities.map((identity) =>
      and(
        eq(juniorEventAutomations.teamId, identity.providerTenantId!),
        sql`${juniorEventAutomations.task}->'createdBy'->>'slackUserId' = ${identity.providerSubjectId}`,
      ),
    ),
  );
  if (!ownership) return [];
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(and(ownership, eq(juniorEventAutomations.status, "deleted")))
    .orderBy(
      desc(juniorEventAutomations.createdAtMs),
      desc(juniorEventAutomations.id),
    )
    .limit(limit);
  return rows.map(parseTask);
}

/** List live event automations whose current Slack destination is public. */
export async function listPublicEventAutomationsForTeams(
  db: JuniorDatabase,
  teamIds: string[],
  limit: number,
  query?: string,
): Promise<StoredEventAutomation[]> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .innerJoin(
      juniorDestinations,
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerTenantId, juniorEventAutomations.teamId),
        sql`${juniorDestinations.providerDestinationId} = ${juniorEventAutomations.task}->'destination'->>'channelId'`,
      ),
    )
    .where(
      and(
        inArray(juniorEventAutomations.teamId, teamIds),
        activeEventAutomationWhere(),
        query
          ? sql<boolean>`strpos(lower(coalesce(${juniorEventAutomations.title}, ${juniorEventAutomations.task}->'task'->>'text')), ${query}) > 0`
          : undefined,
        eq(juniorDestinations.visibility, "public"),
      ),
    )
    .orderBy(
      desc(juniorEventAutomations.createdAtMs),
      desc(juniorEventAutomations.id),
    )
    .limit(limit);
  return rows.map(parseTask);
}

/**
 * Collect match keys from live event automations for these identifiers and event types.
 * Does not evaluate match values — only reports keys that filters use.
 */
export async function collectEventAutomationMatchKeys(
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
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        eq(juniorEventAutomations.teamId, input.teamId),
        eq(juniorEventAutomations.namespace, input.namespace),
        inArray(juniorEventAutomations.identifier, identifiers),
        activeEventAutomationWhere(),
      ),
    )
    .orderBy(
      asc(juniorEventAutomations.createdAtMs),
      asc(juniorEventAutomations.id),
    );
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

/** Find every live task matching one normalized event. */
export async function findMatchingEventAutomations(
  db: JuniorDatabase,
  event: Event,
  teamId: string,
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select({
      status: juniorEventAutomations.status,
      task: juniorEventAutomations.task,
      title: juniorEventAutomations.title,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        eq(juniorEventAutomations.teamId, teamId),
        eq(juniorEventAutomations.namespace, event.namespace),
        eq(juniorEventAutomations.identifier, event.identifier),
        activeEventAutomationWhere(),
      ),
    )
    .orderBy(
      asc(juniorEventAutomations.createdAtMs),
      asc(juniorEventAutomations.id),
    );
  return rows
    .map(parseTask)
    .filter(
      (task) =>
        task.trigger.events.includes(event.eventType) &&
        eventMatches(task.trigger.match, event.data),
    );
}
