import type { SlackDestination, User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { ConversationSourceTask } from "@/api/schema/conversation";
import type {
  AutomationExecutionDay,
  AutomationExecutionList,
  AutomationExecutionStatusDay,
  AutomationList,
  AutomationRunList,
  AutomationSummary,
} from "@/api/schema/automation";
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
  listEventAutomationsCreatedBy,
  listPublicEventAutomationsForTeams,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import { eventAutomationTriggerAvailable } from "@/chat/event-automations/tool-support";
import type { EventAutomation } from "@/chat/event-automations/types";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  deleteViewerScheduledAutomation,
  listViewerScheduledAutomations,
  PersonalScheduledAutomationNotFoundError,
} from "@/chat/scheduled-automations/personal";
import {
  listPublicScheduledAutomationsForTeams,
  parseScheduledAutomationRow,
  readScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import {
  juniorDestinations,
  juniorIdentities,
  juniorSchedulerTasks,
  juniorUsers,
} from "@/db/schema";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const TASK_LIST_LIMIT = 100;
const TASK_FETCH_LIMIT = TASK_LIST_LIMIT + 1;
const TASK_EXECUTION_LIST_LIMIT = 100;

type TaskCandidate =
  | {
      kind: "event";
      ownedByViewer: boolean;
      publicToViewer: boolean;
      task: EventAutomation;
    }
  | {
      kind: "scheduled";
      ownedByViewer: boolean;
      publicToViewer: boolean;
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

async function creatorProfileEmails(
  candidates: TaskCandidate[],
): Promise<Map<string, string>> {
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
      email: juniorUsers.primaryEmailNormalized,
      slackUserId: juniorIdentities.providerSubjectId,
      teamId: juniorIdentities.providerTenantId,
    })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.emailVerified, true),
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
    rows.map((row) => [creatorKey(row.teamId, row.slackUserId), row.email]),
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
  createdByEmail?: string,
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
    ...(createdByEmail ? { createdByEmail } : undefined),
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
  createdByEmail?: string,
): AutomationSummary {
  const instruction = task.task.text;
  return {
    createdAt: new Date(task.createdAtMs).toISOString(),
    createdBy: creatorLabel(task.createdBy),
    ...(createdByEmail ? { createdByEmail } : undefined),
    destination: {
      channelId: task.destination.channelId,
      label: destination.label,
      teamId: task.destination.teamId,
      visibility: destination.visibility,
    },
    events: task.trigger.events,
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
      publicToViewer,
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
    publicToViewer,
    task,
  };
}

async function automationSummaryForCandidate(
  candidate: TaskCandidate,
): Promise<AutomationSummary> {
  const [destinations, creatorEmails, stats] = await Promise.all([
    destinationDetails([candidate.task.destination]),
    creatorProfileEmails([candidate]),
    readAutomationExecutionSummaries(candidate.kind, "junior"),
  ]);
  const destination = destinations.get(
    destinationKey(candidate.task.destination),
  ) ?? {
    label: `Channel ${candidate.task.destination.channelId}`,
    visibility: "private" as const,
  };
  const createdByEmail = creatorEmails.get(
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
      createdByEmail,
    );
  }
  return eventAutomationSummary(
    candidate.task,
    candidate.ownedByViewer,
    destination,
    stats.get(candidate.task.id),
    createdByEmail,
  );
}

/** Read viewer-owned and public-workspace automations as one bounded newest-first projection. */
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

