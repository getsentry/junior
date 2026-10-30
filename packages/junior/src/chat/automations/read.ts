import type { SlackDestination, User } from "@sentry/junior-plugin-api";
import { and, desc, eq, exists, inArray, or } from "drizzle-orm";
import type { ConversationSourceTask } from "@/api/schema/conversation";
import type {
  AutomationExecutionDay,
  AutomationExecutionList,
  AutomationExecutionStatusDay,
  AutomationList,
  AutomationListQuery,
  AutomationVersionList,
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
import { isAutomationCreator } from "@/chat/automations/creator";
import { getDb } from "@/chat/db";
import {
  getDispatchIdForConversation,
  getDispatchInputMessageId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import {
  automationDefinition,
  listAutomationVersions,
  sameDefinitionValue,
} from "@/chat/automations/versions";
import {
  deleteEventAutomation,
  listDeletedEventAutomationsCreatedBy,
  parseEventAutomationRow,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import { describeEventAutomationTrigger } from "@/chat/event-automations/tool-support";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  deleteViewerScheduledAutomation,
  PersonalScheduledAutomationNotFoundError,
} from "@/chat/scheduled-automations/personal";
import { parseScheduledAutomationRow } from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const TASK_EXECUTION_LIST_LIMIT = 100;
const AUTOMATION_VERSION_LIST_LIMIT = 100;

export type TaskCandidate =
  | {
      kind: "event";
      ownedByViewer: boolean;
      task: StoredEventAutomation;
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
    lastRunStatus: stats?.lastRunStatus,
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
  const nextRunAtMs =
    task.status === "active"
      ? (task.runNowAtMs ?? task.nextRunAtMs)
      : undefined;
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
    statusReason: task.statusReason,
    timezone: task.schedule.timezone,
    credentialMode: task.credentialMode,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    title: taskDisplayTitle(
      task.title,
      instruction,
      "Untitled scheduled automation",
    ),
  };
}

function eventAutomationSummary(
  task: StoredEventAutomation,
  ownedByViewer: boolean,
  destination: DestinationDetails,
  stats: AutomationExecutionSummary | undefined,
  creator: CreatorProfile | undefined,
): AutomationSummary {
  const instruction = task.task.text;
  const catalog = getEventCatalog();
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
    kind: "event",
    ...executionSummaryFields(stats),
    ownedByViewer,
    resource: task.trigger.identifier
      ? `${task.trigger.label} · ${task.trigger.identifier}`
      : task.trigger.label,
    source: task.trigger.namespace,
    credentialMode: task.credentialMode,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    title: taskDisplayTitle(
      task.title,
      instruction,
      "Untitled event automation",
    ),
    status: task.status === "deleted" ? "active" : task.status,
    statusReason: task.statusReason,
    trigger: describeEventAutomationTrigger(task.trigger, catalog),
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

/** Resolve an Automation the viewer owns or can read through a public Destination. */
export async function resolveViewerTaskCandidate(
  user: User,
  id: string,
): Promise<TaskCandidate | undefined> {
  const [row] = await getDb()
    .select()
    .from(juniorAutomations)
    .where(eq(juniorAutomations.id, id))
    .limit(1);
  if (!row) return undefined;
  let candidate: TaskCandidate;
  if (row.kind === "scheduled") {
    const task = parseScheduledAutomationRow(row);
    if (!task) return undefined;
    candidate = {
      kind: "scheduled",
      ownedByViewer: isAutomationCreator(user, task),
      task,
    };
  } else {
    const task = parseEventAutomationRow(row);
    candidate = {
      kind: "event",
      ownedByViewer: isAutomationCreator(user, task),
      task,
    };
  }
  const { task } = candidate;
  if (task.status === "deleted") return undefined;
  if (candidate.ownedByViewer) return candidate;
  const destinations = await destinationDetails([task.destination]);
  const destination = destinations.get(destinationKey(task.destination));
  const publicToViewer =
    viewerTeamIds(user).includes(task.destination.teamId) &&
    destination?.visibility === "public";
  return publicToViewer ? candidate : undefined;
}

/** Read one current Automation summary with the Automations view access rules. */
export async function readViewerAutomationSummary(
  user: User,
  id: string,
): Promise<AutomationSummary | undefined> {
  const candidate = await resolveViewerTaskCandidate(user, id);
  if (!candidate) return undefined;
  return automationSummaryForCandidate(candidate);
}

async function automationSummaryForCandidate(
  candidate: TaskCandidate,
): Promise<AutomationSummary> {
  const [destinations, creators, stats] = await Promise.all([
    destinationDetails([candidate.task.destination]),
    creatorProfiles([candidate]),
    readAutomationExecutionSummaries([candidate.task.id]),
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
  const stored = ids.length
    ? await db
        .select()
        .from(juniorAutomations)
        .where(inArray(juniorAutomations.id, ids))
    : [];
  const candidates = new Map<string, TaskCandidate>();
  for (const row of stored) {
    if (row.kind === "scheduled") {
      const task = parseScheduledAutomationRow(row);
      if (task && task.status !== "deleted")
        candidates.set(task.id, {
          kind: "scheduled",
          task,
          ownedByViewer: isAutomationCreator(user, task),
        });
      continue;
    }
    const task = parseEventAutomationRow(row);
    if (task.status !== "deleted")
      candidates.set(task.id, {
        kind: "event",
        task,
        ownedByViewer: isAutomationCreator(user, task),
      });
  }
  const selected = rows.flatMap((row) => {
    const candidate = candidates.get(row.id);
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
      .where(eq(collection.id, juniorAutomationRuns.automationId)),
  );
  const [executionDays, executionHours, stats] = await Promise.all([
    readAutomationExecutionDays(90, { access }),
    readAutomationExecutionHours(7 * 24, { access }),
    readAutomationExecutionSummaries(ids),
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
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "scheduled"),
        eq(juniorAutomations.status, "deleted"),
        inArray(juniorAutomations.creatorIdentityId, identityIds),
      ),
    )
    .orderBy(desc(juniorAutomations.createdAtMs), desc(juniorAutomations.id))
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
    automationIds: automations.map((automation) => automation.automationId),
    limit: TASK_EXECUTION_LIST_LIMIT + 1,
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
  id: string,
): Promise<AutomationExecutionList> {
  const candidate = await resolveViewerTaskCandidate(user, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  const [automation, executions, executionDays, executionHours] =
    await Promise.all([
      automationSummaryForCandidate(candidate),
      readAutomationExecutions({
        automationId: id,
        limit: TASK_EXECUTION_LIST_LIMIT + 1,
      }),
      readAutomationExecutionStatusDays({ automationId: id }),
      readAutomationExecutionStatusHours({ automationId: id }),
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

/** Read saved definitions for one viewer-visible Automation, newest first. */
export async function readViewerAutomationVersions(
  user: User,
  id: string,
): Promise<AutomationVersionList> {
  const candidate = await resolveViewerTaskCandidate(user, id);
  if (!candidate) throw new ViewerTaskNotFoundError();
  const versions = await listAutomationVersions(
    getDb(),
    id,
    AUTOMATION_VERSION_LIST_LIMIT + 1,
  );
  const current = automationDefinition(candidate.task);
  const listed = versions.slice(0, AUTOMATION_VERSION_LIST_LIMIT);
  const catalog = getEventCatalog();
  return {
    versions: listed.map((version) =>
      version.kind === "event"
        ? {
            ...version,
            trigger: describeEventAutomationTrigger(
              version.definition.trigger,
              catalog,
            ),
          }
        : version,
    ),
    activeVersion:
      listed.find(({ definition }) => sameDefinitionValue(definition, current))
        ?.version ?? null,
    truncated: versions.length > AUTOMATION_VERSION_LIST_LIMIT,
  };
}

/** Name the event in a trigger, such as "opened" for `pull_request.opened`. */
function eventActionLabel(eventName: string): string {
  const [, ...action] = eventName.split(".");
  return (action.length > 0 ? action : [eventName])
    .join(" ")
    .replaceAll("_", " ");
}

/**
 * Read whose access one run used from its dispatch record. Return nothing when
 * the record is gone, because the Automation's current setting can differ.
 */
async function readRunCredential(
  dispatchId: string | undefined,
  creator: { fullName?: string; slackUserId: string; userName?: string },
): Promise<Pick<ConversationSourceTask, "credentialMode" | "credentialUser">> {
  if (!dispatchId) return {};
  const dispatch = await getDispatchRecord(dispatchId);
  if (!dispatch) return {};
  const subject = dispatch.credentialSubject;
  if (!subject) return { credentialMode: "system" };
  return {
    credentialMode: "creator",
    credentialUser:
      subject.userId === creator.slackUserId
        ? creatorLabel(creator)
        : subject.userId,
  };
}

/** Resolve the source task for one conversation when an Automation run links it. */
export async function readConversationSourceTask(args: {
  conversationId: string;
  viewer?: User;
}): Promise<ConversationSourceTask | undefined> {
  const execution = await readAutomationExecutionByConversationId({
    conversationId: args.conversationId,
  });
  if (!execution) return undefined;
  const dispatchId = getDispatchIdForConversation(args.conversationId);
  const base = {
    kind: execution.kind,
    ...(dispatchId
      ? { triggerMessageId: getDispatchInputMessageId(dispatchId) }
      : undefined),
  };
  if (!args.viewer) return base;
  const candidate = await resolveViewerTaskCandidate(
    args.viewer,
    execution.automationId,
  );
  if (!candidate) return base;
  const credential = await readRunCredential(
    dispatchId,
    candidate.task.createdBy,
  );
  if (candidate.kind === "scheduled") {
    const instruction = displayText(
      candidate.task.task.text,
      "Untitled scheduled automation",
    );
    const schedule = candidate.task.schedule.description.trim();
    return {
      ...base,
      ...credential,
      id: candidate.task.id,
      kind: "scheduled",
      label: instruction,
      title: taskDisplayTitle(
        candidate.task.title,
        instruction,
        "Untitled scheduled automation",
      ),
      ...(schedule ? { triggerLabel: schedule } : undefined),
    };
  }
  const instruction = displayText(
    candidate.task.task.text,
    "Untitled event automation",
  );
  const { events, label } = candidate.task.trigger;
  return {
    ...base,
    ...credential,
    id: candidate.task.id,
    kind: "event",
    label: instruction,
    title: taskDisplayTitle(
      candidate.task.title,
      instruction,
      "Untitled event automation",
    ),
    triggerLabel:
      events.length === 1 ? `${label} ${eventActionLabel(events[0]!)}` : label,
  };
}

/** Delete one viewer-owned scheduled or event automation. */
export async function deleteViewerTask(user: User, id: string): Promise<void> {
  const candidate = await resolveViewerTaskCandidate(user, id);
  if (!candidate?.ownedByViewer) throw new ViewerTaskNotFoundError();
  if (candidate.kind === "scheduled") {
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
  await deleteEventAutomation(getDb(), id);
}
