import type { Actor } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { AgentInstruction, AgentRun } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  getConversationStoppedAtMs,
  resumeConversationTree,
} from "@/chat/conversations/session-stop";
import type { CredentialContext } from "@/chat/credentials/context";
import { getSqlExecutor } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import {
  appendInboundMessage,
  dropPendingMessages,
  getConversationWorkState,
  releaseInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { juniorConversationEvents } from "@/db/schema";
import { commitForkHistory, FORK_INSTRUCTIONS } from "./fork-history";
import { getParentMessageId } from "./ids";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { renderParentAgentTask } from "@/chat/input-tags";
import { agentTypeInstructions, type AgentType } from "./agent-types";
import { readParentMessage, type ParentMessage } from "./parent-message-input";

/**
 * Return the author id of every parent message from one parent. It matches
 * no other input, so a parent message never shares a Turn with another
 * sender's input.
 */
function parentMessageAuthorId(parentConversationId: string): string {
  return `${PARENT_MESSAGE_AUTHOR_PREFIX}${parentConversationId}`;
}

const PARENT_MESSAGE_AUTHOR_PREFIX = "parent-agent:";

/**
 * Build the parent message that gives one task or message to a child. Its
 * mailbox id comes from the idempotency key, so a replay is a duplicate.
 */
export function buildParentMessage(args: {
  actor: Actor;
  childConversationId: string;
  credentialContext?: CredentialContext | undefined;
  fork?: true | undefined;
  idempotencyKey: string;
  nowMs: number;
  parentConversationId: string;
  parentToolCallId: string;
  text: string;
}): InboundMessage {
  const inboundMessageId = getParentMessageId(
    args.parentConversationId,
    args.idempotencyKey,
  );
  return {
    conversationId: args.childConversationId,
    createdAtMs: args.nowMs,
    delivery: "defer",
    inboundMessageId,
    input: {
      authorId: parentMessageAuthorId(args.parentConversationId),
      // A parent agent wrote the text, not a person.
      authorIdentityId: SYSTEM_IDENTITY_ID,
      metadata: {
        actor: args.actor,
        ...(args.credentialContext
          ? { credentialContext: args.credentialContext }
          : undefined),
        ...(args.fork ? { fork: true } : undefined),
        kind: "parent_message",
        parentConversationId: args.parentConversationId,
        parentToolCallId: args.parentToolCallId,
      } satisfies ParentMessage,
      text: args.text,
    },
    receivedAtMs: args.nowMs,
    source: "internal",
  };
}

/**
 * How a parent message reaches its child. `new_child` is the task of a
 * spawn that created the child in the same SQL transaction. `message` is
 * new work for a child that exists.
 */
export type ParentMessageDelivery = "message" | "new_child";

/**
 * Append one parent message to its child's mailbox without a wake.
 *
 * A new child gets its task even when the mailbox already saw its id: a
 * spawn that rolled back after its mailbox write left that id, and the child
 * dropped the task because no stored parent sent it. SQL decides: the child
 * exists only when this transaction commits.
 *
 * New work for a child that exists ends the stop of the child and of the
 * child agents below it. The stop already
 * dropped the parent messages that waited then. A message that already
 * reached the mailbox changes nothing, so a replay does not end a later
 * stop.
 */
export async function appendParentMessage(
  message: InboundMessage,
  delivery: ParentMessageDelivery,
  options: {
    conversationStore?: ConversationStore | undefined;
    state?: StateAdapter | undefined;
  },
): Promise<void> {
  const conversationId = message.conversationId;
  const work = await getConversationWorkState({
    conversationId,
    state: options.state,
  });
  // A task that a rolled-back spawn left still waits, so this append
  // replaces it.
  const waiting = work?.messages.some(
    (pending) => pending.inboundMessageId === message.inboundMessageId,
  );
  if (delivery === "new_child") {
    if (!waiting) {
      await releaseInboundMessage({ message, state: options.state });
    }
  } else {
    // A replay is not new work, even after a stop dropped it: a drop keeps
    // the id, so check it before the stop ends.
    if (work?.execution.inboundMessageIds.includes(message.inboundMessageId)) {
      return;
    }
    await endStopForParentMessage(message);
  }
  const { status } = await appendInboundMessage({
    message,
    ...(options.conversationStore
      ? { conversationStore: options.conversationStore }
      : undefined),
    nowMs: message.receivedAtMs,
    ...(options.state ? { state: options.state } : undefined),
  });
  if (delivery === "new_child") {
    if (status === "duplicate" && !waiting) {
      // A worker took the stale id between the release and this append.
      throw new Error(
        `Task of new child ${conversationId} was taken before it was appended`,
      );
    }
  }
}

async function endStopForParentMessage(message: InboundMessage): Promise<void> {
  const stoppedAtMs = await getConversationStoppedAtMs(message.conversationId);
  if (stoppedAtMs !== undefined && message.createdAtMs > stoppedAtMs) {
    await resumeConversationTree(message.conversationId, message.createdAtMs);
  }
}

/**
 * Drop every parent message that waits in a Conversation's mailbox. A stop
 * calls this before it saves its stop request: no task from before the stop
 * runs, and an idle Conversation gets no stop request that could cancel its
 * next Turn after the stop ends.
 */
export async function dropWaitingParentMessages(
  conversationId: string,
  state?: StateAdapter,
): Promise<void> {
  const work = await getConversationWorkState({ conversationId, state });
  const waiting = (work?.messages ?? []).flatMap((message) => {
    const parentMessage = readParentMessage(message);
    return parentMessage ? [{ message, parentMessage }] : [];
  });
  if (waiting.length === 0) {
    return;
  }
  await dropPendingMessages({
    conversationId,
    inboundMessageIds: waiting.map(({ message }) => message.inboundMessageId),
    ...(state ? { state } : undefined),
  });
  for (const { message, parentMessage } of waiting) {
    logDroppedParentMessage(message, parentMessage);
  }
}

/**
 * Return whether a parent message has the author id of the parent that it
 * names. The child must also have that parent as its stored parent before
 * the message gets any authority.
 */
export function hasParentMessageAuthor(
  message: InboundMessage,
  parentMessage: ParentMessage,
): boolean {
  return (
    message.input.authorId ===
    parentMessageAuthorId(parentMessage.parentConversationId)
  );
}

/**
 * Log a parent message that a child dropped: its sender check failed, or a
 * stop skipped it. Call it once, where the child drops the message.
 */
export function logDroppedParentMessage(
  message: InboundMessage,
  parentMessage: ParentMessage,
): void {
  logWarn("agent.parent_message.dropped", {
    "app.conversation_id": message.conversationId,
    "app.inbound_message_id": message.inboundMessageId,
    "app.parent_conversation_id": parentMessage.parentConversationId,
  });
}

/**
 * Render a parent task or message as the child model reads it: one
 * `<parent-agent-task>`, after the fork and Agent type instructions.
 */
export function parentTaskText(args: {
  agentType?: AgentType | undefined;
  fork?: true | undefined;
  text: string;
}): string {
  const instructions = [
    args.fork ? FORK_INSTRUCTIONS : undefined,
    agentTypeInstructions(args.agentType),
  ].filter((text) => text !== undefined);
  return renderParentAgentTask([
    ...instructions.flatMap((text) => [text, ""]),
    args.text,
  ]);
}

/** Render a parent message as the child model reads it. */
export async function parentMessageText(
  message: InboundMessage,
  parentMessage: ParentMessage,
): Promise<string> {
  const options = await readAgentConfig(message.conversationId);
  return parentTaskText({
    agentType: options?.agentType,
    fork: parentMessage.fork,
    text: message.input.text,
  });
}

/** Saved transcript author of every parent message from one parent. */
export function parentMessageAuthor(parentConversationId: string) {
  return {
    fullName: "Parent agent",
    isBot: true,
    userId: parentMessageAuthorId(parentConversationId),
  } as const;
}

/**
 * Return whether a saved transcript Message is a parent message, by its
 * author. Only the root Turn code saves one, after its sender check.
 */
export function isParentMessageAuthor(
  author: { userId?: unknown } | undefined,
): boolean {
  return (
    typeof author?.userId === "string" &&
    author.userId.startsWith(PARENT_MESSAGE_AUTHOR_PREFIX)
  );
}

/**
 * Read when the root Turn code last saved a parent message to one child, or
 * undefined when it saved none.
 */
export async function readLastParentMessageAtMs(
  conversationId: string,
): Promise<number | undefined> {
  const payload = juniorConversationEvents.payload;
  const [row] = await getSqlExecutor()
    .db()
    .select({ createdAt: juniorConversationEvents.createdAt })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        like(
          sql`${payload}->'meta'->'author'->>'userId'`,
          `${PARENT_MESSAGE_AUTHOR_PREFIX}%`,
        ),
      ),
    )
    .orderBy(desc(juniorConversationEvents.createdAt))
    .limit(1);
  return row?.createdAt.getTime();
}

