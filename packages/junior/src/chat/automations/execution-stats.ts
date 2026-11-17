import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { logWarn } from "@/chat/logging";
import { fallbackShortTitle } from "@/chat/services/short-title";
import {
  automationTaskDescription,
  automationTaskSchema,
} from "@/chat/automations/task";
import { agentTurnCostUsd, agentTurnTotalTokens } from "@/chat/usage";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorAutomations } from "@/db/schema/automations";
import {
  juniorAutomationRuns,
  type AutomationRunStatus,
} from "@/db/schema/automation-runs";
import { juniorAutomationVersions } from "@/db/schema/automation-versions";
import { AUTOMATION_RECENT_RUN_LIMIT } from "@/api/schema/automation";

export const AUTOMATION_EXECUTION_TYPES = ["scheduled", "event"] as const;
export const AUTOMATION_EXECUTION_STATUSES = [
  "blocked",
  "completed",
  "failed",
] as const satisfies readonly AutomationRunStatus[];

/** Outcome of an Automation run that finished. */
export type AutomationExecutionStatus =
  (typeof AUTOMATION_EXECUTION_STATUSES)[number];

/** An execution is a run with an outcome. Skipped runs are not executions. */
function isExecution(): SQL {
  return and(
    inArray(juniorAutomationRuns.status, [...AUTOMATION_EXECUTION_STATUSES]),
    isNotNull(juniorAutomationRuns.completedAtMs),
  )!;
}

export type AutomationExecutionType =
  (typeof AUTOMATION_EXECUTION_TYPES)[number];

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

export type AutomationRunWindows = {
  1: number;
  7: number;
  30: number;
  90: number;
};

/** Linked Conversation cost in USD for each dashboard range. */
export type AutomationCostWindows = AutomationRunWindows;

/** One run in the list run strip. */
export type AutomationRecentRun = {
  durationMs?: number;
  executedAt: string;
  status: AutomationExecutionStatus;
};

/** What a list row shows of an Automation's runs. */
export type AutomationRowStats = {
  lastRunStatus?: AutomationExecutionStatus;
  lastConversationId?: string;
  lastExecutedAtMs?: number;
  recentRuns: AutomationRecentRun[];
};

/** Row stats plus the totals that read every run. */
export type AutomationExecutionSummary = AutomationRowStats & {
  costUsd: AutomationCostWindows;
  runs: AutomationRunWindows;
  totalCostUsd: number;
  totalRuns: number;
};

const EMPTY_RUN_WINDOWS: AutomationRunWindows = { 1: 0, 7: 0, 30: 0, 90: 0 };

/** Empty run or cost windows for automations with no execution history. */
export function emptyAutomationRunWindows(): AutomationRunWindows {
  return { ...EMPTY_RUN_WINDOWS };
}

export type AutomationExecutionRecord = {
  automationVersion?: number;
  conversationId?: string;
  costUsd?: number;
  credentialMode?: "creator" | "system";
  durationMs?: number;
  error?: string;
  executedAt: string;
  executionId: string;
  scheduledFor?: string;
  startedAt?: string;
  status: AutomationExecutionStatus;
  title?: string;
  totalTokens?: number;
};

export type AutomationRunRecord = AutomationExecutionRecord & {
  kind: AutomationExecutionType;
  automationId: string;
};

