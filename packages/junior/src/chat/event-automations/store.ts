import { requireAutomationRevision } from "@/chat/automations/revision";
import { recordAutomationVersion } from "@/chat/automations/versions";
import {
  eventMatches,
  slackDestinationSchema,
  taskOutcomeSchema,
  type Event,
  type User,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorEventAutomations,
  type EventAutomationStatus,
} from "@/db/schema/event-automations";
import { eventAutomationSchema, type EventAutomation } from "./types";

// Older workers can still write thread destinations during deployment.
const retainedEventAutomationSchema = eventAutomationSchema.extend({
  destination: slackDestinationSchema,
  outcomes: z.array(taskOutcomeSchema).max(5),
});

type EventAutomationRow = {
  status?: EventAutomationStatus | null;
  statusReason?: string | null;
  task: unknown;
  title: string | null;
};

const eventAutomationRowColumns = {
  status: juniorEventAutomations.status,
  statusReason: juniorEventAutomations.statusReason,
  task: juniorEventAutomations.task,
  title: juniorEventAutomations.title,
};

/** Live event automation plus retained SQL status for history after delete. */
export type StoredEventAutomation = EventAutomation & {
  status: EventAutomationStatus;
  /** Why a run blocked this automation, until its creator resumes it. */
  statusReason?: string;
};

/** JSON task payload must not carry SQL-backed columns. */
function eventAutomationJsonPayload(
  task: EventAutomation | StoredEventAutomation,
): EventAutomation {
  const {
    status: _status,
    statusReason: _statusReason,
    title: _title,
    ...payload
  } = task as StoredEventAutomation;
  return payload;
}

/** Decode a retained event Automation with its SQL-backed fields. */
export function parseEventAutomationRow(
  row: EventAutomationRow,
): StoredEventAutomation {
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
  // TODO(dcramer): Remove this rolling-deploy fallback after v0.205.x writers
  // are unsupported. Migration 0041 backfills all rows present at upgrade time.
  if (
    raw &&
    typeof raw === "object" &&
    !("outcomes" in raw) &&
    "destination" in raw
  ) {
    (raw as Record<string, unknown>).outcomes = [
      { action: "send_message", destination: raw.destination },
    ];
  }
  const retained = retainedEventAutomationSchema.parse(raw);
  const { threadTs: _threadTs, ...destination } = retained.destination;
  const title = row.title?.trim();
  return {
    ...retained,
    destination,
    outcomes: retained.outcomes.map((outcome) => {
      const { threadTs: _threadTs, ...destination } = outcome.destination;
      return { ...outcome, destination };
    }),
    status: row.status ?? "active",
    ...(row.statusReason ? { statusReason: row.statusReason } : undefined),
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
      ...eventAutomationRowColumns,
    })
    .from(juniorEventAutomations)
    .where(eq(juniorEventAutomations.id, id))
    .limit(1);
  return rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
}

/** Create one retry-stable event automation, or revive a deleted row with the new payload. */
export async function createEventAutomation(
  db: JuniorDatabase,
  task: EventAutomation,
): Promise<StoredEventAutomation> {
  const parsed = eventAutomationSchema.parse(eventAutomationJsonPayload(task));
  const title = task.title?.trim() || null;
  return db.transaction(async (tx) => {
    const inserted = await tx
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
      .onConflictDoNothing()
      .returning({
        ...eventAutomationRowColumns,
      });
    if (inserted[0]) {
      const created = parseEventAutomationRow(inserted[0]);
      await recordAutomationVersion(tx, "event", created, undefined);
      return created;
    }
    const existing = await getEventAutomation(tx, parsed.id);
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
    const rows = await tx
      .update(juniorEventAutomations)
      .set({
        teamId: parsed.destination.teamId,
        namespace: parsed.trigger.namespace,
        identifier: parsed.trigger.identifier,
        status: "active",
        // A reason from before the delete must not block the new row.
        statusReason: null,
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
        ...eventAutomationRowColumns,
      });
    if (!rows[0]) {
      return (
        (await getEventAutomation(tx, parsed.id)) ?? {
          ...parsed,
          status: "active",
          ...(title ? { title } : undefined),
        }
      );
    }
    const revived = parseEventAutomationRow(rows[0]);
    await recordAutomationVersion(tx, "event", revived, undefined);
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
  const parsed = eventAutomationSchema.parse(eventAutomationJsonPayload(task));
  const title = task.title?.trim() || null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        ...eventAutomationRowColumns,
      })
      .from(juniorEventAutomations)
      .where(eq(juniorEventAutomations.id, parsed.id))
      .for("update");
    const current = rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
    if (expectedRevision !== undefined)
      requireAutomationRevision(current, expectedRevision);
    if (!current || current.status === "deleted") return undefined;
    const updated = await tx
      .update(juniorEventAutomations)
      .set({
        namespace: parsed.trigger.namespace,
        identifier: parsed.trigger.identifier,
        title,
        task: parsed,
      })
      .where(eq(juniorEventAutomations.id, parsed.id))
      .returning({
        ...eventAutomationRowColumns,
      });
    const saved = parseEventAutomationRow(updated[0]!);
    await recordAutomationVersion(tx, "event", saved, current, editedBy);
    return saved;
  });
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
      ...eventAutomationRowColumns,
    });
  return rows[0] ? parseEventAutomationRow(rows[0]) : undefined;
}

