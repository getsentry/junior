import type { SlackDestination, User } from "@sentry/junior-plugin-api";
import { and, desc, eq, exists, inArray, or } from "drizzle-orm";
import type { ConversationSourceTask } from "@/api/schema/conversation";
import type {
  AutomationExecutionDay,
  AutomationExecutionList,
  AutomationExecutionStatusDay,
  AutomationList,
  AutomationListQuery,
  AutomationRunList,
  AutomationSummary,
} from "@/api/schema/automation";
import { automationListQuerySchema } from "@/api/schema/automation";
import {
  readAutomationCollection,
  viewerAutomationCollection,
} from "./collection";
import { sumUtcHoursIntoSixHours } from "@/api/reporting-window";
import { fallbackShortTitle } from "@/chat/services/short-title";
import {
  emptyAutomationRunWindows,
  readAutomationExecutionByConversationId,
  readAutomationExecutionDays,
  readAutomationExecutionHours,
  readAutomationExecutions,
  readAutomationExecutionStatusDays,
  readAutomationExecutionStatusHours,
  readAutomationExecutionSummaries,
  readAutomationRuns,
  type AutomationExecutionSummary,
  type AutomationRunRecord,
} from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import {
  deleteEventAutomation,
  eventAutomationBelongsToUser,
  getEventAutomation,
  listDeletedEventAutomationsCreatedBy,
  parseEventAutomationRow,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import { eventAutomationTriggerAvailable } from "@/chat/event-automations/tool-support";
import type { EventAutomation } from "@/chat/event-automations/types";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  deleteViewerScheduledAutomation,
  PersonalScheduledAutomationNotFoundError,
} from "@/chat/scheduled-automations/personal";
import {
  parseScheduledAutomationRow,
  readScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import {
  juniorAutomationExecutions,
  juniorDestinations,
  juniorEventAutomations,
  juniorIdentities,
  juniorSchedulerTasks,
  juniorUsers,
} from "@/db/schema";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const TASK_EXECUTION_LIST_LIMIT = 100;

type TaskCandidate =
  | {
      kind: "event";
      ownedByViewer: boolean;
      task: EventAutomation;
    }
  | {
      kind: "scheduled";
      ownedByViewer: boolean;
      task: ScheduledAutomation;
    };

function creatorLabel(creator: {
  fullName?: string;
  slackUserId: string;
  userName?: string;
}): string {
  return (
    creator.fullName?.trim() ||
    (creator.userName?.trim() ? `@${creator.userName.trim()}` : "") ||
    creator.slackUserId
  );
}

function creatorKey(teamId: string, slackUserId: string): string {
  return `${teamId}:${slackUserId}`;
}

type CreatorProfile = { email?: string; avatarUrl?: string };

async function creatorProfiles(
  candidates: TaskCandidate[],
): Promise<Map<string, CreatorProfile>> {
  const selectors = new Map(
    candidates.map(({ task }) => {
      const teamId = task.destination.teamId;
      const slackUserId = task.createdBy.slackUserId;
      return [
        creatorKey(teamId, slackUserId),
        { slackUserId, teamId },
      ] as const;
    }),
  );
  if (selectors.size === 0) return new Map();
  const rows = await getDb()
    .select({
      avatarUrl: juniorIdentities.avatarUrl,
      email: juniorUsers.primaryEmailNormalized,
      emailVerified: juniorIdentities.emailVerified,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "slack"),
        or(
          ...[...selectors.values()].map((selector) =>
            and(
              eq(juniorIdentities.providerTenantId, selector.teamId),
              eq(juniorIdentities.providerSubjectId, selector.slackUserId),
            ),
          ),
        ),
      ),
    );
  return new Map(
    rows.map((row) => [
      creatorKey(row.teamId, row.slackUserId),
      {
        email: row.emailVerified ? (row.email ?? undefined) : undefined,
        avatarUrl: row.avatarUrl ?? undefined,
      },
    ]),
  );
}

