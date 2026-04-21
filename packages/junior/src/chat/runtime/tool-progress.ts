import {
  compactStatusCommand,
  compactStatusFilename,
  extractStatusUrlDomain,
} from "@/chat/runtime/status-format";
import {
  makeAssistantStatus,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status";

function readStringField(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Derive a concrete assistant status phase from a major tool call. */
export function buildToolProgressStatus(
  toolName: string,
  params: unknown,
): AssistantStatusSpec | undefined {
  switch (toolName) {
    case "webSearch":
      return makeAssistantStatus("searching", "sources");
    case "webFetch":
      return makeAssistantStatus(
        "reading",
        extractStatusUrlDomain(readStringField(params, "url")) ?? "sources",
      );
    case "readFile":
      return makeAssistantStatus(
        "reading",
        compactStatusFilename(readStringField(params, "path")) ?? "files",
      );
    case "bash":
      return makeAssistantStatus(
        "running",
        compactStatusCommand(readStringField(params, "command")) ?? "checks",
      );
    case "writeFile":
    case "attachFile":
      return makeAssistantStatus(
        "drafting",
        compactStatusFilename(readStringField(params, "path")) ?? "files",
      );
    case "slackCanvasCreate":
    case "slackCanvasUpdate":
      return makeAssistantStatus("drafting", "canvas");
    case "slackCanvasRead":
      return makeAssistantStatus("reading", "canvas");
    case "imageGenerate":
      return makeAssistantStatus("drafting", "image");
    default:
      return undefined;
  }
}
