import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isContinuablePiBoundary,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import {
  classifyAssistantOutput,
  type AssistantOutputRejection,
} from "@/chat/services/assistant-output";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

export type OutputRecovery =
  | { kind: "none" }
  | {
      kind: "retry";
      messages: PiMessage[];
      reason: AssistantOutputRejection;
    }
  | { kind: "exhausted"; reason: AssistantOutputRejection };

/** Decide whether rejected post-compaction output gets one safe continuation. */
export function nextOutputRecovery(args: {
  attempt: number;
  lastAssistant?: AssistantMessage;
  messages: PiMessage[];
}): OutputRecovery {
  if (!hasCompactedConversationContext(args.messages)) {
    return { kind: "none" };
  }
  if (
    args.lastAssistant?.stopReason === "error" ||
    args.lastAssistant?.stopReason === "aborted"
  ) {
    return { kind: "none" };
  }

  const output = args.lastAssistant
    ? classifyAssistantOutput(args.lastAssistant)
    : ({ kind: "reject", reason: "empty" } as const);
  if (output.kind !== "reject") {
    return { kind: "none" };
  }
  if (args.attempt > 0) {
    return { kind: "exhausted", reason: output.reason };
  }

  const messages = trimTrailingAssistantMessages(args.messages);
  const removedAssistant = messages.length < args.messages.length;
  if (
    (!args.lastAssistant || removedAssistant) &&
    isContinuablePiBoundary(messages)
  ) {
    return { kind: "retry", messages, reason: output.reason };
  }
  return { kind: "exhausted", reason: output.reason };
}