/** List one viewer's scheduled and event automations, optionally filtered by title or instruction search. */
export async function readViewerAutomations(
  user: User,
  input: { q?: string } = {},
): Promise<AutomationList> {
  const db = getDb();
  // TODO(dcramer): Search only matches task title and instruction text today.
  // Expand to run history and semantic search once title search ships.
  const query = input.q?.trim().toLowerCase() || undefined;
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const teamIds = viewerTeamIds(user);
  const [
    scheduledPage,
    publicScheduled,
    eventAutomations,
    publicEventAutomations,
  ] = await Promise.all([
    listViewerScheduledAutomations(db, user, {
      limit: TASK_FETCH_LIMIT,
      query,
    }),
    listPublicScheduledAutomationsForTeams(db, teamIds, {
      limit: TASK_FETCH_LIMIT,
      query,
    }),
    listEventAutomationsCreatedBy(db, user, TASK_FETCH_LIMIT, query),
    listPublicEventAutomationsForTeams(db, teamIds, TASK_FETCH_LIMIT, query),
  ]);
  const candidatesById = new Map<string, TaskCandidate>();
  const publicScheduledIds = new Set(publicScheduled.map((task) => task.id));
  const publicEventAutomationIds = new Set(
    publicEventAutomations.map((task) => task.id),
  );
  for (const task of [...scheduledPage.automations, ...publicScheduled]) {
    candidatesById.set(`scheduled:${task.id}`, {
      kind: "scheduled",
      ownedByViewer: identityIds.has(task.creatorIdentityId),
      publicToViewer: publicScheduledIds.has(task.id),
      task,
    });
  }
  for (const task of [...eventAutomations, ...publicEventAutomations]) {
    candidatesById.set(`event:${task.id}`, {
      kind: "event",
      ownedByViewer: eventAutomationBelongsToUser(task, user),
      publicToViewer: publicEventAutomationIds.has(task.id),
      task,
    });
  }
  const candidates = [...candidatesById.values()].sort(
    (left, right) =>
      right.task.createdAtMs - left.task.createdAtMs ||
      right.task.id.localeCompare(left.task.id),
  );
  const ownedCandidates = candidates.filter(
    (candidate) => candidate.ownedByViewer,
  );
  const publicCandidates = candidates.filter(
    (candidate) => candidate.publicToViewer,
  );
  const selectedCandidates = new Set([
    ...ownedCandidates.slice(0, TASK_LIST_LIMIT),
    ...publicCandidates.slice(0, TASK_LIST_LIMIT),
  ]);
  const selected = candidates.filter((candidate) =>
    selectedCandidates.has(candidate),
  );
  const [destinations, creatorEmails] = await Promise.all([
    destinationDetails(selected.map(({ task }) => task.destination)),
    creatorProfileEmails(selected),
  ]);
  const visible = selected.filter(
    (candidate) =>
      candidate.ownedByViewer ||
      destinations.get(destinationKey(candidate.task.destination))
        ?.visibility === "public",
  );
  const [executionDays, executionHours, scheduledStats, eventStats] =
    await Promise.all([
      readAutomationExecutionDays(),
      readAutomationExecutionHours(),
      readAutomationExecutionSummaries("scheduled", "junior"),
      readAutomationExecutionSummaries("event", "junior"),
    ]);
  const automations = visible.map((candidate): AutomationSummary => {
    const destination = destinations.get(
      destinationKey(candidate.task.destination),
    ) ?? {
      label: `Channel ${candidate.task.destination.channelId}`,
      visibility: "private" as const,
    };
    const createdByEmail = creatorEmails.get(
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
        createdByEmail,
      );
    }
    return eventAutomationSummary(
      candidate.task,
      candidate.ownedByViewer,
      destination,
      eventStats.get(candidate.task.id),
      createdByEmail,
    );
  });
  return {
    executionDays,
    executionHours,
    executionSixHours: automationExecutionSixHours(executionHours),
    automations,
    truncated:
      ownedCandidates.length > TASK_LIST_LIMIT ||
      publicCandidates.length > TASK_LIST_LIMIT,
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
    readViewerAutomations(user),
    readDeletedOwnedScheduledAutomations(user),
    readDeletedOwnedEventAutomations(user),
  ]);
  const automationTitles = new Map<string, string>();
  const automations: Array<{
    kind: "scheduled" | "event";
    automationId: string;
  }> = [];
  for (const task of taskList.automations) {
    automationTitles.set(`${task.kind}:${task.id}`, task.title);
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
