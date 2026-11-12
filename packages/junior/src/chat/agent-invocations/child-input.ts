import { isPersonInput } from "@/chat/conversations/kind-behavior";
import {
  getConversationStoppedAtMs,
  isSkippedAfterConversationStop,
} from "@/chat/conversations/session-stop";
import { isEventMailboxMetadata } from "@/chat/events/notification";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getSqlExecutor } from "@/chat/db";
import type { InboundMessage } from "@/chat/task-execution/store";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";
import { parseTurnReplyMessageId } from "./ids";
import { readParentTask } from "./parent-task";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_MESSAGE_EVENT_TYPE,
  AGENT_REPLY_EVENT_TYPE,
  isAgentInvocationResultEventType,
} from "./result-event-type";
import {
  getAgentInvocation,
  isStoppedAgentInvocation,
  isTerminalAgentInvocation,
} from "./store";
import type { AgentInvocation, ChildAgentSender } from "./types";
import { isAgentInvocationInput } from "./work";

/**
 * One result, reply, or message that a child agent sent to its parent.
 * `senderId` is the Agent invocation that sent it, or the child Conversation
 * when no Agent invocation names the child. Only an Agent invocation sends a
 * result.
 */
export type ChildAgentInput = {
  kind: "message" | "reply" | "result";
  senderId: string;
};

/**
 * Where one input to a Conversation goes: a new or open agent invocation, a
 * Turn on the Conversation loop, or nowhere, because a stop skips it.
 */
export type ChildInputRoute =
  | "agent invocation"
  | "Conversation loop"
  | "dropped";

/**
 * Read the sender that one result, reply, or message Event names: the
 * finished child work for a result, or the sender for a reply or message.
 */
export function childAgentInput(
  message: InboundMessage,
): ChildAgentInput | undefined {
  const metadata = message.input.metadata;
  if (
    !isEventMailboxMetadata(metadata) ||
    metadata.event.namespace !== AGENT_INVOCATION_EVENT_NAMESPACE
  ) {
    return undefined;
  }
  if (metadata.event.eventType === AGENT_MESSAGE_EVENT_TYPE) {
    return { kind: "message", senderId: metadata.event.identifier };
  }
  // A reply, like a message, can arrive before its sender's agent invocation
  // ends.
  if (metadata.event.eventType === AGENT_REPLY_EVENT_TYPE) {
    return { kind: "reply", senderId: metadata.event.identifier };
  }
  return isAgentInvocationResultEventType(metadata.event.eventType)
    ? { kind: "result", senderId: metadata.event.identifier }
    : undefined;
}

/**
 * Route one input to a Conversation. Routing, the stop skips, and the child
 * agent status all read this, so they agree on which input starts work.
 *
 * A parent task or message goes to its agent invocation. `latest` is the
 * Conversation's newest agent invocation; a root has none. With an open one, a Watch Event and input from a child agent go to an agent
 * invocation, and so do a result, and input to a child that waits for its own
 * child agents (`replaced`). A stopped child drops input from its own child
 * agents, also input sent before the stop. A session stop at `stoppedAtMs`
 * skips Events as `skipInputAfterConversationStop` does.
 *
 * TODO(dcramer): Drop the agent invocation route with the legacy child worker
 * (#3060 step 7).
 */
export async function routeChildInput(
  message: InboundMessage,
  latest: AgentInvocation | undefined,
  stoppedAtMs: number | undefined,
): Promise<ChildInputRoute> {
  if (isPersonInput(message.source)) {
    return "Conversation loop";
  }
  if (isAgentInvocationInput(message)) {
    return "agent invocation";
  }
  // A parent task that no agent invocation names starts a Turn, as a
  // person's Message does.
  if (readParentTask(message)) {
    return isSkippedAfterConversationStop(message, stoppedAtMs)
      ? "dropped"
      : "Conversation loop";
  }
  const open = latest !== undefined && !isTerminalAgentInvocation(latest);
  const input = childAgentInput(message);
  if (!input) {
    if (open && isEventMailboxMetadata(message.input.metadata)) {
      return "agent invocation";
    }
    return isSkippedAfterConversationStop(message, stoppedAtMs)
      ? "dropped"
      : "Conversation loop";
  }
  if (latest && isStoppedAgentInvocation(latest)) {
    return "dropped";
  }
  if (await isSkippedAgentResult(input, message)) {
    return "dropped";
  }
  // A child agent's result still starts an agent invocation: `main` counts a
  // result that none received as open child work, so after a rollback its
  // parent would wait for the child forever.
  // TODO(dcramer): Run results on the Conversation loop once every deployed
  // `hasOpenChildWork` reads unread results from the mailbox.
  if (
    latest &&
    (open ||
      input.kind === "result" ||
      latest.parentMailboxStatus === "replaced")
  ) {
    return "agent invocation";
  }
  return isSkippedAfterConversationStop(message, stoppedAtMs)
    ? "dropped"
    : "Conversation loop";
}

