import type { SlackDestination, User } from "@sentry/junior-plugin-api";
import { and, eq, or } from "drizzle-orm";
import type { ConversationSourceTask } from "@/api/schema/conversation";
import type {
  TaskExecutionList,
  TaskList,
  TaskRunList,
  TaskSummary,
} from "@/api/schema/task";
import { fallbackShortTitle } from "@/chat/services/short-title";
import {
  readTaskExecutionByConversationId,
  readTaskExecutionDays,
  readTaskExecutions,
  readTaskExecutionStatusDays,
  readTaskExecutionSummaries,
  readTaskRuns,
  type TaskExecutionSummary,
} from "@/chat/tasks/execution-stats";
import { getDb } from "@/chat/db";
import {
  deleteEventTask,
  eventTaskBelongsToUser,
  getEventTask,
  listEventTasksCreatedBy,
  listPublicEventTasksForTeams,
} from "@/chat/event-tasks/store";
import { eventTaskTriggerAvailable } from "@/chat/event-tasks/tool-support";
import type { EventTask } from "@/chat/event-tasks/types";
import { getResourceEventCatalog } from "@/chat/resource-events/runtime-catalog";
import {
  deleteViewerScheduledTask,
  listViewerScheduledTasks,
  PersonalScheduledTaskNotFoundError,
} from "@/chat/scheduled-tasks/personal";
import {
  listPublicScheduledTasksForTeams,
  readScheduledTask,
} from "@/chat/scheduled-tasks/tasks";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { juniorDestinations, juniorIdentities, juniorUsers } from "@/db/schema";

const TASK_LIST_LIMIT = 100;
const TASK_FETCH_LIMIT = TASK_LIST_LIMIT + 1;
const TASK_EXECUTION_LIST_LIMIT = 100;

type TaskCandidate =
  | {
      kind: "event";
      ownedByViewer: boolean;
      publicToViewer: boolean;
      task: EventTask;
    }
  | {
      kind: "scheduled";
      ownedByViewer: boolean;
      publicToViewer: boolean;
      task: ScheduledTask;
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

function executionSummaryFields(stats: TaskExecutionSummary | undefined) {
  return {
    ...(stats?.lastConversationId
      ? { lastConversationId: stats.lastConversationId }
      : undefined),
    ...(stats?.lastExecutedAtMs
      ? { lastRunAt: new Date(stats.lastExecutedAtMs).toISOString() }
      : undefined),
    runsLast7Days: stats?.runsLast7Days ?? 0,
    totalRuns: stats?.totalRuns ?? 0,
  };
}

function scheduledTaskSummary(
  task: ScheduledTask,
  ownedByViewer: boolean,
  destination: DestinationDetails,
  stats: TaskExecutionSummary | undefined,
  createdByEmail?: string,
): TaskSummary {
  if (task.status === "deleted") {
    throw new Error("Deleted scheduled tasks cannot enter the Tasks view");
  }
  const nextRunAtMs = task.runNowAtMs ?? task.nextRunAtMs;
  const instruction = displayText(task.task.text, "Untitled scheduled task");
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
    title: taskDisplayTitle(task.title, instruction, "Untitled scheduled task"),
  };
}

