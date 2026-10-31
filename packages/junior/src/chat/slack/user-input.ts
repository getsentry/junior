import type {
  ActionsBlock,
  Button,
  InputBlock,
  KnownBlock,
  ModalView,
  PlainTextOption,
} from "@slack/types";
import { z } from "zod";
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

const CONTROLS_BLOCK_ID = "junior_user_input";
/** Callback id of the modal form that answers a request. */
export const SLACK_USER_INPUT_VIEW_ID = "junior_user_input";
const ACTION_ID_PREFIX = "junior_user_input:";
const CHOICE_ACTION_ID_PREFIX = `${ACTION_ID_PREFIX}choice:`;
const OPEN_FORM_ACTION_ID = `${ACTION_ID_PREFIX}open`;
const FIELD_BLOCK_ID_PREFIX = "field:";
const OTHER_BLOCK_ID = "other";
const VALUE_ACTION_ID = "value";
// Slack allows 75 characters in option descriptions and 3,000 in context
// and modal metadata text.
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

/**
 * Render a user input request as one Slack message. A request with one
 * `choice` field and up to five options shows one button per option, so
 * one click answers it. Other requests show an Answer button that opens a
 * form. Both show a way to add free text in the form.
 */
export function buildSlackUserInputMessage(request: UserInputRequest): {
  blocks: KnownBlock[];
  text: string;
} {
  const text = slackUserInputText(request);
  const buttonField = buttonUserInputField(request);
  const elements: Button[] = buttonField
    ? [
        ...buttonField.options.map(
          (option, index): Button => ({
            type: "button",
            // Slack requires a unique action_id for each element in one message.
            action_id: `${CHOICE_ACTION_ID_PREFIX}${index}`,
            text: plainText(option.label),
            value: option.label,
          }),
        ),
        {
          type: "button",
          action_id: OPEN_FORM_ACTION_ID,
          text: plainText("Other…"),
        },
      ]
    : [
        {
          type: "button",
          action_id: OPEN_FORM_ACTION_ID,
          style: "primary",
          text: plainText("Answer"),
        },
      ];
  const actions: ActionsBlock = {
    type: "actions",
    block_id: CONTROLS_BLOCK_ID,
    elements,
  };
  return { blocks: [{ type: "markdown", text }, actions], text };
}

/** Kind of control that a Slack action id came from, if it is ours. */
export function slackUserInputAction(
  actionId: string | undefined,
): "choice" | "open_form" | undefined {
  if (actionId === OPEN_FORM_ACTION_ID) return "open_form";
  return actionId?.startsWith(CHOICE_ACTION_ID_PREFIX) ? "choice" : undefined;
}

const formTargetSchema = z.object({
  channelId: z.string(),
  messageTs: z.string(),
  threadTs: z.string(),
});

/** Slack message that a modal form answers. Kept in `private_metadata`. */
export type SlackUserInputFormTarget = z.output<typeof formTargetSchema>;

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

/** Render the answer form of a request in a Slack thread. */
export function buildSlackUserInputModal(
  request: UserInputRequest,
  target: SlackUserInputFormTarget,
): ModalView {
  return buildSlackUserInputForm(request, {
    callbackId: SLACK_USER_INPUT_VIEW_ID,
    privateMetadata: JSON.stringify(target),
  });
}

/** Read the target message of a submitted modal form. */
export function parseSlackUserInputFormTarget(
  privateMetadata: string | undefined,
): SlackUserInputFormTarget | undefined {
  try {
    const parsed = formTargetSchema.safeParse(
      JSON.parse(privateMetadata ?? ""),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
 * field. Without an answer, the note says that the person replied. `who` is
 * Slack markdown, such as a mention.
 */
export function slackUserInputAnswerNote(args: {
  answer?: UserInputAnswer;
  request: UserInputRequest;
  who: string;
}): string {
  const { who } = args;
  if (!args.answer) return `${who} replied in the thread`;
  const answer = args.answer;
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

/** Closing note for a request answered with a dashboard message. */
export function webUserInputAnswerNote(name: string): string {
  return `${escapeSlackMrkdwnText(name)} answered in the Junior dashboard`;
}

/**
 * Render a request without its controls and with a closing note, such as
 * the person's answer. This keeps the question visible and stops more
 * answers on the same message.
 */
export function buildClosedSlackUserInputMessage(args: {
  note: string;
  request: UserInputRequest;
}): { blocks: KnownBlock[]; text: string } {
  const text = slackUserInputText(args.request);
  return {
    blocks: [
      { type: "markdown", text },
      { type: "context", elements: [{ type: "mrkdwn", text: args.note }] },
    ],
    text,
  };
}
