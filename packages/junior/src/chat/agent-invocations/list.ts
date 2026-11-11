import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { getAgentInvocationIdForResult, isAgentReplyMessageId } from "./ids";
import {
  invocationFromRow,
  isTerminalAgentInvocation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
} from "./store";
import {
  CHILD_AGENT_RESULTS,
  type AgentInvocation,
  type AgentInvocationStatus,
  type ChildAgent,
  type ChildAgentResult,
} from "./types";

function isChildAgentResult(
  status: AgentInvocationStatus,
): status is ChildAgentResult {
  return (CHILD_AGENT_RESULTS as readonly string[]).includes(status);
}

/** Bound the agent invocations that one child agent listing reads. */
const CHILD_AGENT_LIST_INVOCATION_LIMIT = 200;

/** Return whether a child's session stopped after its latest agent invocation. */
export function isChildAgentSessionStopped(
  latest: AgentInvocation,
  stoppedAtMs: number | undefined,
): boolean {
  return stoppedAtMs !== undefined && stoppedAtMs >= latest.createdAtMs;
}

/** Stored facts of a child Conversation that its listing shows. */
type ChildConversationFacts = Pick<ChildAgent, "archivedAtMs" | "kind"> & {
  stoppedAtMs?: number;
};

/** Return the child state that one child's agent invocations show. */
function childAgentFromInvocations(
  invocations: readonly AgentInvocation[],
  resultInvocationIds: ReadonlySet<string>,
  facts: ChildConversationFacts,
): ChildAgent {
  const { stoppedAtMs } = facts;
  // `invocations` is newest first. The oldest open agent invocation is the
  // one that runs, so it owns the status. A `steered` agent invocation never
  // ran: the agent invocation that read its input owns its status.
  const latest = invocations[0]!;
  let current =
    invocations.find(
      (invocation) =>
        !isTerminalAgentInvocation(invocation) ||
        invocation.parentMailboxStatus !== "steered",
    ) ?? latest;
  for (const invocation of invocations) {
    if (!isTerminalAgentInvocation(invocation)) {
      current = invocation;
    }
  }
  // A task comes from a parent tool call: spawnAgent or messageAgent. An
  // agent invocation that gives a grandchild result or message, or a watch
  // event, to the child is not a task.
  const tasks = invocations.filter(
    (invocation) =>
      invocation.source.kind === "agent_invocation" &&
      !resultInvocationIds.has(invocation.invocationId),
  );
  const task =
    tasks.find((invocation) => invocation.parentToolCallId) ??
    tasks[0] ??
    invocations[invocations.length - 1]!;
  const terminal = isTerminalAgentInvocation(current) ? current : undefined;
  // A `replaced`, `skipped`, or `steered` result is not reported, so it does
  // not count as a result. A tree stop marks `replaced` results `skipped`.
  const lastResult = invocations
    .filter(isTerminalAgentInvocation)
    .filter(
      (invocation) =>
        invocation.parentMailboxStatus !== "replaced" &&
        invocation.parentMailboxStatus !== "skipped" &&
        invocation.parentMailboxStatus !== "steered",
    )
    .map((invocation) => invocation.status)
    .find(isChildAgentResult);
  return {
    ...(latest.agentName ? { agentName: latest.agentName } : undefined),
    ...(facts.archivedAtMs !== undefined
      ? { archivedAtMs: facts.archivedAtMs }
      : undefined),
    childConversationId: latest.childConversationId,
    ...(terminal && terminal.status !== "completed"
      ? { errorMessage: terminal.errorMessage }
      : undefined),
    kind: facts.kind,
    ...(lastResult ? { lastResult } : undefined),
    // A `replaced` result means open child work starts a later agent
    // invocation on this child, so the child has not finished. Only a stop
    // skips a result.
    status: isChildAgentSessionStopped(latest, stoppedAtMs)
      ? "stopped"
      : terminal?.parentMailboxStatus === "replaced"
        ? "pending"
        : terminal?.parentMailboxStatus === "skipped"
          ? "stopped"
          : current.status,
    task: task.input,
    ...(task.title ? { title: task.title } : undefined),
    updatedAtMs: Math.max(
      ...invocations.map((invocation) => invocation.updatedAtMs),
    ),
  };
}

