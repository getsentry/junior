import { requireAutomationRevision } from "@/chat/automations/revision";
import { recordAutomationVersion } from "@/chat/automations/versions";
import {
  eventMatches,
  type Event,
  type EventData,
  type EventMatch,
  type User,
} from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomations } from "@/db/schema/automations";
import {
  automationEventCatalog,
  registeredEventTriggerProblems,
  type EventCatalog,
} from "@/chat/events/catalog";
import { logWarn } from "@/chat/logging";
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
    creatorIdentityId,
    id: _id,
    ...record
  } = eventAutomationSchema.parse(definition);
  return {
    channelId: record.destination.channelId,
    creatorIdentityId,
    creatorSlackUserId: record.createdBy.slackUserId,
    identifier: record.trigger.identifier ?? null,
    instruction: record.task.text,
    namespace: record.trigger.namespace,
    record,
    teamId: record.destination.teamId,
    title: title?.trim() || null,
  };
}

function eventAutomationRowInput(row: AutomationRow) {
  return {
    ...row.record,
    createdAtMs: row.createdAtMs,
    creatorIdentityId: row.creatorIdentityId,
    id: row.id,
  };
}

/** Decode an event Automation row with its SQL-backed fields. */
export function parseEventAutomationRow(
  row: AutomationRow,
): StoredEventAutomation {
  return withRowFields(
    row,
    eventAutomationSchema.parse(eventAutomationRowInput(row)),
  );
}

/**
 * Decode a row for Event matching. Log and skip a row that does not parse,
 * so one bad row cannot stop matching for its whole namespace.
 */
function readMatchableEventAutomationRow(
  row: AutomationRow,
): StoredEventAutomation | undefined {
  const parsed = eventAutomationSchema.safeParse(eventAutomationRowInput(row));
  if (parsed.success) return withRowFields(row, parsed.data);
  logWarn("event_automation.row.invalid", {
    "app.task.id": row.id,
    "app.task.type": "event",
    "error.message": parsed.error.message,
  });
  return undefined;
}

function withRowFields(
  row: AutomationRow,
  task: EventAutomation,
): StoredEventAutomation {
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

/**
 * List deleted event automations created by one user, newest first.
 * Used only to keep historical runs after the live automation list drops the row.
 */
export async function listDeletedEventAutomationsCreatedBy(
  db: JuniorDatabase,
  user: User,
  limit: number,
): Promise<StoredEventAutomation[]> {
  const identityIds = user.identities.map((identity) => identity.id);
  if (identityIds.length === 0) return [];
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        inArray(juniorAutomations.creatorIdentityId, identityIds),
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomations.status, "deleted"),
      ),
    )
    .orderBy(desc(juniorAutomations.createdAtMs), desc(juniorAutomations.id))
    .limit(limit);
  return rows.map(parseEventAutomationRow);
}

/**
 * List live event automations whose trigger still has an identifier. Skip a
 * row that does not parse; ingest logs it when an event reaches it.
 */
export async function listEventAutomationsWithIdentifier(
  db: JuniorDatabase,
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        activeEventAutomationWhere(),
        isNotNull(juniorAutomations.identifier),
      ),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
  return rows.flatMap((row) => {
    const parsed = eventAutomationSchema.safeParse(
      eventAutomationRowInput(row),
    );
    return parsed.success ? [withRowFields(row, parsed.data)] : [];
  });
}

/**
 * Select live rows whose identifier is one of these, and rows with no
 * identifier. A row with no identifier runs for every resource of its
 * namespace, so it gets every copy of an Event.
 */
function eventIdentifierWhere(identifiers: readonly string[]) {
  return or(
    isNull(juniorAutomations.identifier),
    ...(identifiers.length > 0
      ? [inArray(juniorAutomations.identifier, [...identifiers])]
      : []),
  );
}

/** SQL for rows whose trigger selects any of these event types. */
function eventTypesWhere(eventTypes: readonly string[]) {
  return or(
    ...eventTypes.map(
      (eventType) =>
        sql`${juniorAutomations.record}->'trigger'->'events' @> ${JSON.stringify([eventType])}::jsonb`,
    ),
  );
}

/**
 * Return why a row must not run for an Event with one of these identifiers,
 * or nothing when it may.
 *
 * The identifier column and the saved trigger must agree. A row with no
 * identifier must also have a trigger that the enabled `catalog` accepts. A
 * plugin can later require a filter or stop letting an event run for every
 * resource, and the row must not stay broad.
 */
