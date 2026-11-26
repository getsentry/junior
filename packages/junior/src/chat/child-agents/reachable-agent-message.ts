/**
 * Agent messages to an agent that is not the sender's parent or child: a
 * sibling, an agent in another tree, or another root. A message wakes the
 * target like any other Event. The target runs it as the event system Actor,
 * so the sender's Actor and credentials never reach the target.
 */
import type { StateAdapter } from "chat";
import type { Actor } from "@/chat/actor";
import {
  canAccessConversation,
  readConversationAccessFromSql,
} from "@/api/conversations/access";
import { getConversationStore, getDb } from "@/chat/db";
import type { EventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import { EVENT_WAIT_MS } from "@/chat/events/notification";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { renderDataTag } from "@/chat/input-tags";
import { readLeadSpace } from "@/chat/lead/conversation";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { enqueueAutomatedInput } from "@/chat/conversations/session-stop";
import { AgentMessageTargetError } from "./errors";
import { REACHABLE_AGENT_MESSAGE_EVENT_TYPE } from "./result-event-type";
import { PARENT_AGENT_TARGET } from "./types";

const AGENT_MESSAGE_EVENT_NAMESPACE = "junior";

/**
 * Check that an agent can message another agent under
 * `policies/conversation-access.md`. Any agent, also a child, reaches the
 * agents of its own tree and every public agent. A private agent reaches
 * only agents at its own Destination, such as another thread in the same
 * private Slack channel, or in its own private Space. A Space's Lead
 * messages only roots, and a root outside its Space only when the member
 * who asked is a Participant of that root.
 * Every target that the sender cannot reach gets the same error, so the
 * error does not show that a private Conversation exists.
 */
async function requireReachableAgent(args: {
  askingActor?: Actor | undefined;
  senderConversationId: string;
  to: string;
}): Promise<void> {
  const notReachable = new AgentMessageTargetError(
    `"${args.to}" is not "${PARENT_AGENT_TARGET}", a child agent of this conversation, or an agent that you can reach`,
  );
  if (args.to === args.senderConversationId) {
    throw new AgentMessageTargetError(`"${args.to}" is this conversation`);
  }
  const [access, leadSpace] = await Promise.all([
    readConversationAccessFromSql(getDb(), [
      args.senderConversationId,
      args.to,
    ]),
    readLeadSpace(args.senderConversationId),
  ]);
  const sender = access.get(args.senderConversationId);
  const receiver = access.get(args.to);
  if (
    !sender ||
    !receiver ||
    !canAccessConversation({ requester: sender, target: receiver })
  ) {
    throw notReachable;
  }
  // A message writes the sender's data into the target. Private data never
  // enters a public Conversation. The target is public, so this error shows
  // nothing private.
  if (receiver.visibility === "public" && sender.visibility !== "public") {
    throw new AgentMessageTargetError(
      `"${args.to}" is a public conversation and this conversation is private. A private conversation can message only conversations in its own channel, DM, or private Space`,
    );
  }
  if (!leadSpace) return;
  // The policy gives a Lead writes only into roots.
  if (receiver.rootConversationId !== args.to) {
    throw notReachable;
  }
  const target = await getConversationStore().get({ conversationId: args.to });
  if (target?.spaceId === leadSpace.id) return;
  const person = args.askingActor
    ? (await readActorIdentity(args.askingActor))?.user
    : undefined;
  const personAccess = person
    ? (await readConversationAccessFromSql(getDb(), [args.to], person)).get(
        args.to,
      )
    : undefined;
  if (!personAccess?.isParticipant) {
    throw new AgentMessageTargetError(
      `"${args.to}" is outside this Space. You can message a conversation outside this Space only for a member who takes part in it and asked for this Turn`,
    );
  }
}

// Another agent wrote the text, so it is escaped data. The system prompt
// says how to answer it.
function renderReachableAgentMessageInput(args: {
  senderConversationId: string;
  text: string;
}): string {
  return renderDataTag(
    "agent-message",
    {
      conversation_id: args.senderConversationId,
      source: "agent",
    },
    "Another agent",
    args.text.trim(),
  );
}

/**
 * Send one message to an agent that the sender can reach and that is not
 * its parent or child, and wake the target. The access check runs on each
 * call. A stopped target holds the message, so once the automated-turn
 * limit stops one of two agents, they cannot keep each other running.
 * Repeat calls with the same `messageKey` are safe.
 */
export async function enqueueReachableAgentMessage(args: {
  /** The person whose input started this Turn, if a person started it. */
  askingActor?: Actor | undefined;
  messageKey: string;
  nowMs?: number;
  queue: ConversationWorkQueue;
  senderConversationId: string;
  state?: StateAdapter | undefined;
  text: string;
  to: string;
}): Promise<void> {
  await requireReachableAgent(args);
  const nowMs = args.nowMs ?? Date.now();
  const inboundMessageId = `agent-message:${args.senderConversationId}:${args.messageKey}`;
  const summary = `Agent ${args.senderConversationId} sent a message.`;
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: inboundMessageId,
      eventType: REACHABLE_AGENT_MESSAGE_EVENT_TYPE,
      identifier: args.senderConversationId,
      namespace: AGENT_MESSAGE_EVENT_NAMESPACE,
      trustedSummary: summary,
    },
  };
  await enqueueAutomatedInput({
    message: {
      conversationId: args.to,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        // One author per sender, so messages of one sender share a Turn and
        // never join a Turn of watch Events.
        authorId: `agent-message:${args.senderConversationId}`,
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        text: renderReachableAgentMessageInput({
          senderConversationId: args.senderConversationId,
          text: args.text,
        }),
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}
