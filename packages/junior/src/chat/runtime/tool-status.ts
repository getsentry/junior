import {
  compactStatusCommand,
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain,
} from "@/chat/runtime/status-format";

/** Return a human-readable status label for a tool call (no input context). */
export function formatToolStatus(toolName: string): string {
  const known: Record<string, string> = {
    loadSkill: "Loading skill instructions",
    systemTime: "Reading current system time",
    bash: "Working in the shell",
    readFile: "Reading a file",
    writeFile: "Updating a file",
    webSearch: "Searching public sources",
    webFetch: "Reading source pages",
    slackChannelPostMessage: "Posting message to channel",
    slackMessageAddReaction: "Adding emoji reaction",
    slackChannelListMessages: "Listing channel messages",
    slackCanvasCreate: "Creating detailed brief",
    slackCanvasUpdate: "Updating detailed brief",
    slackListCreate: "Creating tracking list",
    slackListAddItems: "Updating tracking list",
    slackListUpdateItem: "Updating tracking list",
    imageGenerate: "Generating image",
    searchTools: "Searching active tools",
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(toolName);
  if (mcpMatch) {
    return `Running ${mcpMatch[1]}/${mcpMatch[2]}`;
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Running ${readable}` : "Running tool";
}

/** Return a human-readable status label for a tool call, enriched with input details. */
export function formatToolStatusWithInput(
  toolName: string,
  input: unknown,
): string {
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
    return `Running ${command}`;
  }
  if (filename && toolName === "readFile") {
    return `Reading file ${filename}`;
  }
  if (filename && toolName === "writeFile") {
    return `Updating file ${filename}`;
  }
  if (path && toolName === "writeFile") {
    return `Updating file ${path}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loading skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Searching web for "${query}"`;
  }
  if (query && provider && toolName === "searchTools") {
    return `Searching ${provider} tools for "${query}"`;
  }
  if (query && toolName === "searchTools") {
    return `Searching tools for "${query}"`;
  }
  if (domain && toolName === "webFetch") {
    return `Fetching page from ${domain}`;
  }
  return formatToolStatus(toolName);
}
