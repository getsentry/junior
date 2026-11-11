import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import {
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type {
  ConversationKind,
  ConversationStatus,
} from "@/chat/conversations/store";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { listActiveMailboxTurns } from "@/chat/task-execution/mailbox-turn";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  getAgentInvocationIdForResult,
  isAgentReplyMessageId,
  parseAgentReplyMessageId,
  parseTurnReplyMessageId,
} from "./ids";
import {
  invocationFromRow,
  isTerminalAgentInvocation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
  sendsResultToParent,
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
  /** The child's work runs on the Conversation loop. */
  onConversationLoop?: boolean;
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
    // A Turn on the Conversation loop has no agent invocation, so its
    // work shows that the child still runs.
    status: isChildAgentSessionStopped(latest, stoppedAtMs)
      ? "stopped"
      : terminal && facts.onConversationLoop
        ? "running"
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
      executionStatus: juniorConversations.executionStatus,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      stoppedAt: juniorConversations.stoppedAt,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.conversationId, [...byChild.keys()]));
  const onConversationLoop = new Set(
    (
      await Promise.all(
        conversations
          .filter(
            (row) =>
              row.executionStatus === "pending" ||
              row.executionStatus === "running" ||
              row.executionStatus === "paused",
          )
          .map(async (row) =>
            (await runsOnConversationLoop(
              row.conversationId,
              conversationKindFromRow(row),
            ))
              ? row.conversationId
              : undefined,
          ),
      )
    ).filter((id) => id !== undefined),
  );
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
        onConversationLoop: onConversationLoop.has(row.conversationId),
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

// Only a gated Turn answers the parent. A person's Turn in a Thread does not.
function answersParent(kind: ConversationKind, source: string | undefined) {
  const personInput = isPersonInput(source);
  return !personInput && turnBehavior({ kind, personInput }).gated;
}

/**
 * Return whether a child has work on the Conversation loop that will answer
 * its parent. That Turn holds its input in the mailbox until it commits it,
 * such as a Watch Event in its debounce window, and then keeps an open
 * mailbox Turn. Agent invocation input and Turns are not such work.
 */
async function runsOnConversationLoop(
  conversationId: string,
  kind: ConversationKind,
) {
  const work = await getConversationWorkState({ conversationId });
  if (
    work?.execution.pendingMessages.some(
      (message) =>
        message.input.metadata?.kind !== "agent_invocation" &&
        answersParent(kind, message.source),
    )
  ) {
    return true;
  }
  return (await listActiveMailboxTurns(conversationId)).some((turn) =>
    answersParent(kind, turn.source?.kind),
  );
}

// The children whose open Conversation loop Turn has a reply in the parent's
// mailbox.
async function listAnsweredLoopChildren(
  children: readonly ChildAgent[],
  parentInboundMessageIds: readonly string[],
): Promise<string[]> {
  const replies = parentInboundMessageIds.flatMap((messageId) => {
    const invocationId = parseAgentReplyMessageId(messageId);
    return invocationId ? [{ invocationId, messageId }] : [];
  });
  if (children.length === 0 || replies.length === 0) {
    return [];
  }
  const senders = await getSqlExecutor()
    .db()
    .select({
      childConversationId: juniorAgentInvocations.childConversationId,
      invocationId: juniorAgentInvocations.invocationId,
    })
    .from(juniorAgentInvocations)
    .where(
      inArray(
        juniorAgentInvocations.invocationId,
        replies.map((reply) => reply.invocationId),
      ),
    );
  const answered = await Promise.all(
    children.map(async ({ childConversationId }) => {
      const turns = await listActiveMailboxTurns(childConversationId);
      return replies.some(
        (reply) =>
          senders.some(
            (sender) =>
              sender.invocationId === reply.invocationId &&
              sender.childConversationId === childConversationId,
          ) &&
          turns.some(
            (turn) => parseTurnReplyMessageId(reply.messageId) === turn.turnId,
          ),
      )
        ? childConversationId
        : undefined;
    }),
  );
  return answered.filter((id) => id !== undefined);
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
  // A result that is not sent is not waited for.
  const withPendingResult = new Set(
    pendingResults
      .filter((row) => sendsResultToParent(row, parentInboundMessageIds))
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
  // A Turn on the Conversation loop has no open agent invocation. Its reply
  // is keyed by its Turn id, so a child whose open Turn replied has answered.
  for (const child of await listAnsweredLoopChildren(
    children.filter(
      (child) =>
        child.status === "running" &&
        !openInvocations.some(
          (row) => row.childConversationId === child.childConversationId,
        ),
    ),
    parentInboundMessageIds,
  )) {
    answered.add(child);
  }
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