function destinationKey(destination: SlackDestination): string {
  return `${destination.teamId}:${destination.channelId}`;
}

type DestinationDetails = {
  label: string;
  visibility: "private" | "public";
};

function displayText(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function taskDisplayTitle(
  title: string | undefined,
  instruction: string,
  fallback: string,
): string {
  const stored = title?.trim();
  if (stored) return stored;
  return fallbackShortTitle(instruction, fallback);
}

async function destinationDetails(
  destinations: SlackDestination[],
): Promise<Map<string, DestinationDetails>> {
  const selectors = new Map(
    destinations.map((destination) => [
      destinationKey(destination),
      destination,
    ]),
  );
  if (selectors.size === 0) return new Map();
  const rows = await getDb()
    .select({
      displayName: juniorDestinations.displayName,
      kind: juniorDestinations.kind,
      providerDestinationId: juniorDestinations.providerDestinationId,
      providerTenantId: juniorDestinations.providerTenantId,
      visibility: juniorDestinations.visibility,
    })
    .from(juniorDestinations)
    .where(
      or(
        ...[...selectors.values()].map((destination) =>
          and(
            eq(juniorDestinations.provider, "slack"),
            eq(juniorDestinations.providerTenantId, destination.teamId),
            eq(juniorDestinations.providerDestinationId, destination.channelId),
          ),
        ),
      ),
    );
  return new Map(
    rows.map((row) => {
      const name = row.displayName?.trim();
      const label = name
        ? row.kind === "channel"
          ? `#${name.replace(/^#/, "")}`
          : name
        : row.kind === "dm"
          ? "Direct message"
          : row.kind === "group"
            ? "Group message"
            : `Channel ${row.providerDestinationId}`;
      return [
        `${row.providerTenantId}:${row.providerDestinationId}`,
        {
          label,
          visibility: row.visibility === "public" ? "public" : "private",
        },
      ];
    }),
  );
}

function executionSummaryFields(stats: AutomationExecutionSummary | undefined) {
  return {
    ...(stats?.lastConversationId
      ? { lastConversationId: stats.lastConversationId }
      : undefined),
    ...(stats?.lastExecutedAtMs
      ? { lastRunAt: new Date(stats.lastExecutedAtMs).toISOString() }
      : undefined),
    runs: stats?.runs ?? emptyAutomationRunWindows(),
    totalRuns: stats?.totalRuns ?? 0,
  };
}

function scheduledAutomationSummary(
  task: ScheduledAutomation,
  ownedByViewer: boolean,
  destination: DestinationDetails,
  stats: AutomationExecutionSummary | undefined,
  creator: CreatorProfile | undefined,
): AutomationSummary {
  if (task.status === "deleted") {
    throw new Error(
      "Deleted scheduled automations cannot enter the Automations view",
    );
  }
  const nextRunAtMs = task.runNowAtMs ?? task.nextRunAtMs;
  const instruction = displayText(
    task.task.text,
    "Untitled scheduled automation",
  );
  return {
    createdAt: new Date(task.createdAtMs).toISOString(),
    createdBy: creatorLabel(task.createdBy),
    createdByEmail: creator?.email,
    createdByAvatarUrl: creator?.avatarUrl,
    destination: {
      channelId: task.destination.channelId,
      label: destination.label,
      teamId: task.destination.teamId,
      visibility: destination.visibility,
    },
    id: task.id,
    instruction,
    kind: "scheduled",
    ...executionSummaryFields(stats),
    ...(nextRunAtMs !== undefined
      ? { nextRunAt: new Date(nextRunAtMs).toISOString() }
      : undefined),
    ownedByViewer,
    schedule: displayText(task.schedule.description, "Schedule unavailable"),
    status: task.status,
    timezone: task.schedule.timezone,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    title: taskDisplayTitle(
      task.title,
      instruction,
      "Untitled scheduled automation",
    ),
  };
}

function eventAutomationSummary(
  task: EventAutomation,
  ownedByViewer: boolean,
  destination: DestinationDetails,
  stats: AutomationExecutionSummary | undefined,
  creator: CreatorProfile | undefined,
): AutomationSummary {
  const instruction = task.task.text;
  return {
    createdAt: new Date(task.createdAtMs).toISOString(),
    createdBy: creatorLabel(task.createdBy),
    createdByEmail: creator?.email,
    createdByAvatarUrl: creator?.avatarUrl,
    destination: {
      channelId: task.destination.channelId,
      label: destination.label,
      teamId: task.destination.teamId,
      visibility: destination.visibility,
    },
    events: task.trigger.events,
    match: task.trigger.match,
    id: task.id,
    instruction,
    kind: "event",
    ...executionSummaryFields(stats),
    ownedByViewer,
    resource: `${task.trigger.label} · ${task.trigger.identifier}`,
    source: task.trigger.namespace,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    title: taskDisplayTitle(
      task.title,
      instruction,
      "Untitled event automation",
    ),
    triggerAvailable: eventAutomationTriggerAvailable(task, getEventCatalog()),
  };
}

function viewerTeamIds(user: User): string[] {
  return [
    ...new Set(
      user.identities
        .filter((identity) => identity.provider === "slack")
        .map((identity) => identity.providerTenantId)
        .filter((teamId): teamId is string => Boolean(teamId)),
    ),
  ];
}

async function resolveViewerTaskCandidate(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<TaskCandidate | undefined> {
  const db = getDb();
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const teamIds = viewerTeamIds(user);
  if (kind === "scheduled") {
    const task = await readScheduledAutomation(db, id);
    if (!task || task.status === "deleted") return undefined;
    const ownedByViewer = identityIds.has(task.creatorIdentityId);
    const destinations = await destinationDetails([task.destination]);
    const destination = destinations.get(destinationKey(task.destination));
    const publicToViewer =
      teamIds.includes(task.destination.teamId) &&
      destination?.visibility === "public";
    if (!ownedByViewer && !publicToViewer) return undefined;
    return {
      kind: "scheduled",
      ownedByViewer,
      task,
    };
  }
  const task = await getEventAutomation(db, id);
  if (!task || task.status === "deleted") return undefined;
  const ownedByViewer = eventAutomationBelongsToUser(task, user);
  const destinations = await destinationDetails([task.destination]);
  const destination = destinations.get(destinationKey(task.destination));
  const publicToViewer =
    teamIds.includes(task.destination.teamId) &&
    destination?.visibility === "public";
  if (!ownedByViewer && !publicToViewer) return undefined;
  return {
    kind: "event",
    ownedByViewer,
    task,
  };
}

/** Read one current Automation summary with the Automations view access rules. */
export async function readViewerAutomationSummary(
  user: User,
  id: string,
): Promise<AutomationSummary | undefined> {
  const candidate =
    (await resolveViewerTaskCandidate(user, "scheduled", id)) ??
    (await resolveViewerTaskCandidate(user, "event", id));
  if (!candidate) return undefined;
  return automationSummaryForCandidate(candidate);
}

async function automationSummaryForCandidate(
  candidate: TaskCandidate,
): Promise<AutomationSummary> {
  const [destinations, creators, stats] = await Promise.all([
    destinationDetails([candidate.task.destination]),
    creatorProfiles([candidate]),
    readAutomationExecutionSummaries(candidate.kind, "junior", {
      automationIds: [candidate.task.id],
    }),
  ]);
  const destination = destinations.get(
    destinationKey(candidate.task.destination),
  ) ?? {
    label: `Channel ${candidate.task.destination.channelId}`,
    visibility: "private" as const,
  };
  const creator = creators.get(
    creatorKey(
      candidate.task.destination.teamId,
      candidate.task.createdBy.slackUserId,
    ),
  );
  if (candidate.kind === "scheduled") {
    return scheduledAutomationSummary(
      candidate.task,
      candidate.ownedByViewer,
      destination,
      stats.get(candidate.task.id),
      creator,
    );
  }
  return eventAutomationSummary(
    candidate.task,
    candidate.ownedByViewer,
    destination,
    stats.get(candidate.task.id),
    creator,
  );
}

function emptyAutomationExecutionDay(date: string): AutomationExecutionDay {
  return { costUsd: 0, date, event: 0, scheduled: 0 };
}

function emptyAutomationExecutionStatusDay(
  date: string,
): AutomationExecutionStatusDay {
  return { blocked: 0, completed: 0, date, failed: 0 };
}

function automationExecutionSixHours(
  hours: readonly AutomationExecutionDay[],
  nowMs = Date.now(),
): AutomationExecutionDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyAutomationExecutionDay,
    hours,
    nowMs,
  });
}

