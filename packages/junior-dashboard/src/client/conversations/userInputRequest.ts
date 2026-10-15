import type { ConversationReportEvent } from "@sentry/junior/api/schema";

/** Model-facing name of Junior's tool that asks a person to pick a choice. */
const REQUEST_USER_INPUT_TOOL_NAME = "requestUserInput";

/** A question from Junior that still waits for an answer. */
export type OpenUserInputRequest = {
  options: Array<{ description?: string; label: string }>;
  question: string;
  toolCallId: string;
};

function parseRequestInput(
  input: unknown,
): Omit<OpenUserInputRequest, "toolCallId"> | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { options, question } = input as Record<string, unknown>;
  if (typeof question !== "string" || !Array.isArray(options)) return undefined;
  const parsed: OpenUserInputRequest["options"] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null) return undefined;
    const { description, label } = option as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) return undefined;
    parsed.push({
      label: label.trim(),
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim() }
        : undefined),
    });
  }
  return parsed.length > 0 ? { options: parsed, question } : undefined;
}

/**
 * Find the latest `requestUserInput` call that no user message answers yet.
 * Any later user message is the answer, whether it is a click or typed text.
 */
export function openUserInputRequest(
  events: readonly ConversationReportEvent[] | undefined,
): OpenUserInputRequest | undefined {
  let open: OpenUserInputRequest | undefined;
  for (const event of events ?? []) {
    const data = event.data;
    if (data.type === "message" && data.role === "user") {
      open = undefined;
      continue;
    }
    if (data.type !== "tool_calls") continue;
    for (const call of data.calls) {
      if (call.name !== REQUEST_USER_INPUT_TOOL_NAME) continue;
      const request =
        call.status === "completed" ? parseRequestInput(call.input) : undefined;
      if (request) {
        open = { ...request, toolCallId: call.toolCallId };
      } else if (open?.toolCallId === call.toolCallId) {
        open = undefined;
      }
    }
  }
  return open;
}
