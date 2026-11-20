import * as z from "zod";
import {
  normalizeUserInputAnswer,
  type ConversationReportEvent,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { withoutStandaloneUrl } from "../display-text/DisplayText";
import { automationPath } from "../format";
import { displayPlainText } from "../display-text/plainText";
import type { Conversation } from "../types";

/** Return the Inbox route that selects one item. */
export function reviewItemPath(id: string): string {
  return `/inbox?item=${encodeURIComponent(id)}`;
}

/**
 * Return the new UI's Inbox route that expands one item's row: Done for a
 * closed item. The route names the entry, because phones show the entries
 * at `/`.
 */
export function inboxItemPath(
  item: Pick<ReviewItemPayload, "id" | "status">,
): string {
  const view = item.status === "open" ? "inbox" : "done";
  return `/?view=${view}&item=${encodeURIComponent(item.id)}`;
}

/**
 * Return the subject URL when it is safe to link. Agents and plugins supply
 * it, and URL validation also accepts `javascript:` and `data:` URLs.
 */
export function reviewItemSubjectHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the text of an item without a bare URL to its subject, for a
 * surface that shows the subject's own card.
 */
export function reviewItemText(
  item: Pick<ReviewItemPayload, "body" | "subject">,
): string {
  return item.subject?.url
    ? withoutStandaloneUrl(item.body, item.subject.url)
    : item.body;
}

/** Name the state of an item: what it needs while open, or how it closed. */
export function reviewItemStatusLabel(item: ReviewItemPayload): string {
  if (item.status === "open") {
    if (item.kind === "notice") return "Notice";
    // A plugin ask waits on a step outside Junior, so it has no question.
    return item.request ? "Needs an answer" : "Waiting on you";
  }
  return item.status === "done" ? "Done" : "Dismissed";
}

/** Return an item's title as text, with the names of the people it mentions. */
export function reviewItemTitleText(item: ReviewItemPayload): string {
  return displayPlainText(item.title, item.mentions);
}

const ADD_REVIEW_ITEM_TOOL_NAME = "addReviewItem";
const executeToolInputSchema = z.object({ tool_name: z.string() });
const addedItemSchema = z.object({ item: z.object({ id: z.string().min(1) }) });

/** Read the item id from a tool result, which can be JSON text. */
function addedItemId(output: unknown): string | undefined {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  return addedItemSchema.safeParse(value).data?.item.id;
}

/**
 * Return the id of the Review item that one completed tool call added. The
 * agent calls `addReviewItem` directly or through `executeTool`. Returns
 * undefined when the transcript hides the tool result.
 */
export function reviewItemIdFromToolCall(call: {
  input?: unknown;
  name: string;
  output?: unknown;
  status: string;
}): string | undefined {
  if (call.status !== "completed") return undefined;
  const toolName =
    call.name === "executeTool"
      ? executeToolInputSchema.safeParse(call.input).data?.tool_name
      : call.name;
  if (toolName !== ADD_REVIEW_ITEM_TOOL_NAME) return undefined;
  return addedItemId(call.output);
}

/**
 * Return a message for another item's excerpt, without the Review item
 * changes that it records: those show on their own items. Returns undefined
 * when nothing else remains.
 */
export function excerptMessage(
  event: ConversationReportEvent,
): ConversationReportEvent | undefined {
  const { data } = event;
  if (data.type !== "message" || !data.reviewItemChanges) return event;
  // A message with changes lists its own Events. With none, it only
  // records changes.
  if (!data.events) return undefined;
  return { ...event, data: { ...data, reviewItemChanges: undefined } };
}

/** True when an open item asks a question that the viewer can answer. */
export function reviewItemWaitsForAnswer(item: ReviewItemPayload): boolean {
  return (
    item.status === "open" &&
    item.kind === "action" &&
    Boolean(item.request) &&
    item.canAct
  );
}

/**
 * Return a submitted answer as one labeled row for each answered field, then
 * the note.
 */
export function answerRows(
  request: NonNullable<ReviewItemPayload["request"]>,
  answer: NonNullable<ReviewItemPayload["answer"]>,
): Array<{ label: string; value: string }> {
  const normalized = normalizeUserInputAnswer(request, answer);
  const rows = request.fields.flatMap((field) => {
    const values = normalized.values[field.id];
    return values?.length
      ? [{ label: field.label, value: values.join(", ") }]
      : [];
  });
  if (normalized.other) rows.push({ label: "Other", value: normalized.other });
  return rows;
}

/**
 * Return a submitted answer as one line: the values of each field, then the
 * note, so a transcript row can show it after the question.
 */
export function answerLine(
  request: NonNullable<ReviewItemPayload["request"]>,
  answer: NonNullable<ReviewItemPayload["answer"]>,
): string {
  return answerRows(request, answer)
    .map((row) => row.value)
    .join(" · ");
}

/** Say "You answered Hold" for picked options, or "You replied" for text. */
function answeredLine(choices: readonly string[]): string {
  return choices.length > 0
    ? `You answered ${choices.join(", ")}`
    : "You replied";
}

/**
 * Say what the viewer last answered in a Conversation, from the answer that
 * its feed row carries, until a later Message moves it on. The answer's own
 * Message has the close time, so it does not count as later.
 */
export function conversationAnswerLine(
  conversation: Pick<Conversation, "lastMessageAt" | "viewerAnswer">,
): string | undefined {
  const answer = conversation.viewerAnswer;
  if (!answer) return undefined;
  if (
    conversation.lastMessageAt &&
    Date.parse(conversation.lastMessageAt) > Date.parse(answer.closedAt)
  )
    return undefined;
  return answeredLine(answer.choices);
}

/** The open Review items of the inbox, in the groups and order it shows. */
export type InboxGroups = {
  fyi: ReviewItemPayload[];
  needsYou: ReviewItemPayload[];
};

/**
 * The Conversation that owns an item, or undefined when something else owns
 * it, such as an Automation.
 */
export function itemConversationId(
  item: Pick<ReviewItemPayload, "owner">,
): string | undefined {
  return item.owner.kind === "conversation" ? item.owner.id : undefined;
}

/**
 * The route of an item's owner: its Conversation, with `options`, or its
 * Automation.
 */
export function itemOwnerPath(
  item: Pick<ReviewItemPayload, "owner">,
  options?: Parameters<typeof conversationPath>[1],
): string {
  return item.owner.kind === "automation"
    ? automationPath(item.owner.id)
    : conversationPath(item.owner.id, options);
}

/** The label of a link that opens the item's owner (`itemOwnerPath`). */
export function itemOwnerLinkLabel(
  item: Pick<ReviewItemPayload, "owner">,
): string {
  return item.owner.kind === "automation"
    ? "Open automation"
    : "Open conversation";
}

/**
 * The stack that shows an item: its root Conversation, or its owner when
 * the owner is not a Conversation.
 */
export function itemStackKey(item: ReviewItemPayload): string {
  return item.rootConversationId ?? `${item.owner.kind}:${item.owner.id}`;
}

/**
 * The Review items of one root Conversation and its child agents, or of one
 * other owner, such as an Automation: a stack of cards, each with its own
 * actions. `needsYou` sorts the stack into the queue; other stacks are FYI
 * and sort after it.
 */
export type InboxBundle = {
  /**
   * Names the row: the Conversation id for a Conversation stack, the owner
   * for another owner's stack, or the item id for a row that shows one item.
   */
  key: string;
  /**
   * The root Conversation whose stack shows the items
   * (`rootConversationId`). Undefined for another owner's stack.
   */
  conversationId?: string;
  /** Items in inbox order: questions first, then the oldest. */
  items: ReviewItemPayload[];
  /** The item added last, which the collapsed bundle shows. */
  newest: ReviewItemPayload;
  needsYou: boolean;
  /** When the first item that needs the viewer arrived, or the first item. */
  waitingSince: string;
};

/** Inbox order: action items first, then the oldest, then the item id. */
function inboxOrder(a: ReviewItemPayload, b: ReviewItemPayload): number {
  if (a.kind !== b.kind) return a.kind === "action" ? -1 : 1;
  const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (age !== 0) return age;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * True when an item waits on the viewer, as the server's waiting rule says:
 * an open action item assigned to them, not to Everyone. A plugin ask, such
 * as `Ready to merge · #42`, is an action item with no `request`.
 */
export function itemNeedsViewer(item: ReviewItemPayload): boolean {
  return (
    item.status === "open" &&
    item.kind === "action" &&
    item.canAct &&
    !item.assignedToEveryone
  );
}

/**
 * True when an open ask is for Everyone, so anyone can answer or take it.
 * It waits on no one, so it is up for grabs instead of in To do.
 */
export function itemUpForGrabs(item: ReviewItemPayload): boolean {
  return (
    item.status === "open" &&
    item.kind === "action" &&
    item.canAct &&
    item.assignedToEveryone
  );
}

/**
 * Group items into one stack per root Conversation. Stacks that need the
 * viewer come first, the one that waited longest at the top, so the order
 * does not change while the reader works. FYI stacks follow, oldest first.
 */
export function inboxBundles(
  items: readonly ReviewItemPayload[],
): InboxBundle[] {
  const byStack = new Map<string, ReviewItemPayload[]>();
  for (const item of items) {
    const key = itemStackKey(item);
    byStack.set(key, [...(byStack.get(key) ?? []), item]);
  }
  const bundles = [...byStack].map(([key, group]) => {
    const sorted = [...group].sort(inboxOrder);
    const waiting = sorted.filter(itemNeedsViewer);
    const newest = sorted.reduce((latest, item) =>
      Date.parse(item.createdAt) > Date.parse(latest.createdAt) ? item : latest,
    );
    const since = Math.min(
      ...(waiting.length > 0 ? waiting : sorted).map((item) =>
        Date.parse(item.createdAt),
      ),
    );
    return {
      conversationId: sorted[0]!.rootConversationId,
      items: sorted,
      key,
      newest,
      needsYou: waiting.length > 0,
      waitingSince: new Date(since).toISOString(),
    };
  });
  return bundles.sort(
    (a, b) =>
      Number(b.needsYou) - Number(a.needsYou) ||
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Split open items into inbox groups, oldest first, so the item that waited
 * longest is at the top. Archived items are in no group.
 */
export function inboxGroups(items: readonly ReviewItemPayload[]): InboxGroups {
  const open = items.filter((item) => item.status === "open");
  return {
    fyi: open.filter((item) => item.kind === "notice").sort(inboxOrder),
    needsYou: open.filter((item) => item.kind === "action").sort(inboxOrder),
  };
}

/**
 * The open item that follows `current` in inbox order. `current` can be an
 * item that closed and left the open groups.
 */
export function nextInboxItem(
  groups: InboxGroups,
  current: ReviewItemPayload,
): ReviewItemPayload | undefined {
  return [...groups.needsYou, ...groups.fyi].find(
    (item) => inboxOrder(current, item) < 0,
  );
}
