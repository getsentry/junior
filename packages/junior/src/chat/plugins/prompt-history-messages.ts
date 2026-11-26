import {
  startsWithTag,
  type PromptHistoryMessage,
} from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import { readPluginContributions } from "@/chat/prompt";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

function textParts(message: PiMessage): string[] {
  if (!("role" in message) || message.role !== "user") return [];
  const { content } = message;
  if (typeof content === "string") return [content];
  return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

function historyMessage(
  message: PiMessage,
  pluginName: string,
): PromptHistoryMessage | undefined {
  if (isToolResultMessage(message)) {
    return {
      type: "tool_result",
      tool_name: normalizeToolNameFromResult(message) ?? "",
      is_error: isToolResultError(message),
    };
  }
  const texts = textParts(message);
  if (texts.length === 0) return undefined;
  const contributions = (blockTexts: string[]) =>
    blockTexts.flatMap((text) => readPluginContributions(text, pluginName));
  const contexts = texts.filter((text) =>
    startsWithTag(text, [TURN_CONTEXT_TAG]),
  );
  if (contexts.length > 0) {
    return { type: "context", contributions: contributions(contexts) };
  }
  const summaries = texts.filter(isCompactionSummaryText);
  if (summaries.length > 0) {
    return { type: "summary", contributions: contributions(summaries) };
  }
  return { type: "input" };
}

/**
 * Describe the model history that a new prompt replays for one plugin's
 * `userPrompt` hook: each input, each Turn context and compaction summary
 * with the plugin's contributions in it, and each tool result.
 */
export function pluginPromptHistoryMessages(
  messages: readonly PiMessage[],
  pluginName: string,
): PromptHistoryMessage[] {
  return messages.flatMap((message) => {
    const described = historyMessage(message, pluginName);
    return described ? [described] : [];
  });
}
