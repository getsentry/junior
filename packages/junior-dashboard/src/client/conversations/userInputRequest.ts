import {
  userInputRequestSchema,
  type ConversationReportEvent,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

/** Model-facing name of Junior's tool that asks a person for input. */
const REQUEST_USER_INPUT_TOOL_NAME = "requestUserInput";

/** A request from Junior that still waits for an answer. */
export type OpenUserInputRequest = UserInputRequest & { toolCallId: string };

function parseRequestInput(input: unknown): UserInputRequest | undefined {
  const parsed = userInputRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Find the latest `requestUserInput` call that no user message answers yet.
 * Any later user message is the answer, whether it is a submitted form or
 * typed text.
 *
 * Reporting splits one call over events: the assistant event has the input
 * and status `running`, and the later result event has status `completed`
 * without the input. Keep the input by tool call id until the result.
 */
export function openUserInputRequest(
  events: readonly ConversationReportEvent[] | undefined,
): OpenUserInputRequest | undefined {
  const inputs = new Map<string, unknown>();
  const completed = new Set<string>();
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
      if (call.input !== undefined) inputs.set(call.toolCallId, call.input);
      if (call.status === "error" && open?.toolCallId === call.toolCallId) {
        open = undefined;
      }
      // Open a request once, when its result first arrives. A repeated
      // result must not reopen a request that a user message answered.
      if (call.status !== "completed" || completed.has(call.toolCallId)) {
        continue;
      }
      completed.add(call.toolCallId);
      const request = parseRequestInput(inputs.get(call.toolCallId));
      if (request) open = { ...request, toolCallId: call.toolCallId };
    }
  }
  return open;
}
