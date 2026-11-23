import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY, mapBounded } from "@/chat/fan-out";
import type { Source } from "@sentry/junior-plugin-api";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import {
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import * as z from "zod";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import type {
  ConversationKind,
  ConversationStatus,
} from "@/chat/conversations/store";
import { conversationTurnFailedSql } from "@/chat/conversations/sql/status";
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
import { CHILD_AGENT_KINDS, type ChildAgent } from "./types";

const childAgentKindSchema = z.enum(CHILD_AGENT_KINDS);

/** Bound the child agents that one listing reads. */
const CHILD_AGENT_LIST_LIMIT = 200;

/**
 * List the direct child agents of one parent Conversation, with the newest
 * activity first. The state comes from each child's Turns and mailbox, not
 * from model output. Each child agent stores its agent config, so older
 * children of a parent, such as ones that a removed feature created, are not
 * listed. A child is `running` while a Turn or mailbox input that answers its
 * parent is open, and is `failed` when its last Turn failed, also when the
 * Turn ended with a model error and execution went back to idle. Turns do
 * not store a blocked result, so only a failure sets `lastResult`.
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
            kind,
            workStates.get(row.conversationId)?.execution.pendingMessages ?? [],
            mailboxTurnSources.get(row.conversationId) ?? [],
          ),
        ));
      return {
        ...(row.agentName ? { agentName: row.agentName } : undefined),
        ...(row.archivedAt
          ? { archivedAtMs: row.archivedAt.getTime() }
          : undefined),
        childConversationId: row.conversationId,
        kind,
        ...(row.turnFailed && !running ? { lastResult: "failed" } : undefined),
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

// Only a gated Turn answers the parent. A person's Turn in a Thread does not.
function answersParent(kind: ConversationKind, source: string | undefined) {
  const personInput = isPersonInput(source);
  return !personInput && turnBehavior({ kind, personInput }).gated;
}

/**
 * Return whether a child has work that will answer its parent: `pending`
 * input that waits in the mailbox until its Turn commits it, such as a Watch
 * Event in its debounce window, or an open mailbox Turn that answers.
 */
async function runsOnConversationLoop(
  kind: ConversationKind,
  pending: readonly InboundMessage[],
  mailboxTurnSources: ReadonlyArray<Source | undefined>,
) {
  for (const message of pending) {
    if (
      answersParent(kind, message.source) &&
      // oxlint-disable-next-line no-await-in-loop -- Callers already run each child under the fan-out cap, and the first input that runs ends the check.
      !(await isDroppedChildInput(message))
    ) {
      return true;
    }
  }
  return mailboxTurnSources.some((source) => answersParent(kind, source?.kind));
}

/**
 * Return whether input waits in a child's mailbox that will run a Turn that
 * answers its parent, such as a fired Timer whose Watch is already gone.
 */
export async function hasWaitingParentWork(
  conversationId: string,
  kind: ConversationKind,
): Promise<boolean> {
  const work = await getConversationWorkState({ conversationId });
  return await runsOnConversationLoop(
    kind,
    work?.execution.pendingMessages ?? [],
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
 * answered. A running child whose open Turn's `reply` is already among
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
