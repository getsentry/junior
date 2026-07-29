import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import { isContinuablePiBoundary } from "@/chat/pi/transcript";
import {
  decideReply,
  type ReplyRejection,
} from "@/chat/services/assistant-reply";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

type ReplyRecovery =
  | { kind: "none" }
  | {
      kind: "retry";
      messages: PiMessage[];
      reason: ReplyRejection;
    }
  | { kind: "exhausted"; reason: ReplyRejection };

/**
 * Decide whether a rejected assistant message gets one continuation after a
 * history replacement.
 */
export function nextReplyRecovery(args: {
  attempt: number;
  lastAssistant?: AssistantMessage;
  messages: PiMessage[];
}): ReplyRecovery {
  if (!hasCompactedConversationContext(args.messages)) {
    return { kind: "none" };
  }
  if (
    args.lastAssistant?.stopReason === "error" ||
    args.lastAssistant?.stopReason === "aborted"
  ) {
    return { kind: "none" };
  }

  const decision = args.lastAssistant
    ? decideReply(args.lastAssistant)
    : ({ kind: "reject", reason: "empty" } as const);
  if (decision.kind !== "reject") {
    return { kind: "none" };
  }
  if (args.attempt > 0) {
    return { kind: "exhausted", reason: decision.reason };
  }

  if (!args.lastAssistant) {
    return isContinuablePiBoundary(args.messages)
      ? {
          kind: "retry",
          messages: [...args.messages],
          reason: decision.reason,
        }
      : { kind: "exhausted", reason: decision.reason };
  }

  if (args.messages.at(-1) !== args.lastAssistant) {
    return { kind: "exhausted", reason: decision.reason };
  }
  // Earlier assistant messages may already be delivered. Remove only the
  // rejected message, then continue only if the remaining tail is safe.
  const messages = args.messages.slice(0, -1);
  return isContinuablePiBoundary(messages)
    ? { kind: "retry", messages, reason: decision.reason }
    : { kind: "exhausted", reason: decision.reason };
}
