import type { InputBlock, ModalView, PlainTextOption } from "@slack/types";
import {
  escapeSlackMrkdwnText,
  normalizeSlackReplyMarkdown,
} from "@/chat/slack/mrkdwn";
import {
  buttonUserInputField,
  normalizeUserInputAnswer,
  USER_INPUT_LIMITS,
  type UserInputAnswer,
  type UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";

const FIELD_BLOCK_ID_PREFIX = "field:";
const OTHER_BLOCK_ID = "other";
const VALUE_ACTION_ID = "value";
// Slack allows 75 characters in option descriptions and 3,000 in context
// text.
const MAX_OPTION_DESCRIPTION_CHARS = 75;
const MAX_NOTE_CHARS = 3_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function plainText(text: string) {
  return { type: "plain_text" as const, text, emoji: true };
}

/** The question and a short list of what to answer, in Slack markdown. */
export function slackUserInputText(request: UserInputRequest): string {
  const buttonField = buttonUserInputField(request);
  const notes = buttonField
    ? buttonField.options
        .filter((option) => option.description)
        .map((option) => `- **${option.label}**: ${option.description}`)
    : request.fields.map((field) => {
        const detail =
          field.kind === "text"
            ? "short answer"
            : `${field.kind === "multi_choice" ? "pick any" : "pick one"}: ${field.options.map((option) => option.label).join(", ")}`;
        return `- **${field.label}** (${detail})${field.description ? `: ${field.description}` : ""}`;
      });
  return normalizeSlackReplyMarkdown(
    [request.question, ...(notes.length ? [notes.join("\n")] : [])].join(
      "\n\n",
    ),
  );
}

function toOption(option: {
  description?: string;
  label: string;
}): PlainTextOption {
  return {
    text: plainText(option.label),
    value: option.label,
    ...(option.description
      ? {
          description: plainText(
            truncate(option.description, MAX_OPTION_DESCRIPTION_CHARS),
          ),
        }
      : undefined),
  };
}

/**
 * Render a request as a Slack modal form: one input for each field and one
 * optional Other text input. Every input is optional, so a person can answer
 * with free text only. `callbackId` and `privateMetadata` tell the submit
 * handler what the form answers.
 */
export function buildSlackUserInputForm(
  request: UserInputRequest,
  form: { callbackId: string; privateMetadata: string },
): ModalView {
  const inputs: InputBlock[] = request.fields.map((field) => ({
    type: "input",
    block_id: `${FIELD_BLOCK_ID_PREFIX}${field.id}`,
    label: plainText(field.label),
    optional: true,
    ...(field.description ? { hint: plainText(field.description) } : undefined),
    element:
      field.kind === "text"
        ? {
            type: "plain_text_input",
            action_id: VALUE_ACTION_ID,
            max_length: USER_INPUT_LIMITS.maxTextChars,
            multiline: true,
          }
        : field.kind === "choice"
          ? {
              type: "radio_buttons",
              action_id: VALUE_ACTION_ID,
              options: field.options.map(toOption),
            }
          : {
              type: "checkboxes",
              action_id: VALUE_ACTION_ID,
              options: field.options.map(toOption),
            },
  }));
  return {
    type: "modal",
    callback_id: form.callbackId,
    private_metadata: form.privateMetadata,
    title: plainText("Answer"),
    submit: plainText("Send"),
    close: plainText("Cancel"),
    blocks: [
      ...inputs,
      {
        type: "input",
        block_id: OTHER_BLOCK_ID,
        label: plainText("Other"),
        optional: true,
        hint: plainText("Anything else, or an answer that is not listed."),
        element: {
          type: "plain_text_input",
          action_id: VALUE_ACTION_ID,
          max_length: USER_INPUT_LIMITS.maxTextChars,
          multiline: true,
        },
      },
    ],
  };
}

/** One input value in a Slack `view.state.values` payload. */
export interface SlackViewStateValue {
  selected_option?: { value?: string } | null;
  selected_options?: Array<{ value?: string }> | null;
  value?: string | null;
}

/**
 * Turn the submitted values of a modal form into an answer. Unknown blocks
 * and values that do not match the request are dropped.
 */
export function parseSlackUserInputSubmission(args: {
  request: UserInputRequest;
  requestId: string;
  values: Record<string, Record<string, SlackViewStateValue>>;
}): UserInputAnswer {
  const read = (blockId: string): string[] => {
    const value = args.values[blockId]?.[VALUE_ACTION_ID];
    if (!value) return [];
    if (value.selected_options) {
      return value.selected_options.flatMap((option) =>
        option.value ? [option.value] : [],
      );
    }
    if (value.selected_option?.value) return [value.selected_option.value];
    return value.value ? [value.value] : [];
  };
  const values: Record<string, string[]> = {};
  for (const field of args.request.fields) {
    values[field.id] = read(`${FIELD_BLOCK_ID_PREFIX}${field.id}`);
  }
  return normalizeUserInputAnswer(args.request, {
    requestId: args.requestId,
    values,
    other: read(OTHER_BLOCK_ID).join("\n"),
  });
}

/**
 * Write the note that replaces the controls of an answered request. One
 * clicked button shows as "@person chose *X*". A form answer lists each
 * field. `who` is Slack markdown, such as a mention.
 */
export function slackUserInputAnswerNote(args: {
  answer: UserInputAnswer;
  request: UserInputRequest;
  who: string;
}): string {
  const { answer, who } = args;
  const buttonField = buttonUserInputField(args.request);
  const [choice, ...more] = buttonField
    ? (answer.values[buttonField.id] ?? [])
    : [];
  if (choice && !more.length && !answer.other) {
    return `${who} chose *${escapeSlackMrkdwnText(choice)}*`;
  }
  const lines = args.request.fields.flatMap((field) => {
    const values = answer.values[field.id];
    return values?.length
      ? [
          `*${escapeSlackMrkdwnText(field.label)}*: ${escapeSlackMrkdwnText(values.join(", "))}`,
        ]
      : [];
  });
  if (answer.other) {
    lines.push(`*Other*: ${escapeSlackMrkdwnText(answer.other)}`);
  }
  return truncate([`${who} answered`, ...lines].join("\n"), MAX_NOTE_CHARS);
}
