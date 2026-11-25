import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY, mapBounded } from "@/chat/fan-out";
import type { Source } from "@sentry/junior-plugin-api";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import * as z from "zod";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import type { ConversationStatus } from "@/chat/conversations/store";
import {
  conversationLastTurnOutcomeSql,
  conversationTurnFailedSql,
} from "@/chat/conversations/sql/status";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";
import {
  listActiveMailboxTurns,
  listActiveMailboxTurnSources,
} from "@/chat/task-execution/mailbox-turn";
import {
  getConversationWorkState,
  getConversationWorkStates,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ChildMessage } from "./child-message";
import { isDroppedChildInput } from "./child-input";
import {
  CHILD_AGENT_KINDS,
  type ChildAgent,
  type ChildAgentResult,
} from "./types";

const childAgentKindSchema = z.enum(CHILD_AGENT_KINDS);

// How a child's finished Turn ended, as its result. A cancelled Turn is a
// stop, not a result.
const TURN_OUTCOME_RESULTS: Partial<Record<string, ChildAgentResult>> = {
  blocked: "blocked",
  failed: "failed",
  no_reply: "completed",
  success: "completed",
};

/** Bound the child agents that one listing reads. */
const CHILD_AGENT_LIST_LIMIT = 200;

/**
 * List the direct child agents of one parent Conversation, with the newest
 * activity first. The state comes from each child's Turns and mailbox, not
 * from model output. Each child agent stores its agent config, so older
 * children of a parent, such as ones that a removed feature created, are not
 * listed. A child is `running` while a Turn or mailbox input that answers its
 * parent is open, and is `failed` when its last Turn failed, also when the
 * Turn ended with a model error and execution went back to idle. Otherwise
 * `lastResult` is how the child's newest finished Turn ended.
 */
