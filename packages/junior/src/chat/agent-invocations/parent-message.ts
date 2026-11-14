import { actorSchema, type Actor } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { and, desc, eq, sql } from "drizzle-orm";
import * as z from "zod";
import type { AgentInstruction, AgentRun } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  getConversationStoppedAtMs,
  isSkippedAfterConversationStop,
  resumeStoppedConversationTree,
} from "@/chat/conversations/session-stop";
import {
  credentialContextSchema,
  type CredentialContext,
} from "@/chat/credentials/context";
import { getSqlExecutor } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import {
  appendInboundMessage,
  dropPendingMessages,
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { loadForkHistory } from "./fork-history";
import { getAgentInvocationId, getAgentInvocationMessageId } from "./ids";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_PARENT_MESSAGE_EVENT_TYPE,
} from "./result-event-type";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { agentInvocationInputText } from "./work";

/**
 * A parent agent task or message to a child that no Agent invocation names.
 * It is an Event from the parent Conversation (`event.identifier`) with the
 * Actor and grants of the parent's Turn, and the `spawnAgent` or
 * `messageAgent` tool call that sent it. Its text is the raw task. `fork`
 * marks the task of a fork spawn.
 */
const parentMessageSchema = z.object({
  actor: actorSchema,
  credentialContext: credentialContextSchema.optional(),
  event: z.object({
    eventType: z.literal(AGENT_PARENT_MESSAGE_EVENT_TYPE),
    identifier: z.string().min(1),
    namespace: z.literal(AGENT_INVOCATION_EVENT_NAMESPACE),
  }),
  fork: z.literal(true).optional(),
  kind: z.literal("event"),
  parentToolCallId: z.string().min(1),
});

/** One parent agent task or message read from a child's mailbox. */
export type ParentMessage = z.output<typeof parentMessageSchema>;

/**
 * Return the author id of every parent message from one parent. It matches
 * no other input, so a parent message never shares a Turn with another
 * sender's input.
 */
export function parentMessageAuthorId(parentConversationId: string): string {
  return `parent-agent:${parentConversationId}`;
}

/**
 * Build the parent message that gives one task or message to a child that no
 * Agent invocation names. It has the mailbox id that an Agent invocation with
 * the same idempotency key would have, so a replay is a duplicate.
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
  trustedSummary: string;
}): InboundMessage {
  const inboundMessageId = getAgentInvocationMessageId(
    getAgentInvocationId(args.parentConversationId, args.idempotencyKey),
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
        event: {
          eventKey: inboundMessageId,
          eventType: AGENT_PARENT_MESSAGE_EVENT_TYPE,
          identifier: args.parentConversationId,
          namespace: AGENT_INVOCATION_EVENT_NAMESPACE,
          trustedSummary: args.trustedSummary,
        },
        ...(args.fork ? { fork: true } : undefined),
        kind: "event",
        parentToolCallId: args.parentToolCallId,
      },
      text: args.text,
    },
    receivedAtMs: args.nowMs,
    source: "event",
  };
}

/**
 * Append one parent message to its child's mailbox without a wake. New work
 * from the parent ends the stop of the child and of the child agents below
 * it, as an Agent invocation does. The parent messages that the stop skipped
 * stay skipped: they leave the mailbox first. A message that already reached
 * the mailbox changes nothing, so a replay does not end a later stop.
 */
export async function appendParentMessage(
  message: InboundMessage,
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
  if (work?.execution.inboundMessageIds.includes(message.inboundMessageId)) {
    return;
  }
  const stoppedAtMs = await getConversationStoppedAtMs(conversationId);
  if (stoppedAtMs !== undefined && message.createdAtMs > stoppedAtMs) {
    const skipped = (work?.messages ?? []).filter(
      (pending) =>
        readParentMessage(pending) !== undefined &&
        isSkippedAfterConversationStop(pending, stoppedAtMs),
    );
    if (skipped.length > 0) {
      await dropPendingMessages({
        conversationId,
        inboundMessageIds: skipped.map((pending) => pending.inboundMessageId),
        ...(options.state ? { state: options.state } : undefined),
      });
      for (const pending of skipped) {
        logDroppedParentMessage(pending, readParentMessage(pending)!);
      }
    }
    await resumeStoppedConversationTree(conversationId, message.createdAtMs);
  }
  await appendInboundMessage({
    message,
    ...(options.conversationStore
      ? { conversationStore: options.conversationStore }
      : undefined),
    nowMs: message.receivedAtMs,
    ...(options.state ? { state: options.state } : undefined),
  });
}

