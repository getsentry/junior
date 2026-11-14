import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status-render";

interface PlanOutputItem {
  assignee?: unknown;
  status?: unknown;
  title?: unknown;
}

/** Items of the plan's own agent in an `updatePlan` result. */
function ownPlanItems(output: unknown): PlanOutputItem[] {
  const items =
    output && typeof output === "object"
      ? (output as { items?: unknown }).items
      : undefined;
  return Array.isArray(items)
    ? items.filter(
        (item): item is PlanOutputItem =>
          Boolean(item) &&
          typeof item === "object" &&
          (item as PlanOutputItem).assignee === "self",
      )
    : [];
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
  const active = ownPlanItems(output).find(
    (item) => item.status === "in_progress",
  );
  const text = typeof active?.title === "string" ? active.title.trim() : "";
  return text ? { text } : undefined;
}

function toolResultOutput(message: {
  content?: unknown;
  isError?: unknown;
}): unknown {
  if (message.isError === true || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = (message.content[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Recover the latest progress status from a resumable Pi transcript. */
export function latestProgressStatus(
  messages: readonly PiMessage[],
): AssistantStatusSpec | undefined {
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
    // A result that changed an item of the plan's own agent sets the status,
    // and clears it when no item of that agent is in progress.
    if (message.role === "toolResult" && message.toolName === "updatePlan") {
      const output = toolResultOutput(message);
      if (ownPlanItems(output).length > 0) {
        return buildPlanStatus(output);
      }
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
      if (toolCall.name === "reportProgress") {
        const status = buildReportedProgressStatus(toolCall.arguments);
        if (status) {
          return status;
        }
      }
    }
  }
  return undefined;
}