export async function listChildAgents(
  parentConversationId: string,
): Promise<ChildAgent[]> {
  const db = getSqlExecutor().db();
  const rows = await db
    .select({
      agentName: juniorAgentBindings.name,
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      kind: juniorConversations.kind,
      lastTurnOutcome: conversationLastTurnOutcomeSql(juniorConversations),
      stoppedAt: juniorConversations.stoppedAt,
      title: juniorConversations.title,
      turnFailed: conversationTurnFailedSql(juniorConversations),
      updatedAt: juniorConversations.updatedAt,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorAgentBindings,
      eq(
        juniorAgentBindings.childConversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorConversations.parentConversationId, parentConversationId),
        isNotNull(juniorConversations.agentConfig),
      ),
    )
    // The limit keeps the newest activity, so a child with open work stays
    // in the listing.
    .orderBy(
      desc(
        sql`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`,
      ),
    )
    .limit(CHILD_AGENT_LIST_LIMIT);
  const ids = rows.map((row) => row.conversationId);
  const [workStates, mailboxTurnSources] = await Promise.all([
    getConversationWorkStates(ids),
    listActiveMailboxTurnSources(ids),
  ]);
  const limit = pLimit(FAN_OUT_CONCURRENCY);
  const children = await Promise.all(
    rows.map(async (row): Promise<ChildAgent> => {
      // Every child agent stores its kind.
      const kind = childAgentKindSchema.parse(row.kind);
      const stoppedAtMs = row.stoppedAt?.getTime();
      const running =
        stoppedAtMs === undefined &&
        (await limit(() =>
          runsOnConversationLoop(
            workStates.get(row.conversationId)?.execution.pendingMessages ?? [],
            mailboxTurnSources.get(row.conversationId) ?? [],
          ),
        ));
      const lastResult =
        row.turnFailed && !running
          ? "failed"
          : TURN_OUTCOME_RESULTS[row.lastTurnOutcome ?? ""];
      return {
        ...(row.agentName ? { agentName: row.agentName } : undefined),
        ...(row.archivedAt
          ? { archivedAtMs: row.archivedAt.getTime() }
          : undefined),
        childConversationId: row.conversationId,
        kind,
        ...(lastResult ? { lastResult } : undefined),
        status:
          stoppedAtMs !== undefined
            ? "stopped"
            : running
              ? "running"
              : row.turnFailed
                ? "failed"
                : "completed",
        // The task text stays in the child's transcript. The spawn title
        // names it.
        task: row.title ?? "",
        ...(row.title ? { title: row.title } : undefined),
        updatedAtMs: (row.executionUpdatedAt ?? row.updatedAt).getTime(),
      };
    }),
  );
  return children.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

/** List the ids of the child agents of one parent that have open work. */
export async function listOpenChildAgents(
  parentConversationId: string,
): Promise<string[]> {
  return (await listChildAgents(parentConversationId))
    .filter((child) => child.status === "running")
    .map((child) => child.childConversationId);
}

/**
 * Return whether a child has work that will answer its parent: `pending`
 * input that waits in the mailbox until its Turn commits it, such as a Watch
 * Event in its debounce window, or an open mailbox Turn. Every Turn of a
 * child answers its parent, whoever started it.
 */
async function runsOnConversationLoop(
  pending: readonly InboundMessage[],
  mailboxTurnSources: ReadonlyArray<Source | undefined>,
) {
  if (mailboxTurnSources.length > 0) {
    return true;
  }
  for (const message of pending) {
    // oxlint-disable-next-line no-await-in-loop -- Callers already run each child under the fan-out cap, and the first input that runs ends the check.
    if (!(await isDroppedChildInput(message))) {
      return true;
    }
  }
  return false;
}

/**
 * Return whether input waits in a child's mailbox that will run a later Turn
 * that answers its parent, such as a fired Timer whose Watch is already gone.
 * The input that the running attempt took belongs to its own Turn, which
 * can ack it as late as its end.
 */
export async function hasWaitingParentWork(
  conversationId: string,
): Promise<boolean> {
  const work = await getConversationWorkState({ conversationId });
  const running = new Set(work?.runningInboundMessageIds);
  return await runsOnConversationLoop(
    (work?.messages ?? []).filter(
      (message) => !running.has(message.inboundMessageId),
    ),
    [],
  );
}

/**
 * List the ids of a child's open Turns on the Conversation loop. A Turn keeps
 * its input in the mailbox until it commits it, so before its first
 * checkpoint its id comes from its first input. Attempt selection can take
 * any pending input first, so each one gives a candidate id.
 */
async function listOpenLoopTurnIds(conversationId: string) {
  const [turns, work] = await Promise.all([
    listActiveMailboxTurns(conversationId),
    getConversationWorkState({ conversationId }),
  ]);
  return [
    ...turns.map((turn) => turn.turnId),
    ...(work?.execution.pendingMessages ?? []).map((message) =>
      buildDeterministicTurnId(message.inboundMessageId),
    ),
  ];
}

// The children whose open Conversation loop Turn has a reply in the parent's
// mailbox.
async function listAnsweredLoopChildren(
  children: readonly ChildAgent[],
  parentMessages: readonly ChildMessage[],
): Promise<string[]> {
  if (children.length === 0 || parentMessages.length === 0) {
    return [];
  }
  const answered = await mapBounded(
    children,
    async ({ childConversationId }) => {
      const turnIds = await listOpenLoopTurnIds(childConversationId);
      return parentMessages.some(
        ({ sender }) =>
          sender.conversationId === childConversationId &&
          turnIds.includes(sender.turnId),
      )
        ? childConversationId
        : undefined;
    },
  );
  return answered.filter((id) => id !== undefined);
}

/**
 * List the other child agents of one parent that still run and have not
 * answered. A running child whose open Turn's result is already among
 * `parentMessages`, the child replies and results that reached the parent's
 * mailbox, has answered, so it does not count.
 */
export async function listUnreportedSiblingAgents(
  parentConversationId: string,
  childConversationId: string,
  parentMessages: readonly ChildMessage[],
): Promise<ChildAgent[]> {
  const running = (await listChildAgents(parentConversationId)).filter(
    (child) =>
      child.childConversationId !== childConversationId &&
      child.status === "running",
  );
  const answered = new Set(
    await listAnsweredLoopChildren(running, parentMessages),
  );
  return running.filter((child) => !answered.has(child.childConversationId));
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
  parentConversationId?: string | undefined;
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
