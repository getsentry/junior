import type { SlackDestination, User } from "@sentry/junior-plugin-api";
import { and, eq, or } from "drizzle-orm";
import type { TaskList, TaskSummary } from "@/api/schema/task";
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
  createViewerScheduledTasks,
  PersonalScheduledTaskNotFoundError,
} from "@/chat/scheduled-tasks/personal";
import {
  createSchedulerSqlStore,
  listPublicScheduledTasksForTeams,
} from "@/chat/scheduled-tasks/store";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { juniorDestinations, juniorIdentities, juniorUsers } from "@/db/schema";

const TASK_LIST_LIMIT = 100;
const TASK_FETCH_LIMIT = TASK_LIST_LIMIT + 1;

type TaskCandidate =
  | { kind: "event"; ownedByViewer: boolean; task: EventTask }
  | { kind: "scheduled"; ownedByViewer: boolean; task: ScheduledTask };

function taskIsPublic(candidate: TaskCandidate): boolean {
  return candidate.kind === "scheduled"
    ? candidate.task.conversationAccess.visibility === "public"
    : candidate.task.destinationVisibility === "public";
}

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

async function destinationLabels(
  destinations: SlackDestination[],
): Promise<Map<string, string>> {
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
      return [`${row.providerTenantId}:${row.providerDestinationId}`, label];
    }),
  );
}

function scheduledTaskSummary(
  task: ScheduledTask,
  ownedByViewer: boolean,
  destinationLabel: string,
): TaskSummary {
  if (task.status === "deleted") {
    throw new Error("Deleted scheduled tasks cannot enter the Tasks view");
  }
  const nextRunAtMs = task.runNowAtMs ?? task.nextRunAtMs;
  return {
    createdAt: new Date(task.createdAtMs).toISOString(),
    createdBy: creatorLabel(task.createdBy),
    destination: {
      channelId: task.destination.channelId,
      label: destinationLabel,
      teamId: task.destination.teamId,
      visibility: task.conversationAccess.visibility,
    },
    id: task.id,
    instruction: task.task.text,
    kind: "scheduled",
    ...(nextRunAtMs !== undefined
      ? { nextRunAt: new Date(nextRunAtMs).toISOString() }
      : {}),
    ownedByViewer,
    schedule: task.schedule.description,
    status: task.status,
  };
}

/** Read viewer-owned and public-workspace tasks as one bounded newest-first projection. */
export async function readViewerTasks(user: User): Promise<TaskList> {
  const db = getDb();
  const schedulerStore = createSchedulerSqlStore(db);
  const identityIds = new Set(user.identities.map((identity) => identity.id));
  const teamIds = [
    ...new Set(
      user.identities
        .filter((identity) => identity.provider === "slack")
        .map((identity) => identity.providerTenantId)
        .filter((teamId): teamId is string => Boolean(teamId)),
    ),
  ];
  const [scheduledPage, publicScheduled, eventTasks, publicEventTasks] =
    await Promise.all([
      createViewerScheduledTasks(schedulerStore, user).list({
        limit: TASK_FETCH_LIMIT,
      }),
      listPublicScheduledTasksForTeams(db, teamIds, TASK_FETCH_LIMIT),
      listEventTasksCreatedBy(db, user, TASK_FETCH_LIMIT),
      listPublicEventTasksForTeams(db, teamIds, TASK_FETCH_LIMIT),
    ]);
  const candidatesById = new Map<string, TaskCandidate>();
  for (const task of [...scheduledPage.tasks, ...publicScheduled]) {
    candidatesById.set(`scheduled:${task.id}`, {
      kind: "scheduled",
      ownedByViewer: identityIds.has(task.creatorIdentityId),
      task,
    });
  }
  for (const task of [...eventTasks, ...publicEventTasks]) {
    candidatesById.set(`event:${task.id}`, {
      kind: "event",
      ownedByViewer: eventTaskBelongsToUser(task, user),
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
  const publicCandidates = candidates.filter(taskIsPublic);
  const selectedCandidates = new Set([
    ...ownedCandidates.slice(0, TASK_LIST_LIMIT),
    ...publicCandidates.slice(0, TASK_LIST_LIMIT),
  ]);
  const selected = candidates.filter((candidate) =>
    selectedCandidates.has(candidate),
  );
  const [labels, creatorEmails] = await Promise.all([
    destinationLabels(selected.map(({ task }) => task.destination)),
    creatorProfileEmails(selected),
  ]);
  const eventCatalog = getResourceEventCatalog();
  const tasks = selected.map((candidate): TaskSummary => {
    const label =
      labels.get(destinationKey(candidate.task.destination)) ??
      `Channel ${candidate.task.destination.channelId}`;
    const createdByEmail = creatorEmails.get(
      creatorKey(
        candidate.task.destination.teamId,
        candidate.task.createdBy.slackUserId,
      ),
    );
    if (candidate.kind === "scheduled") {
      const summary = scheduledTaskSummary(
        candidate.task,
        candidate.ownedByViewer,
        label,
      );
      return {
        ...summary,
        ...(createdByEmail ? { createdByEmail } : {}),
      };
    }
    const task = candidate.task;
    return {
      createdAt: new Date(task.createdAtMs).toISOString(),
      createdBy: creatorLabel(task.createdBy),
      ...(createdByEmail ? { createdByEmail } : {}),
      destination: {
        channelId: task.destination.channelId,
        label,
        teamId: task.destination.teamId,
        visibility: task.destinationVisibility,
      },
      events: task.trigger.events,
      id: task.id,
      instruction: task.task.text,
      kind: "event",
      ownedByViewer: candidate.ownedByViewer,
      resource: `${task.trigger.label} · ${task.trigger.identifier}`,
      source: task.trigger.namespace,
      triggerAvailable: eventTaskTriggerAvailable(task, eventCatalog),
    };
  });
  return {
    tasks,
    truncated:
      ownedCandidates.length > TASK_LIST_LIMIT ||
      publicCandidates.length > TASK_LIST_LIMIT,
  };
}

export class ViewerTaskNotFoundError extends Error {
  constructor() {
    super("Task was not found.");
    this.name = "ViewerTaskNotFoundError";
  }
}

/** Delete one viewer-owned scheduled or event task. */
export async function deleteViewerTask(
  user: User,
  kind: "scheduled" | "event",
  id: string,
): Promise<void> {
  if (kind === "scheduled") {
    try {
      await createViewerScheduledTasks(
        createSchedulerSqlStore(getDb()),
        user,
      ).delete(id);
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