export type AutomationExecutionStatusDay = {
  blocked: number;
  completed: number;
  costUsd: number;
  date: string;
  failed: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyStatusDay(date: string): AutomationExecutionStatusDay {
  return { blocked: 0, completed: 0, costUsd: 0, date, failed: 0 };
}

/**
 * Return the Conversation id when that Conversation exists, else null. A
 * dispatch can end before it creates its Conversation, and the run's
 * `conversation_id` is a foreign key.
 */
export function existingConversationId(conversationId: string): SQL {
  return sql`(select ${juniorConversations.conversationId} from ${juniorConversations} where ${juniorConversations.conversationId} = ${conversationId})`;
}

/**
 * Copy when an Automation's latest execution ended, and its outcome, to the
 * Automation row. Call it after each write that adds, settles, or removes an
 * execution. It reads the runs again, so a late or out-of-order write cannot
 * leave an older run.
 */
export async function refreshAutomationLastRun(
  db: JuniorDatabase,
  automationId: string,
): Promise<void> {
  const latest = (column: SQL) =>
    sql`(select ${column} from ${juniorAutomationRuns} where ${juniorAutomationRuns.automationId} = ${automationId} and ${isExecution()} order by ${juniorAutomationRuns.completedAtMs} desc, ${juniorAutomationRuns.id} desc limit 1)`;
  await db
    .update(juniorAutomations)
    .set({
      lastRunAtMs: latest(sql`${juniorAutomationRuns.completedAtMs}`),
      lastRunStatus: latest(sql`${juniorAutomationRuns.status}`),
    })
    .where(eq(juniorAutomations.id, automationId));
}

/**
 * Record the outcome of one Automation run. A run that already has an outcome
 * keeps it. A failed write is logged, and the heartbeat settles a started
 * event run later.
 */
export async function recordAutomationExecution(
  automationId: string,
  options: {
    conversationId?: string;
    errorMessage?: string | undefined;
    executionId: string;
    nowMs?: number;
    status?: AutomationExecutionStatus;
  },
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "completed";
  const outcome = {
    completedAtMs: nowMs,
    errorMessage: options.errorMessage ?? null,
    status,
  };
  try {
    await getDb()
      .insert(juniorAutomationRuns)
      .values({
        id: options.executionId,
        automationId,
        conversationId: options.conversationId
          ? existingConversationId(options.conversationId)
          : null,
        ...outcome,
      })
      .onConflictDoUpdate({
        target: juniorAutomationRuns.id,
        set: {
          ...outcome,
          conversationId: sql`coalesce(${juniorAutomationRuns.conversationId}, excluded.conversation_id)`,
        },
        setWhere: inArray(juniorAutomationRuns.status, ["pending", "running"]),
      });
    await refreshAutomationLastRun(getDb(), automationId);
  } catch (error) {
    logWarn("task.execution.stat_failed", {
      error,
      "app.task.execution.id": options.executionId,
      "app.task.execution.status": status,
      "app.task.execution.task_id": automationId,
    });
  }
}

/** Load usage analytics for the given automations. */
export async function readAutomationExecutionSummaries(
  automationIds: string[],
  options: { nowMs?: number } = {},
): Promise<Map<string, AutomationExecutionSummary>> {
  if (automationIds.length === 0) return new Map();
  const nowMs = options.nowMs ?? Date.now();
  const oneDayAgoMs = nowMs - 1 * 24 * 60 * 60 * 1000;
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysAgoMs = nowMs - 90 * 24 * 60 * 60 * 1000;
  const db = getDb();
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  const costSince = (sinceMs: number) =>
    sql<number>`coalesce(sum(${conversationCost}) filter (where ${juniorAutomationRuns.completedAtMs} >= ${sinceMs}), 0)::double precision`;
  const summaryRows = db
    .select({
      costLast1Day: costSince(oneDayAgoMs),
      costLast7Days: costSince(sevenDaysAgoMs),
      costLast30Days: costSince(thirtyDaysAgoMs),
      costLast90Days: costSince(ninetyDaysAgoMs),
      runsLast1Day: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${oneDayAgoMs})::int`,
      runsLast7Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${sevenDaysAgoMs})::int`,
      runsLast30Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${thirtyDaysAgoMs})::int`,
      runsLast90Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${ninetyDaysAgoMs})::int`,
      automationId: juniorAutomationRuns.automationId,
      totalCostUsd: sql<number>`coalesce(sum(${conversationCost}), 0)::double precision`,
      totalRuns: sql<number>`count(*)::int`,
    })
    .from(juniorAutomationRuns)
    .leftJoin(juniorConversations, executionConversation())
    .where(
      and(
        isExecution(),
        inArray(juniorAutomationRuns.automationId, automationIds),
      ),
    )
    .groupBy(juniorAutomationRuns.automationId);
  const [rows, rowStats] = await Promise.all([
    summaryRows,
    readAutomationRowStats(automationIds),
  ]);
  return new Map(
    rows.map((row) => [
      row.automationId,
      {
        ...rowStats.get(row.automationId)!,
        costUsd: {
          1: addUsd(0, row.costLast1Day),
          7: addUsd(0, row.costLast7Days),
          30: addUsd(0, row.costLast30Days),
          90: addUsd(0, row.costLast90Days),
        },
        runs: {
          1: row.runsLast1Day,
          7: row.runsLast7Days,
          30: row.runsLast30Days,
          90: row.runsLast90Days,
        },
        totalCostUsd: addUsd(0, row.totalCostUsd),
        totalRuns: row.totalRuns,
      },
    ]),
  );
}

