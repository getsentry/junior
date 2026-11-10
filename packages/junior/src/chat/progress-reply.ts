/** Progress-only replies of a Turn. */
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";

/** Model-facing tool that marks the replies of a Turn as progress only. */
export const PROGRESS_REPLY_TOOL_NAME = "markProgressReply";

/**
 * True when the messages of the current Turn hold a successful progress-reply
 * call. Do not pass the whole history: a call from an earlier Turn must not
 * mark this one.
 */
export function readProgressReply(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) =>
      isToolResultMessage(message) &&
      !isToolResultError(message) &&
      normalizeToolNameFromResult(message) === PROGRESS_REPLY_TOOL_NAME,
  );
}

/**
 * Message meta for a delivered reply. A Progress message still delivers; it
 * only skips unread and push. A card means someone must look, so a reply with
 * a card always notifies.
 */
export function progressReplyMeta(
  options: { progress?: true } | undefined,
  cards: readonly unknown[],
): { progress: true } | undefined {
  return options?.progress && cards.length === 0
    ? { progress: true }
    : undefined;
}
