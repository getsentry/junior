/**
 * Automation run result.
 *
 * A Scheduled automation or Event automation run ends with one declared
 * result. The run does not deliver its final assistant text. The work owner
 * reads the declared result and applies the stored outcomes.
 */
import type { Source } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { isNoReplyMarker } from "@/chat/no-reply";
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

/** One declared result for an Automation run. */
export const automationResultSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("send_message"),
    // The declared message gets the same cleanup as a chat reply.
    message: z
      .string()
      .transform(sanitizeAssistantText)
      .pipe(z.string().min(1)),
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

/** Return whether this Source starts an Automation run. */
export function isAutomationSource(source: Source): boolean {
  return (
    source.kind === "scheduled_automation" || source.kind === "event_automation"
  );
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
 * Return the declared result to save. A message that is only the old
 * no-reply marker posts nothing, so it becomes `no_action`.
 */
export function normalizeAutomationResult(
  result: AutomationResult,
): AutomationResult {
  return result.result === "send_message" && isNoReplyMarker(result.message)
    ? { result: "no_action", reason: "The message was the no-reply marker." }
    : result;
}

/**
 * Map one finished agent run to its dispatch outcome. A declared
 * `misconfigured` result becomes a blocked dispatch with the declared reason.
 * A blocked dispatch blocks its Scheduled automation or Event automation
 * until its creator resumes it.
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
