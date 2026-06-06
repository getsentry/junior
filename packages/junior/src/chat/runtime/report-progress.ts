import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status-render";

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
