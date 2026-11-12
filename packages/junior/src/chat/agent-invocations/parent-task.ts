import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { AgentInstruction, AgentRun } from "@/chat/agent/types";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import { credentialContextSchema } from "@/chat/credentials/context";
import type { PiMessage } from "@/chat/pi/messages";
import type { InboundMessage } from "@/chat/task-execution/store";
import { loadForkHistory } from "./fork-history";
import {
  AGENT_INVOCATION_EVENT_NAMESPACE,
  AGENT_TASK_EVENT_TYPE,
} from "./result-event-type";
import { readChildSpawnOptions } from "./spawn-options";

/**
 * A parent agent task or message to a child that no agent invocation names.
 * It is an Event from the parent Conversation (`event.identifier`) with the
 * Actor and grants of the parent's Turn, and the `spawnAgent` or
 * `messageAgent` tool call that sent it. The parent renders its text.
 */
const parentTaskSchema = z.object({
  actor: actorSchema,
  credentialContext: credentialContextSchema.optional(),
  event: z.object({
    eventType: z.literal(AGENT_TASK_EVENT_TYPE),
    identifier: z.string().min(1),
    namespace: z.literal(AGENT_INVOCATION_EVENT_NAMESPACE),
  }),
  kind: z.literal("event"),
  parentToolCallId: z.string().min(1),
});

/** One parent agent task or message read from a child's mailbox. */
export type ParentTask = z.output<typeof parentTaskSchema>;

/** Read the parent agent task that one mailbox input is, if it is one. */
export function readParentTask(
  message: InboundMessage,
): ParentTask | undefined {
  if (message.source !== "event") {
    return undefined;
  }
  const parsed = parentTaskSchema.safeParse(message.input.metadata);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Apply the spawn options of a child agent to one of its Turns on the root
 * Turn code. Every Turn keeps the reasoning level. A fork's first Turn
 * starts with its parent's history. A parent task is the child's
 * instruction, as on an agent invocation.
 */
export async function childAgentTurnOptions(args: {
  conversationId: string;
  history: PiMessage[];
  inputs: readonly InboundMessage[];
}): Promise<{
  history: PiMessage[];
  instruction: Pick<AgentInstruction, "provenance">;
  run: Pick<AgentRun, "reasoning">;
}> {
  const options = await readChildSpawnOptions(args.conversationId);
  const task = args.inputs
    .map(readParentTask)
    .find((input) => input !== undefined);
  return {
    history:
      task && options.fork && args.history.length === 0
        ? await loadForkHistory({
            parentConversationId: task.event.identifier,
            parentToolCallId: task.parentToolCallId,
          })
        : args.history,
    instruction: task ? { provenance: agentInstructionProvenance } : {},
    run: options.reasoningLevel ? { reasoning: options.reasoningLevel } : {},
  };
}