/**
 * Commit the parent's history for the first Turn of a fork child, before the
 * Turn starts. `inputs` passed the sender check.
 */
export async function commitParentMessageFork(args: {
  conversationId: string;
  inputs: readonly InboundMessage[];
}): Promise<void> {
  const parentMessage = args.inputs
    .map(readParentMessage)
    .find((input) => input !== undefined);
  if (parentMessage?.fork) {
    await commitForkHistory({
      childConversationId: args.conversationId,
      parentConversationId: parentMessage.parentConversationId,
      parentToolCallId: parentMessage.parentToolCallId,
    });
  }
}

/**
 * Apply the agent config of a child agent to one of its Turns on the root
 * Turn code. Every Turn keeps the reasoning level. A parent message is the
 * child's instruction, also when its Turn resumes (`fromParent`). A reply or
 * message from the Conversation's own child agent is context with the Turn's
 * Actor (`fromChildAgent`): it is data, not that person's instruction, and
 * the person's earlier messages keep their authority.
 */
export async function childAgentTurnOptions(args: {
  actor: Actor;
  conversationId: string;
  fromChildAgent: boolean;
  fromParent: boolean;
}): Promise<{
  instruction: Pick<AgentInstruction, "provenance">;
  run: Pick<AgentRun, "reasoning">;
}> {
  const options = await readAgentConfig(args.conversationId);
  return {
    instruction: args.fromParent
      ? { provenance: agentInstructionProvenance }
      : args.fromChildAgent
        ? { provenance: { authority: "context", actor: args.actor } }
        : {},
    run: options?.reasoningLevel ? { reasoning: options.reasoningLevel } : {},
  };
}
