import { desc, eq, inArray } from "drizzle-orm";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations, juniorConversations } from "@/db/schema";
import {
  getAgentInvocationIdForResult,
  invocationFromRow,
  isTerminalAgentInvocation,
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

/** Return the child state that one child's agent invocations show. */
function childAgentFromInvocations(
  invocations: readonly AgentInvocation[],
  resultInvocationIds: ReadonlySet<string>,
  stoppedAtMs: number | undefined,
): ChildAgent {
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
    childConversationId: latest.childConversationId,
    ...(terminal && terminal.status !== "completed"
      ? { errorMessage: terminal.errorMessage }
      : undefined),
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
  const stops = await db
    .select({
      conversationId: juniorConversations.conversationId,
      stoppedAt: juniorConversations.stoppedAt,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, [...byChild.keys()]));
  const stoppedAtMs = new Map(
    stops.map((row) => [row.conversationId, row.stoppedAt?.getTime()]),
  );
  return [...byChild.entries()]
    .map(([childConversationId, invocations]) =>
      childAgentFromInvocations(
        invocations,
        resultInvocationIds,
        stoppedAtMs.get(childConversationId),
      ),
    )
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
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