/**
 * List the direct child agents of one parent Conversation, with the newest
 * activity first. The state comes from SQL agent invocation records, not from
 * model output.
 */
export async function listChildAgents(
  parentConversationId: string,
): Promise<ChildAgent[]> {
  const db = getSqlExecutor().db();
  const rows = await db
    .select()
    .from(juniorAgentInvocations)
    .where(
      eq(juniorAgentInvocations.parentConversationId, parentConversationId),
    )
    .orderBy(desc(juniorAgentInvocations.createdAt))
    .limit(CHILD_AGENT_LIST_INVOCATION_LIMIT);
  if (rows.length === 0) {
    return [];
  }
  const byChild = new Map<string, AgentInvocation[]>();
  for (const invocation of rows.map(invocationFromRow)) {
    const invocations = byChild.get(invocation.childConversationId) ?? [];
    invocations.push(invocation);
    byChild.set(invocation.childConversationId, invocations);
  }
  const grandchildren = await db
    .select({ invocationId: juniorAgentInvocations.invocationId })
    .from(juniorAgentInvocations)
    .where(
      inArray(juniorAgentInvocations.parentConversationId, [...byChild.keys()]),
    );
  const resultInvocationIds = new Set(
    grandchildren.map((row) => getAgentInvocationIdForResult(row.invocationId)),
  );
  const conversations = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      stoppedAt: juniorConversations.stoppedAt,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, [...byChild.keys()]));
  const factsByChild = new Map(
    conversations.map((row): [string, ChildConversationFacts] => [
      row.conversationId,
      {
        ...(row.archivedAt
          ? { archivedAtMs: row.archivedAt.getTime() }
          : undefined),
        kind: conversationKindFromRow(row) === "thread" ? "thread" : "task",
        ...(row.stoppedAt
          ? { stoppedAtMs: row.stoppedAt.getTime() }
          : undefined),
      },
    ]),
  );
  return [...byChild.entries()]
    .map(([childConversationId, invocations]) =>
      childAgentFromInvocations(
        invocations,
        resultInvocationIds,
        // A child row from before the kind column reads as a Task.
        factsByChild.get(childConversationId) ?? { kind: "task" },
      ),
    )
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

/**
 * Return whether a completed agent invocation still sends its result text to
 * the parent. Only a row saved before `reply` existed does: its text is a
 * final response, and no `reply` of it is in `parentInboundMessageIds`.
 * TODO(dcramer): Remove one release after getsentry/junior#3160, when no
 * completed row from before it can still be in flight.
 */
export function sendsCompletedResult(
  invocation: { invocationId: string; result?: string | null },
  parentInboundMessageIds: readonly string[],
): boolean {
  return (
    Boolean(invocation.result?.trim()) &&
    !parentInboundMessageIds.some((messageId) =>
      isAgentReplyMessageId(messageId, invocation.invocationId),
    )
  );
}

/**
 * List the other child agents of one parent whose results have not reached
 * the parent yet. A child counts while it runs and after it finishes until its
 * result is appended to the parent mailbox. A running child whose `reply` is
 * already in `parentInboundMessageIds`, the ids that reached the parent's
 * mailbox, has answered, so it does not count.
 */