function automationExecutionStatusSixHours(
  hours: readonly AutomationExecutionStatusDay[],
  nowMs = Date.now(),
): AutomationExecutionStatusDay[] {
  return sumUtcHoursIntoSixHours({
    empty: emptyAutomationExecutionStatusDay,
    hours,
    nowMs,
  });
}

/** Read a page from the full accessible Automation collection. */
export async function readViewerAutomations(
  user: User,
  input: AutomationListQuery = automationListQuerySchema.parse({}),
): Promise<AutomationList> {
  const { rows, ...page } = await readAutomationCollection(user, input);
  const db = getDb();
  const ids = rows.map((row) => row.id);
  const [scheduled, events] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(juniorSchedulerTasks)
          .where(inArray(juniorSchedulerTasks.id, ids)),
        db
          .select()
          .from(juniorEventAutomations)
          .where(inArray(juniorEventAutomations.id, ids)),
      ])
    : [[], []];
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const candidates = new Map<string, TaskCandidate>();
  for (const row of scheduled) {
    const task = parseScheduledAutomationRow(row);
    if (task && task.status !== "deleted")
      candidates.set(`scheduled:${task.id}`, {
        kind: "scheduled",
        task,
        ownedByViewer: identityIds.has(task.creatorIdentityId),
      });
  }
  for (const row of events) {
    const task = parseEventAutomationRow(row);
    if (task.status !== "deleted")
      candidates.set(`event:${task.id}`, {
        kind: "event",
        task,
        ownedByViewer: eventAutomationBelongsToUser(task, user),
      });
  }
  const selected = rows.flatMap((row) => {
    const candidate = candidates.get(`${row.kind}:${row.id}`);
    return candidate ? [candidate] : [];
  });
  const [destinations, creators] = await Promise.all([
    destinationDetails(selected.map(({ task }) => task.destination)),
    creatorProfiles(selected),
  ]);
  const visible = selected.filter(
    (candidate) =>
      candidate.ownedByViewer ||
      destinations.get(destinationKey(candidate.task.destination))
        ?.visibility === "public",
  );
  const collection = viewerAutomationCollection(user);
  const access = exists(
    getDb()
      .select({ id: collection.id })
      .from(collection)
      .where(
        and(
          eq(collection.id, juniorAutomationExecutions.automationId),
          eq(collection.kind, juniorAutomationExecutions.kind),
          eq(juniorAutomationExecutions.namespace, "junior"),
        ),
      ),
  );
  const [executionDays, executionHours, scheduledStats, eventStats] =
    await Promise.all([
      readAutomationExecutionDays(90, { access }),
      readAutomationExecutionHours(7 * 24, { access }),
      readAutomationExecutionSummaries("scheduled", "junior", {
        automationIds: ids,
      }),
      readAutomationExecutionSummaries("event", "junior", {
        automationIds: ids,
      }),
    ]);
  const automations = visible.map((candidate): AutomationSummary => {
    const destination = destinations.get(
      destinationKey(candidate.task.destination),
    ) ?? {
      label: `Channel ${candidate.task.destination.channelId}`,
      visibility: "private" as const,
    };
    const creator = creators.get(
      creatorKey(
        candidate.task.destination.teamId,
        candidate.task.createdBy.slackUserId,
      ),
    );
    if (candidate.kind === "scheduled") {
      return scheduledAutomationSummary(
        candidate.task,
        candidate.ownedByViewer,
        destination,
        scheduledStats.get(candidate.task.id),
        creator,
      );
    }
    return eventAutomationSummary(
      candidate.task,
      candidate.ownedByViewer,
      destination,
      eventStats.get(candidate.task.id),
      creator,
    );
  });
  return {
    executionDays,
    executionHours,
    executionSixHours: automationExecutionSixHours(executionHours),
    automations,
    ...page,
  };
}

