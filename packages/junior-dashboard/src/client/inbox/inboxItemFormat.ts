import * as z from "zod";
import {
  ASK_TOOL_NAMES,
  inboxItemQuestion,
  normalizeUserInputAnswer,
  USER_INPUT_NOTE,
  type InboxItemPayload,
  type UserInputRequest,
} from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { withoutStandaloneUrl } from "../display-text/DisplayText";
import { automationPath } from "../format";
import { displayPlainText } from "../display-text/plainText";

/** Return the Inbox route that selects one item. */
export function inboxItemPath(id: string): string {
  return `/inbox?item=${encodeURIComponent(id)}`;
}

/**
 * Return the Inbox route that expands one item's row: Done for a
 * closed item. The route names the entry, because phones show the entries
 * at `/inbox`.
 */
export function inboxRowPath(
  item: Pick<InboxItemPayload, "id" | "status">,
): string {
  const view = item.status === "open" ? "inbox" : "done";
  return `/inbox?view=${view}&item=${encodeURIComponent(item.id)}`;
}

/**
 * Return the subject URL when it is safe to link. Agents and plugins supply
 * it, and URL validation also accepts `javascript:` and `data:` URLs.
 */
export function inboxItemSubjectHref(url: string): string | undefined {
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
export function inboxItemText(
  item: Pick<InboxItemPayload, "body" | "subject">,
): string {
  return item.subject?.url
    ? withoutStandaloneUrl(item.body, item.subject.url)
    : item.body;
}

/** Name the state of an item: what it needs while open, or how it closed. */
export function inboxItemStatusLabel(item: InboxItemPayload): string {
  if (item.status === "open") {
    if (item.kind === "notice") return "Notice";
    // A plugin ask waits on a step outside Junior, so it has no question.
    return inboxItemQuestion(item.request)
      ? "Needs an answer"
      : "Waiting on you";
  }
  return item.status === "done" ? "Done" : "Dismissed";
}

/** Return an item's title as text, with the names of the people it mentions. */
export function inboxItemTitleText(
  item: Pick<InboxItemPayload, "mentions" | "title">,
): string {
  return displayPlainText(item.title, item.mentions);
}

const executeToolInputSchema = z.object({ tool_name: z.string() });
const askedQuestionSchema = z.object({
  question: z.object({ id: z.string().min(1) }),
});
const addedItemSchema = z.object({
  item: z.object({
    id: z.string().min(1),
    subject: z.object({ id: z.string().min(1) }).optional(),
  }),
});

/** The Inbox item that a tool call added, and the question it shows. */
export type InboxItemAsk = { itemId: string; questionId: string };

/** Read the asked question from a tool result, which can be JSON text. */
function addedItemAsk(output: unknown): InboxItemAsk | undefined {
  let value = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      return undefined;
    }
  }
  // The Inbox gives a question's item the question's id.
  const question = askedQuestionSchema.safeParse(value).data?.question;
  if (question) return { itemId: question.id, questionId: question.id };
  // An older result names the item that the tool added. One from before
  // items had subjects names none, and its question took the item's id.
  const item = addedItemSchema.safeParse(value).data?.item;
  return item && { itemId: item.id, questionId: item.subject?.id ?? item.id };
}

/**
 * Return the Inbox item that one completed tool call added, and its
 * question. The agent calls `askUserQuestion` directly or through
 * `executeTool`. Returns undefined when the transcript hides the tool
 * result.
 */
export function inboxItemAskFromToolCall(call: {
  input?: unknown;
  name: string;
  output?: unknown;
  status: string;
}): InboxItemAsk | undefined {
  if (call.status !== "completed") return undefined;
  const toolName =
    call.name === "executeTool"
      ? executeToolInputSchema.safeParse(call.input).data?.tool_name
      : call.name;
  if (!toolName || !ASK_TOOL_NAMES.has(toolName)) return undefined;
  return addedItemAsk(call.output);
}

