import type { Actor, Destination } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import { buildParentMessage } from "@/chat/agent-invocations/parent-message";
import type { AgentConfig } from "@/chat/conversations/agent-config";
import type { ConversationStore } from "@/chat/conversations/store";
import type { CredentialContext } from "@/chat/credentials/context";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { slackDestination } from "./agent-invocations";

/**
 * Put a parent message in a child's mailbox with no parent lock or capacity
 * check, as a parent that writes no Agent invocation sends it. `from`
 * overrides the parent that the message names, and `authorId` its author id,
 * so a test can send one that the child must drop.
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
  text?: string | undefined;
}): Promise<string> {
  const message = buildParentMessage({
    actor: args.actor,
    childConversationId: args.childConversationId,
    credentialContext: args.credentialContext,
    fork: args.fork,
    idempotencyKey: args.idempotencyKey,
    nowMs: Date.now(),
    parentConversationId: args.from ?? args.parentConversationId,
    parentToolCallId: args.idempotencyKey,
    text: args.text ?? "Check the deploy.",
    trustedSummary: "Your parent agent sent a task.",
  });
  if (args.authorId) {
    message.input.authorId = args.authorId;
  }
  await appendAndEnqueueInboundMessage({
    message,
    queue: args.queue,
    state: args.state,
  });
  return message.inboundMessageId;
}

/**
 * Spawn a child agent as `spawnAgent` does with the flag on: the child
 * Conversation with its agent config, and its task as a parent message in
 * its mailbox. Tests use it to build that child whatever the flag is.
 */
export async function spawnChildWithoutAgentInvocation(args: {
  actor: Actor;
  agentConfig?: AgentConfig;
  conversationStore: ConversationStore;
  credentialContext?: CredentialContext;
  destination?: Destination;
  idempotencyKey: string;
  kind?: "task" | "thread";
  parentConversationId: string;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
  task?: string;
  title?: string;
}): Promise<string> {
  const { childConversationId } = await spawnChildAgent(
    {
      actor: args.actor,
      ...args.agentConfig,
      ...(args.credentialContext
        ? { credentialContext: args.credentialContext }
        : undefined),
      destination: args.destination ?? slackDestination,
      idempotencyKey: args.idempotencyKey,
      input: args.task ?? "Check the deploy.",
      ...(args.kind ? { kind: args.kind } : undefined),
      parentConversationId: args.parentConversationId,
      parentToolCallId: args.idempotencyKey,
      parentTurnId: args.idempotencyKey,
      ...(args.title ? { title: args.title } : undefined),
    },
    {
      conversationStore: args.conversationStore,
      queue: args.queue,
      state: args.state,
    },
  );
  return childConversationId;
}
