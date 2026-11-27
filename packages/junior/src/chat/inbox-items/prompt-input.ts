/**
 * Prompt inputs for person answers to questions. Each answer is its own
 * prompt part, tied to the `askUserQuestion` call that asked it, and reads
 * like Claude Code's AskUserQuestion result. The runtime builds it from the
 * stored change record and the item, so the model never reads status prose.
 */
import { mapBounded } from "@/chat/fan-out";
import { instructionForInputs } from "@/chat/agent/prompt";
import type {
  AgentInstruction,
  RuntimeInstructionInput,
} from "@/chat/agent/types";
import { getDb } from "@/chat/db";
import { escapeTagText, renderTag } from "@sentry/junior-plugin-api";
import {
  fieldAnswerValues,
  formatUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputRequest,
} from "@/chat/inbox-items/user-input-request";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { InboxItemChangeRecord } from "./change-record";
import { getInboxItem, type InboxItem } from "./store";
import {
  ASK_SUBJECT_PREFIX,
  inboxItemQuestion,
} from "@/chat/inbox-items/request";

const QUESTION_MAX_LENGTH = 512;

// The words that the person typed: text fields, their own answers, and the
// additional notes. Choice labels and the question are the agent's words.
function typedAnswerText(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string {
  const normalized = normalizeUserInputAnswer(request, answer);
  return [
    ...request.fields.flatMap((field) => {
      if (field.kind === "text") return normalized.values[field.id] ?? [];
      const own = normalized.custom?.[field.id];
      return own ? [own] : [];
    }),
    ...(normalized.other ? [normalized.other] : []),
  ].join("\n\n");
}

function shortQuestion(text: string): string {
  const question = text.trim();
  return question.length > QUESTION_MAX_LENGTH
    ? `${question.slice(0, QUESTION_MAX_LENGTH - 1)}…`
    : question;
}

// A request whose fields each hold their own question pairs each question
// with its answer, in the shape of Claude Code's AskUserQuestion result, so
// the model maps each answer to its question. A question left blank says so,
// so that the model does not read it as consent.
function questionAnswerLines(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string[] {
  const normalized = normalizeUserInputAnswer(request, answer);
  const { other } = normalized;
  const pairs = request.fields.map(
    (field) =>
      `"${shortQuestion(field.description ?? field.label)}"="${fieldAnswerValues(field, normalized).join(", ") || "(no answer)"}"`,
  );
  return [
    `The person has answered your questions: ${pairs.join(", ")}`,
    ...(other ? [`They also wrote: ${other}`] : []),
    "You can now continue with their answers in mind.",
  ];
}

// The `askUserQuestion` call that asked a question, from its subject id.
// Older questions came from another tool and have no call id.
function askToolUseId(item: InboxItem): string | undefined {
  const id = item.subject.id;
  return id.startsWith(ASK_SUBJECT_PREFIX) &&
    id.length > ASK_SUBJECT_PREFIX.length
    ? id.slice(ASK_SUBJECT_PREFIX.length)
    : undefined;
}

// Render one answer to a question as a prompt input. Only an action item
// with a request takes an answer.
function renderInboxItemAnswer(
  item: InboxItem,
): RuntimeInstructionInput | undefined {
  const request = inboxItemQuestion(item.request);
  if (!request || !item.answer) return undefined;
  const requestText = typedAnswerText(request, item.answer);
  const text = renderTag(
    "question-answer",
    { tool_use_id: askToolUseId(item) },
    (request.question
      ? [
          `Question: ${shortQuestion(request.question)}`,
          formatUserInputAnswer(request, item.answer),
        ]
      : questionAnswerLines(request, item.answer)
    ).map(escapeTagText),
  );
  return {
    kind: "runtime",
    text,
    ...(requestText ? { requestText } : undefined),
  };
}

/**
 * Render the prompt input of a message that records an answer, or undefined
 * when it has none. A take or a dismiss starts no Turn, so it has no input.
 * A message without an answer, or whose item is gone, goes to the model as
 * written.
 */
export async function loadInboxItemInput(
  record: InboxItemChangeRecord | undefined,
): Promise<RuntimeInstructionInput | undefined> {
  if (record?.kind !== "submitted") return undefined;
  const item = await getInboxItem(getDb(), record.reviewItemId);
  return item ? renderInboxItemAnswer(item) : undefined;
}

/**
 * Return the instruction of one saved input. `runtime` text, such as an
 * Automation dispatch or an Event Turn, is already rendered as its tags.
 * An answer is its Inbox item tag. It is not typed text, so it does not go
 * in `<current-instruction>`.
 */
export async function savedInputInstruction(args: {
  runtime: boolean;
  requestText?: string | undefined;
  reviewItemChange: InboxItemChangeRecord | undefined;
  text: string;
}): Promise<Pick<AgentInstruction, "inputs" | "text">> {
  const inboxItemInput = args.runtime
    ? undefined
    : await loadInboxItemInput(args.reviewItemChange);
  if (!args.runtime && !inboxItemInput) return { text: args.text };
  return instructionForInputs([
    inboxItemInput ?? {
      kind: "runtime",
      text: args.text,
      ...(args.requestText ? { requestText: args.requestText } : undefined),
    },
  ]);
}

/**
 * Render the Inbox item input of each Event in a batch that records an
 * answer, keyed by inbound message id. A Conversation with no web identity,
 * such as a local CLI Conversation, gets the answer as a system Event, but
 * the input is the same as on web.
 */
export async function eventInboxItemInputs(
  messages: readonly InboundMessage[],
): Promise<Map<string, RuntimeInstructionInput>> {
  const rendered = await mapBounded(
    messages,
    async (message) =>
      [
        message.inboundMessageId,
        await loadInboxItemInput(message.input.reviewItemChange),
      ] as const,
  );
  return new Map(
    rendered.flatMap(([id, input]) => (input ? [[id, input] as const] : [])),
  );
}