/**
 * Read the parent message that one mailbox input is, if it is one. Check its
 * sender with `isFromStoredParent` before it gets any authority.
 */
export function readParentMessage(
  message: InboundMessage,
): ParentMessage | undefined {
  if (message.source !== "event") {
    return undefined;
  }
  const parsed = parentMessageSchema.safeParse(message.input.metadata);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Return whether a parent message names the stored parent of the child that
 * received it, with that parent's author id. The caller drops another
 * message.
 */
export async function isFromStoredParent(
  message: InboundMessage,
  parentMessage: ParentMessage,
): Promise<boolean> {
  const rows =
    message.input.authorId ===
    parentMessageAuthorId(parentMessage.event.identifier)
      ? await getSqlExecutor()
          .db()
          .select({ conversationId: juniorConversations.conversationId })
          .from(juniorConversations)
          .where(
            and(
              eq(juniorConversations.conversationId, message.conversationId),
              eq(
                juniorConversations.parentConversationId,
                parentMessage.event.identifier,
              ),
            ),
          )
      : [];
  return rows.length > 0;
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
    "app.parent_conversation_id": parentMessage.event.identifier,
  });
}

/**
 * Render a parent message as the child model reads it, as an Agent
 * invocation renders its task.
 */
export async function parentMessageText(
  message: InboundMessage,
  parentMessage: ParentMessage,
): Promise<string> {
  const options = await readAgentConfig(message.conversationId);
  return agentInvocationInputText({
    agentType: options?.agentType,
    fork: parentMessage.fork,
    input: message.input.text,
    parentToolCallId: parentMessage.parentToolCallId,
  });
}

/**
 * Return whether a saved transcript Message is a parent message. Only the
 * root Turn code saves one, after its sender check.
 */
export function isParentMessageMeta(
  meta: { eventNamespace?: unknown; eventType?: unknown } | undefined,
): boolean {
  return (
    meta?.eventNamespace === AGENT_INVOCATION_EVENT_NAMESPACE &&
    meta.eventType === AGENT_PARENT_MESSAGE_EVENT_TYPE
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
        sql`${payload}->'meta'->>'eventNamespace' = ${AGENT_INVOCATION_EVENT_NAMESPACE}`,
        sql`${payload}->'meta'->>'eventType' = ${AGENT_PARENT_MESSAGE_EVENT_TYPE}`,
      ),
    )
    .orderBy(desc(juniorConversationEvents.createdAt))
    .limit(1);
  return row?.createdAt.getTime();
}

/**
 * Return whether a child got a parent message sent after `afterMs`: one that
 * waits in its mailbox, or one that its Turn saved.
 */
export async function hasParentMessageAfter(
  conversationId: string,
  afterMs: number,
  state?: StateAdapter,
): Promise<boolean> {
  const pending =
    (await getConversationWorkState({ conversationId, state }))?.messages ?? [];
  if (
    pending.some(
      (message) =>
        readParentMessage(message) !== undefined &&
        message.createdAtMs > afterMs,
    )
  ) {
    return true;
  }
  return ((await readLastParentMessageAtMs(conversationId)) ?? 0) > afterMs;
}

/**
 * Apply the agent config of a child agent to one of its Turns on the root
 * Turn code. Every Turn keeps the reasoning level. A fork's first Turn
 * starts with its parent's history. A parent message is the child's
 * instruction, as on an Agent invocation, also when its Turn resumes
 * (`savedParentMessage`). `inputs` passed the sender check.
 */
export async function childAgentTurnOptions(args: {
  conversationId: string;
  history: PiMessage[];
  inputs: readonly InboundMessage[];
  savedParentMessage: boolean;
}): Promise<{
  history: PiMessage[];
  instruction: Pick<AgentInstruction, "provenance">;
  run: Pick<AgentRun, "reasoning">;
}> {
  const options = await readAgentConfig(args.conversationId);
  const parentMessage = args.inputs
    .map(readParentMessage)
    .find((input) => input !== undefined);
  return {
    history:
      parentMessage?.fork && args.history.length === 0
        ? await loadForkHistory({
            parentConversationId: parentMessage.event.identifier,
            parentToolCallId: parentMessage.parentToolCallId,
          })
        : args.history,
    instruction:
      parentMessage || args.savedParentMessage
        ? { provenance: agentInstructionProvenance }
        : {},
    run: options?.reasoningLevel ? { reasoning: options.reasoningLevel } : {},
  };
}
