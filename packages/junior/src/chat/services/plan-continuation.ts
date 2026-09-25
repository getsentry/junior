import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";

const OPEN_PLAN_TAG = "open-plan";

type OpenPlanItem = {
  step: string;
  status: "pending" | "in_progress";
};

function openItems(input: unknown): OpenPlanItem[] {
  const plan =
    input && typeof input === "object"
      ? (input as { plan?: unknown }).plan
      : undefined;
  if (!Array.isArray(plan)) {
    return [];
  }
  return plan.flatMap((value): OpenPlanItem[] => {
    const item = value as { step?: unknown; status?: unknown } | undefined;
    if (
      typeof item?.step !== "string" ||
      (item.status !== "pending" && item.status !== "in_progress")
    ) {
      return [];
    }
    return [{ step: item.step, status: item.status }];
  });
}

function messageText(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .flatMap((part) => {
      const text = (part as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function retainedOpenItems(message: PiMessage): OpenPlanItem[] | undefined {
  const text = messageText(message);
  if (!isCompactionSummaryText(text)) {
    return undefined;
  }
  const continuation = unwrapCurrentInstruction(text) ?? text;
  const open = `<${OPEN_PLAN_TAG}>\n`;
  const close = `\n</${OPEN_PLAN_TAG}>`;
  const closeIndex = continuation.lastIndexOf(close);
  const openIndex = continuation.lastIndexOf(open, closeIndex);
  if (openIndex < 0 || closeIndex < 0) {
    return undefined;
  }
  const payload = continuation.slice(openIndex + open.length, closeIndex);
  try {
    return openItems({ plan: JSON.parse(payload) });
  } catch {
    return undefined;
  }
}

/** Read open items from the latest successful plan state. */
export function latestOpenPlanItems(
  messages: readonly PiMessage[],
): OpenPlanItem[] {
  const successfulCalls = new Set<string>();
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex] as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    if (
      message.role === "toolResult" &&
      message.toolName === "updatePlan" &&
      typeof message.toolCallId === "string" &&
      message.isError !== true
    ) {
      successfulCalls.add(message.toolCallId);
      continue;
    }
    if (message.role === "user") {
      const retained = retainedOpenItems(messages[messageIndex]!);
      if (retained) {
        return retained;
      }
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const call = message.content[partIndex] as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (
        call?.type === "toolCall" &&
        call.name === "updatePlan" &&
        typeof call.id === "string" &&
        successfulCalls.has(call.id)
      ) {
        return openItems(call.arguments);
      }
    }
  }
  return [];
}

/** Append exact open plan state to continuation text. */
export function appendOpenPlan(
  continuation: string,
  messages: readonly PiMessage[],
): string {
  const plan = latestOpenPlanItems(messages);
  return plan.length === 0
    ? continuation
    : `${continuation}\n\n<${OPEN_PLAN_TAG}>\n${JSON.stringify(plan)}\n</${OPEN_PLAN_TAG}>`;
}
