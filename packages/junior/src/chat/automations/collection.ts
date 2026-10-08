import { pluginEventCatalog } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  eq,
  inArray,
  ne,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { AutomationListQuery } from "@/api/schema/automation";
import { getDb } from "@/chat/db";
import {
  juniorAutomationExecutions,
  juniorDestinations,
  juniorEventAutomations,
  juniorSchedulerTasks,
} from "@/db/schema";

/**
 * The web collection applies access before counts, filter options, and paging.
 * Keep its ownership rules aligned with the direct Automation reader. A public
 * Destination only grants access inside a viewer's linked Slack workspaces.
 */
export function viewerAutomationCollection(user: User) {
  const db = getDb();
  const identities = user.identities.filter(
    (identity) => identity.provider === "slack",
  );
  const teamIds = identities.flatMap((identity) =>
    identity.providerTenantId ? [identity.providerTenantId] : [],
  );
  const scheduled = juniorSchedulerTasks;
  const event = juniorEventAutomations;
  const destination = juniorDestinations;
  const scheduledOwned = inArray(
    scheduled.creatorIdentityId,
    user.identities.map((identity) => identity.id),
  );
  const eventOwned =
    or(
      ...identities.map((identity) =>
        and(
          eq(event.teamId, identity.providerTenantId ?? ""),
          sql`${event.task}->'createdBy'->>'slackUserId' = ${identity.providerSubjectId}`,
        ),
      ),
    ) ?? sql`false`;
  const publicDestination = sql<boolean>`coalesce(${destination.visibility} = 'public', false)`;
  const scheduledPublic = and(
    inArray(scheduled.teamId, teamIds),
    publicDestination,
    ne(scheduled.status, "completed"),
  )!;
  const eventPublic = and(inArray(event.teamId, teamIds), publicDestination)!;
  function fields(record: SQLWrapper, teamId: SQLWrapper) {
    return {
      creator:
        sql<string>`${teamId} || ':' || (${record}->'createdBy'->>'slackUserId')`.as(
          "creator",
        ),
      creatorLabel:
        sql<string>`coalesce(nullif(trim(${record}->'createdBy'->>'fullName'), ''), nullif(trim(${record}->'createdBy'->>'userName'), ''), ${record}->'createdBy'->>'slackUserId')`.as(
          "creator_label",
        ),
      destination:
        sql<string>`${teamId} || ':' || (${record}->'destination'->>'channelId')`.as(
          "destination",
        ),
      destinationLabel:
        sql<string>`coalesce(nullif(${destination.displayName}, ''), ${record}->'destination'->>'channelId')`.as(
          "destination_label",
        ),
      isPublic: publicDestination.as("is_public"),
      instruction: sql<string>`${record}->'task'->>'text'`.as("instruction"),
    };
  }
  function destinationJoin(record: SQLWrapper, teamId: SQLWrapper) {
    return and(
      eq(destination.provider, "slack"),
      sql`${destination.providerTenantId} = ${teamId}`,
      sql`${destination.providerDestinationId} = ${record}->'destination'->>'channelId'`,
    );
  }
  // Use the same namespace/event availability rule as the direct reader.
  const available =
    or(
      ...Object.entries(pluginEventCatalog(getEventCatalog())).map(
        ([namespace, registration]) => {
          const events = registration.resourceTypes.flatMap(
            (resource) => resource.supportedEvents,
          );
          return and(
            eq(event.namespace, namespace),
            sql`${event.task}->'trigger'->'events' <@ ${JSON.stringify(events)}::jsonb`,
          );
        },
      ),
    ) ?? sql`false`;
  const executions = juniorAutomationExecutions;
  function lastRunNeedsAttention(kind: "scheduled" | "event", id: SQLWrapper) {
    return sql<boolean>`coalesce((select ${executions.status} in ('failed', 'blocked') from ${executions}
      where ${executions.kind} = ${kind} and ${executions.namespace} = 'junior' and ${executions.automationId} = ${id}
      order by ${executions.executedAtMs} desc, ${executions.executionId} desc limit 1), false)`;
  }
  return unionAll(
    db
      .select({
        kind: sql<"scheduled" | "event">`'scheduled'`.as("kind"),
        id: scheduled.id,
        title: sql<string | null>`${scheduled.title}`.as("title"),
        createdAtMs: scheduled.createdAtMs,
        state: sql<string>`${scheduled.status}`.as("state"),
        unavailable: sql<boolean>`false`.as("unavailable"),
        attention:
          sql<boolean>`${scheduled.status} not in ('paused', 'completed') and (${scheduled.status} = 'blocked' or ${lastRunNeedsAttention("scheduled", scheduled.id)})`.as(
            "attention",
          ),
        owned: sql<boolean>`${scheduledOwned}`.as("owned"),
        resource: sql<string>`''`.as("resource"),
        ...fields(scheduled.record, scheduled.teamId),
      })
      .from(scheduled)
      .leftJoin(
        destination,
        destinationJoin(scheduled.record, scheduled.teamId),
      )
      .where(
        and(
          inArray(scheduled.status, [
            "active",
            "blocked",
            "paused",
            "completed",
          ]),
          or(scheduledOwned, scheduledPublic),
        ),
      ),
    db
      .select({
        kind: sql<"scheduled" | "event">`'event'`.as("kind"),
        id: event.id,
        title: sql<string | null>`${event.title}`.as("title"),
        createdAtMs: event.createdAtMs,
        state: sql<string>`${event.status}`.as("state"),
        unavailable: sql<boolean>`not (${available})`.as("unavailable"),
        attention:
          sql<boolean>`${event.status} <> 'paused' and (not (${available}) or ${lastRunNeedsAttention("event", event.id)})`.as(
            "attention",
          ),
        owned: sql<boolean>`${eventOwned}`.as("owned"),
        resource:
          sql<string>`concat_ws(' ', ${event.identifier}, ${event.task}->'trigger'->>'label', ${event.namespace})`.as(
            "resource",
          ),
        ...fields(event.task, event.teamId),
      })
      .from(event)
      .leftJoin(destination, destinationJoin(event.task, event.teamId))
      .where(and(ne(event.status, "deleted"), or(eventOwned, eventPublic))),
  ).as("accessible_automations");
}

