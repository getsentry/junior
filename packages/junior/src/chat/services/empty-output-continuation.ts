import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import { isContinuablePiBoundary } from "@/chat/pi/transcript";
import { decideReply } from "@/chat/services/assistant-reply";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

type EmptyOutputContinuation =
  | { kind: "none" }
  | {
      kind: "retry";
      messages: PiMessage[];
    }
  | { kind: "exhausted" };

/**
 * Decide whether empty assistant output gets one continuation after a
 * history replacement.
 */
export function nextEmptyOutputContinuation(args: {
  attempt: number;
  lastAssistant?: AssistantMessage;
  messages: PiMessage[];
}): EmptyOutputContinuation {
  if (!hasCompactedConversationContext(args.messages)) {
    return { kind: "none" };
  }
  if (
    args.lastAssistant?.stopReason === "error" ||
    args.lastAssistant?.stopReason === "aborted"
  ) {
    return { kind: "none" };
  }

  if (args.lastAssistant && decideReply(args.lastAssistant).kind !== "empty") {
    return { kind: "none" };
  }
  if (args.attempt > 0) {
    return { kind: "exhausted" };
  }

  if (!args.lastAssistant) {
    return isContinuablePiBoundary(args.messages)
      ? {
          kind: "retry",
          messages: [...args.messages],
        }
      : { kind: "exhausted" };
  }

  if (args.messages.at(-1) !== args.lastAssistant) {
    return { kind: "exhausted" };
  }
  // Earlier assistant messages may already be delivered. Remove only the
  // empty message, then continue only if the remaining tail is safe.
  const messages = args.messages.slice(0, -1);
  return isContinuablePiBoundary(messages)
    ? { kind: "retry", messages }
    : { kind: "exhausted" };
}
