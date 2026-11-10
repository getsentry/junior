import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import { getAgentInvocationIdForResult } from "./ids";
import {
  type AGENT_INVOCATION_PARENT_MAILBOX_STATUSES,
  resultDeliveryFor,
} from "./statuses";
import {
  agentInvocationSchema,
  type AgentInvocation,
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

/**
 * Values for one write of `parent_mailbox_status`. Each write also stores
 * the matching `result_delivery`.
 */
export function parentMailboxWrite(
  status: (typeof AGENT_INVOCATION_PARENT_MAILBOX_STATUSES)[number],
) {
  return {
    parentMailboxStatus: status,
    resultDelivery: resultDeliveryFor(status),
  };
}

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
    invocationId: row.invocationId,
    mailboxStatus: row.mailboxStatus,
    parentConversationId: row.parentConversationId,
    kind: row.kind,
    ...(row.parentMailboxStatus
      ? { parentMailboxStatus: row.parentMailboxStatus }
      : undefined),
    ...(row.parentToolCallId
      ? { parentToolCallId: row.parentToolCallId }
      : undefined),
    ...(row.agentType ? { agentType: row.agentType } : undefined),
    ...(row.reasoningLevel
      ? { reasoningLevel: row.reasoningLevel }
      : undefined),
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

/**
 * Return whether a child Conversation has work that will start another agent
 * invocation on it: another open agent invocation, an open child agent, or a
 * sent child agent result that no agent invocation has received yet.
 */
async function hasOpenChildWork(invocation: AgentInvocation): Promise<boolean> {
  const conversationId = invocation.childConversationId;
  const open = await listOpenAgentInvocations(conversationId);
  if (open.some((row) => row.invocationId !== invocation.invocationId)) {
    return true;
  }
  const db = getSqlExecutor().db();
  // A `replaced` child result is never sent. A later agent invocation of
  // that child agent sends its report instead.
  const sent = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.parentConversationId, conversationId),
        inArray(juniorAgentInvocations.parentMailboxStatus, [
          "pending",
          "appended",
        ]),
      ),
    );
  if (sent.length === 0) {
    return false;
  }
  const received = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      inArray(
        juniorAgentInvocations.invocationId,
        sent.map((row) => getAgentInvocationIdForResult(row.invocationId)),
      ),
    );
  return received.length < sent.length;
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

/** List terminal agent invocation results that still need a parent mailbox append. */
export async function listPendingAgentInvocationResults(
  limit = 100,
): Promise<TerminalAgentInvocation[]> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.parentMailboxStatus, "pending"))
    .orderBy(asc(juniorAgentInvocations.terminalAt))
    .limit(limit);
  return rows.map(invocationFromRow).filter(isTerminalAgentInvocation);
}

/**
 * Send a `replaced` result to the parent now. A stop ended the open work of
 * the child, so no later agent invocation sends the report.
 */
export async function reportReplacedAgentInvocation(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ ...parentMailboxWrite("pending"), updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.parentMailboxStatus, "replaced"),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Record that one terminal result is in its parent mailbox. */
export async function markAgentInvocationParentMailboxAppended(
  invocationId: string,
  nowMs = Date.now(),
): Promise<void> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({ ...parentMailboxWrite("appended"), updatedAt: new Date(nowMs) })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.parentMailboxStatus, "pending"),
      ),
    );
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
 * Persist one terminal invocation result without overwriting an earlier
 * result. The same write marks the result for the parent mailbox. If the
 * child still has open work, the result is `replaced`: the parent gets one
 * report, from the agent invocation that finishes the child's work.
 * `reportNow` sends the result even then, when that open work does not
 * continue this task.
 */
export async function completeAgentInvocation(
  args: (
    | {
        invocationId: string;
        result: string;
        status: "completed";
      }
    | {
        errorMessage: string;
        invocationId: string;
        status: "blocked" | "failed" | "stopped";
      }
  ) & { nowMs?: number; reportNow?: boolean },
): Promise<AgentInvocation | undefined> {
  const nowMs = args.nowMs ?? Date.now();
  const current = await getAgentInvocation(args.invocationId);
  if (!current || isTerminalAgentInvocation(current)) {
    return current;
  }
  // Open child work only moves forward, so a read before the write is safe:
  // each `replaced` result has open work that starts a later invocation. A
  // stop is always reported, because the stop also stops that open work.
  const parentMailboxStatus =
    !args.reportNow &&
    args.status !== "stopped" &&
    (await hasOpenChildWork(current))
      ? "replaced"
      : "pending";
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      status: args.status,
      result: args.status === "completed" ? args.result : null,
      errorMessage: args.status === "completed" ? null : args.errorMessage,
      ...parentMailboxWrite(parentMailboxStatus),
      terminalAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, args.invocationId),
        inArray(
          juniorAgentInvocations.status,
          NON_TERMINAL_AGENT_INVOCATION_STATUSES,
        ),
      ),
    );
  return await getAgentInvocation(args.invocationId);
}

/**
 * End a pending agent invocation whose input the running agent invocation of
 * the same child read as a steering message. The running agent invocation
 * reports for both, so this one is never sent to the parent.
 */
export async function markAgentInvocationSteered(
  invocationId: string,
  nowMs = Date.now(),
): Promise<AgentInvocation | undefined> {
  await getSqlExecutor()
    .db()
    .update(juniorAgentInvocations)
    .set({
      status: "completed",
      result: "",
      ...parentMailboxWrite("steered"),
      terminalAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorAgentInvocations.invocationId, invocationId),
        eq(juniorAgentInvocations.status, "pending"),
      ),
    );
  return await getAgentInvocation(invocationId);
}

/** Return whether an agent invocation has finished. */
export function isTerminalAgentInvocation(
  invocation: AgentInvocation,
): invocation is TerminalAgentInvocation {
  return TERMINAL_AGENT_INVOCATION_STATUSES.includes(
    invocation.status as (typeof TERMINAL_AGENT_INVOCATION_STATUSES)[number],
  );
}