function eventAutomationGateProblem(
  row: AutomationRow,
  task: StoredEventAutomation,
  identifiers: readonly string[],
  catalog: EventCatalog,
): string | undefined {
  const identifier = task.trigger.identifier;
  if (identifier !== undefined) {
    return identifier === row.identifier && identifiers.includes(identifier)
      ? undefined
      : "The saved trigger has a different identifier from its row.";
  }
  if (row.identifier !== null) {
    return "The saved trigger has no identifier, but its row has one.";
  }
  const problems = registeredEventTriggerProblems(catalog, task.trigger);
  return problems.length > 0
    ? problems.map((problem) => problem.message).join(" ")
    : undefined;
}

/**
 * Read the rows that can match an Event: live rows of one team and
 * namespace whose identifier is one of these, or that have no identifier,
 * and that select one of these event types. Skip and log a row that does
 * not parse or that the gate rejects.
 */
async function readGatedEventAutomations(
  db: JuniorDatabase,
  input: {
    catalog: EventCatalog;
    eventTypes: readonly string[];
    identifiers: readonly string[];
    namespace: string;
    teamId: string;
  },
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomations.teamId, input.teamId),
        eq(juniorAutomations.namespace, input.namespace),
        eventIdentifierWhere(input.identifiers),
        eventTypesWhere(input.eventTypes),
        eq(juniorAutomations.status, "active"),
      ),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
  const plugins = automationEventCatalog(input.catalog);
  return rows.flatMap((row) => {
    const task = readMatchableEventAutomationRow(row);
    if (!task) return [];
    const problem = eventAutomationGateProblem(
      row,
      task,
      input.identifiers,
      plugins,
    );
    if (problem === undefined) return [task];
    logWarn("event_automation.gate.rejected", {
      "app.task.id": task.id,
      "app.task.type": "event",
      "app.event_automation.skip_reason": problem,
    });
    return [];
  });
}

/** The filters of a match whose keys are in this data. */
function knownMatch(
  match: EventMatch | undefined,
  data: EventData,
): EventMatch | undefined {
  if (!match) return undefined;
  return Object.fromEntries(
    Object.entries(match).filter(([key]) => data[key] !== undefined),
  ) as EventMatch;
}

/**
 * Collect match keys from live event automations for these identifiers and
 * event types, and from automations with no identifier. Does not evaluate
 * match values, except for automations with no identifier: one whose
 * filters on the keys in `data` fail adds no keys. So a broad trigger for
 * one repository does not make every repository load its lazy data.
 */
export async function collectEventAutomationMatchKeys(
  db: JuniorDatabase,
  input: {
    catalog: EventCatalog;
    data?: EventData;
    eventTypes: string[];
    identifiers: string[];
    namespace: string;
    teamId: string;
  },
): Promise<string[]> {
  const eventTypes = [
    ...new Set(
      input.eventTypes.map((eventType) => eventType.trim()).filter(Boolean),
    ),
  ];
  const identifiers = [
    ...new Set(input.identifiers.map((value) => value.trim()).filter(Boolean)),
  ];
  if (eventTypes.length === 0) return [];
  const tasks = await readGatedEventAutomations(db, {
    catalog: input.catalog,
    eventTypes,
    identifiers,
    namespace: input.namespace,
    teamId: input.teamId,
  });
  const keys = new Set<string>();
  for (const task of tasks) {
    if (
      task.trigger.identifier === undefined &&
      input.data &&
      !eventMatches(knownMatch(task.trigger.match, input.data), input.data)
    ) {
      continue;
    }
    for (const key of Object.keys(task.trigger.match ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Find every live task matching one normalized event: tasks for its exact
 * identifier, and tasks with no identifier whose filters match. The gate
 * skips a row whose trigger and identifier column disagree, and a row with
 * no identifier whose trigger the enabled `catalog` rejects.
 */
export async function findMatchingEventAutomations(
  db: JuniorDatabase,
  event: Event,
  teamId: string,
  catalog: EventCatalog,
): Promise<StoredEventAutomation[]> {
  const tasks = await readGatedEventAutomations(db, {
    catalog,
    eventTypes: [event.eventType],
    identifiers: [event.identifier],
    namespace: event.namespace,
    teamId,
  });
  return tasks.filter(
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