/** Return the id of the Inbox item that one completed tool call added. */
export function inboxItemIdFromToolCall(
  call: Parameters<typeof inboxItemAskFromToolCall>[0],
): string | undefined {
  return inboxItemAskFromToolCall(call)?.itemId;
}

/**
 * Return a submitted answer as one labeled row for each answered field, then
 * the note.
 */
export function answerRows(
  request: UserInputRequest,
  answer: NonNullable<InboxItemPayload["answer"]>,
): Array<{ label: string; value: string }> {
  const normalized = normalizeUserInputAnswer(request, answer);
  const rows = request.fields.flatMap((field) => {
    const values = normalized.values[field.id];
    return values?.length
      ? [{ label: field.label, value: values.join(", ") }]
      : [];
  });
  if (normalized.other) {
    rows.push({ label: USER_INPUT_NOTE.label, value: normalized.other });
  }
  return rows;
}

/**
 * Return a submitted answer as one line: the values of each field, then the
 * note, so a transcript row can show it after the question.
 */
export function answerLine(
  request: UserInputRequest,
  answer: NonNullable<InboxItemPayload["answer"]>,
): string {
  return answerRows(request, answer)
    .map((row) => row.value)
    .join(" · ");
}

/**
 * Whether the viewer cannot see the Conversation that owns the item. The
 * API then names no root for it, as for a person whose role on the subject
 * puts them on the item.
 */
export function itemConversationHidden(
  item: Pick<InboxItemPayload, "owner" | "rootConversationId">,
): boolean {
  return item.owner.kind === "conversation" && !item.rootConversationId;
}

/**
 * The Conversation that owns an item, or undefined when something else owns
 * it, such as an Automation, or when the viewer cannot see it.
 */
export function itemConversationId(
  item: Pick<InboxItemPayload, "owner" | "rootConversationId">,
): string | undefined {
  return item.owner.kind === "conversation" && !itemConversationHidden(item)
    ? item.owner.id
    : undefined;
}

/**
 * The route of an item's owner: its Conversation, with `options`, or its
 * Automation. When the viewer cannot see the Conversation, the item's own
 * row, so nothing links to the Conversation.
 */
export function itemOwnerPath(
  item: Pick<
    InboxItemPayload,
    "id" | "owner" | "rootConversationId" | "status"
  >,
  options?: Parameters<typeof conversationPath>[1],
): string {
  if (item.owner.kind === "automation") return automationPath(item.owner.id);
  return itemConversationHidden(item)
    ? inboxRowPath(item)
    : conversationPath(item.owner.id, options);
}

/** The label of a link that opens the item's owner (`itemOwnerPath`). */
export function itemOwnerLinkLabel(
  item: Pick<InboxItemPayload, "owner">,
): string {
  return item.owner.kind === "automation"
    ? "Open automation"
    : "Open conversation";
}

/**
 * The stack that shows an item: its root Conversation, or its owner when
 * the owner is not a Conversation.
 */
export function itemStackKey(item: InboxItemPayload): string {
  return item.rootConversationId ?? `${item.owner.kind}:${item.owner.id}`;
}

/**
 * The Inbox items of one root Conversation and its child agents, or of one
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
  items: InboxItemPayload[];
  /** The item added last, which the collapsed bundle shows. */
  newest: InboxItemPayload;
  needsYou: boolean;
  /** When the first item that needs the viewer arrived, or the first item. */
  waitingSince: string;
};

/** Inbox order: action items first, then the oldest, then the item id. */
function inboxOrder(a: InboxItemPayload, b: InboxItemPayload): number {
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
export function itemNeedsViewer(item: InboxItemPayload): boolean {
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
export function itemUpForGrabs(item: InboxItemPayload): boolean {
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
  items: readonly InboxItemPayload[],
): InboxBundle[] {
  const byStack = new Map<string, InboxItemPayload[]>();
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
