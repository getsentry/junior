import * as z from "zod";
import {
  normalizeUserInputAnswer,
  type ReviewItemPayload,
} from "@sentry/junior/api/schema";

/**
 * Return the Inbox route that expands one item's row. A closed item opens
 * in Done. The route names the Inbox entry, because phones show the
 * entries at `/`.
 */
export function reviewItemPath(id: string): string {
  return `/?view=inbox&item=${encodeURIComponent(id)}`;
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

/** Name the state of an item: what it needs while open, or how it closed. */
export function reviewItemStatusLabel(item: ReviewItemPayload): string {
  if (item.status === "open") {
    if (item.kind === "notice") return "Notice";
    // A plugin ask waits on a step outside Junior, so it has no question.
    return item.request ? "Needs an answer" : "Waiting on you";
  }
  return item.status === "done" ? "Done" : "Dismissed";
}

/** Name the assignees of an item in one short line. */
export function assigneeLabel(item: ReviewItemPayload): string {
  const names = item.assignees.map(
    (person) => person.displayName ?? person.email,
  );
  if (item.assignedToEveryone) names.unshift("Everyone");
  return names.length > 0 ? names.join(", ") : "Unassigned";
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
 * Return a submitted answer as one line: the values of each field, then the
 * note, so a transcript row can show it after the question.
 */
export function answerLine(
  request: NonNullable<ReviewItemPayload["request"]>,
  answer: NonNullable<ReviewItemPayload["answer"]>,
): string {
  const normalized = normalizeUserInputAnswer(request, answer);
  const parts = request.fields.flatMap((field) => {
    const values = normalized.values[field.id];
    return values?.length ? [values.join(", ")] : [];
  });
  if (normalized.other) parts.push(normalized.other);
  return parts.join(" · ");
}

/**
 * The Review items of one Conversation, triaged as one unit. `needsYou` sorts
 * the bundle into the queue; other bundles are FYI and sort after it.
 */
export type InboxBundle = {
  /**
   * Names the row: the Conversation id for a Conversation bundle, or the
   * item id for a row that shows one item.
   */
  key: string;
  /** The Conversation that added the items. */
  conversationId: string;
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
 * Group items into one bundle per Conversation. Bundles that need the viewer
 * come first, the one that waited longest at the top, so the order does not
 * change while the reader works. FYI bundles follow, oldest first.
 */
export function inboxBundles(
  items: readonly ReviewItemPayload[],
): InboxBundle[] {
  const byConversation = new Map<string, ReviewItemPayload[]>();
  for (const item of items) {
    const key = item.addedByConversationId;
    byConversation.set(key, [...(byConversation.get(key) ?? []), item]);
  }
  const bundles = [...byConversation].map(([conversationId, group]) => {
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
      conversationId,
      items: sorted,
      key: conversationId,
      newest,
      needsYou: waiting.length > 0,
      waitingSince: new Date(since).toISOString(),
    };
  });
  return bundles.sort(
    (a, b) =>
      Number(b.needsYou) - Number(a.needsYou) ||
      Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
      a.conversationId.localeCompare(b.conversationId),
  );
}
