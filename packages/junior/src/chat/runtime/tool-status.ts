import { buildReportedProgressStatus } from "@/chat/runtime/report-progress";
import {
  compactStatusCommand,
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain,
} from "@/chat/runtime/status-format";
import {
  makeAssistantStatus,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";

/**
 * Build internal progress copy for a tool call.
 *
 * For Slack, this ultimately feeds the assistant loading surface rather than
 * the fixed generic `status` string itself.
 */
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
  const reportedProgress = buildReportedProgressStatus(obj);

  if (toolName === "reportProgress" && reportedProgress) {
    return reportedProgress;
  }

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
    return makeAssistantStatus("searching", "sources");
  }
  if (query && toolName === "searchTools") {
    return makeAssistantStatus(
      "searching",
      provider ? `${provider} tools` : "tools",
    );
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
    slackCanvasRead: makeAssistantStatus("reading", "brief"),
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
