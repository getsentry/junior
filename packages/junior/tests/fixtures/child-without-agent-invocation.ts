import type { Actor } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { eq } from "drizzle-orm";
import {
  getAgentInvocationId,
  getAgentInvocationMessageId,
  getUnnamedAgentConversationId,
} from "@/chat/agent-invocations/ids";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_PARENT_MESSAGE_EVENT_TYPE,
} from "@/chat/agent-invocations/result-event-type";
import { parentMessageAuthorId } from "@/chat/agent-invocations/parent-message";
import type { AgentConfig } from "@/chat/conversations/agent-config";
import type { ConversationStore } from "@/chat/conversations/store";
import type { CredentialContext } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { juniorConversations } from "@/db/schema";

/**
 * Send a parent message as a parent that writes no Agent invocation does: an
 * Event in the child's mailbox with the Actor and grants of the parent's
 * Turn. `from` overrides the parent that the message names, and `authorId`
 * its author id.
 */
export async function sendParentMessage(args: {
  actor: Actor;
  authorId?: string;
  childConversationId: string;
  credentialContext?: CredentialContext;
  fork?: true;
  from?: string;
  idempotencyKey: string;
  parentConversationId: string;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
  text?: string;
}): Promise<string> {
  const from = args.from ?? args.parentConversationId;
  const inboundMessageId = getAgentInvocationMessageId(
    getAgentInvocationId(args.parentConversationId, args.idempotencyKey),
  );
  const nowMs = Date.now();
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.childConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: args.authorId ?? parentMessageAuthorId(from),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata: {
          actor: args.actor,
          ...(args.credentialContext
            ? { credentialContext: args.credentialContext }
            : undefined),
          event: {
            eventKey: inboundMessageId,
            eventType: AGENT_PARENT_MESSAGE_EVENT_TYPE,
            identifier: from,
            namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
            trustedSummary: "Your parent agent sent a task.",
          },
          ...(args.fork ? { fork: true } : undefined),
          kind: "event",
          parentToolCallId: args.idempotencyKey,
        },
        text: args.text ?? "Check the deploy.",
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    state: args.state,
  });
  return inboundMessageId;
}

/**
 * Spawn a child agent as a spawn that writes no Agent invocation does: the
 * child Conversation with its agent config, and its task as a parent
 * message in its mailbox. This pins the state that a rollback must still
 * read.
 */
export async function spawnChildWithoutAgentInvocation(args: {
  actor: Actor;
  authorId?: string;
  conversationStore: ConversationStore;
  credentialContext?: CredentialContext;
  from?: string;
  idempotencyKey: string;
  kind?: "task" | "thread";
  parentConversationId: string;
  queue: ConversationWorkQueue;
  agentConfig?: AgentConfig;
  state?: StateAdapter;
  task?: string;
  title?: string;
}): Promise<string> {
  const childConversationId = getUnnamedAgentConversationId(
    getAgentInvocationId(args.parentConversationId, args.idempotencyKey),
  );
  await args.conversationStore.createChild({
    childConversationId,
    kind: args.kind ?? "task",
    parentConversationId: args.parentConversationId,
    source: "internal",
    ...(args.title ? { title: args.title } : undefined),
  });
  await getDb()
    .update(juniorConversations)
    .set({ agentConfig: args.agentConfig ?? {} })
    .where(eq(juniorConversations.conversationId, childConversationId));
  await sendParentMessage({
    ...args,
    childConversationId,
    ...(args.agentConfig?.fork ? { fork: true } : undefined),
    text: args.task,
  });
  return childConversationId;
}