/** Load deleted scheduled automations the viewer still owns, newest first. */
async function readDeletedOwnedScheduledAutomations(
  user: User,
): Promise<ScheduledAutomation[]> {
  const identityIds = user.identities.map((identity) => identity.id);
  if (identityIds.length === 0) return [];
  const rows = await getDb()
    .select({
      creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
      id: juniorSchedulerTasks.id,
      record: juniorSchedulerTasks.record,
      title: juniorSchedulerTasks.title,
    })
    .from(juniorSchedulerTasks)
    .where(
      and(
        eq(juniorSchedulerTasks.status, "deleted"),
        inArray(juniorSchedulerTasks.creatorIdentityId, identityIds),
      ),
    )
    .orderBy(
      desc(juniorSchedulerTasks.createdAtMs),
      desc(juniorSchedulerTasks.id),
    )
    .limit(TASK_EXECUTION_LIST_LIMIT);
  return rows
    .map(parseScheduledAutomationRow)
    .filter((task): task is ScheduledAutomation => task?.status === "deleted");
}

/** Load deleted event automations the viewer still owns, newest first. */
async function readDeletedOwnedEventAutomations(
  user: User,
): Promise<StoredEventAutomation[]> {
  return await listDeletedEventAutomationsCreatedBy(
    getDb(),
    user,
    TASK_EXECUTION_LIST_LIMIT,
  );
}

