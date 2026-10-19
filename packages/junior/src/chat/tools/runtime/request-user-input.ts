import { randomUUID } from "node:crypto";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  findUserInputRequestProblem,
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";

/**
 * Show a user input request on the surface that owns the Turn. Returns
 * surface details for the tool result, such as a posted message id.
 */
export type ShowUserInputRequest = (
  request: UserInputRequest,
  requestId: string,
) => Promise<Record<string, unknown>>;

/**
 * Create the tool that asks a person for input.
 *
 * The model only describes the fields it needs. Each surface renders them in
 * a fixed way: Slack posts buttons or a form, and the web dashboard reads the
 * tool call from the transcript. The answer is the next message from the
 * person, so the tool does not wait. The request id is the tool call id.
 */
export function createRequestUserInputTool(show?: ShowUserInputRequest) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: `Ask the person for input before you continue. Use it when you need a decision or a few facts that only they can give, such as accept or decline a change, or pick an approach and the checks to run. Each field is one of: \`choice\` (pick one option), \`multi_choice\` (pick any number), or \`text\` (type a short answer). For a simple decision, use one \`choice\` field. Ask for related input in one call instead of several calls. The person can always add free text or type a reply instead. The answer arrives as their next message. When they use the controls, the message starts with \`Answer to request <request_id>:\` and has one line for each field, in the form \`Label (id): value\`, plus an optional \`Other:\` line with free text. A field without a value shows \`(no answer)\`. The request is already shown, so after this call end the turn with exactly ${NO_REPLY_MARKER}.`,
    inputSchema: userInputRequestSchema,
    outputSchema: juniorToolOutputSchema,
    execute: async (request, options) => {
      const problem = findUserInputRequestProblem(request);
      if (problem) throw new ToolInputError(problem);
      const requestId = options.toolCallId ?? randomUUID();
      const shown = show ? await show(request, requestId) : {};
      return { ...shown, request_id: requestId, status: "waiting_for_answer" };
    },
  });
}
