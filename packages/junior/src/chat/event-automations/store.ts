import { requireAutomationRevision } from "@/chat/automations/revision";
import { recordAutomationVersion } from "@/chat/automations/versions";
import { eventMatches, type Event, type User } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomations } from "@/db/schema/automations";
import { clearEventAutomationRuns } from "./run-limit";
import {
  eventAutomationSchema,
  type EventAutomation,
  type EventAutomationStatus,
} from "./types";

type AutomationRow = typeof juniorAutomations.$inferSelect;

/** Live event automation plus retained SQL status for history after delete. */
export type StoredEventAutomation = EventAutomation & {
  status: EventAutomationStatus;
  /** Why a run blocked this automation, until its creator resumes it. */
  statusReason?: string;
};

/**
 * Validate an event automation and split it into its SQL columns. Lifecycle
 * columns are written separately.
 */
function eventAutomationColumns(task: EventAutomation | StoredEventAutomation) {
  const {
    status: _status,
    statusReason: _statusReason,
    title,
    ...definition
  } = task as StoredEventAutomation;
  const {
    createdAtMs: _createdAtMs,
    id: _id,
    ...record
  } = eventAutomationSchema.parse(definition);
  return {
    channelId: record.destination.channelId,
    creatorSlackUserId: record.createdBy.slackUserId,
    identifier: record.trigger.identifier,
    instruction: record.task.text,
    namespace: record.trigger.namespace,
    record,
    teamId: record.destination.teamId,
    title: title?.trim() || null,
  };
}

/** Decode an event Automation row with its SQL-backed fields. */
export function parseEventAutomationRow(
  row: AutomationRow,
): StoredEventAutomation {
  const task = eventAutomationSchema.parse({
    ...row.record,
    createdAtMs: row.createdAtMs,
    id: row.id,
  });
  const title = row.title?.trim();
  return {
    ...task,
    // The trigger check rejects "completed" for event rows.
    status: row.status as EventAutomationStatus,
    ...(row.statusReason ? { statusReason: row.statusReason } : undefined),
    ...(title ? { title } : undefined),
  };
}

function eventAutomationWhere(id: string) {
  return and(eq(juniorAutomations.id, id), eq(juniorAutomations.kind, "event"));
}

function activeEventAutomationWhere() {
  return and(
    eq(juniorAutomations.kind, "event"),
    ne(juniorAutomations.status, "deleted"),
  );
}

/** Read one event automation by id, including deleted rows when present. */
export async function getEventAutomation(
  db: JuniorDatabase,
  id: string,
): Promise<StoredEventAutomation | undefined> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(eventAutomationWhere(id))
    .limit(1);
  return rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
}

/** Create one retry-stable event automation, or revive a deleted row with the new payload. */
export async function createEventAutomation(
  db: JuniorDatabase,
  task: EventAutomation,
): Promise<StoredEventAutomation> {
  const columns = eventAutomationColumns(task);
  // A revived row starts with a new run-limit window. Clear while the row is
  // still deleted and cannot match Events. Live retries keep their count.
  if ((await getEventAutomation(db, task.id))?.status === "deleted") {
    await clearEventAutomationRuns(task.id);
  }
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(juniorAutomations)
      .values({
        ...columns,
        createdAtMs: task.createdAtMs,
        id: task.id,
        kind: "event",
        status: "active",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      const created = parseEventAutomationRow(inserted[0]);
      await recordAutomationVersion(tx, created, undefined);
      return created;
    }
    const existing = await getEventAutomation(tx, task.id);
    if (!existing) {
      throw new Error(
        `Automation ${task.id} already exists with another kind.`,
      );
    }
    // Live retries keep the original row. Deleted rows reactivate with the new payload.
    if (existing.status !== "deleted") {
      return existing;
    }
    const rows = await tx
      .update(juniorAutomations)
      .set({
        ...columns,
        status: "active",
        // A reason from before the delete must not block the new row.
        statusReason: null,
      })
      .where(
        and(
          eventAutomationWhere(task.id),
          eq(juniorAutomations.status, "deleted"),
        ),
      )
      .returning();
    if (!rows[0]) {
      return (await getEventAutomation(tx, task.id))!;
    }
    const revived = parseEventAutomationRow(rows[0]);
    await recordAutomationVersion(tx, revived, undefined);
    return revived;
  });
}

/**
 * Replace an existing non-deleted event automation under a row lock.
 * Pass `editedBy` when a person changes the definition so its version names them.
 */
export async function saveEventAutomation(
  db: JuniorDatabase,
  task: EventAutomation,
  expectedRevision?: string,
  editedBy?: EventAutomation["createdBy"],
): Promise<StoredEventAutomation | undefined> {
  const columns = eventAutomationColumns(task);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(juniorAutomations)
      .where(eventAutomationWhere(task.id))
      .for("update");
    const current = rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
    if (expectedRevision !== undefined)
      requireAutomationRevision(current, expectedRevision);
    if (!current || current.status === "deleted") return undefined;
    const updated = await tx
      .update(juniorAutomations)
      .set(columns)
      .where(eventAutomationWhere(task.id))
      .returning();
    const saved = parseEventAutomationRow(updated[0]!);
    await recordAutomationVersion(tx, saved, current, editedBy);
    return saved;
  });
}

