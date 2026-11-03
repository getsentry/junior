import { z } from "zod";
import type {
  ConversationReportEvent,
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

/** Return the review desk route that selects one item. */
export function reviewItemPath(id: string): string {
  return `/review?item=${encodeURIComponent(id)}`;
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
    return item.kind === "action" ? "Needs an answer" : "Notice";
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

/** Return the id of the last Review item that a tool call in the events added. */
export function latestReviewItemId(
  events: readonly ConversationReportEvent[] | undefined,
): string | undefined {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const data = events![index]!.data;
    if (data.type !== "tool_calls") continue;
    for (let call = data.calls.length - 1; call >= 0; call -= 1) {
      const id = reviewItemIdFromToolCall(data.calls[call]!);
      if (id) return id;
    }
  }
  return undefined;
}

type ChangeRecords = {
  events?: readonly { reviewItemChange?: ReviewItemChangeRecord }[];
  reviewItemChange?: ReviewItemChangeRecord;
};

/**
 * Return the Review item changes that one message records. A person message
 * or a single relay has one. An Event batch has one for each relay in it.
 */
export function messageReviewItemChanges(
  message: ChangeRecords,
): ReviewItemChangeRecord[] {
  if (message.reviewItemChange) return [message.reviewItemChange];
  return (message.events ?? []).flatMap((event) =>
    event.reviewItemChange ? [event.reviewItemChange] : [],
  );
}

/** True when a message only records Review item changes. */
export function onlyRecordsReviewItemChanges(message: ChangeRecords): boolean {
  if (message.reviewItemChange) return true;
  const events = message.events ?? [];
  return events.length > 0 && events.every((event) => event.reviewItemChange);
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

/** The open Review items of the inbox, in the groups and order it shows. */
export type InboxGroups = {
  fyi: ReviewItemPayload[];
  needsYou: ReviewItemPayload[];
};

/** Inbox order: action items first, then the oldest, then the item id. */
function inboxOrder(a: ReviewItemPayload, b: ReviewItemPayload): number {
  if (a.kind !== b.kind) return a.kind === "action" ? -1 : 1;
  const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (age !== 0) return age;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