export async function listUnreportedSiblingAgents(
  parentConversationId: string,
  childConversationId: string,
  parentInboundMessageIds: readonly string[],
): Promise<ChildAgent[]> {
  const db = getSqlExecutor().db();
  const [children, pendingResults, openInvocations] = await Promise.all([
    listChildAgents(parentConversationId),
    db
      .select({
        childConversationId: juniorAgentInvocations.childConversationId,
        invocationId: juniorAgentInvocations.invocationId,
        result: juniorAgentInvocations.result,
        status: juniorAgentInvocations.status,
      })
      .from(juniorAgentInvocations)
      .where(
        and(
          eq(juniorAgentInvocations.parentConversationId, parentConversationId),
          eq(juniorAgentInvocations.parentMailboxStatus, "pending"),
        ),
      ),
    db
      .select({
        childConversationId: juniorAgentInvocations.childConversationId,
        invocationId: juniorAgentInvocations.invocationId,
      })
      .from(juniorAgentInvocations)
      .where(
        and(
          eq(juniorAgentInvocations.parentConversationId, parentConversationId),
          inArray(juniorAgentInvocations.status, [
            ...NON_TERMINAL_AGENT_INVOCATION_STATUSES,
          ]),
        ),
      ),
  ]);
  // A completed agent invocation sends no result, so it is not waited for.
  const withPendingResult = new Set(
    pendingResults
      .filter(
        (row) =>
          row.status !== "completed" ||
          sendsCompletedResult(row, parentInboundMessageIds),
      )
      .map((row) => row.childConversationId),
  );
  const unanswered = new Set(
    openInvocations
      .filter(
        (row) =>
          !parentInboundMessageIds.some((messageId) =>
            isAgentReplyMessageId(messageId, row.invocationId),
          ),
      )
      .map((row) => row.childConversationId),
  );
  const answered = new Set(
    openInvocations
      .map((row) => row.childConversationId)
      .filter((child) => !unanswered.has(child)),
  );
  return children.filter(
    (child) =>
      child.childConversationId !== childConversationId &&
      (((NON_TERMINAL_AGENT_INVOCATION_STATUSES as readonly string[]).includes(
        child.status,
      ) &&
        !answered.has(child.childConversationId)) ||
        withPendingResult.has(child.childConversationId)),
  );
}

/** One child agent below a Conversation, at any depth. */
export type DescendantAgent = {
  conversationId: string;
  /** The agent binding name. An unnamed child agent has none. */
  name?: string;
};

/**
 * List every child agent below one Conversation, at any depth. A parent owns
 * the work of its child agents and of their child agents. The list never has
 * the Conversation itself, its parent, or a sibling.
 */
export async function listDescendantAgents(
  conversationId: string,
): Promise<DescendantAgent[]> {
  const rows = await getSqlExecutor()
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      name: juniorAgentBindings.name,
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree([conversationId]),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .leftJoin(
      juniorAgentBindings,
      eq(
        juniorAgentBindings.childConversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(ne(juniorConversations.conversationId, conversationId))
    .orderBy(juniorConversations.conversationId);
  return rows.map((row) => ({
    conversationId: row.conversationId,
    ...(row.name ? { name: row.name } : undefined),
  }));
}

/** Conversation execution state of the parent of a child agent. */
export type ParentAgent = {
  conversationId: string;
  status: ConversationStatus;
  updatedAtMs: number;
};

/**
 * List the agents that one Conversation can see. A root Conversation sees
 * only its child agents. A child agent also sees itself, its parent, and the
 * other child agents of its parent.
 */
export async function listAgentRelatives(input: {
  conversationId: string;
  parentConversationId?: string;
}): Promise<{
  children: ChildAgent[];
  parent?: ParentAgent;
  self?: ChildAgent;
  siblings: ChildAgent[];
}> {
  const { conversationId, parentConversationId } = input;
  const [children, family, parent] = await Promise.all([
    listChildAgents(conversationId),
    parentConversationId ? listChildAgents(parentConversationId) : [],
    parentConversationId
      ? getConversationStore().get({ conversationId: parentConversationId })
      : undefined,
  ]);
  const self = family.find(
    (agent) => agent.childConversationId === conversationId,
  );
  return {
    children,
    ...(parent
      ? {
          parent: {
            conversationId: parent.conversationId,
            status: parent.execution.status,
            updatedAtMs: parent.execution.updatedAtMs ?? parent.updatedAtMs,
          },
        }
      : undefined),
    ...(self ? { self } : undefined),
    siblings: family.filter(
      (agent) => agent.childConversationId !== conversationId,
    ),
  };
}
