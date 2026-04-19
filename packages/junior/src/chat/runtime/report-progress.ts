import {
  makeAssistantStatus,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";
import { compactStatusText } from "@/chat/runtime/status-format";

/**
 * Convert a structured major-progress update into internal progress copy for
 * Slack's assistant loading surface.
 */
export function buildReportedProgressStatus(
  input: unknown,
): AssistantStatusSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const phase = (input as { phase?: unknown }).phase;
  if (typeof phase !== "string") {
    return undefined;
  }

  const detail = compactStatusText((input as { detail?: unknown }).detail, 40);

  switch (phase) {
    case "thinking":
      return makeAssistantStatus("thinking", detail, { source: "major" });
    case "researching":
      return makeAssistantStatus("searching", detail, { source: "major" });
    case "reading":
      return makeAssistantStatus("reading", detail, { source: "major" });
    case "executing":
      return makeAssistantStatus("running", detail, { source: "major" });
    case "reviewing":
      return makeAssistantStatus("reviewing", detail, { source: "major" });
    case "drafting":
      return makeAssistantStatus("drafting", detail, { source: "major" });
    default:
      return undefined;
  }
}