type CollectionRow = {
  attention: boolean;
  createdAtMs: number;
  creator: string | null;
  creatorLabel: string | null;
  destination: string | null;
  destinationLabel: string | null;
  id: string;
  instruction: string | null;
  isPublic: boolean;
  kind: "scheduled" | "event";
  owned: boolean;
  resource: string | null;
  state: string;
  title: string | null;
  unavailable: boolean;
};

type FilterOption = { value: string; label: string };

/** Code point order with Postgres' ascending NULLS LAST placement. */
function compareText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

/** Postgres `trim()` only strips spaces, unlike `String.prototype.trim`. */
function trimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

function titleSortKey(row: CollectionRow): string | null {
  const title = row.title === null ? "" : trimSpaces(row.title);
  const value = title || row.instruction;
  return value === null ? null : value.toLowerCase();
}

function filterOptions(
  rows: CollectionRow[],
  value: (row: CollectionRow) => string | null,
  label: (row: CollectionRow) => string | null,
): FilterOption[] {
  const groups = new Map<string | null, string | null>();
  for (const row of rows) {
    const key = value(row);
    const candidate = label(row);
    const current = groups.get(key) ?? null;
    if (!groups.has(key) || compareText(candidate, current) < 0) {
      groups.set(key, candidate);
    }
  }
  return [...groups]
    .map(([optionValue, optionLabel]) => ({
      value: optionValue,
      label: optionLabel,
    }))
    .sort(
      (left, right) =>
        compareText(left.label, right.label) ||
        compareText(left.value, right.value),
    ) as FilterOption[];
}

function matchesQuery(row: CollectionRow, input: AutomationListQuery): boolean {
  if (input.scope === "mine" && !row.owned) return false;
  if (input.scope === "public" && !row.isPublic) return false;
  if (input.scope === "attention" && !row.attention) return false;
  if (input.type !== "all" && row.kind !== input.type) return false;
  if (input.state === "unavailable" && !row.unavailable) return false;
  if (
    input.state !== "all" &&
    input.state !== "unavailable" &&
    row.state !== input.state
  ) {
    return false;
  }
  if (input.creator && row.creator !== input.creator) return false;
  if (input.destination && row.destination !== input.destination) {
    return false;
  }
  if (input.q) {
    const text = [row.title, row.instruction, row.resource]
      .filter((part): part is string => part !== null)
      .join(" ")
      .toLowerCase();
    if (!text.includes(input.q.toLowerCase())) return false;
  }
  return true;
}

function compareRows(sort: AutomationListQuery["sort"]) {
  return (left: CollectionRow, right: CollectionRow): number => {
    const primary =
      sort === "oldest"
        ? Number(left.createdAtMs) - Number(right.createdAtMs)
        : sort === "title"
          ? compareText(titleSortKey(left), titleSortKey(right))
          : Number(right.createdAtMs) - Number(left.createdAtMs);
    return (
      primary ||
      compareText(right.id, left.id) ||
      compareText(left.kind, right.kind)
    );
  };
}

/**
 * Read a page plus complete, access-scoped counts and filter options.
 *
 * The access-scoped collection is a union with correlated execution lookups,
 * so it is evaluated once and the counts, options, and page are derived from
 * that single result instead of re-running the union for every aggregate.
 */
export async function readAutomationCollection(
  user: User,
  input: AutomationListQuery,
) {
  const collection = viewerAutomationCollection(user);
  const all: CollectionRow[] = await getDb()
    .select({
      attention: collection.attention,
      createdAtMs: collection.createdAtMs,
      creator: collection.creator,
      creatorLabel: collection.creatorLabel,
      destination: collection.destination,
      destinationLabel: collection.destinationLabel,
      id: collection.id,
      instruction: collection.instruction,
      isPublic: collection.isPublic,
      kind: collection.kind,
      owned: collection.owned,
      resource: collection.resource,
      state: collection.state,
      title: collection.title,
      unavailable: collection.unavailable,
    })
    .from(collection);
  const matching = all.filter((row) => matchesQuery(row, input));
  const total = matching.length;
  const page = Math.min(
    input.page,
    Math.max(1, Math.ceil(total / input.pageSize)),
  );
  const offset = (page - 1) * input.pageSize;
  const rows = matching
    .sort(compareRows(input.sort))
    .slice(offset, offset + input.pageSize)
    .map(({ id, kind }) => ({ id, kind }));
  return {
    rows,
    total,
    page,
    pageSize: input.pageSize,
    counts: {
      all: all.length,
      mine: all.filter((row) => row.owned).length,
      public: all.filter((row) => row.isPublic).length,
      private: all.filter((row) => !row.isPublic).length,
    },
    creators: filterOptions(
      all,
      (row) => row.creator,
      (row) => row.creatorLabel,
    ),
    destinations: filterOptions(
      all,
      (row) => row.destination,
      (row) => row.destinationLabel,
    ),
  };
}
