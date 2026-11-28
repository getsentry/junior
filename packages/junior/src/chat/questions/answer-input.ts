/**
 * Prompt inputs for person answers to questions. Each answer is its own
 * prompt part, tied to the `askUserQuestion` call that asked it, and reads
 * like Claude Code's AskUserQuestion result. The runtime builds it from the
 * stored change record and the question, so the model never reads status
 * prose.
 */
import { mapBounded } from "@/chat/fan-out";
import { instructionForInputs } from "@/chat/agent/prompt";
import type {
  AgentInstruction,
  RuntimeInstructionInput,
} from "@/chat/agent/types";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItems } from "@/db/schema";
import { escapeTagText, renderTag } from "@sentry/junior-plugin-api";
import {
  formatUserInputAnswer,
  normalizeUserInputAnswer,
  type UserInputAnswer,
  type UserInputRequest,
} from "./user-input-request";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { InboxItemChangeRecord } from "@/chat/state/inbox-item-change-record";
import { askToolCallId, inboxItemQuestion } from "./request";
import { getQuestion, type Question } from "./store";

const QUESTION_MAX_LENGTH = 512;

// The words that the person typed: text fields and the additional notes.
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
      `"${shortQuestion(field.description ?? field.label)}"="${normalized.values[field.id]?.join(", ") || "(no answer)"}"`,
  );
  return [
    `The person has answered your questions: ${pairs.join(", ")}`,
    ...(other ? [`They also wrote: ${other}`] : []),
    "You can now continue with their answers in mind.",
  ];
}

// Render one answer to a question as a prompt input. Only a question with
// a form takes an answer. It names the person who answered, who need not be
// one of the people asked. Without the name the model guesses one.
function renderQuestionAnswer(
  question: Question,
): RuntimeInstructionInput | undefined {
  const request = inboxItemQuestion(question.request);
  const answer = question.answer;
  if (!request || !answer) return undefined;
  const requestText = typedAnswerText(request, answer);
  const by = question.answeredBy;
  const text = renderTag(
    "question-answer",
    { tool_use_id: askToolCallId(question.id, question.conversationId) },
    [
      ...(by
        ? [
            `Answered by: ${by.displayName ? `${by.displayName} (${by.email})` : by.email}`,
          ]
        : []),
      ...(request.question
        ? [
            `Question: ${shortQuestion(request.question)}`,
            formatUserInputAnswer(request, answer),
          ]
        : questionAnswerLines(request, answer)),
    ].map(escapeTagText),
  );
  return {
    kind: "runtime",
    text,
    ...(requestText ? { requestText } : undefined),
  };
}

// legacy: an older worker gave a question's Inbox item its own id, so a
// record of an answer to it names that item and not the question. Remove
// once no open question has an item with another id.
async function legacyQuestionIdOfItem(
  db: JuniorDatabase,
  itemId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ questionId: juniorInboxItems.subjectId })
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.id, itemId),
        eq(juniorInboxItems.subjectKind, "question"),
      ),
    )
    .limit(1);
  return row?.questionId;
}

/**
 * Render the prompt input of a message that records an answer, or undefined
 * when it has none. A take or a dismiss starts no Turn, so it has no input.
 * The record names the question's item, which has the question's id. A
 * message without an answer, or whose question is gone, goes to the model
 * as written.
 */
export async function loadAnswerInput(
  record: InboxItemChangeRecord | undefined,
): Promise<RuntimeInstructionInput | undefined> {
  if (record?.kind !== "submitted") return undefined;
  const db = getDb();
  let question = await getQuestion(db, record.reviewItemId);
  if (!question) {
    const legacyId = await legacyQuestionIdOfItem(db, record.reviewItemId);
    question = legacyId ? await getQuestion(db, legacyId) : undefined;
  }
  return question ? renderQuestionAnswer(question) : undefined;
}

/**
 * Return the instruction of one saved input. `runtime` text, such as an
 * Automation dispatch or an Event Turn, is already rendered as its tags.
 * An answer is its `<question-answer>` tag. It is not typed text, so it
 * does not go in `<current-instruction>`.
 */
export async function savedInputInstruction(args: {
  runtime: boolean;
  requestText?: string | undefined;
  reviewItemChange: InboxItemChangeRecord | undefined;
  text: string;
}): Promise<Pick<AgentInstruction, "inputs" | "text">> {
  const answerInput = args.runtime
    ? undefined
    : await loadAnswerInput(args.reviewItemChange);
  if (!args.runtime && !answerInput) return { text: args.text };
  return instructionForInputs([
    answerInput ?? {
      kind: "runtime",
      text: args.text,
      ...(args.requestText ? { requestText: args.requestText } : undefined),
    },
  ]);
}

/**
 * Render the answer input of each Event in a batch that records an answer,
 * keyed by inbound message id. A Conversation with no web identity,
 * such as a local CLI Conversation, gets the answer as a system Event, but
 * the input is the same as on web.
 */
export async function eventAnswerInputs(
  messages: readonly InboundMessage[],
): Promise<Map<string, RuntimeInstructionInput>> {
  const rendered = await mapBounded(
    messages,
    async (message) =>
      [
        message.inboundMessageId,
        await loadAnswerInput(message.input.reviewItemChange),
      ] as const,
  );
  return new Map(
    rendered.flatMap(([id, input]) => (input ? [[id, input] as const] : [])),
  );
}