/**
 * Load the newest runs of each Automation, oldest first, and its last run.
 * A lateral limit reads at most `AUTOMATION_RECENT_RUN_LIMIT` rows per
 * Automation from the (automation, completed) index, so long histories do
 * not slow the list. An Automation with no run is absent.
 */
export async function readAutomationRowStats(
  automationIds: string[],
): Promise<Map<string, AutomationRowStats>> {
  if (automationIds.length === 0) return new Map();
  const db = getDb();
  const recent = db
    .select({
      conversationId: juniorAutomationRuns.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorAutomationRuns.completedAtMs,
      executionId: juniorAutomationRuns.id,
      status: juniorAutomationRuns.status,
    })
    .from(juniorAutomationRuns)
    .leftJoin(juniorConversations, executionConversation())
    .where(
      and(
        isExecution(),
        eq(juniorAutomationRuns.automationId, juniorAutomations.id),
      ),
    )
    .orderBy(
      desc(juniorAutomationRuns.completedAtMs),
      desc(juniorAutomationRuns.id),
    )
    .limit(AUTOMATION_RECENT_RUN_LIMIT)
    .as("recent_run");
  const rows = await db
    .select({
      automationId: juniorAutomations.id,
      conversationId: recent.conversationId,
      durationMs: recent.durationMs,
      executedAtMs: recent.executedAtMs,
      status: recent.status,
    })
    .from(juniorAutomations)
    .innerJoinLateral(recent, sql`true`)
    .where(inArray(juniorAutomations.id, automationIds))
    .orderBy(
      juniorAutomations.id,
      asc(recent.executedAtMs),
      asc(recent.executionId),
    );
  const byAutomation = new Map<string, AutomationRowStats>();
  for (const row of rows) {
    const durationMs = positiveDuration(row.durationMs);
    // isExecution() selects only runs with an outcome and a completion time.
    const status = row.status as AutomationExecutionStatus;
    const executedAtMs = row.executedAtMs!;
    const stats = byAutomation.get(row.automationId) ?? { recentRuns: [] };
    stats.recentRuns.push({
      ...(durationMs !== undefined ? { durationMs } : undefined),
      executedAt: new Date(executedAtMs).toISOString(),
      status,
    });
    // Rows come oldest first, so the last one is the last run.
    byAutomation.set(row.automationId, {
      recentRuns: stats.recentRuns,
      lastRunStatus: status,
      lastExecutedAtMs: executedAtMs,
      ...(row.conversationId
        ? { lastConversationId: row.conversationId }
        : undefined),
    });
  }
  return byAutomation;
}

