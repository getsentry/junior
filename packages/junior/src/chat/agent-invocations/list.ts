import { desc, eq, inArray } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
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

/** Return the child state that one child's agent invocations show. */
function childAgentFromInvocations(
  invocations: readonly AgentInvocation[],
  resultInvocationIds: ReadonlySet<string>,
): ChildAgent {
  // `invocations` is newest first. The oldest open agent invocation is the
  // one that runs, so it owns the status.
  const latest = invocations[0]!;
  let current = latest;
  for (const invocation of invocations) {
    if (!isTerminalAgentInvocation(invocation)) {
      current = invocation;
    }
  }
  // A task comes from a parent tool call: spawnAgent or messageAgent. An
  // agent invocation that gives a grandchild result or message to the child
  // holds that input, not a task from the parent.
  const tasks = invocations.filter(
    (invocation) => !resultInvocationIds.has(invocation.invocationId),
  );
  const task =
    tasks.find((invocation) => invocation.parentToolCallId) ??
    tasks[0] ??
    invocations[invocations.length - 1]!;
  const terminal = isTerminalAgentInvocation(current) ? current : undefined;
  // A `replaced` or `skipped` result is not reported, so it does not count as
  // a result. A tree stop marks `replaced` results `skipped`.
  const lastResult = invocations
    .filter(isTerminalAgentInvocation)
    .filter(
      (invocation) =>
        invocation.parentMailboxStatus !== "replaced" &&
        invocation.parentMailboxStatus !== "skipped",
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
    status:
      terminal?.parentMailboxStatus === "replaced"
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
  return [...byChild.values()]
    .map((invocations) =>
      childAgentFromInvocations(invocations, resultInvocationIds),
    )
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
