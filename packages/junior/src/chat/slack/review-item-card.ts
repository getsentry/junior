import type { Button, KnownBlock, ModalView } from "@slack/types";
import { z } from "zod";
import { getDashboardReviewItemLink } from "@/chat/dashboard-link";
import {
  REVIEW_ITEM_REPLIED_REASON,
  type ReviewItem,
  type ReviewItemAssignee,
} from "@/chat/review-items/store";
import {
  escapeSlackMrkdwnText,
  normalizeSlackReplyMarkdown,
} from "@/chat/slack/mrkdwn";
import {
  buildSlackUserInputForm,
  slackUserInputAnswerNote,
  slackUserInputText,
} from "@/chat/slack/user-input";
import { buttonUserInputField } from "@/chat/tools/runtime/user-input-request";

/** Callback id of the modal form that answers a Review item. */
export const SLACK_REVIEW_ITEM_VIEW_ID = "junior_review_item";
const ACTION_ID_PREFIX = "junior_review_item:";
const CHOICE_ACTION_ID_PREFIX = `${ACTION_ID_PREFIX}choice:`;
const ANSWER_ACTION_ID = `${ACTION_ID_PREFIX}answer`;
const DONE_ACTION_ID = `${ACTION_ID_PREFIX}done`;
const DISMISS_ACTION_ID = `${ACTION_ID_PREFIX}dismiss`;
// Slack allows 12,000 characters in all markdown blocks of one message.
const MAX_BODY_CHARS = 3_000;
// Slack allows 3,000 characters in one context element.
const MAX_CONTEXT_CHARS = 3_000;

