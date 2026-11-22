/**
 * Token estimates of compaction: the size of history before a compaction,
 * and of the replacement that it writes.
 */
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { PiMessage } from "@/chat/pi/messages";
import { estimateMessagesTokens } from "@/chat/services/token-estimate";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";

function timestampOf(message: PiMessage): number | undefined {
  return "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : undefined;
}

/** Find the latest compaction summary in history. */
function latestSummaryIndex(messages: PiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && hasCompactedConversationContext([message])) {
      return index;
    }
  }
  return -1;
}

/** Find when the latest compaction summary in history was written. */
function latestSummaryTimestamp(messages: PiMessage[]): number | undefined {
  const index = latestSummaryIndex(messages);
  return index < 0 ? undefined : timestampOf(messages[index]!);
}

/**
 * Read the input size that the provider reported for one model call. Output
 * is left out: it is not part of the request that the call measured.
 */
function measuredInputTokens(message: PiMessage): number | undefined {
  if (
    message.role !== "assistant" ||
    !message.usage ||
    message.stopReason === "aborted" ||
    message.stopReason === "error"
  ) {
    return undefined;
  }
  const { usage } = message;
  const tokens =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return tokens > 0 ? tokens : undefined;
}

// Pi 1.0 removed `estimateContextTokens` from agent-core. pi-ai's version also
// drops the usage of an assistant message that is stamped before any earlier
// message, such as after clock skew, and then estimates all history by size.
// Junior checks only the case that matters, a newer summary, below.
function lastAssistantUsage(
  messages: PiMessage[],
): { tokens: number; index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role !== "assistant" ||
      message.stopReason === "aborted" ||
      message.stopReason === "error" ||
      !message.usage
    ) {
      continue;
    }
    const tokens = calculateContextTokens(message.usage);
    if (tokens > 0) return { tokens, index };
  }
  return undefined;
}

/**
 * Measure provider-visible history without counting host-only message fields.
 *
 * Provider usage counts the request that produced it. A replacement keeps
 * assistant messages that are older than its summary, and their usage counts
 * the history before the replacement. So when the latest usage is older than
 * the latest summary, estimate each message by size.
 */
export function estimateHistoryTokens(
  messages: PiMessage[],
  modelId: string,
  requestOverheadTokens = 0,
): number {
  const usage = lastAssistantUsage(messages);
  const summaryAt = latestSummaryTimestamp(messages);
  const usageAt = usage ? timestampOf(messages[usage.index]!) : undefined;
  if (
    usage &&
    usageAt !== undefined &&
    (summaryAt === undefined || usageAt > summaryAt)
  ) {
    // The usage counts the request up to that call. Estimate the rest by size.
    return (
      usage.tokens +
      estimateMessagesTokens(messages.slice(usage.index + 1), modelId)
    );
  }
  return estimateReplacementTokens(messages, modelId, requestOverheadTokens);
}

/**
 * Read the provider-reported input of the first model call after the latest
 * full compaction. That request held only the summary and the kept context,
 * so another full compaction of the same context cannot get much below it.
 * A swap also keeps agent history from before its summary. A full compaction
 * can still drop that history, so a swap gives no such size.
 */
export function measuredReplacementTokens(
  messages: PiMessage[],
): number | undefined {
  const summaryIndex = latestSummaryIndex(messages);
  if (summaryIndex < 0) return undefined;
  const summaryAt = timestampOf(messages[summaryIndex]!);
  if (summaryAt === undefined) return undefined;
  for (const message of messages.slice(summaryIndex + 1)) {
    const timestamp = timestampOf(message);
    if (timestamp === undefined || timestamp <= summaryAt) {
      // A replacement adds only user messages and section changes.
      if (message.role !== "user" && message.role !== "system") {
        return undefined;
      }
      continue;
    }
    const tokens = measuredInputTokens(message);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

/**
 * Estimate a replacement request from each message's own size. A kept
 * assistant message holds provider usage for the whole request before the
 * replacement, so usage is ignored here.
 */
export function estimateReplacementTokens(
  messages: PiMessage[],
  modelId: string,
  requestOverheadTokens = 0,
): number {
  return requestOverheadTokens + estimateMessagesTokens(messages, modelId);
}