function automationTitleForRun(
  run: AutomationRunRecord,
  automationTitles: Map<string, string>,
): string {
  return (
    automationTitles.get(`${run.kind}:${run.automationId}`) ??
    run.title?.trim() ??
    "Untitled task"
  );
}

function addDeletedAutomationRun(
  args: {
    kind: "scheduled" | "event";
    automationId: string;
    title: string;
  },
  automationTitles: Map<string, string>,
  automations: Array<{ kind: "scheduled" | "event"; automationId: string }>,
): void {
  const key = `${args.kind}:${args.automationId}`;
  if (automationTitles.has(key)) return;
  automationTitles.set(key, args.title);
  automations.push({ kind: args.kind, automationId: args.automationId });
}

/**
 * Read newest runs across live viewer-visible automations and deleted automations the
 * viewer owns. Deleted task rows stay available so history does not depend on
 * conversation actor membership.
 */
export async function readViewerAutomationRuns(
  user: User,
): Promise<AutomationRunList> {
  const [taskList, deletedScheduled, deletedEvent] = await Promise.all([
    getDb().select().from(viewerAutomationCollection(user)),
    readDeletedOwnedScheduledAutomations(user),
    readDeletedOwnedEventAutomations(user),
  ]);
  const automationTitles = new Map<string, string>();
  const automations: Array<{
    kind: "scheduled" | "event";
    automationId: string;
  }> = [];
  for (const task of taskList) {
    automationTitles.set(
      `${task.kind}:${task.id}`,
      taskDisplayTitle(
        task.title ?? undefined,
        task.instruction,
        `Untitled ${task.kind} automation`,
      ),
    );
    automations.push({ kind: task.kind, automationId: task.id });
  }
  for (const task of deletedScheduled) {
    const instruction = displayText(
      task.task.text,
      "Untitled scheduled automation",
    );
    addDeletedAutomationRun(
      {
        kind: "scheduled",
        automationId: task.id,
        title: taskDisplayTitle(
          task.title,
          instruction,
          "Untitled scheduled automation",
        ),
      },
      automationTitles,
      automations,
    );
  }
  for (const task of deletedEvent) {
    const instruction = displayText(
      task.task.text,
      "Untitled event automation",
    );
    addDeletedAutomationRun(
      {
        kind: "event",
        automationId: task.id,
        title: taskDisplayTitle(
          task.title,
          instruction,
          "Untitled event automation",
        ),
      },
      automationTitles,
      automations,
    );
  }
  const runs = await readAutomationRuns({
    limit: TASK_EXECUTION_LIST_LIMIT + 1,
    automations,
  });
  return {
    runs: runs.slice(0, TASK_EXECUTION_LIST_LIMIT).map((run) => ({
      ...run,
      automationTitle: automationTitleForRun(run, automationTitles),
    })),
    truncated: runs.length > TASK_EXECUTION_LIST_LIMIT,
  };
}

