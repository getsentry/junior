import { readMessageAttachments } from "@/chat/attachments/input";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import type {
  ConversationAuthor,
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import type { AgentInstructionInput } from "@/chat/agent/types";
import type { InboundMessage } from "@/chat/task-execution/store";

/**
 * Return the Turn inputs of web Messages, one per non-empty Message, in
 * order. Each one becomes its own prompt content part. A batch with only
 * attachments keeps one empty input, so the prompt still has an instruction.
 */
export function webTurnInputs(
  messages: readonly { text: string }[],
): AgentInstructionInput[] {
  const inputs = messages.flatMap((message) => {
    const text = message.text.trim();
    return text ? [{ kind: "person" as const, text }] : [];
  });
  return inputs.length ? inputs : [{ kind: "person", text: "" }];
}

/**
 * Build the transcript Message for one web mailbox Message. Each web Message
 * keeps its own transcript Message and Review item change record, so the
 * dashboard shows what each Message did even when several share a Turn.
 */
export function webConversationMessage(
  message: InboundMessage,
  author: ConversationAuthor,
): ConversationMessage {
  const attachments = readMessageAttachments(message.input.attachments);
  const { reviewItemChange } = message.input;
  return {
    id: message.inboundMessageId,
    role: "user",
    text: normalizeConversationText(message.input.text),
    createdAtMs: message.createdAtMs,
    author,
    ...(message.input.authorIdentityId
      ? { authorIdentityId: message.input.authorIdentityId }
      : undefined),
    meta: {
      ...(attachments.length ? { attachments } : undefined),
      explicitMention: true,
      ...(reviewItemChange
        ? { reviewItemChanges: [reviewItemChange] }
        : undefined),
      source: "web",
    },
  };
}

/**
 * Return the saved input Messages of a resumed Turn in input order. A web
 * batch saves each Message apart. An older Turn saved one joined Message, so
 * its other input ids have no saved Message.
 */
export function savedTurnInputMessages(
  conversation: ThreadConversationState,
  turnMessage: ConversationMessage,
  inputMessageIds: readonly string[] | undefined,
): ConversationMessage[] {
  const saved = (inputMessageIds ?? []).flatMap(
    (id) =>
      conversation.messages.find(
        (message) => message.id === id && message.role === "user",
      ) ?? [],
  );
  return saved.some((message) => message.id === turnMessage.id)
    ? saved
    : [turnMessage];
}