/** List live event automations in one Slack workspace. */
export async function listEventAutomationsForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<StoredEventAutomation[]> {
  const rows = await db
    .select({
      ...eventAutomationRowColumns,
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
        eq(juniorEventAutomations.teamId, identity.providerTenantId!),
        sql`${juniorEventAutomations.task}->'createdBy'->>'slackUserId' = ${identity.providerSubjectId}`,
      ),
    ),
  );
  if (!ownership) return [];
  const rows = await db
    .select({
      ...eventAutomationRowColumns,
    })
    .from(juniorEventAutomations)
    .where(and(ownership, eq(juniorEventAutomations.status, "deleted")))
    .orderBy(
      desc(juniorEventAutomations.createdAtMs),
      desc(juniorEventAutomations.id),
    )
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
    .select({
      ...eventAutomationRowColumns,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        eq(juniorEventAutomations.teamId, input.teamId),
        eq(juniorEventAutomations.namespace, input.namespace),
        inArray(juniorEventAutomations.identifier, identifiers),
        eq(juniorEventAutomations.status, "active"),
      ),
    )
    .orderBy(
      asc(juniorEventAutomations.createdAtMs),
      asc(juniorEventAutomations.id),
    );
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
    .select({
      ...eventAutomationRowColumns,
    })
    .from(juniorEventAutomations)
    .where(
      and(
        eq(juniorEventAutomations.teamId, teamId),
        eq(juniorEventAutomations.namespace, event.namespace),
        eq(juniorEventAutomations.identifier, event.identifier),
        eq(juniorEventAutomations.status, "active"),
      ),
    )
    .orderBy(
      asc(juniorEventAutomations.createdAtMs),
      asc(juniorEventAutomations.id),
    );
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
 * clear the reason.
 */
export async function setEventAutomationStatus(
  db: JuniorDatabase,
  id: string,
  status: "active" | "paused",
  revision: string,
): Promise<StoredEventAutomation> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(juniorEventAutomations)
      .where(eq(juniorEventAutomations.id, id))
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
      .update(juniorEventAutomations)
      .set({ status: next.status, statusReason: next.statusReason ?? null })
      .where(eq(juniorEventAutomations.id, id));
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
 * Deleted automations do not change.
 */
export async function blockEventAutomation(
  db: JuniorDatabase,
  id: string,
  reason: string,
): Promise<void> {
  await db
    .update(juniorEventAutomations)
    .set({
      status: sql`case when ${juniorEventAutomations.status} = 'active' then 'blocked' else ${juniorEventAutomations.status} end`,
      statusReason: reason,
    })
    .where(
      and(
        eq(juniorEventAutomations.id, id),
        or(
          eq(juniorEventAutomations.status, "active"),
          and(
            eq(juniorEventAutomations.status, "paused"),
            sql`${juniorEventAutomations.statusReason} is distinct from ${reason}`,
          ),
        ),
      ),
    );
}
