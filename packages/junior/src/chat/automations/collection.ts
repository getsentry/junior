import {
  automationEventCatalog,
  registeredEventTriggerProblems,
} from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { eventAutomationTriggerSchema } from "@/chat/event-automations/types";
import type { AutomationViewer } from "./creator";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AutomationListQuery } from "@/api/schema/automation";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorDestinations,
} from "@/db/schema";

/**
 * The collection applies access before counts, filter options, and paging.
 * It is the SQL form of `resolveViewerTaskCandidate`; keep the two aligned. A
 * public Destination only grants access inside a viewer's linked Slack
 * workspaces.
 */
export function viewerAutomationCollection(viewer: AutomationViewer) {
  const db = getDb();
  const slackAccounts = viewer.identities.filter(
    (identity) => identity.provider === "slack" && identity.providerTenantId,
  );
  const teamIds = slackAccounts.map((identity) => identity.providerTenantId!);
  const identityIds = viewer.identities.flatMap((identity) =>
    identity.id ? [identity.id] : [],
  );
  const automation = juniorAutomations;
  const destination = juniorDestinations;
  const isScheduled = eq(automation.kind, "scheduled");
  // Keep this aligned with `isAutomationCreator`.
  const owned = or(
    inArray(automation.creatorIdentityId, identityIds),
    ...slackAccounts.map((account) =>
      and(
        eq(automation.teamId, account.providerTenantId!),
        eq(automation.creatorSlackUserId, account.providerSubjectId),
      ),
    ),
  )!;
  const publicDestination = sql<boolean>`coalesce(${destination.visibility} = 'public', false)`;
  const sharedToViewer = and(
    ne(automation.status, "completed"),
    or(
      and(inArray(automation.teamId, teamIds), publicDestination),
      viewer.location
        ? and(
            eq(automation.teamId, viewer.location.teamId),
            eq(automation.channelId, viewer.location.channelId),
          )
        : undefined,
    ),
  )!;
  const lastRun = juniorAutomationRuns;
  const lastRunNeedsAttention = sql<boolean>`coalesce(${lastRun.status} in ('failed', 'blocked'), false)`;
  // When the last run ended, or else when the Automation was created.
  const activityAtMs = sql<number>`coalesce(${lastRun.completedAtMs}, ${automation.createdAtMs})`;
  return db
    .select({
      kind: automation.kind,
      id: automation.id,
      title: automation.title,
      createdAtMs: automation.createdAtMs,
      lastRunId: automation.lastRunId,
      activityAtMs: activityAtMs.mapWith(Number).as("activity_at_ms"),
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
      skill: automation.skill,
      task: sql<unknown>`${automation.record}->'task'`.as("task"),
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
    .leftJoin(lastRun, eq(lastRun.id, automation.lastRunId))
    .where(and(ne(automation.status, "deleted"), or(owned, sharedToViewer)))
    .as("accessible_automations");
}

// `eventTriggerProblems` decides, the same check that the tools and the
// dashboard use, so SQL does not keep its own copy of the rules.
function eventTriggerAvailable(
  catalog: ReturnType<typeof automationEventCatalog>,
  trigger: unknown,
): boolean {
  const parsed = eventAutomationTriggerSchema.safeParse(trigger);
  return (
    parsed.success &&
    registeredEventTriggerProblems(catalog, parsed.data).length === 0
  );
}

/**
 * List the accessible event automations whose trigger cannot work with the
 * enabled plugins.
 */
async function unavailableEventAutomationIds(
  collection: ReturnType<typeof viewerAutomationCollection>,
): Promise<string[]> {
  const catalog = automationEventCatalog(getEventCatalog());
  const rows = await getDb()
    .select({ id: collection.id, trigger: collection.trigger })
    .from(collection)
    .where(eq(collection.kind, "event"));
  return rows.flatMap((row) =>
    eventTriggerAvailable(catalog, row.trigger) ? [] : [row.id],
  );
}

/**
 * Build the filters for Automations whose trigger cannot work and for those
 * that need attention: blocked, an unavailable trigger, or a last run that
 * failed or blocked. Paused and completed Automations never need attention.
 */
async function attentionFilters(
  collection: ReturnType<typeof viewerAutomationCollection>,
) {
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
  return { attention, unavailable };
}

/** Where a page of `sort=activity` ends: its last row's activity and ID. */
export type AutomationActivityPosition = { activityAtMs: number; id: string };

/** A viewer's access-scoped collection and the filters of one list query. */
export type AutomationListSelection = {
  collection: ReturnType<typeof viewerAutomationCollection>;
  where: SQL | undefined;
};

/** Build the access-scoped collection and the filters of one list query. */
export async function selectViewerAutomations(
  viewer: AutomationViewer,
  input: AutomationListQuery,
): Promise<AutomationListSelection> {
  const collection = viewerAutomationCollection(viewer);
  // The trigger check reads every accessible event Automation, so only the
  // filters that use it pay for it.
  const { attention, unavailable } =
    input.scope === "attention" || input.state === "unavailable"
      ? await attentionFilters(collection)
      : { attention: undefined, unavailable: undefined };
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
    input.owner === "me" ? eq(collection.owned, true) : undefined,
    input.destination
      ? eq(collection.destination, input.destination)
      : undefined,
    input.skill ? eq(collection.skill, input.skill) : undefined,
    // A pasted dashboard URL finds its Automation by ID.
    input.q
      ? sql`(strpos(lower(concat_ws(' ', ${collection.title}, ${collection.instruction}, ${collection.skill}, ${collection.resource})), ${input.q.toLowerCase()}) > 0 or strpos(${input.q.toLowerCase()}, lower(${collection.id})) > 0)`
      : undefined,
  );
  return { collection, where };
}

/**
 * Read one `sort=activity` page: the rows after `after`, newest activity
 * first. `next` is set when more rows follow.
 */
export async function readAutomationActivityPage(
  { collection, where }: AutomationListSelection,
  pageSize: number,
  after?: AutomationActivityPosition,
) {
  const db = getDb();
  const limit = pageSize + 1; // One extra row tells whether more follow.
  // Sorting the collection by its last run's end time would read the last
  // run of every row. Instead, walk runs newest first and keep each run that
  // is a listed Automation's last run, and merge the Automations that have no
  // run yet by creation time.
  const run = alias(juniorAutomationRuns, "page_run");
  const withRun = db
    .select({
      activityAtMs: sql<number>`${run.completedAtMs}`
        .mapWith(Number)
        .as("activity_at_ms"),
      id: collection.id,
      kind: collection.kind,
    })
    .from(run)
    .innerJoin(collection, eq(collection.lastRunId, run.id))
    .where(
      and(
        where,
        after
          ? and(
              lte(run.completedAtMs, after.activityAtMs),
              sql`(${run.completedAtMs}, ${collection.id}) < (${after.activityAtMs}, ${after.id})`,
            )
          : undefined,
      ),
    )
    .orderBy(desc(run.completedAtMs), desc(collection.id))
    .limit(limit);
  const withoutRun = db
    .select({
      activityAtMs: sql<number>`${collection.createdAtMs}`
        .mapWith(Number)
        .as("activity_at_ms"),
      id: collection.id,
      kind: collection.kind,
    })
    .from(collection)
    .where(
      and(
        where,
        isNull(collection.lastRunId),
        after
          ? sql`(${collection.createdAtMs}, ${collection.id}) < (${after.activityAtMs}, ${after.id})`
          : undefined,
      ),
    )
    .orderBy(desc(collection.createdAtMs), desc(collection.id))
    .limit(limit);
  const rows = await unionAll(withRun, withoutRun)
    .orderBy(desc(sql.identifier("activity_at_ms")), desc(sql.identifier("id")))
    .limit(limit);
  const pageRows = rows.slice(0, pageSize);
  const last = pageRows.at(-1);
  return {
    rows: pageRows,
    ...(rows.length > pageSize && last
      ? { next: { activityAtMs: last.activityAtMs, id: last.id } }
      : undefined),
  };
}

/** Read an SQL page by offset and complete, access-scoped counts and filter options. */
export async function readAutomationCollection(
  viewer: AutomationViewer,
  input: AutomationListQuery,
) {
  const selection = await selectViewerAutomations(viewer, input);
  const { collection, where } = selection;
  const facets = await readAutomationFacets(selection);
  const page = Math.min(
    input.page,
    Math.max(1, Math.ceil(facets.total / input.pageSize)),
  );
  const order =
    input.sort === "oldest"
      ? asc(collection.createdAtMs)
      : input.sort === "title"
        ? asc(
            sql`lower(coalesce(nullif(trim(${collection.title}), ''), ${collection.instruction}, ${collection.skill}))`,
          )
        : input.sort === "activity"
          ? desc(collection.activityAtMs)
          : desc(collection.createdAtMs);
  const rows = await getDb()
    .select({ id: collection.id, kind: collection.kind })
    .from(collection)
    .where(where)
    .orderBy(order, desc(collection.id))
    .limit(input.pageSize)
    .offset((page - 1) * input.pageSize);
  return { rows, page, pageSize: input.pageSize, ...facets };
}

/**
 * Read the match total, the scope counts, and the creator and Destination
 * options. Separate statements run in parallel on their own connections,
 * which measured faster than one grouped statement.
 */
export async function readAutomationFacets({
  collection,
  where,
}: AutomationListSelection) {
  const db = getDb();
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
  return {
    total: totals[0]!.total,
    counts: counts[0]!,
    creators,
    destinations,
  };
}
