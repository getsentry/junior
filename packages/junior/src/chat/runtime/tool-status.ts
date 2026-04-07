import type { AssistantStatusSpec } from "@/chat/runtime/assistant-status";
import { makeAssistantStatus } from "@/chat/runtime/assistant-status";
import {
  compactStatusCommand,
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain,
} from "@/chat/runtime/status-format";

/** Build a typed assistant status for a tool call. */
export function buildToolStatus(
  toolName: string,
  input: unknown,
): AssistantStatusSpec {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const command = obj ? compactStatusCommand(obj.command) : undefined;
  const path = obj ? compactStatusPath(obj.path) : undefined;
  const filename = obj ? compactStatusFilename(obj.path) : undefined;
  const query = obj ? compactStatusText(obj.query, 70) : undefined;
  const domain = obj ? extractStatusUrlDomain(obj.url) : undefined;
  const skillName = obj
    ? compactStatusText(obj.skill_name ?? obj.skillName, 40)
    : undefined;
  const provider = obj ? compactStatusText(obj.provider, 20) : undefined;

  if (command && toolName === "bash") {
    return makeAssistantStatus("running", command);
  }
  if (filename && toolName === "readFile") {
    return makeAssistantStatus("reading", filename);
  }
  if (filename && toolName === "writeFile") {
    return makeAssistantStatus("updating", filename);
  }
  if (path && toolName === "writeFile") {
    return makeAssistantStatus("updating", path);
  }
  if (skillName && toolName === "loadSkill") {
    return makeAssistantStatus("loading", skillName);
  }
  if (query && toolName === "webSearch") {
    return makeAssistantStatus("searching", `"${query}"`);
  }
  if (query && provider && toolName === "searchTools") {
    return makeAssistantStatus("searching", `"${query}"`);
  }
  if (query && toolName === "searchTools") {
    return makeAssistantStatus("searching", `"${query}"`);
  }
  if (domain && toolName === "webFetch") {
    return makeAssistantStatus("fetching", domain);
  }

  const known: Partial<Record<string, AssistantStatusSpec>> = {
    loadSkill: makeAssistantStatus("loading", "skill instructions"),
    systemTime: makeAssistantStatus("reading", "system time"),
    bash: makeAssistantStatus("running", "shell"),
    readFile: makeAssistantStatus("reading", "file"),
    writeFile: makeAssistantStatus("updating", "file"),
    webSearch: makeAssistantStatus("searching", "sources"),
    webFetch: makeAssistantStatus("fetching", "pages"),
    slackChannelPostMessage: makeAssistantStatus("posting", "channel"),
    slackMessageAddReaction: makeAssistantStatus("adding", "reaction"),
    slackChannelListMessages: makeAssistantStatus("listing", "messages"),
    slackCanvasCreate: makeAssistantStatus("creating", "brief"),
    slackCanvasUpdate: makeAssistantStatus("updating", "brief"),
    slackListCreate: makeAssistantStatus("creating", "tracking list"),
    slackListAddItems: makeAssistantStatus("updating", "tracking list"),
    slackListUpdateItem: makeAssistantStatus("updating", "tracking list"),
    imageGenerate: makeAssistantStatus("creating", "image"),
    searchTools: makeAssistantStatus(
      "searching",
      provider ? `${provider} tools` : "tools",
    ),
  };

  if (known[toolName]) {
    return known[toolName] as AssistantStatusSpec;
  }

  const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(toolName);
  if (mcpMatch) {
    return makeAssistantStatus("running", `${mcpMatch[1]}/${mcpMatch[2]}`);
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return makeAssistantStatus("running", readable || "tool");
}
