/** No-reply result of a Turn. */
import * as z from "zod";
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";

/** Model-facing tool that ends a Turn with no reply. */
export const NO_REPLY_TOOL_NAME = "noReply";

const noReplySchema = z.object({
  note: z.string().trim().min(1).optional(),
});

/**
 * A Turn that ended with no reply. `note` is the outcome that the agent kept
 * for the Conversation: an Event Turn stores it as a Quiet message.
 */
export type NoReply = z.output<typeof noReplySchema>;

/**
 * Read the last successful no-reply result from the new messages of one run.
 * Do not pass the whole history: a call from an earlier Turn must not end
 * this one.
 */
export function readNoReply(messages: readonly unknown[]): NoReply | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !isToolResultMessage(message) ||
      isToolResultError(message) ||
      normalizeToolNameFromResult(message) !== NO_REPLY_TOOL_NAME
    ) {
      continue;
    }
    const parsed = noReplySchema.safeParse(message.details);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

// Stored history from before `noReply` ends some Turns with these markers,
// and a model that reads that history can copy one as its whole final response.
const LEGACY_NO_REPLY_MARKERS: readonly string[] = [
  "[[NO_REPLY]]",
  "[[QUIET]]",
];

/** True when the text is only a legacy no-reply marker from old history. */
export function isLegacyNoReplyMarker(text: string): boolean {
  return LEGACY_NO_REPLY_MARKERS.includes(text.trim());
}

/** Return the first legacy no-reply marker that the text contains. */
export function findLegacyNoReplyMarker(text: string): string | undefined {
  return LEGACY_NO_REPLY_MARKERS.find((marker) => text.includes(marker));
}
