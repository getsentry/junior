import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import { appendClosingReport } from "./report";
import {
  agentInvocationSchema,
  type AgentInvocation,
  type AgentInvocationReportEntry,
  type AgentInvocationStatus,
  type TerminalAgentInvocation,
} from "./types";

const TERMINAL_AGENT_INVOCATION_STATUSES = [
  "blocked",
  "completed",
  "failed",
  "stopped",
] as const satisfies readonly AgentInvocationStatus[];
/** Statuses of an agent invocation that owns its child's Turn. */
export const ACTIVE_AGENT_INVOCATION_STATUSES = [
  "running",
  "paused",
] as const satisfies readonly AgentInvocationStatus[];
/** Statuses of an agent invocation that has not finished. */
export const NON_TERMINAL_AGENT_INVOCATION_STATUSES = [
  "pending",
  "running",
  "paused",
] as const satisfies readonly AgentInvocationStatus[];

/** Parse one agent invocation row. */
export function invocationFromRow(
  row: typeof juniorAgentInvocations.$inferSelect,
): AgentInvocation {
  return agentInvocationSchema.parse({
    actor: row.actor,
    ...(row.agentName ? { agentName: row.agentName } : undefined),
    childConversationId: row.childConversationId,
    createdAtMs: row.createdAt.getTime(),
    ...(row.credentialContext
      ? { credentialContext: row.credentialContext }
      : undefined),
    destination: row.destination,
    ...(row.errorMessage !== null
      ? { errorMessage: row.errorMessage }
      : undefined),
    input: row.input,
    ...(row.inputLabel ? { inputLabel: row.inputLabel } : undefined),
    invocationId: row.invocationId,
    mailboxStatus: row.mailboxStatus,
    parentConversationId: row.parentConversationId,
    ...(row.parentToolCallId
      ? { parentToolCallId: row.parentToolCallId }
      : undefined),
    ...(row.agentType ? { agentType: row.agentType } : undefined),
    ...(row.reasoningLevel
      ? { reasoningLevel: row.reasoningLevel }
      : undefined),
    ...(row.reportLog ? { reportLog: row.reportLog } : undefined),
    ...(row.result !== null ? { result: row.result } : undefined),
    source: row.source,
    status: row.status,
    ...(row.terminalAt
      ? { terminalAtMs: row.terminalAt.getTime() }
      : undefined),
    ...(row.title ? { title: row.title } : undefined),
    updatedAtMs: row.updatedAt.getTime(),
  });
}

/** Read one durable agent invocation. */
export async function getAgentInvocation(
  invocationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.invocationId, invocationId));
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

/** List the agent invocations of one child Conversation in the given statuses. */
export async function listAgentInvocationsForConversation(
  childConversationId: string,
  statuses: readonly AgentInvocationStatus[],
): Promise<AgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.childConversationId, childConversationId),
        inArray(juniorAgentInvocations.status, [...statuses]),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt));
  return rows.map(invocationFromRow);
}

/** Resolve the single invocation that may resume for one child conversation. */
export async function getActiveAgentInvocationForConversation(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const active = await listAgentInvocationsForConversation(
    childConversationId,
    ACTIVE_AGENT_INVOCATION_STATUSES,
  );
  if (active.length > 1) {
    throw new Error(
      `Child conversation ${childConversationId} has multiple active agent invocations`,
    );
  }
  return active[0];
}

/** Read the newest agent invocation of one child Conversation. */
export async function getLatestAgentInvocationForConversation(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.childConversationId, childConversationId))
    .orderBy(desc(juniorAgentInvocations.createdAt))
    .limit(1);
  return rows[0] ? invocationFromRow(rows[0]) : undefined;
}

/**
 * Read the name and the newest task title of one child Conversation, for
 * labels. Agent invocations that give a nested result to the child have no
 * title, so an agent invocation with a title comes first.
 */
export async function getChildAgentLabel(
  childConversationId: string,
): Promise<{ agentName: string | null; title: string | null } | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({
      agentName: juniorAgentInvocations.agentName,
      title: juniorAgentInvocations.title,
    })
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.childConversationId, childConversationId))
    .orderBy(
      sql`${juniorAgentInvocations.title} is null`,
      desc(juniorAgentInvocations.createdAt),
    )
    .limit(1);
  return row;
}

/**
 * List the open agent invocations that run on one Conversation or on its
 * child agents, oldest first. Open-work checks read this once and filter it.
 */
export async function listOpenAgentInvocations(
  conversationId: string,
): Promise<AgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        or(
          eq(juniorAgentInvocations.childConversationId, conversationId),
          eq(juniorAgentInvocations.parentConversationId, conversationId),
        ),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt));
  return rows.map(invocationFromRow);
}

/** List bounded invocation records whose mailbox append still needs repair. */
export async function listPendingAgentInvocationMailboxAppends(
  limit = 100,
): Promise<AgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.mailboxStatus, "pending"),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    )
    .orderBy(asc(juniorAgentInvocations.createdAt))
    .limit(limit);
  return rows.map(invocationFromRow);
}