function plainText(text: string) {
  return { type: "plain_text" as const, text, emoji: true };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function personName(person: ReviewItemAssignee): string {
  return escapeSlackMrkdwnText(person.displayName ?? person.email);
}

function assigneeText(item: ReviewItem): string {
  const names = [
    ...(item.assignedToEveryone ? ["Everyone"] : []),
    ...item.assignees.map(personName),
  ];
  return names.length ? `For ${names.join(", ")}` : "Not assigned";
}

/** The title, body, and question of an item, in Slack markdown. */
function itemText(item: ReviewItem): string {
  return normalizeSlackReplyMarkdown(
    [
      `**${item.title}**`,
      truncate(item.body, MAX_BODY_CHARS),
      ...(item.request ? [slackUserInputText(item.request)] : []),
    ].join("\n\n"),
  );
}

function controls(item: ReviewItem): Button[] {
  const dismiss: Button = {
    type: "button",
    action_id: DISMISS_ACTION_ID,
    text: plainText("Dismiss"),
    value: item.id,
  };
  if (item.kind === "notice" || !item.request) {
    return [
      {
        type: "button",
        action_id: DONE_ACTION_ID,
        style: "primary",
        text: plainText("Done"),
        value: item.id,
      },
      dismiss,
    ];
  }
  const buttonField = buttonUserInputField(item.request);
  if (!buttonField) {
    return [
      {
        type: "button",
        action_id: ANSWER_ACTION_ID,
        style: "primary",
        text: plainText("Answer"),
        value: item.id,
      },
      dismiss,
    ];
  }
  return [
    ...buttonField.options.map(
      (option, index): Button => ({
        type: "button",
        // Slack requires a unique action_id for each element in one message.
        action_id: `${CHOICE_ACTION_ID_PREFIX}${index}`,
        text: plainText(option.label),
        // The label goes with the click, so a click on a stale card cannot
        // pick another option after the request changes.
        value: JSON.stringify({ itemId: item.id, label: option.label }),
      }),
    ),
    {
      type: "button",
      action_id: ANSWER_ACTION_ID,
      text: plainText("Other…"),
      value: item.id,
    },
    dismiss,
  ];
}

/** The note that replaces the controls of a closed item. */
function closedNote(item: ReviewItem): string {
  const who = item.closedBy ? personName(item.closedBy) : undefined;
  if (item.closeReason === REVIEW_ITEM_REPLIED_REASON) {
    return `${who ?? "A person"} replied in the thread`;
  }
  if (item.status === "done" && item.request && item.answer && who) {
    return slackUserInputAnswerNote({
      answer: item.answer,
      request: item.request,
      who,
    });
  }
  if (who) {
    return item.status === "done"
      ? `${who} marked this done`
      : `${who} dismissed this`;
  }
  const status = item.status === "done" ? "Closed as done" : "Dismissed";
  return item.closeReason
    ? `${status}: ${escapeSlackMrkdwnText(item.closeReason)}`
    : status;
}

/**
 * Render a Review item as one Slack message. An open item shows its
 * controls: one button per choice when one click can answer it, an Answer
 * button that opens a form otherwise, and Done for a notice. A closed item
 * shows a note instead, so nobody can act on it again.
 */
export function buildSlackReviewItemCard(item: ReviewItem): {
  blocks: KnownBlock[];
  text: string;
} {
  const text = itemText(item);
  const link = getDashboardReviewItemLink(item.id);
  // Each part is its own element, so a long answer note cannot push the
  // element over the Slack limit and make the card update fail.
  const details = [
    item.status === "open" ? assigneeText(item) : closedNote(item),
    ...(link ? [`<${link}|Open in the review desk>`] : []),
  ].map((part) => ({
    type: "mrkdwn" as const,
    text: truncate(part, MAX_CONTEXT_CHARS),
  }));
  return {
    blocks: [
      { type: "markdown", text },
      { type: "context", elements: details },
      ...(item.status === "open"
        ? [{ type: "actions" as const, elements: controls(item) }]
        : []),
    ],
    text: `Review item: ${item.title}`,
  };
}

/** Render a card for a thread that the item is no longer linked to. */
export function buildHiddenSlackReviewItemCard(item: ReviewItem): {
  blocks: KnownBlock[];
  text: string;
} {
  const link = getDashboardReviewItemLink(item.id);
  const text = link
    ? `This review item is not shown in this thread. <${link}|Open the review desk>.`
    : "This review item is not shown in this thread.";
  return {
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
    text: "Review item",
  };
}

/** One click on a Review item card. */
export type SlackReviewItemClick =
  | { kind: "choice"; itemId: string; label: string }
  | { kind: "answer"; itemId: string }
  | { kind: "done"; itemId: string }
  | { kind: "dismiss"; itemId: string };

const choiceValueSchema = z.object({
  itemId: z.string().min(1),
  label: z.string().min(1),
});

function parseChoiceValue(
  value: string,
): z.output<typeof choiceValueSchema> | undefined {
  try {
    const parsed = choiceValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Read a click on a Review item card, if the action is ours. */
export function parseSlackReviewItemClick(action: {
  action_id?: string;
  value?: string;
}): SlackReviewItemClick | undefined {
  const value = action.value?.trim();
  if (!value || !action.action_id?.startsWith(ACTION_ID_PREFIX)) {
    return undefined;
  }
  if (action.action_id.startsWith(CHOICE_ACTION_ID_PREFIX)) {
    const choice = parseChoiceValue(value);
    return choice ? { kind: "choice", ...choice } : undefined;
  }
  if (action.action_id === ANSWER_ACTION_ID) {
    return { kind: "answer", itemId: value };
  }
  if (action.action_id === DONE_ACTION_ID) {
    return { kind: "done", itemId: value };
  }
  if (action.action_id === DISMISS_ACTION_ID) {
    return { kind: "dismiss", itemId: value };
  }
  return undefined;
}

const formTargetSchema = z.object({
  channelId: z.string(),
  itemId: z.string(),
  messageTs: z.string(),
  threadTs: z.string(),
});

/** The card and thread that a Review item form answers. */
export type SlackReviewItemFormTarget = z.output<typeof formTargetSchema>;

/** Render the answer form of an action item. */
export function buildSlackReviewItemModal(
  item: ReviewItem,
  target: SlackReviewItemFormTarget,
): ModalView | undefined {
  if (!item.request) return undefined;
  return buildSlackUserInputForm(item.request, {
    callbackId: SLACK_REVIEW_ITEM_VIEW_ID,
    privateMetadata: JSON.stringify(target),
  });
}

/** Read the target of a submitted Review item form. */
export function parseSlackReviewItemFormTarget(
  privateMetadata: string | undefined,
): SlackReviewItemFormTarget | undefined {
  try {
    const parsed = formTargetSchema.safeParse(
      JSON.parse(privateMetadata ?? ""),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
