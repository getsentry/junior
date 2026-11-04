/**
 * Prompt inputs for person changes to Review items. An answer or a dismiss
 * is its own prompt content part, keyed by the item id that `addReviewItem`
 * returned. The runtime builds it from the stored change record and the
 * item, so the model never reads status prose. `policies/prompt-markers.md`
 * owns the tags.
 */
import { instructionForInputs } from "@/chat/agent/prompt";
import type { AgentInstruction } from "@/chat/agent/types";
import { getDb } from "@/chat/db";
import { escapeTagText, renderTag } from "@/chat/input-tags";
import { formatUserInputAnswer } from "@/chat/tools/runtime/user-input-request";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ReviewItemChangeRecord } from "./change-record";
import { getReviewItem, type ReviewItem } from "./store";

const ITEM_TEXT_MAX_LENGTH = 512;

// A notice has no question, so it names the item by its title.
function questionLine(item: ReviewItem): string {
  const [label, text] = item.request
    ? ["Question", item.request.question.trim()]
    : ["Title", item.title.trim()];
  return `${label}: ${
    text.length > ITEM_TEXT_MAX_LENGTH
      ? `${text.slice(0, ITEM_TEXT_MAX_LENGTH - 1)}…`
      : text
  }`;
}

function bodyLines(
  item: ReviewItem,
  kind: "submitted" | "dismissed",
): string[] {
  return [
    questionLine(item),
    ...(kind === "submitted" && item.request && item.answer
      ? [formatUserInputAnswer(item.request, item.answer)]
      : []),
  ];
}

// Render one person change to a Review item as a prompt input. A take has
// no input: it never reaches the model.
function renderReviewItemInput(
  item: ReviewItem,
  record: ReviewItemChangeRecord,
): string | undefined {
  if (record.kind === "taken") return undefined;
  const tag =
    record.kind === "submitted"
      ? "review-item-answer"
      : "review-item-dismissed";
  return renderTag(
    tag,
    { id: item.id },
    bodyLines(item, record.kind).map(escapeTagText),
  );
}

/**
 * Render the prompt input of a message that records a person change, or
 * undefined when it has none. A message without an answer or dismiss, or
 * whose item is gone, goes to the model as written.
 */
export async function loadReviewItemInput(
  record: ReviewItemChangeRecord | undefined,
): Promise<string | undefined> {
  if (!record || record.kind === "taken") return undefined;
  const item = await getReviewItem(getDb(), record.reviewItemId);
  return item ? renderReviewItemInput(item, record) : undefined;
}

/**
 * Return the instruction of one saved input. A dispatch is an Automation
 * `<task>`, and an answer or a dismiss is its Review item tag. Neither is
 * typed text, so neither goes in `<current-instruction>`.
 */
export async function savedInputInstruction(args: {
  dispatch: boolean;
  reviewItemChange: ReviewItemChangeRecord | undefined;
  text: string;
}): Promise<Pick<AgentInstruction, "inputs" | "text">> {
  const reviewItemInput = args.dispatch
    ? undefined
    : await loadReviewItemInput(args.reviewItemChange);
  if (!args.dispatch && !reviewItemInput) return { text: args.text };
  return instructionForInputs([
    { kind: "runtime", text: reviewItemInput ?? args.text },
  ]);
}

/**
 * Render the Review item input of each Event in a batch that records an
 * answer or a dismiss, keyed by inbound message id. A Conversation with no
 * web identity, such as a local CLI Conversation, gets the change as a
 * system Event, but the input is the same as on web.
 */
export async function eventReviewItemInputs(
  messages: readonly InboundMessage[],
): Promise<Map<string, string>> {
  const rendered = await Promise.all(
    messages.map(
      async (message) =>
        [
          message.inboundMessageId,
          await loadReviewItemInput(message.input.reviewItemChange),
        ] as const,
    ),
  );
  return new Map(
    rendered.flatMap(([id, text]) => (text ? [[id, text] as const] : [])),
  );
}
