import { z } from "zod";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Model-facing name of the tool that asks a person to pick a choice. */
export const REQUEST_USER_INPUT_TOOL_NAME = "requestUserInput";

// Slack buttons allow 75 label characters and 5 buttons in one row. Use the
// same limits on every surface so one request renders the same everywhere.
// https://docs.slack.dev/reference/block-kit/block-elements/button-element
export const USER_INPUT_LIMITS = {
  maxDescriptionChars: 200,
  maxLabelChars: 75,
  maxOptions: 5,
  maxQuestionChars: 3_000,
  minOptions: 2,
} as const;

export const userInputRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(USER_INPUT_LIMITS.maxQuestionChars)
    .describe(
      "The question, in markdown. Include the facts the person needs to decide.",
    ),
  options: z
    .array(
      z.object({
        label: z
          .string()
          .trim()
          .min(1)
          .max(USER_INPUT_LIMITS.maxLabelChars)
          .describe(
            "Short choice text, such as `Accept` or `Decline`. The answer is this exact text.",
          ),
        description: z
          .string()
          .trim()
          .min(1)
          .max(USER_INPUT_LIMITS.maxDescriptionChars)
          .optional()
          .describe("Optional short note about what this choice does."),
      }),
    )
    .min(USER_INPUT_LIMITS.minOptions)
    .max(USER_INPUT_LIMITS.maxOptions)
    .describe("Choices in display order."),
});

/** One question with a short list of choices for a person to pick from. */
export type UserInputRequest = z.output<typeof userInputRequestSchema>;

/**
 * Show a user input request on the surface that owns the Turn. Returns
 * surface details for the tool result, such as a posted message id.
 */
export type ShowUserInputRequest = (
  request: UserInputRequest,
) => Promise<Record<string, unknown>>;

/**
 * Create the tool that asks a person to pick one of a few choices.
 *
 * The model only supplies the question and the choices. Each surface renders
 * them in a fixed way: Slack posts buttons, and the web dashboard reads the
 * tool call from the transcript. The answer is the next message from the
 * person, so the tool does not wait.
 */
export function createRequestUserInputTool(show?: ShowUserInputRequest) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: `Ask the person a question and show a few choices as buttons. Use it when you need a decision before you continue and the answer is one of a few clear options, such as accept or decline a proposed change. Ask one question at a time. The person can click a choice or type a different answer. Their answer arrives as their next message, and a click sends the exact choice label. The question is already shown, so after this call end the turn with exactly ${NO_REPLY_MARKER}.`,
    inputSchema: userInputRequestSchema,
    outputSchema: juniorToolOutputSchema,
    execute: async (request) => {
      const labels = request.options.map((option) =>
        option.label.toLowerCase(),
      );
      if (new Set(labels).size !== labels.length) {
        throw new ToolInputError("Each choice needs a different label.");
      }
      const shown = show ? await show(request) : {};
      return { ...shown, status: "waiting_for_answer" };
    },
  });
}