/** Mark one existing event automation deleted while retaining the row for history. */
export async function deleteEventAutomation(
  db: JuniorDatabase,
  id: string,
): Promise<StoredEventAutomation | undefined> {
  const rows = await db
    .update(juniorAutomations)
    .set({ status: "deleted" })
    .where(and(eq(juniorAutomations.id, id), activeEventAutomationWhere()))
    .returning();
  return rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
}

/** List live event automations in one Slack workspace. */
export async function listEventAutomationsForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(eq(juniorAutomations.teamId, teamId), activeEventAutomationWhere()),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
  return rows.map(parseEventAutomationRow);
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

/**
 * List deleted event automations created by one user, newest first.
 * Used only to keep historical runs after the live automation list drops the row.
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
        eq(juniorAutomations.teamId, identity.providerTenantId!),
        eq(juniorAutomations.creatorSlackUserId, identity.providerSubjectId!),
      ),
    ),
  );
  if (!ownership) return [];
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        ownership,
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomations.status, "deleted"),
      ),
    )
    .orderBy(desc(juniorAutomations.createdAtMs), desc(juniorAutomations.id))
    .limit(limit);
  return rows.map(parseEventAutomationRow);
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
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomations.teamId, input.teamId),
        eq(juniorAutomations.namespace, input.namespace),
        inArray(juniorAutomations.identifier, identifiers),
        eq(juniorAutomations.status, "active"),
      ),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
  const keys = new Set<string>();
  for (const row of rows) {
    const task = parseEventAutomationRow(row);
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
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomations.teamId, teamId),
        eq(juniorAutomations.namespace, event.namespace),
        eq(juniorAutomations.identifier, event.identifier),
        eq(juniorAutomations.status, "active"),
      ),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
  return rows
    .map(parseEventAutomationRow)
    .filter(
      (task) =>
        task.trigger.events.includes(event.eventType) &&
        eventMatches(task.trigger.match, event.data),
    );
}

/**
 * Change lifecycle under the same row lock as edits, without changing
 * credentials. A pause keeps an unresolved block reason, so resuming a paused
 * blocked automation returns it to blocked. Resume a blocked automation to
 * clear the reason. A resume also clears the run-limit count first.
 */
export async function setEventAutomationStatus(
  db: JuniorDatabase,
  id: string,
  status: "active" | "paused",
  revision: string,
): Promise<StoredEventAutomation> {
  // Clear before activation, while the row does not match Events. An already
  // active row keeps its count.
  if (
    status === "active" &&
    (await getEventAutomation(db, id))?.status !== "active"
  ) {
    await clearEventAutomationRuns(id);
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(juniorAutomations)
      .where(eventAutomationWhere(id))
      .for("update");
    const current = rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
    requireAutomationRevision(current, revision);
    if (!current || current.status === "deleted")
      throw new Error("Automation no longer exists.");
    const next: Pick<StoredEventAutomation, "status" | "statusReason"> =
      status === "paused"
        ? { status, statusReason: current.statusReason }
        : current.status === "paused" && current.statusReason
          ? { status: "blocked", statusReason: current.statusReason }
          : { status, statusReason: undefined };
    await tx
      .update(juniorAutomations)
      .set({ status: next.status, statusReason: next.statusReason ?? null })
      .where(eventAutomationWhere(id));
    const { statusReason: _statusReason, ...rest } = current;
    return {
      ...rest,
      status: next.status,
      ...(next.statusReason ? { statusReason: next.statusReason } : undefined),
    };
  });
}

/**
 * Stop an event automation after a run reports a problem that only its
 * creator can fix. An active automation becomes blocked. A paused automation
 * stays paused and keeps the reason, so resume returns it to blocked.
 * Deleted automations do not change. Returns true only when this call set
 * the automation to blocked, so the creator notice goes once and never for
 * an automation that the dashboard shows as paused.
 */
export async function blockEventAutomation(
  db: JuniorDatabase,
  id: string,
  reason: string,
): Promise<boolean> {
  const updated = await db
    .update(juniorAutomations)
    .set({
      status: sql`case when ${juniorAutomations.status} = 'active' then 'blocked' else ${juniorAutomations.status} end`,
      statusReason: reason,
    })
    .where(
      and(
        eventAutomationWhere(id),
        or(
          eq(juniorAutomations.status, "active"),
          and(
            eq(juniorAutomations.status, "paused"),
            sql`${juniorAutomations.statusReason} is distinct from ${reason}`,
          ),
        ),
      ),
    )
    .returning({ status: juniorAutomations.status });
  return updated[0]?.status === "blocked";
}