export class ViewerTaskNotFoundError extends Error {
  constructor() {
    super("Task was not found.");
    this.name = "ViewerTaskNotFoundError";
  }
}

/** Read one viewer-visible task and its newest terminal executions. */
export async function readViewerAutomationExecutions(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<AutomationExecutionList> {
  const candidate = await resolveViewerTaskCandidate(user, kind, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  const [automation, executions, executionDays, executionHours] =
    await Promise.all([
      automationSummaryForCandidate(candidate),
      readAutomationExecutions({
        kind,
        limit: TASK_EXECUTION_LIST_LIMIT + 1,
        automationId: id,
      }),
      readAutomationExecutionStatusDays({
        kind,
        automationId: id,
      }),
      readAutomationExecutionStatusHours({
        kind,
        automationId: id,
      }),
    ]);
  return {
    executionDays,
    executionHours,
    executionSixHours: automationExecutionStatusSixHours(executionHours),
    executions: executions.slice(0, TASK_EXECUTION_LIST_LIMIT),
    automation,
    truncated: executions.length > TASK_EXECUTION_LIST_LIMIT,
  };
}

/** Resolve the source task for one conversation when a terminal execution links it. */
export async function readConversationSourceTask(args: {
  conversationId: string;
  viewer?: User;
}): Promise<ConversationSourceTask | undefined> {
  const execution = await readAutomationExecutionByConversationId({
    conversationId: args.conversationId,
  });
  if (!execution) return undefined;
  if (!args.viewer) return { kind: execution.kind };
  const candidate = await resolveViewerTaskCandidate(
    args.viewer,
    execution.kind,
    execution.automationId,
  );
  if (!candidate) return { kind: execution.kind };
  if (candidate.kind === "scheduled") {
    const instruction = displayText(
      candidate.task.task.text,
      "Untitled scheduled automation",
    );
    return {
      id: candidate.task.id,
      kind: "scheduled",
      label: instruction,
      title: taskDisplayTitle(
        candidate.task.title,
        instruction,
        "Untitled scheduled automation",
      ),
    };
  }
  const instruction = displayText(
    candidate.task.task.text,
    "Untitled event automation",
  );
  return {
    id: candidate.task.id,
    kind: "event",
    label: instruction,
    title: taskDisplayTitle(
      candidate.task.title,
      instruction,
      "Untitled event automation",
    ),
  };
}

/** Delete one viewer-owned scheduled or event automation. */
export async function deleteViewerTask(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<void> {
  if (kind === "scheduled") {
    try {
      await deleteViewerScheduledAutomation(getDb(), user, id);
      return;
    } catch (error) {
      if (error instanceof PersonalScheduledAutomationNotFoundError) {
        throw new ViewerTaskNotFoundError();
      }
      throw error;
    }
  }
  const task = await getEventAutomation(getDb(), id);
  if (
    !task ||
    task.status === "deleted" ||
    !eventAutomationBelongsToUser(task, user)
  ) {
    throw new ViewerTaskNotFoundError();
  }
  await deleteEventAutomation(getDb(), id);
}