function eventTaskSummary(
  task: EventTask,
  ownedByViewer: boolean,
  destination: DestinationDetails,
  stats: TaskExecutionSummary | undefined,
  createdByEmail?: string,
): TaskSummary {
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
    title: taskDisplayTitle(task.title, instruction, "Untitled event task"),
    triggerAvailable: eventTaskTriggerAvailable(
      task,
      getResourceEventCatalog(),
    ),
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
    const task = await readScheduledTask(db, id);
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
  const task = await getEventTask(db, id);
  if (!task) return undefined;
  const ownedByViewer = eventTaskBelongsToUser(task, user);
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

async function taskSummaryForCandidate(
  candidate: TaskCandidate,
): Promise<TaskSummary> {
  const [destinations, creatorEmails, stats] = await Promise.all([
    destinationDetails([candidate.task.destination]),
    creatorProfileEmails([candidate]),
    readTaskExecutionSummaries(candidate.kind, "junior"),
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
    return scheduledTaskSummary(
      candidate.task,
      candidate.ownedByViewer,
      destination,
      stats.get(candidate.task.id),
      createdByEmail,
    );
  }
  return eventTaskSummary(
    candidate.task,
    candidate.ownedByViewer,
    destination,
    stats.get(candidate.task.id),
    createdByEmail,
  );
}

/** Read viewer-owned and public-workspace tasks as one bounded newest-first projection. */
export async function readViewerTasks(user: User): Promise<TaskList> {
  const db = getDb();
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const teamIds = viewerTeamIds(user);
  const [scheduledPage, publicScheduled, eventTasks, publicEventTasks] =
    await Promise.all([
      listViewerScheduledTasks(db, user, { limit: TASK_FETCH_LIMIT }),
      listPublicScheduledTasksForTeams(db, teamIds, TASK_FETCH_LIMIT),
      listEventTasksCreatedBy(db, user, TASK_FETCH_LIMIT),
      listPublicEventTasksForTeams(db, teamIds, TASK_FETCH_LIMIT),
    ]);
  const candidatesById = new Map<string, TaskCandidate>();
  const publicScheduledIds = new Set(publicScheduled.map((task) => task.id));
  const publicEventTaskIds = new Set(publicEventTasks.map((task) => task.id));
  for (const task of [...scheduledPage.tasks, ...publicScheduled]) {
    candidatesById.set(`scheduled:${task.id}`, {
      kind: "scheduled",
      ownedByViewer: identityIds.has(task.creatorIdentityId),
      publicToViewer: publicScheduledIds.has(task.id),
      task,
    });
  }
  for (const task of [...eventTasks, ...publicEventTasks]) {
    candidatesById.set(`event:${task.id}`, {
      kind: "event",
      ownedByViewer: eventTaskBelongsToUser(task, user),
      publicToViewer: publicEventTaskIds.has(task.id),
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
  const [executionDays, scheduledStats, eventStats] = await Promise.all([
    readTaskExecutionDays(),
    readTaskExecutionSummaries("scheduled", "junior"),
    readTaskExecutionSummaries("event", "junior"),
  ]);
  const tasks = visible.map((candidate): TaskSummary => {
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
      return scheduledTaskSummary(
        candidate.task,
        candidate.ownedByViewer,
        destination,
        scheduledStats.get(candidate.task.id),
        createdByEmail,
      );
    }
    return eventTaskSummary(
      candidate.task,
      candidate.ownedByViewer,
      destination,
      eventStats.get(candidate.task.id),
      createdByEmail,
    );
  });
  return {
    executionDays,
    tasks,
    truncated:
      ownedCandidates.length > TASK_LIST_LIMIT ||
      publicCandidates.length > TASK_LIST_LIMIT,
  };
}

/** Read newest runs across the viewer-visible scheduled and event tasks. */
export async function readViewerTaskRuns(user: User): Promise<TaskRunList> {
  const taskList = await readViewerTasks(user);
  const taskTitles = new Map(
    taskList.tasks.map((task) => [`${task.kind}:${task.id}`, task.title]),
  );
  const runs = await readTaskRuns({
    limit: TASK_EXECUTION_LIST_LIMIT + 1,
    tasks: taskList.tasks.map((task) => ({
      kind: task.kind,
      taskId: task.id,
    })),
  });
  return {
    runs: runs.slice(0, TASK_EXECUTION_LIST_LIMIT).map((run) => ({
      ...run,
      taskTitle: taskTitles.get(`${run.kind}:${run.taskId}`) ?? "Untitled task",
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
export async function readViewerTaskExecutions(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<TaskExecutionList> {
  const candidate = await resolveViewerTaskCandidate(user, kind, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  const [task, executions, executionDays] = await Promise.all([
    taskSummaryForCandidate(candidate),
    readTaskExecutions({
      kind,
      limit: TASK_EXECUTION_LIST_LIMIT + 1,
      taskId: id,
    }),
    readTaskExecutionStatusDays({
      kind,
      taskId: id,
    }),
  ]);
  return {
    executionDays,
    executions: executions.slice(0, TASK_EXECUTION_LIST_LIMIT),
    task,
    truncated: executions.length > TASK_EXECUTION_LIST_LIMIT,
  };
}

/** Resolve the source task for one conversation when a terminal execution links it. */
export async function readConversationSourceTask(args: {
  conversationId: string;
  viewer?: User;
}): Promise<ConversationSourceTask | undefined> {
  const execution = await readTaskExecutionByConversationId({
    conversationId: args.conversationId,
  });
  if (!execution) return undefined;
  if (!args.viewer) return { kind: execution.kind };
  const candidate = await resolveViewerTaskCandidate(
    args.viewer,
    execution.kind,
    execution.taskId,
  );
  if (!candidate) return { kind: execution.kind };
  if (candidate.kind === "scheduled") {
    const instruction = displayText(
      candidate.task.task.text,
      "Untitled scheduled task",
    );
    return {
      id: candidate.task.id,
      kind: "scheduled",
      label: instruction,
      title: taskDisplayTitle(
        candidate.task.title,
        instruction,
        "Untitled scheduled task",
      ),
    };
  }
  const instruction = displayText(
    candidate.task.task.text,
    "Untitled event task",
  );
  return {
    id: candidate.task.id,
    kind: "event",
    label: instruction,
    title: taskDisplayTitle(
      candidate.task.title,
      instruction,
      "Untitled event task",
    ),
  };
}

/** Delete one viewer-owned scheduled or event task. */
export async function deleteViewerTask(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<void> {
  if (kind === "scheduled") {
    try {
      await deleteViewerScheduledTask(getDb(), user, id);
      return;
    } catch (error) {
      if (error instanceof PersonalScheduledTaskNotFoundError) {
        throw new ViewerTaskNotFoundError();
      }
      throw error;
    }
  }
  const task = await getEventTask(getDb(), id);
  if (!task || !eventTaskBelongsToUser(task, user)) {
    throw new ViewerTaskNotFoundError();
  }
  await deleteEventTask(getDb(), id);
}
