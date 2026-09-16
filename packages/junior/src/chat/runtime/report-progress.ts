import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status-render";

function isActivePlanItem(value: unknown): value is { step: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as { status?: unknown; step?: unknown };
  return (
    item.status === "in_progress" &&
    typeof item.step === "string" &&
    item.step.trim().length > 0
  );
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

/** Convert an `updatePlan` payload into the active assistant status. */
export function buildPlanStatus(
  input: unknown,
): AssistantStatusSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const plan = (input as { plan?: unknown }).plan;
  if (!Array.isArray(plan)) {
    return undefined;
  }

  const active = plan.find(isActivePlanItem);
  return active ? { text: active.step.trim() } : undefined;
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
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.content[partIndex];
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
      if (toolCall.name === "updatePlan") {
        return buildPlanStatus(toolCall.arguments);
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
