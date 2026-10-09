import { pluginEventCatalog } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  count,
  desc,
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
import { PRIVATE_DESTINATION_LABEL } from "./visibility";

/**
 * The web collection applies access before counts, filter options, and paging.
 * Keep its ownership rules aligned with the direct Automation reader. A public
 * Automation only grants access inside a viewer's linked Slack workspaces. The
 * creator's visibility override wins over the Destination visibility.
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
  // A creator override wins. Without one, the Destination decides.
  function publicAutomation(visibility: SQLWrapper) {
    return sql<boolean>`coalesce(${visibility} = 'public', ${destination.visibility} = 'public', false)`;
  }
  const scheduledPublic = and(
    inArray(scheduled.teamId, teamIds),
    publicAutomation(scheduled.visibility),
    ne(scheduled.status, "completed"),
  )!;
  const eventPublic = and(
    inArray(event.teamId, teamIds),
    publicAutomation(event.visibility),
  )!;
  function fields(
    record: SQLWrapper,
    teamId: SQLWrapper,
    visibility: SQLWrapper,
    owned: SQLWrapper,
  ) {
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
      // Do not show a private Destination name to readers outside it.
      destinationLabel:
        sql<string>`case when ${owned} or ${publicDestination} then coalesce(nullif(${destination.displayName}, ''), ${record}->'destination'->>'channelId') else ${PRIVATE_DESTINATION_LABEL} end`.as(
          "destination_label",
        ),
      destinationPublic: publicDestination.as("destination_public"),
      isPublic: publicAutomation(visibility).as("is_public"),
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
        ...fields(
          scheduled.record,
          scheduled.teamId,
          scheduled.visibility,
          scheduledOwned,
        ),
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
        ...fields(event.task, event.teamId, event.visibility, eventOwned),
      })
      .from(event)
      .leftJoin(destination, destinationJoin(event.task, event.teamId))
      .where(and(ne(event.status, "deleted"), or(eventOwned, eventPublic))),
  ).as("accessible_automations");
}

/** Read an SQL page and complete, access-scoped counts and filter options. */
export async function readAutomationCollection(
  user: User,
  input: AutomationListQuery,
) {
  const db = getDb();
  const collection = viewerAutomationCollection(user);
  const where = and(
    input.scope === "mine"
      ? eq(collection.owned, true)
      : input.scope === "public"
        ? eq(collection.isPublic, true)
        : input.scope === "attention"
          ? eq(collection.attention, true)
          : undefined,
    input.type === "all" ? undefined : eq(collection.kind, input.type),
    input.state === "all"
      ? undefined
      : input.state === "unavailable"
        ? eq(collection.unavailable, true)
        : eq(collection.state, input.state),
    input.creator ? eq(collection.creator, input.creator) : undefined,
    input.destination
      ? eq(collection.destination, input.destination)
      : undefined,
    input.q
      ? sql`strpos(lower(concat_ws(' ', ${collection.title}, ${collection.instruction}, ${collection.resource})), ${input.q.toLowerCase()}) > 0`
      : undefined,
  );
  const [totals, counts, creators, destinations] = await Promise.all([
    db.select({ total: count() }).from(collection).where(where),
    db
      .select({
        all: count(),
        mine: sql<number>`count(*) filter (where ${collection.owned})::int`,
        public: sql<number>`count(*) filter (where ${collection.isPublic})::int`,
        private: sql<number>`count(*) filter (where not ${collection.isPublic})::int`,
      })
      .from(collection),
    db
      .select({
        value: collection.creator,
        label: sql<string>`min(${collection.creatorLabel})`,
      })
      .from(collection)
      .groupBy(collection.creator)
      .orderBy(sql`min(${collection.creatorLabel})`, collection.creator),
    db
      .select({
        value: collection.destination,
        label: sql<string>`min(${collection.destinationLabel})`,
      })
      .from(collection)
      .groupBy(collection.destination)
      .orderBy(
        sql`min(${collection.destinationLabel})`,
        collection.destination,
      ),
  ]);
  const total = totals[0]!.total;
  const page = Math.min(
    input.page,
    Math.max(1, Math.ceil(total / input.pageSize)),
  );
  const order =
    input.sort === "oldest"
      ? asc(collection.createdAtMs)
      : input.sort === "title"
        ? asc(
            sql`lower(coalesce(nullif(trim(${collection.title}), ''), ${collection.instruction}))`,
          )
        : desc(collection.createdAtMs);
  const rows = await db
    .select({ id: collection.id, kind: collection.kind })
    .from(collection)
    .where(where)
    .orderBy(order, desc(collection.id), asc(collection.kind))
    .limit(input.pageSize)
    .offset((page - 1) * input.pageSize);
  return {
    rows,
    total,
    page,
    pageSize: input.pageSize,
    counts: counts[0]!,
    creators,
    destinations,
  };
}
