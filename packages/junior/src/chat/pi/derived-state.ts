import type { PiMessage } from "@/chat/pi/messages";
import { parseMcpProviderFromToolName } from "@/chat/mcp/tool-name";

const MCP_BRIDGE_TOOLS = new Set(["callMcpTool", "searchMcpTools"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function providerFromToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parseMcpProviderFromToolName(value);
}

function addString(values: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    values.add(value.trim());
  }
}

function getToolName(value: Record<string, unknown>): string | undefined {
  return typeof value.toolName === "string"
    ? value.toolName
    : typeof value.name === "string"
      ? value.name
      : undefined;
}

function addBridgeToolProvider(
  toolName: string | undefined,
  value: Record<string, unknown>,
  providers: Set<string>,
): void {
  const bridgeTool =
    toolName && MCP_BRIDGE_TOOLS.has(toolName) ? toolName : undefined;

  if (bridgeTool === "searchMcpTools") {
    for (const argsKey of ["input", "args", "arguments", "params"]) {
      const args = value[argsKey];
      if (isRecord(args)) {
        addString(providers, args.provider);
      }
    }
    addString(providers, value.provider);
  }

  if (bridgeTool === "callMcpTool") {
    for (const argsKey of ["input", "args", "arguments", "params"]) {
      const args = value[argsKey];
      if (isRecord(args)) {
        addString(providers, providerFromToolName(args.tool_name));
      }
    }
    addString(providers, providerFromToolName(value.tool_name));
  }
}

function addMcpResultProvider(
  message: Record<string, unknown>,
  providers: Set<string>,
): void {
  const toolName =
    typeof message.toolName === "string" ? message.toolName : undefined;
  if (message.isError === true) {
    return;
  }

  if (toolName === "loadSkill") {
    if (isRecord(message.details)) {
      addString(providers, message.details.mcp_provider);
    }
    addString(providers, message.mcp_provider);
    return;
  }

  if (toolName === "searchMcpTools") {
    if (isRecord(message.details)) {
      addString(providers, message.details.provider);
      if (Array.isArray(message.details.tools)) {
        for (const tool of message.details.tools) {
          if (isRecord(tool)) {
            addString(providers, providerFromToolName(tool.tool_name));
          }
        }
      }
    }
    addString(providers, message.provider);
    return;
  }

  if (toolName === "callMcpTool") {
    for (const argsKey of ["input", "args", "arguments", "params"]) {
      const args = message[argsKey];
      if (isRecord(args)) {
        addString(providers, providerFromToolName(args.tool_name));
      }
    }
    if (isRecord(message.details)) {
      addString(providers, message.details.provider);
      addString(providers, providerFromToolName(message.details.tool_name));
    }
    addString(providers, providerFromToolName(message.tool_name));
  }
}

function scanMcpProviders(message: PiMessage, providers: Set<string>): void {
  if (!isRecord(message)) {
    return;
  }

  if (message.role === "toolResult") {
    addMcpResultProvider(message, providers);
    return;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    addBridgeToolProvider(getToolName(part), part, providers);
  }
}

function scanLoadedSkills(message: PiMessage, skills: Set<string>): void {
  if (
    isRecord(message) &&
    message.role === "toolResult" &&
    message.toolName === "loadSkill" &&
    message.isError !== true
  ) {
    if (isRecord(message.details)) {
      addString(skills, message.details.skill_name);
    }
    addString(skills, message.skill_name);
  }
}

/** Infer MCP providers previously used in durable Pi history. */
export function inferActiveMcpProvidersFromPiMessages(
  messages: PiMessage[] | undefined,
): string[] {
  const providers = new Set<string>();
  for (const message of messages ?? []) {
    scanMcpProviders(message, providers);
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

/** Infer successfully loaded skills from durable Pi history. */
export function inferLoadedSkillNamesFromPiMessages(
  messages: PiMessage[] | undefined,
): string[] {
  const skills = new Set<string>();
  for (const message of messages ?? []) {
    scanLoadedSkills(message, skills);
  }
  return [...skills].sort((left, right) => left.localeCompare(right));
}