/**
 * Return whether a stop skipped this result or reply, so it starts no work.
 * A message that a child sent before its stop is still delivered. A reply
 * that an agent invocation sent names its own work, so it is dropped with
 * that work. A reply from a Turn on the Conversation loop names no work of
 * its own: the stop drops it from the parent's mailbox. While the sending
 * child is stopped, a reply that it sent after the stop is also dropped.
 */
async function isSkippedAgentResult(
  input: ChildAgentInput,
  message: InboundMessage,
): Promise<boolean> {
  if (input.kind === "message") {
    return false;
  }
  const { invocation, sender } = await getChildAgentInputSender(message, input);
  const skipped =
    invocation !== undefined &&
    isTerminalAgentInvocation(invocation) &&
    invocation.parentMailboxStatus === "skipped";
  if (input.kind === "result") {
    return skipped;
  }
  if (
    skipped &&
    parseTurnReplyMessageId(message.inboundMessageId) === undefined
  ) {
    return true;
  }
  const senderStoppedAtMs = await getConversationStoppedAtMs(
    sender.childConversationId,
  );
  return (
    senderStoppedAtMs !== undefined && message.createdAtMs >= senderStoppedAtMs
  );
}

/**
 * Read the sender of one child Conversation that no Agent invocation names,
 * from its parent edge and its binding. A Conversation without a parent has
 * none.
 */
export async function readChildConversationSender(
  childConversationId: string,
): Promise<ChildAgentSender | undefined> {
  const parent = alias(juniorConversations, "parent");
  const [row] = await getSqlExecutor()
    .db()
    .select({
      agentName: juniorAgentBindings.name,
      parentConversationId: parent.conversationId,
      title: juniorConversations.title,
    })
    .from(juniorConversations)
    .innerJoin(
      parent,
      eq(parent.conversationId, juniorConversations.parentConversationId),
    )
    .leftJoin(
      juniorAgentBindings,
      eq(
        juniorAgentBindings.childConversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(eq(juniorConversations.conversationId, childConversationId));
  return row
    ? {
        ...(row.agentName ? { agentName: row.agentName } : undefined),
        childConversationId,
        parentConversationId: row.parentConversationId,
        ...(row.title ? { title: row.title } : undefined),
      }
    : undefined;
}

/**
 * Read the sender of one result, reply, or message and check that it is a
 * child of the Conversation that received it. The Agent invocation that the
 * input names wins. A reply or message from a child that no Agent invocation
 * names comes from its child Conversation, and has no `invocation`.
 */
export async function getChildAgentInputSender(
  message: InboundMessage,
  input: ChildAgentInput,
): Promise<{ invocation?: AgentInvocation; sender: ChildAgentSender }> {
  const invocation = await getAgentInvocation(input.senderId);
  const sender: ChildAgentSender | undefined = invocation
    ? input.kind === "result" && !isTerminalAgentInvocation(invocation)
      ? undefined
      : invocation
    : input.kind === "result"
      ? undefined
      : await readChildConversationSender(input.senderId);
  if (!sender || sender.parentConversationId !== message.conversationId) {
    throw new Error(
      `Agent invocation ${input.kind} ${input.senderId} does not belong to ${message.conversationId}`,
    );
  }
  return invocation ? { invocation, sender } : { sender };
}
