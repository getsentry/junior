import * as z from "zod";
import type { PiMessage } from "@/chat/pi/messages";
import { SELF_PLAN_ASSIGNEE } from "@/chat/plan/types";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status-render";

// Reads only what the status needs, so other result fields can change.
const planOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      assignee: z.string(),
      status: z.string(),
      title: z.string(),
    }),
  ),
  removed_ids: z.array(z.number()).optional(),
});

type PlanOutputItem = z.output<typeof planOutputSchema>["items"][number];

function isOwnActiveItem(item: PlanOutputItem): boolean {
  return item.assignee === SELF_PLAN_ASSIGNEE && item.status === "in_progress";
}

function planItemStatus(
  item: PlanOutputItem | undefined,
): AssistantStatusSpec | undefined {
  const text = item?.title.trim();
  return text ? { text } : undefined;
}

/** Convert a `reportProgress` tool payload into assistant status text. */
export function buildReportedProgressStatus(
  input: unknown,
): AssistantStatusSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const message = (input as { message?: unknown }).message;
  if (typeof message !== "string") {
    return undefined;
  }

  const text = message.trim();
  if (!text) {
    return undefined;
  }

  return { text };
}

/**
 * Convert an `updatePlan` result into the active assistant status: the
 * item that the plan's own agent has in progress.
 */
export function buildPlanStatus(
  output: unknown,
): AssistantStatusSpec | undefined {
  const parsed = planOutputSchema.safeParse(output);
  return parsed.success
    ? planItemStatus(parsed.data.items.find(isOwnActiveItem))
    : undefined;
}

const textPartSchema = z.object({ text: z.string() });

function toolResultOutput(message: {
  content?: unknown;
  isError?: unknown;
}): unknown {
  if (message.isError === true || !Array.isArray(message.content)) {
    return undefined;
  }
  const part = textPartSchema.safeParse(message.content[0]);
  if (!part.success) return undefined;
  try {
    const output: unknown = JSON.parse(part.data.text);
    return output;
  } catch {
    return undefined;
  }
}

/** Recover the latest progress status from a resumable Pi transcript. */
export function latestProgressStatus(
  messages: readonly PiMessage[],
): AssistantStatusSpec | undefined {
  // A result lists only the items that its call changed, so a newer result
  // overrides an older one item by item.
  const newerItemIds = new Set<number>();
  let sawOwnPlanItem = false;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex] as {
      role?: unknown;
      content?: unknown;
      isError?: unknown;
      toolName?: unknown;
    };
    if (message.role === "toolResult" && message.toolName === "updatePlan") {
      const parsed = planOutputSchema.safeParse(toolResultOutput(message));
      if (!parsed.success) continue;
      const { items, removed_ids: removedIds = [] } = parsed.data;
      const status = planItemStatus(
        items.find(
          (item) => !newerItemIds.has(item.id) && isOwnActiveItem(item),
        ),
      );
      if (status) return status;
      for (const item of items) newerItemIds.add(item.id);
      for (const id of removedIds) newerItemIds.add(id);
      sawOwnPlanItem ||= items.some(
        (item) => item.assignee === SELF_PLAN_ASSIGNEE,
      );
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part: unknown = message.content[partIndex];
      if (!part || typeof part !== "object") {
        continue;
      }
      const toolCall = part as {
        type?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (toolCall.type !== "toolCall") {
        continue;
      }
      // The plan of the agent replaces older progress text.
      if (toolCall.name === "reportProgress" && !sawOwnPlanItem) {
        const status = buildReportedProgressStatus(toolCall.arguments);
        if (status) {
          return status;
        }
      }
    }
  }
  return undefined;
}
