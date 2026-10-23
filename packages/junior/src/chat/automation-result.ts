/**
 * Automation run result.
 *
 * A Scheduled automation or Event automation run ends with one declared
 * result. The run does not deliver its final assistant text. The work owner
 * reads the declared result and applies the stored outcomes.
 */
import { z } from "zod";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isAssistantMessage,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import { sanitizeAssistantText } from "@/chat/services/assistant-reply";

/** Model-facing tool that ends an Automation run. */
export const FINISH_AUTOMATION_RUN_TOOL_NAME = "finishAutomationRun";

/** Most thread replies one declared message can carry. */
export const MAX_AUTOMATION_THREAD_REPLIES = 10;

const declaredText = z
  .string()
  .transform(sanitizeAssistantText)
  .pipe(z.string().min(1));

/** One declared result for an Automation run. */
export const automationResultSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("send_message"),
    // The declared message gets the same cleanup as a chat reply.
    message: declaredText,
    threadReplies: z
      .array(declaredText)
      .max(MAX_AUTOMATION_THREAD_REPLIES)
      .optional(),
  }),
  z.object({
    result: z.literal("no_action"),
    reason: z.string().trim().min(1),
  }),
  z.object({
    result: z.literal("misconfigured"),
    reason: z.string().trim().min(1),
  }),
]);

/** One declared result for an Automation run. */
export type AutomationResult = z.output<typeof automationResultSchema>;

/** Dispatch facts that decide what a run posts. */
type RunDispatch =
  | { declaresResult?: boolean; outcomes?: readonly unknown[] }
  | undefined;

/**
 * Return whether the runtime delivers the final assistant text of a run. It
 * does not for a dispatch with no outcomes. It does not for an Automation
 * run, which posts only its declared message, after the run.
 */
export function deliversFinalText(dispatch: RunDispatch): boolean {
  return dispatch?.outcomes?.length !== 0 && !dispatch?.declaresResult;
}

/** Text that a finished run posts, plus replies in the thread under it. */
export type FinishedRunReply = {
  text: string;
  threadReplies: readonly string[];
};

/**
 * Return what to post after a run ends, if anything. A chat Turn already
 * delivered a successful reply, so it posts only its failure reply. An
 * Automation run posts only a declared message and its thread replies. It
 * never posts a failure reply to its outcomes. The failed execution shows on
 * the Automation.
 */
export function finishedRunReply(
  result: {
    automation?: AutomationResult;
    diagnostics: { outcome: string };
    text: string;
  },
  dispatch: RunDispatch,
): FinishedRunReply | undefined {
  if (!dispatch?.declaresResult) {
    return result.diagnostics.outcome === "success"
      ? undefined
      : { text: result.text, threadReplies: [] };
  }
  return result.diagnostics.outcome === "success" &&
    result.automation?.result === "send_message" &&
    dispatch.outcomes?.length !== 0
    ? {
        text: result.text,
        threadReplies: result.automation.threadReplies ?? [],
      }
    : undefined;
}

/**
 * Read the last successful declared result from agent history items.
 *
 * Pass the whole run history, not only the current slice. An Automation run
 * owns its dispatch Conversation, and a resumed slice must see a result that
 * an earlier slice already saved.
 */
export function readAutomationResult(
  messages: readonly unknown[],
): AutomationResult | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !isToolResultMessage(message) ||
      isToolResultError(message) ||
      normalizeToolNameFromResult(message) !== FINISH_AUTOMATION_RUN_TOOL_NAME
    ) {
      continue;
    }
    const parsed = automationResultSchema.safeParse(message.details);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

/**
 * Map one finished agent run to its dispatch outcome. A declared
 * `misconfigured` result becomes a blocked dispatch with the declared reason.
 */
export function runDispatchOutcome(result: {
  automation?: AutomationResult;
  diagnostics: { errorMessage?: string; outcome: string };
}): { errorMessage?: string; outcome: "blocked" | "completed" | "failed" } {
  if (result.diagnostics.outcome !== "success") {
    return {
      errorMessage:
        result.diagnostics.errorMessage ??
        `Agent turn ended with ${result.diagnostics.outcome}.`,
      outcome: "failed",
    };
  }
  if (result.automation?.result === "misconfigured") {
    return { errorMessage: result.automation.reason, outcome: "blocked" };
  }
  return { outcome: "completed" };
}

const MISSING_RESULT_REMINDER =
  "This automation run has not ended. Your text was not delivered. Call `finishAutomationRun` now with one result.";

/**
 * Return agent history plus a reminder when the model stopped without a
 * declared result, or undefined when the run already declared one.
 */
export function remindMissingAutomationResult(
  messages: readonly PiMessage[],
): PiMessage[] | undefined {
  const last = messages.at(-1);
  if (
    !isAssistantMessage(last) ||
    last.stopReason !== "stop" ||
    readAutomationResult(messages)
  ) {
    return undefined;
  }
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: MISSING_RESULT_REMINDER }],
      timestamp: Date.now(),
    } as PiMessage,
  ];
}
