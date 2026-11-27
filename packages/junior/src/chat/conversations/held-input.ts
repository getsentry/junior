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

// Most characters of held input that one Turn gets. The newest held
// Messages that fit are kept, and older ones are left out with a note.
const HELD_INPUT_MAX_CHARS = 16_000;
const TRUNCATED_HELD_NOTE =
  " [truncated: read the full Message with readConversationEvent]";

/**
 * Keep the newest held texts that fit in the held-input budget, oldest
 * first. A newest text that alone is too long is cut and marked. When older
 * texts are left out, one line before the rest says how many.
 */
export function capHeldInputs(
  texts: readonly string[],
): RuntimeInstructionInput[] {
  const kept: string[] = [];
  let remaining = HELD_INPUT_MAX_CHARS;
  for (const text of [...texts].reverse()) {
    if (text.length <= remaining) {
      kept.unshift(text);
      remaining -= text.length;
    } else if (kept.length === 0) {
      kept.unshift(
        `${text.slice(0, remaining - TRUNCATED_HELD_NOTE.length)}${TRUNCATED_HELD_NOTE}`,
      );
      remaining = 0;
    } else {
      break;
    }
  }
  const omitted = texts.length - kept.length;
  return [
    ...(omitted > 0
      ? [
          `${omitted} earlier held ${omitted === 1 ? "Event is" : "Events are"} not shown. Find them with a searchConversationEvents query, then read them with readConversationEvent.`,
        ]
      : []),
    ...kept,
  ].map((text): RuntimeInstructionInput => ({ kind: "runtime", text }));
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
  const inputs = capHeldInputs(
    held
      .filter(
        (message) =>
          afterSeq === undefined ||
          message.seq === undefined ||
          message.seq > afterSeq,
      )
      .map((message) => message.text),
  );
  if (inputs.length === 0) return instruction;
  return instructionForInputs([
    ...inputs,
    ...(instruction.inputs ?? [
      { kind: "person" as const, text: instruction.text },
    ]),
  ]);
}
