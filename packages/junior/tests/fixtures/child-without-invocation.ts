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
  AGENT_TASK_EVENT_TYPE,
} from "@/chat/agent-invocations/result-event-type";
import type { ChildSpawnOptions } from "@/chat/agent-invocations/spawn-options";
import type { ConversationStore } from "@/chat/conversations/store";
import type { CredentialContext } from "@/chat/credentials/context";
import { getDb } from "@/chat/db";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { juniorConversations } from "@/db/schema";

// The author id that a parent's Turn Actor writes on its child input.
function authorIdFor(actor: Actor): string {
  switch (actor.platform) {
    case "system":
      return `agent-invocation:system:${actor.name}`;
    case "slack":
      return `agent-invocation:slack:${actor.teamId}:${actor.userId}`;
    default:
      return `agent-invocation:${actor.platform}:${actor.userId}`;
  }
}

/**
 * Spawn a child agent as a spawn that writes no agent invocation does: the
 * child Conversation with its spawn options, and its task as an Event in its
 * mailbox. This pins the state that a rollback must still read.
 */
export async function spawnChildWithoutInvocation(args: {
  actor: Actor;
  conversationStore: ConversationStore;
  credentialContext?: CredentialContext;
  idempotencyKey: string;
  kind?: "task" | "thread";
  parentConversationId: string;
  queue: ConversationWorkQueue;
  spawnOptions?: ChildSpawnOptions;
  state?: StateAdapter;
  task?: string;
  title?: string;
}): Promise<string> {
  const invocationId = getAgentInvocationId(
    args.parentConversationId,
    args.idempotencyKey,
  );
  const childConversationId = getUnnamedAgentConversationId(invocationId);
  await args.conversationStore.createChild({
    childConversationId,
    kind: args.kind ?? "task",
    parentConversationId: args.parentConversationId,
    source: "internal",
    ...(args.title ? { title: args.title } : undefined),
  });
  await getDb()
    .update(juniorConversations)
    .set({ spawnOptions: args.spawnOptions ?? {} })
    .where(eq(juniorConversations.conversationId, childConversationId));
  const inboundMessageId = getAgentInvocationMessageId(invocationId);
  const nowMs = Date.now();
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: childConversationId,
      createdAtMs: nowMs,
      delivery: "defer",
      inboundMessageId,
      input: {
        authorId: authorIdFor(args.actor),
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata: {
          actor: args.actor,
          ...(args.credentialContext
            ? { credentialContext: args.credentialContext }
            : undefined),
          event: {
            eventKey: inboundMessageId,
            eventType: AGENT_TASK_EVENT_TYPE,
            identifier: args.parentConversationId,
            namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
            trustedSummary: "Your parent agent sent a task.",
          },
          kind: "event",
          parentToolCallId: args.idempotencyKey,
        },
        text: `<parent-agent-task>\n${args.task ?? "Check the deploy."}\n</parent-agent-task>`,
      },
      receivedAtMs: nowMs,
      source: "event",
    },
    queue: args.queue,
    state: args.state,
  });
  return childConversationId;
}
