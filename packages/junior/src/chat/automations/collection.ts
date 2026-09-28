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
  return unionAll(
    db
      .select({
        kind: sql<"scheduled" | "event">`'scheduled'`.as("kind"),
        id: scheduled.id,
        title: sql<string | null>`${scheduled.title}`.as("title"),
        createdAtMs: scheduled.createdAtMs,
        state: scheduled.status,
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
          inArray(scheduled.status, ["active", "blocked", "completed"]),
          or(scheduledOwned, scheduledPublic),
        ),
      ),
    db
      .select({
        kind: sql<"scheduled" | "event">`'event'`.as("kind"),
        id: event.id,
        title: sql<string | null>`${event.title}`.as("title"),
        createdAtMs: event.createdAtMs,
        state: event.status,
        owned: sql<boolean>`${eventOwned}`.as("owned"),
        resource:
          sql<string>`concat_ws(' ', ${event.identifier}, ${event.task}->'trigger'->>'label', ${event.namespace})`.as(
            "resource",
          ),
        ...fields(event.task, event.teamId),
      })
      .from(event)
      .leftJoin(destination, destinationJoin(event.task, event.teamId))
      .where(and(eq(event.status, "active"), or(eventOwned, eventPublic))),
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
        : undefined,
    input.type === "all" ? undefined : eq(collection.kind, input.type),
    input.state === "all" ? undefined : eq(collection.state, input.state),
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
