/**
 * Prompt inputs for person answers to Review items. An answer is its own
 * prompt content part, keyed by the item id that `addReviewItem` returned.
 * The runtime builds it from the stored change record and the item, so the
 * model never reads status prose. `policies/prompt-markers.md` owns the
 * tags.
 */
import { mapBounded } from "@/chat/fan-out";
import { instructionForInputs } from "@/chat/agent/prompt";
import type {
  AgentInstruction,
  AgentInstructionInput,
} from "@/chat/agent/types";
import { getDb } from "@/chat/db";
import { escapeTagText, renderTag } from "@sentry/junior-plugin-api";
import {
  formatUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputRequest,
} from "@/chat/tools/runtime/user-input-request";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ReviewItemChangeRecord } from "./change-record";
import { getReviewItem, type ReviewItem } from "./store";

const QUESTION_MAX_LENGTH = 512;

type ReviewItemAnswerInput = Extract<
  AgentInstructionInput,
  { kind: "runtime" }
>;

// The words that the person typed: text fields and the free-text answer.
// Choice labels and the question are the agent's words.
function typedAnswerText(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string {
  const normalized = normalizeUserInputAnswer(request, answer);
  return [
    ...request.fields.flatMap((field) =>
      field.kind === "text" ? (normalized.values[field.id] ?? []) : [],
    ),
    ...(normalized.other ? [normalized.other] : []),
  ].join("\n\n");
}

// Render one answer to a Review item as a prompt input. Only an action
// item with a request takes an answer.
function renderReviewItemAnswer(
  item: ReviewItem,
): ReviewItemAnswerInput | undefined {
  if (!item.request || !item.answer) return undefined;
  const question = item.request.question.trim();
  const requestText = typedAnswerText(item.request, item.answer);
  const text = renderTag(
    "review-item-answer",
    { id: item.id },
    [
      `Question: ${
        question.length > QUESTION_MAX_LENGTH
          ? `${question.slice(0, QUESTION_MAX_LENGTH - 1)}…`
          : question
      }`,
      formatUserInputAnswer(item.request, item.answer),
    ].map(escapeTagText),
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
export async function loadReviewItemInput(
  record: ReviewItemChangeRecord | undefined,
): Promise<ReviewItemAnswerInput | undefined> {
  if (record?.kind !== "submitted") return undefined;
  const item = await getReviewItem(getDb(), record.reviewItemId);
  return item ? renderReviewItemAnswer(item) : undefined;
}

/**
 * Return the instruction of one saved input. `runtime` text, such as an
 * Automation dispatch or an Event Turn, is already rendered as its tags.
 * An answer is its Review item tag. It is not typed text, so it does not go
 * in `<current-instruction>`.
 */
export async function savedInputInstruction(args: {
  runtime: boolean;
  reviewItemChange: ReviewItemChangeRecord | undefined;
  text: string;
}): Promise<Pick<AgentInstruction, "inputs" | "text">> {
  const reviewItemInput = args.runtime
    ? undefined
    : await loadReviewItemInput(args.reviewItemChange);
  if (!args.runtime && !reviewItemInput) return { text: args.text };
  return instructionForInputs([
    reviewItemInput ?? { kind: "runtime", text: args.text },
  ]);
}

/**
 * Render the Review item input of each Event in a batch that records an
 * answer, keyed by inbound message id. A Conversation with no web identity,
 * such as a local CLI Conversation, gets the answer as a system Event, but
 * the input is the same as on web.
 */
export async function eventReviewItemInputs(
  messages: readonly InboundMessage[],
): Promise<Map<string, string>> {
  const rendered = await mapBounded(
    messages,
    async (message) =>
      [
        message.inboundMessageId,
        (await loadReviewItemInput(message.input.reviewItemChange))?.text,
      ] as const,
  );
  return new Map(
    rendered.flatMap(([id, text]) => (text ? [[id, text] as const] : [])),
  );
}
