import type { Button, KnownBlock, ModalView } from "@slack/types";
import * as z from "zod";
import {
  getDashboardInboxItemLink,
  getDashboardInboxItemSnoozeLink,
} from "@/chat/dashboard-link";
import {
  INBOX_ITEM_REPLIED_REASON,
  type InboxItem,
  type InboxItemAssignee,
} from "@/chat/inbox-items/store";
import { subjectLink } from "@/chat/inbox-items/subjects";
import {
  escapeSlackMrkdwnText,
  normalizeSlackReplyMarkdown,
} from "@/chat/slack/mrkdwn";
import {
  buildSlackUserInputForm,
  slackUserInputAnswerNote,
  slackUserInputText,
} from "@/chat/slack/user-input";
import { buttonUserInputField } from "@/chat/inbox-items/user-input-request";
import { safeLinkUrl } from "@/net/link-url";

// Posted Slack cards and open forms keep the ids that they were sent with,
// so these ids keep the name from before Review items became Inbox items.
/** Callback id of the modal form that answers an Inbox item. */
export const SLACK_INBOX_ITEM_VIEW_ID = "junior_review_item";
const ACTION_ID_PREFIX = "junior_review_item:";
const CHOICE_ACTION_ID_PREFIX = `${ACTION_ID_PREFIX}choice:`;
const ANSWER_ACTION_ID = `${ACTION_ID_PREFIX}answer`;
const DISMISS_ACTION_ID = `${ACTION_ID_PREFIX}dismiss`;
// A link: Slack sends its click too, with no value, and nothing reads it.
const SNOOZE_ACTION_ID = `${ACTION_ID_PREFIX}snooze`;
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

function personName(person: InboxItemAssignee): string {
  return escapeSlackMrkdwnText(person.displayName ?? person.email);
}

function assigneeText(item: InboxItem): string {
  const names = [
    ...(item.assignedToEveryone ? ["Everyone"] : []),
    ...item.assignees.map(personName),
  ];
  return names.length ? `For ${names.join(", ")}` : "Not assigned";
}

/**
 * Link the title to the subject. A plugin rewrite skips text in a link, so
 * it cannot guess another URL for a reference in the title, such as an
 * issue URL for a pull request.
 */
function titleText(item: InboxItem): string {
  const href = safeLinkUrl(subjectLink(item.subject));
  if (!href) return `**${item.title}**`;
  const label = item.title.replace(/[[\]\\]/g, "\\$&");
  return `**[${label}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})**`;
}

/** The title, body, and question of an item, in Slack markdown. */
function itemText(item: InboxItem): string {
  return normalizeSlackReplyMarkdown(
    [
      titleText(item),
      // A plugin item asks its body as the question, so it shows once.
      ...(item.request?.question === item.body
        ? []
        : [truncate(item.body, MAX_BODY_CHARS)]),
      ...(item.request ? [slackUserInputText(item.request)] : []),
    ].join("\n\n"),
  );
}

/**
 * The card's buttons, in the order of every Inbox card: Dismiss, Snooze,
 * then the main action. A Slack message looks the same to everyone, so
 * Snooze opens the item's snooze form in the dashboard, where the snooze
 * hides it for the person who clicked only.
 */
