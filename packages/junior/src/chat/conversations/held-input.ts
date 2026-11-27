import { instructionForInputs } from "@/chat/agent/prompt";
import type {
  AgentInstruction,
  RuntimeInstructionInput,
} from "@/chat/agent/types";
import { loadThreadContextCursor } from "@/chat/conversations/thread-context";
import type {
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";

/** Skip reason on the Message that saves input a stopped Conversation holds. */
export const STOPPED_CONVERSATION_SKIP_REASON = "stopped conversation";

/** Return whether a Message saves input that a stopped Conversation held. */
export function isHeldInputMessage(message: ConversationMessage): boolean {
  return message.meta?.skippedReason === STOPPED_CONVERSATION_SKIP_REASON;
}

/**
 * Put the input that a stopped Conversation held since the previous Turn
 * before the inputs of this Turn, so the Turn gets it as Turn input. The
 * cursor is read only when the Conversation holds input.
 */
export async function withHeldInput(
  args: {
    conversation: ThreadConversationState;
    conversationId: string;
    turnId: string;
  },
  instruction: Pick<AgentInstruction, "inputs" | "text">,
): Promise<Pick<AgentInstruction, "inputs" | "text">> {
  const held = args.conversation.messages.filter(isHeldInputMessage);
  if (held.length === 0) return instruction;
  const afterSeq = await loadThreadContextCursor(args);
  const inputs = held
    .filter(
      (message) =>
        afterSeq === undefined ||
        message.seq === undefined ||
        message.seq > afterSeq,
    )
    .map((message): RuntimeInstructionInput => ({
      kind: "runtime",
      text: message.text,
    }));
  if (inputs.length === 0) return instruction;
  return instructionForInputs([
    ...inputs,
    ...(instruction.inputs ?? [
      { kind: "person" as const, text: instruction.text },
    ]),
  ]);
}
