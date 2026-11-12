/**
 * Answer of a gated Turn.
 *
 * A gated Turn ends with one answer tool: `reply`, `noReply`, or
 * `reportBlocked`. Its final response is not delivered. The runtime reads the
 * answer and decides what to post.
 */
import * as z from "zod";
import {
  REPORT_BLOCKED_TOOL_NAME,
  type BlockedReport,
} from "@/chat/agent-invocations/blocked-report";
import { NO_REPLY_TOOL_NAME, type NoReply } from "@/chat/no-reply";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isAssistantMessage,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import { sanitizeAssistantText } from "@/chat/services/assistant-reply";

/** Model-facing tool that sets the reply of a gated Turn. */
export const REPLY_TOOL_NAME = "reply";

/** Return whether a tool ends a gated Turn with its answer. */
export function isAnswerToolName(name: string): boolean {
  return (
    name === REPLY_TOOL_NAME ||
    name === NO_REPLY_TOOL_NAME ||
    name === REPORT_BLOCKED_TOOL_NAME
  );
}

/**
 * The `reply` call of a gated Turn. Its tool call id keys the delivery, so a
 * retried delivery does not send it twice.
 */
export type Reply = { text: string; toolCallId: string };

/** The answer that ended a gated Turn. */
export type TurnAnswer =
  | { reply: Reply }
  | { noReply: NoReply }
  | { blocked: BlockedReport };

/** The `reply` text gets the same cleanup as a chat reply. */
export const replyTextSchema = z
  .string()
  .transform(sanitizeAssistantText)
  .pipe(z.string().min(1));

const replySchema = z.object({ text: replyTextSchema });
const noReplySchema = z.object({ note: z.string().trim().min(1).optional() });
const blockedSchema = z.object({ missing: z.string().trim().min(1) });

// TODO(dcramer): Remove one release after #3060 step 3. An Automation run
// that was in progress at deploy can have this result from an earlier slice.
const LEGACY_FINISH_AUTOMATION_RUN_TOOL_NAME = "finishAutomationRun";
const legacyResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("send_message"), message: replyTextSchema }),
  z.object({ result: z.literal("no_action"), reason: z.string() }),
  z.object({ result: z.literal("misconfigured"), reason: z.string().min(1) }),
]);

function parseAnswer(
  toolName: string | undefined,
  details: unknown,
  toolCallId: string,
): TurnAnswer | undefined {
  switch (toolName) {
    case REPLY_TOOL_NAME: {
      const parsed = replySchema.safeParse(details);
      return parsed.success
        ? { reply: { text: parsed.data.text, toolCallId } }
        : undefined;
    }
    case NO_REPLY_TOOL_NAME: {
      const parsed = noReplySchema.safeParse(details);
      return parsed.success ? { noReply: parsed.data } : undefined;
    }
    case REPORT_BLOCKED_TOOL_NAME: {
      const parsed = blockedSchema.safeParse(details);
      return parsed.success ? { blocked: parsed.data } : undefined;
    }
    case LEGACY_FINISH_AUTOMATION_RUN_TOOL_NAME: {
      const parsed = legacyResultSchema.safeParse(details);
      if (!parsed.success) return undefined;
      switch (parsed.data.result) {
        case "send_message":
          return { reply: { text: parsed.data.message, toolCallId } };
        case "no_action":
          return { noReply: {} };
        case "misconfigured":
          return { blocked: { missing: parsed.data.reason } };
      }
    }
  }
  return undefined;
}

/**
 * Read the last successful answer from the messages of one Turn. Do not pass
 * the whole history: an answer from an earlier Turn must not end this one.
 */
export function readTurnAnswer(
  messages: readonly unknown[],
): TurnAnswer | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolResultMessage(message) || isToolResultError(message)) {
      continue;
    }
    const answer = parseAnswer(
      normalizeToolNameFromResult(message),
      message.details,
      message.toolCallId,
    );
    if (answer) return answer;
  }
  return undefined;
}

const MISSING_ANSWER_REMINDER = `This Turn has not ended. Your text was not delivered. Call \`${REPLY_TOOL_NAME}\`, \`${NO_REPLY_TOOL_NAME}\`, or \`${REPORT_BLOCKED_TOOL_NAME}\` now.`;

/**
 * Return agent history plus a reminder when the model stopped without an
 * answer, or undefined when the Turn already has one. `turnStart` is the
 * index of the Turn's first message in `messages`.
 */
export function remindMissingAnswer(
  messages: readonly PiMessage[],
  turnStart: number,
): PiMessage[] | undefined {
  const last = messages.at(-1);
  if (
    !isAssistantMessage(last) ||
    last.stopReason !== "stop" ||
    readTurnAnswer(messages.slice(turnStart))
  ) {
    return undefined;
  }
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: MISSING_ANSWER_REMINDER }],
      timestamp: Date.now(),
    } as PiMessage,
  ];
}