function controls(item: InboxItem): Button[] {
  const snoozeUrl = getDashboardInboxItemSnoozeLink(item.id);
  const quiet: Button[] = [
    {
      type: "button",
      action_id: DISMISS_ACTION_ID,
      text: plainText("Dismiss"),
      value: item.id,
    },
    ...(snoozeUrl
      ? [
          {
            type: "button" as const,
            action_id: SNOOZE_ACTION_ID,
            text: plainText("Snooze"),
            url: snoozeUrl,
          },
        ]
      : []),
  ];
  // A notice has nothing to answer, and it can close by itself, so a person
  // can only dismiss or snooze it.
  if (item.kind === "notice" || !item.request) return quiet;
  const buttonField = buttonUserInputField(item.request);
  if (!buttonField) {
    return [
      ...quiet,
      {
        type: "button",
        action_id: ANSWER_ACTION_ID,
        style: "primary",
        text: plainText("Answer"),
        value: item.id,
      },
    ];
  }
  return [
    ...quiet,
    ...buttonField.options.map((option, index): Button => ({
      type: "button",
      // Slack requires a unique action_id for each element in one message.
      action_id: `${CHOICE_ACTION_ID_PREFIX}${index}`,
      ...(option.recommended ? { style: "primary" as const } : undefined),
      text: plainText(option.label),
      // The label goes with the click, so a click on a stale card cannot
      // pick another option after the request changes.
      value: JSON.stringify({ itemId: item.id, label: option.label }),
    })),
    // One choice is a plugin's action, such as Resume. The plugin does the
    // work and reads no words, so there is no Other….
    ...(buttonField.options.length > 1
      ? [
          {
            type: "button" as const,
            action_id: ANSWER_ACTION_ID,
            text: plainText("Other…"),
            value: item.id,
          },
        ]
      : []),
  ];
}

/** The note that replaces the controls of a closed item. */
function closedNote(item: InboxItem): string {
  const who = item.closedBy ? personName(item.closedBy) : undefined;
  if (item.closeReason === INBOX_ITEM_REPLIED_REASON) {
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
 * Render an Inbox item as one Slack message. An open item shows its
 * controls: one button per choice when one click can answer it, an Answer
 * button that opens a form otherwise, and only Dismiss and Snooze for a
 * notice. A
 * closed item shows a note instead, so nobody can act on it again.
 */
export function buildSlackInboxItemCard(item: InboxItem): {
  blocks: KnownBlock[];
  text: string;
} {
  const text = itemText(item);
  const link = getDashboardInboxItemLink(item.id);
  // Each part is its own element, so a long answer note cannot push the
  // element over the Slack limit and make the card update fail.
  const details = [
    item.status === "open" ? assigneeText(item) : closedNote(item),
    ...(link ? [`<${link}|Open in the Inbox>`] : []),
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
    text: `Inbox item: ${item.title}`,
  };
}

/** Render a card for a thread that the item is no longer linked to. */
export function buildHiddenSlackInboxItemCard(item: InboxItem): {
  blocks: KnownBlock[];
  text: string;
} {
  const link = getDashboardInboxItemLink(item.id);
  const text = link
    ? `This inbox item is not shown in this thread. <${link}|Open the Inbox>.`
    : "This inbox item is not shown in this thread.";
  return {
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }],
    text: "Inbox item",
  };
}

/** One click on an Inbox item card. */
export type SlackInboxItemClick =
  | { kind: "choice"; itemId: string; label: string }
  | { kind: "answer"; itemId: string }
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

/** Read a click on an Inbox item card, if the action is ours. */
export function parseSlackInboxItemClick(action: {
  action_id?: string | undefined;
  value?: string | undefined;
}): SlackInboxItemClick | undefined {
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

/** The card and thread that an Inbox item form answers. */
type SlackInboxItemFormTarget = z.output<typeof formTargetSchema>;

/** Render the answer form of an action item. */
export function buildSlackInboxItemModal(
  item: InboxItem,
  target: SlackInboxItemFormTarget,
): ModalView | undefined {
  if (!item.request) return undefined;
  return buildSlackUserInputForm(item.request, {
    callbackId: SLACK_INBOX_ITEM_VIEW_ID,
    privateMetadata: JSON.stringify(target),
  });
}

/** Read the target of a submitted Inbox item form. */
export function parseSlackInboxItemFormTarget(
  privateMetadata: string | undefined,
): SlackInboxItemFormTarget | undefined {
  try {
    const parsed = formTargetSchema.safeParse(
      JSON.parse(privateMetadata ?? ""),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
