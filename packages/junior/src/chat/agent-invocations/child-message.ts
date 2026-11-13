import { inArray } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import {
  readInboundMessageSender,
  type InboundMessageSender,
  type InboundMessageSenders,
} from "@/chat/task-execution/message-sender";
import type { InboundMessage } from "@/chat/task-execution/store";
import { juniorAgentInvocations } from "@/db/schema";
import {
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "./ids";

/**
 * One reply or result that a child agent sent to its parent, read from the
 * sender fields that the message stores. The message id is only its
 * idempotency key.
 */
export type ChildMessage = {
  inboundMessageId: string;
  sender: InboundMessageSender;
};

/** Mailbox metadata that stores who sent one child reply or result. */
export function childMessageSenderMetadata(sender: InboundMessageSender): {
  sender: InboundMessageSender;
} {
  return { sender };
}

/** Read who sent one child reply or result in a parent's mailbox. */
export async function readChildMessageSender(
  message: Pick<InboundMessage, "inboundMessageId" | "input">,
): Promise<InboundMessageSender | undefined> {
  return (
    readInboundMessageSender(message) ??
    (await readLegacyChildMessageSenders([message.inboundMessageId])).get(
      message.inboundMessageId,
    )
  );
}

/**
 * List the child replies and results among the ids that reached one
 * mailbox, oldest first, with the sender fields that the mailbox keeps.
 */
export async function listChildMessages(
  inboundMessageIds: readonly string[],
  messageSenders: Readonly<InboundMessageSenders>,
): Promise<ChildMessage[]> {
  const legacy = await readLegacyChildMessageSenders(
    inboundMessageIds.filter((id) => !messageSenders[id]),
  );
  return inboundMessageIds.flatMap((inboundMessageId) => {
    const sender =
      messageSenders[inboundMessageId] ?? legacy.get(inboundMessageId);
    return sender ? [{ inboundMessageId, sender }] : [];
  });
}

/**
 * Return the Agent invocation whose own Turn sent the message. A Turn on the
 * child's Conversation loop has none, even when the message names the
 * child's newest Agent invocation.
 *
 * TODO(dcramer): Remove with Agent invocation rows (#3060 step 7).
 */
export function ownAgentInvocation(
  sender: InboundMessageSender,
): string | undefined {
  const { agentInvocationId } = sender;
  return agentInvocationId &&
    sender.turnId === getAgentInvocationTurnId(agentInvocationId)
    ? agentInvocationId
    : undefined;
}

/** Return whether the message is the result of an Agent invocation. */
export function isAgentInvocationResult(message: ChildMessage): boolean {
  const agentInvocationId = ownAgentInvocation(message.sender);
  return (
    agentInvocationId !== undefined &&
    message.inboundMessageId ===
      getAgentInvocationResultMessageId(agentInvocationId)
  );
}

/**
 * Return whether one Agent invocation sent a reply to its parent: a message
 * names it as sender and is not its own result.
 */
export function hasAgentInvocationReply(
  messages: readonly ChildMessage[],
  agentInvocationId: string,
): boolean {
  return messages.some(
    (message) =>
      message.sender.agentInvocationId === agentInvocationId &&
      !isAgentInvocationResult(message),
  );
}

// Agent invocation ids, child Conversation ids, and Turn ids come from
// `stableId` and `buildDeterministicTurnId`.
const LEGACY_REPLY_ID =
  /^agent-reply:(agent(?:-invocation)?:[0-9a-f]{32}):(?:(turn_[A-Za-z0-9_-]+)(?::|$))?/;
const LEGACY_RESULT_ID =
  /^agent-invocation:(agent-invocation:[0-9a-f]{32}):result$/;

/**
 * Read the sender of child messages that reached a mailbox before senders
 * stored their fields, from their ids.
 *
 * TODO: remove one release after this ships. Step 7 of #3060 deletes it and
 * makes the id a plain generated key.
 */
async function readLegacyChildMessageSenders(
  inboundMessageIds: readonly string[],
): Promise<Map<string, InboundMessageSender>> {
  const senders = new Map<string, InboundMessageSender>();
  const byAgentInvocation = new Map<
    string,
    { agentInvocationId: string; turnId?: string }
  >();
  for (const id of inboundMessageIds) {
    const result = LEGACY_RESULT_ID.exec(id);
    const reply = result ? undefined : LEGACY_REPLY_ID.exec(id);
    const senderId = result?.[1] ?? reply?.[1];
    if (!senderId) continue;
    const turnId = reply?.[2];
    if (senderId.startsWith("agent-invocation:")) {
      byAgentInvocation.set(id, { agentInvocationId: senderId, turnId });
    } else if (turnId) {
      senders.set(id, { conversationId: senderId, turnId });
    }
  }
  if (byAgentInvocation.size === 0) return senders;
  const rows = await getSqlExecutor()
    .db()
    .select({
      childConversationId: juniorAgentInvocations.childConversationId,
      invocationId: juniorAgentInvocations.invocationId,
    })
    .from(juniorAgentInvocations)
    .where(
      inArray(juniorAgentInvocations.invocationId, [
        ...new Set(
          [...byAgentInvocation.values()].map((s) => s.agentInvocationId),
        ),
      ]),
    );
  const childOf = new Map(
    rows.map((row) => [row.invocationId, row.childConversationId]),
  );
  for (const [id, { agentInvocationId, turnId }] of byAgentInvocation) {
    const conversationId = childOf.get(agentInvocationId);
    if (!conversationId) continue;
    senders.set(id, {
      agentInvocationId,
      conversationId,
      turnId: turnId ?? getAgentInvocationTurnId(agentInvocationId),
    });
  }
  return senders;
}
