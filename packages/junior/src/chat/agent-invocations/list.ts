import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import { conversationStatusSql } from "@/chat/conversations/sql/status";
import { getSqlExecutor } from "@/chat/db";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { getAgentInvocationIdForResult } from "./ids";
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
type ChildConversationFacts = Pick<
  ChildAgent,
  "archivedAtMs" | "conversationStatus" | "kind"
> & {
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
    conversationStatus: facts.conversationStatus,
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
      status: conversationStatusSql(juniorConversations),
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
        conversationStatus: row.status,
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
        factsByChild.get(childConversationId) ?? {
          conversationStatus: "idle",
          kind: "task",
        },
      ),
    )
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

/**
 * List the other child agents of one parent whose results have not reached
 * the parent yet. A child counts while it runs and after it finishes until its
 * result is appended to the parent mailbox.
 */
export async function listUnreportedSiblingAgents(
  parentConversationId: string,
  childConversationId: string,
): Promise<ChildAgent[]> {
  const [children, pendingResults] = await Promise.all([
    listChildAgents(parentConversationId),
    getSqlExecutor()
      .db()
      .selectDistinct({
        childConversationId: juniorAgentInvocations.childConversationId,
      })
      .from(juniorAgentInvocations)
      .where(
        and(
          eq(juniorAgentInvocations.parentConversationId, parentConversationId),
          eq(juniorAgentInvocations.parentMailboxStatus, "pending"),
        ),
      ),
  ]);
  const withPendingResult = new Set(
    pendingResults.map((row) => row.childConversationId),
  );
  return children.filter(
    (child) =>
      child.childConversationId !== childConversationId &&
      ((NON_TERMINAL_AGENT_INVOCATION_STATUSES as readonly string[]).includes(
        child.status,
      ) ||
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

/** The status of the parent of a child agent. */
export type ParentAgent = {
  conversationId: string;
  status: ConversationReportStatus;
  updatedAtMs: number;
};

/** Read the status of one parent Conversation. */
async function readParentAgent(
  conversationId: string,
): Promise<ParentAgent | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      status: conversationStatusSql(juniorConversations),
      updatedAt: juniorConversations.updatedAt,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return row
    ? {
        conversationId,
        status: row.status,
        updatedAtMs: (row.executionUpdatedAt ?? row.updatedAt).getTime(),
      }
    : undefined;
}

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
    parentConversationId ? readParentAgent(parentConversationId) : undefined,
  ]);
  const self = family.find(
    (agent) => agent.childConversationId === conversationId,
  );
  return {
    children,
    ...(parent ? { parent } : undefined),
    ...(self ? { self } : undefined),
    siblings: family.filter(
      (agent) => agent.childConversationId !== conversationId,
    ),
  };
}
