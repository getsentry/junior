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
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { agentTurnCostUsd, agentTurnTotalTokens } from "@/chat/usage";
import { juniorConversations } from "@/db/schema/conversations";
import { juniorAutomations } from "@/db/schema/automations";
import {
  juniorAutomationRuns,
  type AutomationRunStatus,
} from "@/db/schema/automation-runs";

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

export type AutomationExecutionDay = {
  costUsd: number;
  date: string;
  event: number;
  scheduled: number;
};

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

export type AutomationRunWindows = {
  1: number;
  7: number;
  30: number;
  90: number;
};

export type AutomationExecutionSummary = {
  lastRunStatus?: AutomationExecutionStatus;
  lastConversationId?: string;
  lastExecutedAtMs?: number;
  runs: AutomationRunWindows;
  totalRuns: number;
};

const EMPTY_RUN_WINDOWS: AutomationRunWindows = { 1: 0, 7: 0, 30: 0, 90: 0 };

/** Empty run windows for automations with no execution history. */
export function emptyAutomationRunWindows(): AutomationRunWindows {
  return { ...EMPTY_RUN_WINDOWS };
}

export type AutomationExecutionRecord = {
  conversationId?: string;
  costUsd?: number;
  durationMs?: number;
  executedAt: string;
  executionId: string;
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
  date: string;
  failed: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyDay(date: string): AutomationExecutionDay {
  return { costUsd: 0, date, event: 0, scheduled: 0 };
}

function emptyStatusDay(date: string): AutomationExecutionStatusDay {
  return { blocked: 0, completed: 0, date, failed: 0 };
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
 * Record the outcome of one Automation run. A run that already has an outcome
 * keeps it. A failed write is logged, and the heartbeat settles a started
 * event run later.
 */
export async function recordAutomationExecution(
  automationId: string,
  options: {
    conversationId?: string;
    errorMessage?: string;
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
  const selected = and(
    isExecution(),
    inArray(juniorAutomationRuns.automationId, automationIds),
  );
  const latest = db
    .selectDistinctOn([juniorAutomationRuns.automationId], {
      status: juniorAutomationRuns.status,
      conversationId: juniorAutomationRuns.conversationId,
      automationId: juniorAutomationRuns.automationId,
    })
    .from(juniorAutomationRuns)
    .where(selected)
    .orderBy(
      juniorAutomationRuns.automationId,
      desc(juniorAutomationRuns.completedAtMs),
      desc(juniorAutomationRuns.id),
    )
    .as("latest_task_execution");
  const rows = await db
    .select({
      lastRunStatus: latest.status,
      lastConversationId: latest.conversationId,
      lastExecutedAtMs: max(juniorAutomationRuns.completedAtMs),
      runsLast1Day: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${oneDayAgoMs})::int`,
      runsLast7Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${sevenDaysAgoMs})::int`,
      runsLast30Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${thirtyDaysAgoMs})::int`,
      runsLast90Days: sql<number>`count(*) filter (where ${juniorAutomationRuns.completedAtMs} >= ${ninetyDaysAgoMs})::int`,
      automationId: juniorAutomationRuns.automationId,
      totalRuns: sql<number>`count(*)::int`,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      latest,
      eq(latest.automationId, juniorAutomationRuns.automationId),
    )
    .where(selected)
    .groupBy(
      juniorAutomationRuns.automationId,
      latest.conversationId,
      latest.status,
    );
  return new Map(
    rows.map((row) => [
      row.automationId,
      {
        lastRunStatus: row.lastRunStatus as AutomationExecutionStatus,
        ...(row.lastConversationId
          ? { lastConversationId: row.lastConversationId }
          : undefined),
        ...(row.lastExecutedAtMs !== null
          ? { lastExecutedAtMs: row.lastExecutedAtMs }
          : undefined),
        runs: {
          1: row.runsLast1Day,
          7: row.runsLast7Days,
          30: row.runsLast30Days,
          90: row.runsLast90Days,
        },
        totalRuns: row.totalRuns,
      },
    ]),
  );
}

/** Load a fixed trailing window of completed executions stacked by task type. */
export async function readAutomationExecutionDays(
  dayCount = 90,
  options: { nowMs?: number; access?: SQL } = {},
): Promise<AutomationExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorAutomationRuns.completedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await readCompletedExecutionBuckets({
    access: options.access,
    bucket: executionDate,
    endMs,
    startMs,
  });

  const byDate = new Map<string, AutomationExecutionDay>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = utcDate(startMs + offset * 86_400_000);
    byDate.set(date, emptyDay(date));
  }
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) continue;
    if (row.kind === "scheduled") day.scheduled = row.count;
    else if (row.kind === "event") day.event = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      day.costUsd = addUsd(day.costUsd, row.costUsd);
    }
  }
  return [...byDate.values()];
}

/** Load a fixed trailing window of completed executions stacked by hour. */
export async function readAutomationExecutionHours(
  hourCount = 7 * 24,
  options: { nowMs?: number; access?: SQL } = {},
): Promise<AutomationExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorAutomationRuns.completedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const rows = await readCompletedExecutionBuckets({
    access: options.access,
    bucket: executionHour,
    endMs,
    startMs,
  });

  const byHour = new Map<string, AutomationExecutionDay>();
  for (let offset = 0; offset < hourCount; offset += 1) {
    const date = new Date(startMs + offset * 3_600_000)
      .toISOString()
      .slice(0, 13);
    byHour.set(date, emptyDay(date));
  }
  for (const row of rows) {
    const hour = byHour.get(row.date);
    if (!hour) continue;
    if (row.kind === "scheduled") hour.scheduled = row.count;
    else if (row.kind === "event") hour.event = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      hour.costUsd = addUsd(hour.costUsd, row.costUsd);
    }
  }
  return [...byHour.values()];
}

/** Count completed executions and their cost per time bucket and kind. */
async function readCompletedExecutionBuckets(args: {
  access?: SQL;
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
      kind: juniorAutomations.kind,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationRuns.conversationId,
      ),
    )
    .where(
      and(
        gte(juniorAutomationRuns.completedAtMs, args.startMs),
        lte(juniorAutomationRuns.completedAtMs, args.endMs),
        eq(juniorAutomationRuns.status, "completed"),
        args.access,
      ),
    )
    .groupBy(args.bucket, juniorAutomations.kind)
    .orderBy(asc(args.bucket), asc(juniorAutomations.kind));
}

/** Load the Automation run linked to one conversation, if any. */
export async function readAutomationExecutionByConversationId(args: {
  conversationId: string;
}): Promise<
  { kind: AutomationExecutionType; automationId: string } | undefined
> {
  const [row] = await getDb()
    .select({
      kind: juniorAutomations.kind,
      automationId: juniorAutomationRuns.automationId,
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
    title?: string | null;
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
      instruction: juniorAutomations.instruction,
      title: juniorAutomations.title,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .where(inArray(juniorAutomationRuns.conversationId, untitledIds));
  for (const row of rows) {
    const title = row.title?.trim() || fallbackShortTitle(row.instruction, "");
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
    .select({
      conversationId: juniorAutomationRuns.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorAutomationRuns.completedAtMs,
      executionId: juniorAutomationRuns.id,
      status: juniorAutomationRuns.status,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorAutomationRuns)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationRuns.conversationId,
      ),
    )
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
      conversationId: juniorAutomationRuns.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorAutomationRuns.completedAtMs,
      executionId: juniorAutomationRuns.id,
      kind: juniorAutomations.kind,
      status: juniorAutomationRuns.status,
      automationId: juniorAutomationRuns.automationId,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationRuns.conversationId,
      ),
    )
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

function mapAutomationExecutionRecord(row: {
  conversationId: string | null;
  durationMs: number | null;
  executedAtMs: number | null;
  executionId: string;
  status: AutomationRunStatus;
  title: string | null;
  usage: Parameters<typeof agentTurnCostUsd>[0] | null;
}): AutomationExecutionRecord {
  const title = row.title?.trim();
  const costUsd = agentTurnCostUsd(row.usage ?? undefined);
  const totalTokens = agentTurnTotalTokens(row.usage ?? undefined);
  const durationMs =
    typeof row.durationMs === "number" &&
    Number.isFinite(row.durationMs) &&
    row.durationMs > 0
      ? row.durationMs
      : undefined;
  return {
    ...(row.conversationId
      ? { conversationId: row.conversationId }
      : undefined),
    ...(costUsd !== undefined ? { costUsd } : undefined),
    ...(durationMs !== undefined ? { durationMs } : undefined),
    // isExecution() selects only runs with an outcome and a completion time.
    executedAt: new Date(row.executedAtMs!).toISOString(),
    executionId: row.executionId,
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
  }
  return [...byHour.values()];
}

/** Count one automation's executions per time bucket and status. */
async function readExecutionStatusBuckets(args: {
  automationId: string;
  bucket: SQL<string>;
  endMs: number;
  startMs: number;
}) {
  return await getDb()
    .select({
      count: count(),
      date: args.bucket,
      status: juniorAutomationRuns.status,
    })
    .from(juniorAutomationRuns)
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
