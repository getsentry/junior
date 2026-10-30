import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { eventAutomationTriggerSchema } from "@/chat/event-automations/types";
import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { AutomationListQuery } from "@/api/schema/automation";
import { getDb } from "@/chat/db";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorDestinations,
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
  const automation = juniorAutomations;
  const destination = juniorDestinations;
  const isScheduled = eq(automation.kind, "scheduled");
  // Both kinds belong to the Junior identity that created them.
  const owned = inArray(
    automation.creatorIdentityId,
    user.identities.map((identity) => identity.id),
  );
  const publicDestination = sql<boolean>`coalesce(${destination.visibility} = 'public', false)`;
  const publicToViewer = and(
    inArray(automation.teamId, teamIds),
    publicDestination,
    ne(automation.status, "completed"),
  )!;
  const runs = juniorAutomationRuns;
  const lastRunNeedsAttention = sql<boolean>`coalesce((select ${runs.status} in ('failed', 'blocked') from ${runs}
      where ${runs.automationId} = ${automation.id} and ${runs.status} in ('blocked', 'completed', 'failed') and ${runs.completedAtMs} is not null
      order by ${runs.completedAtMs} desc, ${runs.id} desc limit 1), false)`;
  return db
    .select({
      kind: automation.kind,
      id: automation.id,
      title: automation.title,
      createdAtMs: automation.createdAtMs,
      state: sql<string>`${automation.status}`.as("state"),
      lastRunNeedsAttention: lastRunNeedsAttention.as(
        "last_run_needs_attention",
      ),
      trigger: sql<unknown>`${automation.record}->'trigger'`.as("trigger"),
      owned: sql<boolean>`${owned}`.as("owned"),
      resource:
        sql<string>`case when ${isScheduled} then '' else concat_ws(' ', ${automation.identifier}, ${automation.record}->'trigger'->>'label', ${automation.namespace}) end`.as(
          "resource",
        ),
      creator:
        sql<string>`${automation.teamId} || ':' || ${automation.creatorSlackUserId}`.as(
          "creator",
        ),
      creatorLabel:
        sql<string>`coalesce(nullif(trim(${automation.record}->'createdBy'->>'fullName'), ''), nullif(trim(${automation.record}->'createdBy'->>'userName'), ''), ${automation.creatorSlackUserId})`.as(
          "creator_label",
        ),
      destination:
        sql<string>`${automation.teamId} || ':' || ${automation.channelId}`.as(
          "destination",
        ),
      destinationLabel:
        sql<string>`coalesce(nullif(${destination.displayName}, ''), ${automation.channelId})`.as(
          "destination_label",
        ),
      isPublic: publicDestination.as("is_public"),
      instruction: automation.instruction,
    })
    .from(automation)
    .leftJoin(
      destination,
      and(
        eq(destination.provider, "slack"),
        eq(destination.providerTenantId, automation.teamId),
        eq(destination.providerDestinationId, automation.channelId),
      ),
    )
    .where(and(ne(automation.status, "deleted"), or(owned, publicToViewer)))
    .as("accessible_automations");
}

/**
 * List the accessible event automations whose trigger cannot work with the
 * enabled plugins. `eventTriggerProblems` decides, the same check that the
 * tools and the dashboard use, so SQL does not keep its own copy of the rules.
 */
async function unavailableEventAutomationIds(
  collection: ReturnType<typeof viewerAutomationCollection>,
): Promise<string[]> {
  const catalog = automationEventCatalog(getEventCatalog());
  const rows = await getDb()
    .select({ id: collection.id, trigger: collection.trigger })
    .from(collection)
    .where(eq(collection.kind, "event"));
  return rows.flatMap((row) => {
    const trigger = eventAutomationTriggerSchema.safeParse(row.trigger);
    const available =
      trigger.success &&
      registeredEventTriggerProblems(catalog, trigger.data).length === 0;
    return available ? [] : [row.id];
  });
}

/** Read an SQL page and complete, access-scoped counts and filter options. */
export async function readAutomationCollection(
  user: User,
  input: AutomationListQuery,
) {
  const db = getDb();
  const collection = viewerAutomationCollection(user);
  const unavailableIds = await unavailableEventAutomationIds(collection);
  const unavailable =
    unavailableIds.length > 0
      ? inArray(collection.id, unavailableIds)
      : sql`false`;
  const attention = and(
    notInArray(collection.state, ["paused", "completed"]),
    or(
      eq(collection.state, "blocked"),
      unavailable,
      eq(collection.lastRunNeedsAttention, true),
    ),
  );
  const where = and(
    input.scope === "mine"
      ? eq(collection.owned, true)
      : input.scope === "public"
        ? eq(collection.isPublic, true)
        : input.scope === "attention"
          ? attention
          : undefined,
    input.type === "all" ? undefined : eq(collection.kind, input.type),
    input.state === "all"
      ? undefined
      : input.state === "unavailable"
        ? unavailable
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
    .orderBy(order, desc(collection.id))
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