/** Record that the invocation's idempotent mailbox append completed. */
export async function markAgentInvocationMailboxAppended(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ mailboxStatus: "appended", updatedAt: new Date(nowMs) })
    .where(eq(juniorAgentInvocations.invocationId, invocationId));
}

/** Mark one non-terminal invocation as actively executing. */
export async function markAgentInvocationRunning(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ status: "running", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Mark one invocation as waiting for another shared execution slice. */
export async function markAgentInvocationPaused(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ status: "paused", updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
}

/**
 * Save one report entry on a running agent invocation. A replay of the same
 * report or steering task does not save it twice.
 */
export async function appendAgentInvocationReport(
  invocationId: string,
  entry: AgentInvocationReportEntry,
  nowMs = Date.now(),
): Promise<void> {
  const key =
    entry.kind === "report"
      ? { key: entry.key, kind: entry.kind }
      : { invocationId: entry.invocationId, kind: entry.kind };
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      reportLog: sql`coalesce(${juniorAgentInvocations.reportLog}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
        sql`not coalesce(${juniorAgentInvocations.reportLog}, '[]'::jsonb) @> ${JSON.stringify([key])}::jsonb`,
      ),
    );
}

/** How one agent invocation ends. `closingReport` ends a parent task's log. */
export type AgentInvocationEnd = (
  | { noReply?: boolean; status: "completed" }
  | { errorMessage: string; status: "blocked" | "failed" | "stopped" }
) & { closingReport?: string };

/**
 * Return a parent task: work that a parent `spawnAgent` or `messageAgent`
 * call gave the child. Other work, such as a Watch Event Run, is own work.
 */
export function isParentTask(
  invocation: Pick<AgentInvocation, "parentToolCallId">,
): boolean {
  return invocation.parentToolCallId !== undefined;
}

function terminalColumns(
  current: AgentInvocation,
  end: AgentInvocationEnd,
  nowMs: number,
) {
  const completed = end.status === "completed";
  return {
    errorMessage: completed ? null : end.errorMessage,
    reportLog: isParentTask(current)
      ? appendClosingReport(current.reportLog, end.closingReport, {
          noReply: completed && Boolean(end.noReply),
        })
      : (current.reportLog ?? []),
    result: completed ? "" : null,
    status: end.status,
    terminalAt: new Date(nowMs),
  };
}

/**
 * Return the agent invocation as it reads after `end`, without saving it.
 * `finishAgentInvocation` renders the result from it before it saves.
 */
export function terminalAgentInvocation(
  current: AgentInvocation,
  end: AgentInvocationEnd,
  nowMs: number,
): TerminalAgentInvocation {
  const columns = terminalColumns(current, end, nowMs);
  return agentInvocationSchema.parse({
    ...current,
    ...(columns.errorMessage !== null
      ? { errorMessage: columns.errorMessage }
      : undefined),
    reportLog: columns.reportLog,
    ...(columns.result !== null ? { result: columns.result } : undefined),
    status: columns.status,
    terminalAtMs: nowMs,
  }) as TerminalAgentInvocation;
}

/**
 * Save how one agent invocation ended, without overwriting an earlier end.
 * Only `finishAgentInvocation` calls it, after it sent any result.
 * TODO(dcramer): Stop writing `parent_mailbox_status` in the cleanup after
 * this release. Until then, `appended` or `steered` keeps an older runtime
 * from sending the result again after a rollback.
 */
export async function saveTerminalAgentInvocation(
  invocationId: string,
  end: AgentInvocationEnd,
  options: { nowMs: number; resultSent: boolean },
): Promise<AgentInvocation | undefined> {
  const executor = getSqlExecutor();
  // The row lock keeps a report that `messageAgent` saves at the same time
  // from being lost: it lands before this read or sees the terminal status.
  return await executor.transaction(async () => {
    const [row] = await executor
      .db()
      .select()
      .from(juniorAgentInvocations)
      .where(eq(juniorAgentInvocations.invocationId, invocationId))
      .for("update");
    const current = row ? invocationFromRow(row) : undefined;
    if (!current || isTerminalAgentInvocation(current)) {
      return current;
    }
    await executor
      .db()
      .update(juniorAgentInvocations)
      .set({
        ...terminalColumns(current, end, options.nowMs),
        parentMailboxStatus: options.resultSent ? "appended" : "steered",
        updatedAt: new Date(options.nowMs),
      })
      .where(
        and(
          eq(juniorAgentInvocations.invocationId, invocationId),
          inArray(
            juniorAgentInvocations.status,
            NON_TERMINAL_AGENT_INVOCATION_STATUSES,
          ),
        ),
      );
    return await getAgentInvocation(invocationId);
  });
}

/** Return whether an agent invocation has finished. */
export function isTerminalAgentInvocation(
  invocation: AgentInvocation,
): invocation is TerminalAgentInvocation {
  return TERMINAL_AGENT_INVOCATION_STATUSES.includes(
    invocation.status as (typeof TERMINAL_AGENT_INVOCATION_STATUSES)[number],
  );
}
