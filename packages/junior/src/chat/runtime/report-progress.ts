import type { PiMessage } from "@/chat/pi/messages";

export interface ReportedProgress {
  text: string;
  intentAcknowledgment?: boolean;
}

/** Convert a `reportProgress` tool payload into assistant status text. */
export function buildReportedProgressStatus(
  input: unknown,
): ReportedProgress | undefined {
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

  return {
    text,
    ...((input as { intentAcknowledgment?: unknown }).intentAcknowledgment ===
    true
      ? { intentAcknowledgment: true }
      : undefined),
  };
}

/** Recover the latest explicit progress update from a resumable Pi transcript. */
export function latestReportedProgress(
  messages: readonly PiMessage[],
): ReportedProgress | undefined {
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
      if (toolCall.type !== "toolCall" || toolCall.name !== "reportProgress") {
        continue;
      }
      const status = buildReportedProgressStatus(toolCall.arguments);
      if (status) {
        return status;
      }
    }
  }
  return undefined;
}