/** Keep a recorded runtime only when it is a real duration. */
function positiveDuration(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Load the Automation run linked to one conversation, if any. */
export async function readAutomationExecutionByConversationId(args: {
  conversationId: string;
}): Promise<
  | { kind: AutomationExecutionType; automationId: string; runId: string }
  | undefined
> {
  const [row] = await getDb()
    .select({
      kind: juniorAutomations.kind,
      automationId: juniorAutomationRuns.automationId,
      runId: juniorAutomationRuns.id,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .where(eq(juniorAutomationRuns.conversationId, args.conversationId))
    .limit(1);
  return row;
}

/**
 * Load the display name of the Automation linked to each untitled
 * conversation. Like the Automation list, the name falls back to the first
 * line of the instruction. Titled conversations and conversations without a
 * linked Automation are absent from the result.
 */
export async function readAutomationTitlesByConversationId(
  conversations: ReadonlyArray<{
    conversationId: string;
    title?: string | null | undefined;
  }>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const untitledIds = conversations.flatMap((conversation) =>
    conversation.title ? [] : [conversation.conversationId],
  );
  if (untitledIds.length === 0) return titles;
  const rows = await getDb()
    .select({
      conversationId: juniorAutomationRuns.conversationId,
      task: sql<unknown>`${juniorAutomations.record}->'task'`,
      title: juniorAutomations.title,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .where(inArray(juniorAutomationRuns.conversationId, untitledIds));
  for (const row of rows) {
    const title =
      row.title?.trim() ||
      fallbackShortTitle(
        automationTaskDescription(automationTaskSchema.parse(row.task)),
        "",
      );
    if (row.conversationId && title) titles.set(row.conversationId, title);
  }
  return titles;
}

/** Load newest-first executions for one automation, with conversation titles when present. */
export async function readAutomationExecutions(args: {
  automationId: string;
  limit: number;
}): Promise<AutomationExecutionRecord[]> {
  const rows = await getDb()
    .select(executionColumns)
    .from(juniorAutomationRuns)
    .leftJoin(juniorConversations, executionConversation())
    .leftJoin(juniorAutomationVersions, executionVersion())
    .where(
      and(
        isExecution(),
        eq(juniorAutomationRuns.automationId, args.automationId),
      ),
    )
    .orderBy(
      desc(juniorAutomationRuns.completedAtMs),
      desc(juniorAutomationRuns.id),
    )
    .limit(args.limit);
  return rows.map((row) => mapAutomationExecutionRecord(row));
}

/** Load newest-first executions for the supplied viewer-visible automations. */
export async function readAutomationRuns(args: {
  automationIds: string[];
  limit: number;
}): Promise<AutomationRunRecord[]> {
  if (args.automationIds.length === 0) return [];
  const rows = await getDb()
    .select({
      ...executionColumns,
      kind: juniorAutomations.kind,
      automationId: juniorAutomationRuns.automationId,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .leftJoin(juniorConversations, executionConversation())
    .leftJoin(juniorAutomationVersions, executionVersion())
    .where(
      and(
        isExecution(),
        inArray(juniorAutomationRuns.automationId, args.automationIds),
      ),
    )
    .orderBy(
      desc(juniorAutomationRuns.completedAtMs),
      desc(juniorAutomationRuns.id),
    )
    .limit(args.limit);
  return rows.map((row) => ({
    ...mapAutomationExecutionRecord(row),
    kind: row.kind,
    automationId: row.automationId,
  }));
}

/** Columns that describe one execution, its Conversation, and its version. */
const executionColumns = {
  automationVersion: juniorAutomationRuns.automationVersion,
  conversationId: juniorAutomationRuns.conversationId,
  credentialMode: sql<
    string | null
  >`${juniorAutomationVersions.definition}->>'credentialMode'`,
  durationMs: juniorConversations.durationMs,
  errorMessage: juniorAutomationRuns.errorMessage,
  executedAtMs: juniorAutomationRuns.completedAtMs,
  executionId: juniorAutomationRuns.id,
  scheduledForMs: juniorAutomationRuns.scheduledForMs,
  startedAtMs: juniorAutomationRuns.startedAtMs,
  status: juniorAutomationRuns.status,
  title: juniorConversations.title,
  usage: juniorConversations.usage,
};

function executionConversation(): SQL {
  return eq(
    juniorConversations.conversationId,
    juniorAutomationRuns.conversationId,
  );
}

function executionVersion(): SQL {
  return and(
    eq(
      juniorAutomationVersions.automationId,
      juniorAutomationRuns.automationId,
    ),
    eq(
      juniorAutomationVersions.version,
      juniorAutomationRuns.automationVersion,
    ),
  )!;
}

function isoTime(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toISOString();
}

function mapAutomationExecutionRecord(row: {
  automationVersion: number | null;
  conversationId: string | null;
  credentialMode: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  executedAtMs: number | null;
  executionId: string;
  scheduledForMs: number | null;
  startedAtMs: number | null;
  status: AutomationRunStatus;
  title: string | null;
  usage: Parameters<typeof agentTurnCostUsd>[0] | null;
}): AutomationExecutionRecord {
  const title = row.title?.trim();
  const costUsd = agentTurnCostUsd(row.usage ?? undefined);
  const totalTokens = agentTurnTotalTokens(row.usage ?? undefined);
  const durationMs = positiveDuration(row.durationMs);
  const error = row.errorMessage?.trim();
  const scheduledFor = isoTime(row.scheduledForMs);
  const startedAt = isoTime(row.startedAtMs);
  return {
    ...(row.automationVersion !== null
      ? { automationVersion: row.automationVersion }
      : undefined),
    ...(row.conversationId
      ? { conversationId: row.conversationId }
      : undefined),
    ...(costUsd !== undefined ? { costUsd } : undefined),
    ...(row.credentialMode === "creator" || row.credentialMode === "system"
      ? { credentialMode: row.credentialMode }
      : undefined),
    ...(durationMs !== undefined ? { durationMs } : undefined),
    ...(error ? { error } : undefined),
    // isExecution() selects only runs with an outcome and a completion time.
    executedAt: new Date(row.executedAtMs!).toISOString(),
    executionId: row.executionId,
    ...(scheduledFor ? { scheduledFor } : undefined),
    ...(startedAt ? { startedAt } : undefined),
    status: row.status as AutomationExecutionStatus,
    ...(title ? { title } : undefined),
    ...(totalTokens !== undefined ? { totalTokens } : undefined),
  };
}

/** Load a fixed trailing window of terminal executions for one automation by status. */
export async function readAutomationExecutionStatusDays(args: {
  automationId: string;
  dayCount?: number;
  nowMs?: number;
}): Promise<AutomationExecutionStatusDay[]> {
  const dayCount = args.dayCount ?? 90;
  const nowMs = args.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorAutomationRuns.completedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await readExecutionStatusBuckets({
    automationId: args.automationId,
    bucket: executionDate,
    endMs,
    startMs,
  });

  const byDate = new Map<string, AutomationExecutionStatusDay>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = utcDate(startMs + offset * 86_400_000);
    byDate.set(date, emptyStatusDay(date));
  }
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) continue;
    if (row.status === "completed") day.completed = row.count;
    else if (row.status === "failed") day.failed = row.count;
    else if (row.status === "blocked") day.blocked = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      day.costUsd = addUsd(day.costUsd, row.costUsd);
    }
  }
  return [...byDate.values()];
}

/** Load a fixed trailing window of terminal executions for one automation by hour. */
export async function readAutomationExecutionStatusHours(args: {
  automationId: string;
  hourCount?: number;
  nowMs?: number;
}): Promise<AutomationExecutionStatusDay[]> {
  const hourCount = args.hourCount ?? 7 * 24;
  const nowMs = args.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorAutomationRuns.completedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const rows = await readExecutionStatusBuckets({
    automationId: args.automationId,
    bucket: executionHour,
    endMs,
    startMs,
  });

  const byHour = new Map<string, AutomationExecutionStatusDay>();
  for (let offset = 0; offset < hourCount; offset += 1) {
    const date = new Date(startMs + offset * 3_600_000)
      .toISOString()
      .slice(0, 13);
    byHour.set(date, emptyStatusDay(date));
  }
  for (const row of rows) {
    const hour = byHour.get(row.date);
    if (!hour) continue;
    if (row.status === "completed") hour.completed = row.count;
    else if (row.status === "failed") hour.failed = row.count;
    else if (row.status === "blocked") hour.blocked = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      hour.costUsd = addUsd(hour.costUsd, row.costUsd);
    }
  }
  return [...byHour.values()];
}

/** Count one automation's executions and their cost per time bucket and status. */
async function readExecutionStatusBuckets(args: {
  automationId: string;
  bucket: SQL<string>;
  endMs: number;
  startMs: number;
}) {
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  return await getDb()
    .select({
      count: count(),
      costUsd: sql<number | null>`SUM(${conversationCost})::double precision`,
      date: args.bucket,
      status: juniorAutomationRuns.status,
    })
    .from(juniorAutomationRuns)
    .leftJoin(juniorConversations, executionConversation())
    .where(
      and(
        isExecution(),
        eq(juniorAutomationRuns.automationId, args.automationId),
        gte(juniorAutomationRuns.completedAtMs, args.startMs),
        lte(juniorAutomationRuns.completedAtMs, args.endMs),
      ),
    )
    .groupBy(args.bucket, juniorAutomationRuns.status)
    .orderBy(asc(args.bucket), asc(juniorAutomationRuns.status));
}
