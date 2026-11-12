import { actorSchema } from "@sentry/junior-plugin-api";
import { and, desc, eq, sql } from "drizzle-orm";
import * as z from "zod";
import type { AgentInstruction, AgentRun } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import { credentialContextSchema } from "@/chat/credentials/context";
import { getSqlExecutor } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import type { InboundMessage } from "@/chat/task-execution/store";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { loadForkHistory } from "./fork-history";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_PARENT_MESSAGE_EVENT_TYPE,
} from "./result-event-type";
import { readChildSpawnOptions } from "./spawn-options";
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
 * received it, with that parent's author id. Another message is logged, and
 * the caller drops it.
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
  if (rows.length > 0) {
    return true;
  }
  logWarn("agent.parent_message.dropped", {
    "app.conversation_id": message.conversationId,
    "app.inbound_message_id": message.inboundMessageId,
    "app.parent_conversation_id": parentMessage.event.identifier,
  });
  return false;
}

/**
 * Render a parent message as the child model reads it, as an Agent
 * invocation renders its task.
 */
export async function parentMessageText(
  message: InboundMessage,
  parentMessage: ParentMessage,
): Promise<string> {
  const options = await readChildSpawnOptions(message.conversationId);
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
 * Apply the spawn options of a child agent to one of its Turns on the root
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
  const options = await readChildSpawnOptions(args.conversationId);
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
