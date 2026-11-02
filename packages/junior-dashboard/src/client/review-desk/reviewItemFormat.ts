import { z } from "zod";
import type {
  ConversationReportEvent,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

/** Return the review desk route that selects one item. */
export function reviewItemPath(id: string): string {
  return `/review?item=${encodeURIComponent(id)}`;
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

/** True when an open item asks a question that the viewer can answer. */
export function reviewItemWaitsForAnswer(item: ReviewItemPayload): boolean {
  return (
    item.status === "open" &&
    item.kind === "action" &&
    Boolean(item.request) &&
    item.canAct
  );
}
