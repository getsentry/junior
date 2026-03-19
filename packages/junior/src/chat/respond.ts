import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageAttributes,
  serializeGenAiAttribute,
} from "@/chat/gen-ai-attributes";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import { getMcpAuthSession, patchMcpAuthSession } from "@/chat/mcp/auth-store";
import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  setTags,
  withSpan,
  type ObservabilityContext,
} from "@/chat/observability";
import { deliverPrivateMessage, formatProviderLabel } from "@/chat/oauth-flow";
import { buildSystemPrompt } from "@/chat/prompt";
import {
  createSkillCapabilityRuntime,
  getUserTokenStore,
} from "@/chat/capabilities/factory";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { isExplicitChannelPostIntent } from "@/chat/channel-intent";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import {
  buildReplyDeliveryPlan,
  type ReplyDeliveryPlan,
} from "@/chat/delivery/plan";
import { SkillSandbox } from "@/chat/skill-sandbox";
import {
  discoverSkills,
  findSkillByName,
  parseSkillInvocation,
  type Skill,
} from "@/chat/skills";
import {
  getPluginMcpProviders,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { SlackActionError } from "@/chat/slack-actions/client";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import { toExposedToolSummary } from "@/chat/tools/mcp-tool-summary";
import type { ImageGenerateToolDeps } from "@/chat/tools/types";
import {
  GEN_AI_PROVIDER_NAME,
  getGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import { getRuntimeMetadata } from "@/chat/runtime-metadata";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  getAgentTurnSessionCheckpoint,
  upsertAgentTurnSessionCheckpoint,
} from "@/chat/state";
import {
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain,
} from "@/chat/status-format";
import { RetryableTurnError, isRetryableTurnError } from "@/chat/turn/errors";
import { enforceAttachmentClaimTruth } from "@/chat/attachment-claims";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";

export interface ReplyRequestContext {
  skillDirs?: string[];
  assistant?: {
    userId?: string;
    userName?: string;
  };
  requester?: {
    userId?: string;
    userName?: string;
    fullName?: string;
  };
  correlation?: {
    conversationId?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
    channelId?: string;
    messageTs?: string;
    threadTs?: string;
    requesterId?: string;
  };
  toolChannelId?: string;
  conversationContext?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  userAttachments?: Array<{
    data: Buffer;
    mediaType: string;
    filename?: string;
  }>;
  sandbox?: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
  };
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
  };
  onStatus?: (status: string) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  deliveryPlan?: ReplyDeliveryPlan;
  deliveryMode?: "thread" | "channel_only";
  ackStrategy?: "none" | "reaction";
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  diagnostics: AgentTurnDiagnostics;
}

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  errorMessage?: string;
  providerError?: unknown;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usedPrimaryText: boolean;
}

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;
let startupDiscoveryLogged = false;

function getSessionIdentifiers(context: ReplyRequestContext): {
  conversationId?: string;
  sessionId?: string;
} {
  return {
    conversationId:
      context.correlation?.conversationId ??
      context.correlation?.threadId ??
      context.correlation?.runId,
    sessionId: context.correlation?.turnId,
  };
}

type ResumablePiAgent = Agent & {
  continue?: () => Promise<unknown>;
  replaceMessages?: (messages: unknown[]) => Promise<void> | void;
};

class AgentTurnTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Agent turn timed out after ${timeoutMs}ms`);
    this.name = "AgentTurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class McpAuthorizationPauseError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`MCP authorization started for ${provider}`);
    this.name = "McpAuthorizationPauseError";
    this.provider = provider;
  }
}

async function maybeReplaceAgentMessages(
  agent: Agent,
  messages: unknown[],
): Promise<boolean> {
  const resumable = agent as ResumablePiAgent;
  if (typeof resumable.replaceMessages !== "function") {
    return false;
  }
  await resumable.replaceMessages(messages);
  return true;
}

async function runAgentContinuation(agent: Agent): Promise<unknown> {
  const resumable = agent as ResumablePiAgent;
  if (typeof resumable.continue !== "function") {
    throw new Error("Agent continuation is unavailable in this runtime");
  }
  return await resumable.continue();
}

function trimTrailingAssistantMessages(messages: unknown[]): unknown[] {
  let end = messages.length;
  while (end > 0 && getPiMessageRole(messages[end - 1]) === "assistant") {
    end -= 1;
  }
  return end === messages.length ? [...messages] : messages.slice(0, end);
}

function isExecutionDeferralResponse(text: string): boolean {
  return /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
    text,
  );
}

function isToolAccessDisclaimerResponse(text: string): boolean {
  return /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
    text,
  );
}

function isExecutionEscapeResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    isExecutionDeferralResponse(trimmed) ||
    isToolAccessDisclaimerResponse(trimmed)
  );
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return undefined;
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isToolPayloadShape(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.startsWith("tool-")) return true;
  if (
    type === "tool_use" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "tool_error"
  )
    return true;

  const hasToolName =
    typeof record.toolName === "string" || typeof record.name === "string";
  const hasToolInput =
    Object.prototype.hasOwnProperty.call(record, "input") ||
    Object.prototype.hasOwnProperty.call(record, "args");
  if (hasToolName && hasToolInput) return true;

  return false;
}

function isRawToolPayloadResponse(text: string): boolean {
  const parsed = parseJsonCandidate(text);
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => isToolPayloadShape(entry));
  }
  if (isToolPayloadShape(parsed)) {
    return true;
  }

  const compact = text.replace(/\s+/g, " ");
  return /"type"\s*:\s*"tool[-_](use|call|result|error)"/i.test(compact);
}

function formatToolStatus(toolName: string): string {
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
    useTool: "Running active tool",
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Running ${readable}` : "Running tool";
}

function formatCanonicalToolStatusName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(trimmed);
  if (mcpMatch) {
    return compactStatusText(`${mcpMatch[1]}/${mcpMatch[2]}`, 40);
  }

  return compactStatusText(trimmed, 40);
}

function formatToolStatusWithInput(toolName: string, input: unknown): string {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const command = obj ? compactStatusText(obj.command, 70) : undefined;
  const path = obj ? compactStatusPath(obj.path) : undefined;
  const filename = obj ? compactStatusFilename(obj.path) : undefined;
  const query = obj ? compactStatusText(obj.query, 70) : undefined;
  const domain = obj ? extractStatusUrlDomain(obj.url) : undefined;
  const skillName = obj
    ? compactStatusText(obj.skill_name ?? obj.skillName, 40)
    : undefined;
  const provider = obj ? compactStatusText(obj.provider, 20) : undefined;
  const activeToolName = obj
    ? formatCanonicalToolStatusName(obj.tool_name ?? obj.toolName)
    : undefined;

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
  if (activeToolName && toolName === "useTool") {
    return `Running ${activeToolName}`;
  }
  if (domain && toolName === "webFetch") {
    return `Fetching page from ${domain}`;
  }
  return formatToolStatus(toolName);
}

function formatToolResultStatus(toolName: string): string {
  const known: Record<string, string> = {
    loadSkill: "Integrating loaded skill guidance",
    systemTime: "Applying current time context",
    bash: "Reviewing command results",
    readFile: "Analyzing file contents",
    writeFile: "Saving file update",
    webSearch: "Reviewing search results",
    webFetch: "Reviewing page content",
    slackChannelPostMessage: "Posted message to channel",
    slackMessageAddReaction: "Added emoji reaction",
    slackChannelListMessages: "Reviewed channel messages",
    slackCanvasCreate: "Preparing canvas response",
    slackCanvasUpdate: "Preparing canvas update",
    slackListCreate: "Preparing list update",
    slackListAddItems: "Preparing list update",
    slackListUpdateItem: "Preparing list update",
    imageGenerate: "Preparing generated image",
    searchTools: "Reviewing tool matches",
    useTool: "Reviewing tool result",
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0
    ? `Reviewing ${readable} result`
    : "Reviewing tool result";
}

function formatToolResultStatusWithInput(
  toolName: string,
  input: unknown,
): string {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const command = obj ? compactStatusText(obj.command, 70) : undefined;
  const path = obj ? compactStatusPath(obj.path) : undefined;
  const filename = obj ? compactStatusFilename(obj.path) : undefined;
  const query = obj ? compactStatusText(obj.query, 70) : undefined;
  const domain = obj ? extractStatusUrlDomain(obj.url) : undefined;
  const skillName = obj
    ? compactStatusText(obj.skill_name ?? obj.skillName, 40)
    : undefined;
  const provider = obj ? compactStatusText(obj.provider, 20) : undefined;
  const activeToolName = obj
    ? formatCanonicalToolStatusName(obj.tool_name ?? obj.toolName)
    : undefined;

  if (command && toolName === "bash") {
    return `Reviewed results from ${command}`;
  }
  if (filename && toolName === "readFile") {
    return `Reviewed file ${filename}`;
  }
  if (filename && toolName === "writeFile") {
    return `Updated file ${filename}`;
  }
  if (path && toolName === "writeFile") {
    return `Updated file ${path}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loaded skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Reviewed web results for "${query}"`;
  }
  if (query && provider && toolName === "searchTools") {
    return `Reviewed ${provider} tool matches`;
  }
  if (query && toolName === "searchTools") {
    return `Reviewed tool matches for "${query}"`;
  }
  if (activeToolName && toolName === "useTool") {
    return `Reviewed ${activeToolName} result`;
  }
  if (domain && toolName === "webFetch") {
    return `Reviewed page from ${domain}`;
  }
  return formatToolResultStatus(toolName);
}

function toObservablePromptPart(
  part:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string },
): Record<string, unknown> {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    };
  }

  return {
    type: "image",
    mimeType: part.mimeType,
    data: `[omitted:${part.data.length}]`,
  };
}

function summarizeMessageText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "[empty]";
  }
  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}...`
    : normalized;
}

function buildUserTurnText(
  userInput: string,
  conversationContext?: string,
): string {
  const trimmedContext = conversationContext?.trim();
  if (!trimmedContext) {
    return userInput;
  }

  return [
    "<current-message>",
    userInput,
    "</current-message>",
    "",
    "<thread-conversation-context>",
    "Use this context for continuity across prior thread turns.",
    trimmedContext,
    "</thread-conversation-context>",
  ].join("\n");
}

function encodeNonImageAttachmentForPrompt(attachment: {
  data: Buffer;
  mediaType: string;
  filename?: string;
}): string {
  const base64 = attachment.data.toString("base64");
  const wasTruncated = base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS;
  const encodedPayload = wasTruncated
    ? `${base64.slice(0, MAX_INLINE_ATTACHMENT_BASE64_CHARS)}...`
    : base64;

  return [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
    "encoding: base64",
    `truncated: ${wasTruncated ? "true" : "false"}`,
    "<data_base64>",
    encodedPayload,
    "</data_base64>",
    "</attachment>",
  ].join("\n");
}

function buildExecutionFailureMessage(toolErrorCount: number): string {
  if (toolErrorCount > 0) {
    return "I couldn’t complete this because one or more required tools failed in this turn. I’ve logged the failure details.";
  }

  return "I couldn’t complete this request in this turn due to an execution failure. I’ve logged the details for debugging.";
}

function toToolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isStructuredToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
  details: unknown;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(content) &&
    content.every((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text") {
        return typeof record.text === "string";
      }
      if (record.type === "image") {
        return (
          typeof record.data === "string" && typeof record.mimeType === "string"
        );
      }
      return false;
    }) &&
    "details" in value
  );
}

export const respondStatusFormatters = {
  formatToolStatus,
  formatToolStatusWithInput,
  formatToolResultStatus,
  formatToolResultStatusWithInput,
};

function isToolResultMessage(value: unknown): value is ToolResultMessage<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "toolResult"
  );
}

function normalizeToolNameFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { toolName?: unknown; name?: unknown };
  if (typeof record.toolName === "string" && record.toolName.length > 0) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.length > 0) {
    return record.name;
  }
  return undefined;
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean((result as { isError?: unknown }).isError);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "assistant"
  );
}

function getPiMessageRole(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractAssistantText(message: AssistantMessage): string {
  const content =
    (message as { content?: Array<{ type?: unknown; text?: unknown }> })
      .content ?? [];
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function upsertActiveSkill(activeSkills: Skill[], next: Skill): void {
  const existing = activeSkills.find((skill) => skill.name === next.name);
  if (existing) {
    existing.body = next.body;
    existing.description = next.description;
    existing.skillPath = next.skillPath;
    existing.allowedTools = next.allowedTools;
    existing.requiresCapabilities = next.requiresCapabilities;
    existing.usesConfig = next.usesConfig;
    existing.pluginProvider = next.pluginProvider;
    return;
  }

  activeSkills.push(next);
}

function collectRelevantConfigurationKeys(
  activeSkills: Array<{ usesConfig?: string[] }>,
  explicitSkill?: { usesConfig?: string[] } | null,
): string[] {
  const keys = new Set<string>();
  for (const skill of [
    ...activeSkills,
    ...(explicitSkill ? [explicitSkill] : []),
  ]) {
    for (const key of skill.usesConfig ?? []) {
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function getToolErrorAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!(error instanceof SlackActionError)) {
    return {};
  }

  return {
    "app.slack.error_code": error.code,
    ...(error.apiError ? { "app.slack.api_error": error.apiError } : {}),
    ...(error.detail ? { "app.slack.detail": error.detail } : {}),
    ...(error.detailLine !== undefined
      ? { "app.slack.detail_line": error.detailLine }
      : {}),
    ...(error.detailRule ? { "app.slack.detail_rule": error.detailRule } : {}),
  };
}

function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  spanContext: ObservabilityContext,
  onStatus?: (status: string) => void | Promise<void>,
  sandboxExecutor?: SandboxExecutor,
  capabilityRuntime?: SkillCapabilityRuntime,
  hooks?: {
    onToolCall?: (toolName: string) => void;
  },
): AgentTool[] {
  const shouldTrace = shouldEmitDevAgentTrace();
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    execute: async (toolCallId: unknown, params: unknown) => {
      const normalizedToolCallId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : undefined;
      const toolArgumentsAttribute = serializeGenAiAttribute(params);
      hooks?.onToolCall?.(toolName);
      const toolStartedAt = Date.now();
      const traceToolContext = {
        ...spanContext,
        conversationId: spanContext.conversationId,
        turnId: spanContext.turnId,
        agentId: spanContext.agentId,
      };
      await onStatus?.(`${formatToolStatusWithInput(toolName, params)}...`);
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async () => {
          if (!Value.Check(toolDef.inputSchema, params)) {
            const details = [...Value.Errors(toolDef.inputSchema, params)]
              .slice(0, 3)
              .map((entry) => `${entry.path || "/"}: ${entry.message}`)
              .join("; ");
            const validationMessage =
              details.length > 0 ? details : "Invalid tool input";
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "error.type": "tool_input_validation_error",
            });
            setSpanStatus("error");
            logWarn(
              "agent_tool_call_invalid_input",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId
                  ? { "gen_ai.tool.call.id": normalizedToolCallId }
                  : {}),
                "app.ai.tool_duration_ms": durationMs,
              },
              "Agent tool call input validation failed",
            );
            logException(
              new Error(validationMessage),
              "agent_tool_call_invalid_input_exception",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId
                  ? { "gen_ai.tool.call.id": normalizedToolCallId }
                  : {}),
                "app.ai.tool_duration_ms": durationMs,
              },
              "Agent tool call input validation failed with exception",
            );
            throw new Error(validationMessage);
          }
          const parsed = params as Record<string, unknown>;

          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails = { ok: true };
              const durationMs = Date.now() - toolStartedAt;
              const toolResultAttribute =
                serializeGenAiAttribute(resultDetails);
              setSpanAttributes({
                "app.ai.tool_duration_ms": durationMs,
                "app.ai.tool_outcome": "success",
                ...(toolResultAttribute
                  ? { "gen_ai.tool.call.result": toolResultAttribute }
                  : {}),
              });
              setSpanStatus("ok");
              await onStatus?.(
                `${formatToolResultStatusWithInput(toolName, parsed)}...`,
              );
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails,
              };
            }

            const injectedHeaders =
              toolName === "bash"
                ? capabilityRuntime?.getTurnHeaderTransforms()
                : undefined;
            const injectedEnv =
              toolName === "bash" ? capabilityRuntime?.getTurnEnv() : undefined;
            const bashCommand =
              toolName === "bash" && typeof parsed.command === "string"
                ? parsed.command.trim()
                : "";
            const isCustomBashCommand =
              toolName === "bash" && /^jr-rpc(?:\s|$)/.test(bashCommand);
            const shouldLogCredentialInjection =
              toolName === "bash" &&
              !isCustomBashCommand &&
              Boolean(injectedHeaders && injectedHeaders.length > 0);
            if (shouldLogCredentialInjection) {
              const headerDomains = (injectedHeaders ?? []).map(
                (transform) => transform.domain,
              );
              logInfo(
                "credential_inject_start",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name,
                  "app.credential.delivery": "header_transform",
                  "app.credential.header_domains": headerDomains,
                },
                "Injecting scoped credential headers for sandbox command",
              );
            }

            const hasBashCredentials = injectedHeaders || injectedEnv;
            const sandboxInput =
              toolName === "bash"
                ? { command: String(parsed.command ?? "") }
                : toolName === "readFile"
                  ? { path: String(parsed.path ?? "") }
                  : toolName === "writeFile"
                    ? {
                        path: String(parsed.path ?? ""),
                        content: String(parsed.content ?? ""),
                      }
                    : parsed;
            const result = sandboxExecutor?.canExecute(toolName)
              ? await sandboxExecutor.execute({
                  toolName,
                  input:
                    toolName === "bash" && hasBashCredentials
                      ? {
                          ...sandboxInput,
                          ...(injectedHeaders
                            ? { headerTransforms: injectedHeaders }
                            : {}),
                          ...(injectedEnv ? { env: injectedEnv } : {}),
                        }
                      : sandboxInput,
                })
              : await toolDef.execute(parsed as never, {
                  experimental_context: sandbox,
                });
            const resultDetails =
              sandboxExecutor?.canExecute(toolName) &&
              result &&
              typeof result === "object" &&
              "result" in result
                ? (result as { result: unknown }).result
                : result;
            if (shouldLogCredentialInjection) {
              logInfo(
                "credential_inject_cleanup",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name,
                },
                "Scoped credential header injection completed",
              );
            }

            const durationMs = Date.now() - toolStartedAt;
            const structuredToolResult = isStructuredToolExecutionResult(
              resultDetails,
            )
              ? resultDetails
              : undefined;
            const toolResultAttribute = serializeGenAiAttribute(
              structuredToolResult?.details ?? resultDetails,
            );
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "success",
              ...(toolResultAttribute
                ? { "gen_ai.tool.call.result": toolResultAttribute }
                : {}),
            });
            setSpanStatus("ok");
            await onStatus?.(
              `${formatToolResultStatusWithInput(toolName, parsed)}...`,
            );
            if (structuredToolResult) {
              return structuredToolResult;
            }
            return {
              content: [
                { type: "text", text: toToolContentText(resultDetails) },
              ],
              details: resultDetails,
            };
          } catch (error) {
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "error",
              "error.type":
                error instanceof Error ? error.name : "tool_execution_error",
            });
            setSpanStatus("error");
            if (shouldTrace) {
              logWarn(
                "agent_tool_call_failed",
                traceToolContext,
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "execute_tool",
                  "gen_ai.tool.name": toolName,
                  ...(normalizedToolCallId
                    ? { "gen_ai.tool.call.id": normalizedToolCallId }
                    : {}),
                  "app.ai.tool_duration_ms": durationMs,
                  "app.ai.tool_outcome": "error",
                  "error.type":
                    error instanceof Error
                      ? error.name
                      : "tool_execution_error",
                  "error.message":
                    error instanceof Error ? error.message : String(error),
                },
                "Agent tool call failed",
              );
            }
            logException(
              error,
              "agent_tool_call_failed",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId
                  ? { "gen_ai.tool.call.id": normalizedToolCallId }
                  : {}),
                "app.ai.tool_duration_ms": durationMs,
                ...getToolErrorAttributes(error),
              },
              "Agent tool call failed",
            );
            throw error;
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          ...(normalizedToolCallId
            ? { "gen_ai.tool.call.id": normalizedToolCallId }
            : {}),
          ...(toolArgumentsAttribute
            ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute }
            : {}),
        },
      );
    },
  }));
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {},
): Promise<AssistantReply> {
  let timeoutResumeConversationId: string | undefined;
  let timeoutResumeSessionId: string | undefined;
  let timeoutResumeSliceId = 1;
  let timeoutResumeMessages: unknown[] = [];
  let lastKnownSandboxId: string | undefined = context.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    context.sandbox?.sandboxDependencyProfileHash;
  let loadedSkillNamesForResume: string[] = [];
  let mcpToolManager: McpToolManager | undefined;
  let pendingMcpAuthorizationPause: McpAuthorizationPauseError | undefined;

  try {
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: ObservabilityContext = {
      conversationId:
        context.correlation?.conversationId ??
        context.correlation?.threadId ??
        context.correlation?.runId,
      turnId: context.correlation?.turnId,
      agentId: context.correlation?.turnId,
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId,
    };

    const availableSkills = await discoverSkills({
      additionalRoots: context.skillDirs,
    });
    if (!startupDiscoveryLogged) {
      startupDiscoveryLogged = true;
      const plugins = getPluginProviders();
      const roots = [
        ...new Set(availableSkills.map((skill) => skill.skillPath)),
      ].sort();
      logInfo(
        "startup_discovery_summary",
        spanContext,
        {
          "app.skill.count": availableSkills.length,
          "app.skill.names": availableSkills.map((skill) => skill.name).sort(),
          "file.directories": roots,
          "app.plugin.count": plugins.length,
          "app.plugin.names": plugins
            .map((plugin) => plugin.manifest.name)
            .sort(),
        },
        "Discovered startup SOUL/skills/plugins",
      );
    }
    const configurationValues: Record<string, unknown> = {
      ...(context.configuration ?? {}),
    };
    const userInput = messageText;
    if (shouldTrace) {
      logInfo(
        "agent_message_in",
        spanContext,
        {
          "app.message.kind": "user_inbound",
          "app.message.length": userInput.length,
          "app.message.input": summarizeMessageText(userInput),
          "app.message.attachment_count": context.userAttachments?.length ?? 0,
          "messaging.message.id": context.correlation?.messageTs ?? "",
        },
        "Agent message received",
      );
    }
    const skillInvocation = parseSkillInvocation(userInput, availableSkills);
    const invokedSkill = skillInvocation
      ? findSkillByName(skillInvocation.skillName, availableSkills)
      : null;
    const activeSkills: Skill[] = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);
    const { conversationId: sessionConversationId, sessionId } =
      getSessionIdentifiers(context);
    const canUseTurnSession = Boolean(sessionConversationId && sessionId);
    timeoutResumeConversationId = sessionConversationId;
    timeoutResumeSessionId = sessionId;
    const existingTurnCheckpoint =
      canUseTurnSession && sessionConversationId && sessionId
        ? await getAgentTurnSessionCheckpoint(sessionConversationId, sessionId)
        : undefined;
    const hasAwaitingResumeCheckpoint = Boolean(
      existingTurnCheckpoint &&
      existingTurnCheckpoint.state === "awaiting_resume" &&
      existingTurnCheckpoint.piMessages.length > 0,
    );
    const resumedFromCheckpoint = hasAwaitingResumeCheckpoint;
    const currentSliceId = hasAwaitingResumeCheckpoint
      ? existingTurnCheckpoint!.sliceId
      : 1;
    timeoutResumeSliceId = currentSliceId;
    const capabilityRuntime = createSkillCapabilityRuntime({
      invocationArgs: skillInvocation?.args,
      requesterId: context.requester?.userId,
      resolveConfiguration: async (key) => configurationValues[key],
    });
    const sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      sandboxDependencyProfileHash:
        context.sandbox?.sandboxDependencyProfileHash,
      traceContext: spanContext,
      onStatus: context.onStatus,
      runBashCustomCommand: async (command) => {
        const result = await maybeExecuteJrRpcCustomCommand(command, {
          capabilityRuntime,
          activeSkill: skillSandbox.getActiveSkill(),
          channelConfiguration: context.channelConfiguration,
          requesterId: context.requester?.userId,
          channelId: context.correlation?.channelId,
          threadTs: context.correlation?.threadTs,
          userMessage: userInput,
          userTokenStore: getUserTokenStore(),
          onConfigurationValueChanged: (key, value) => {
            if (value === undefined) {
              delete configurationValues[key];
              return;
            }
            configurationValues[key] = value;
          },
        });
        return result.handled
          ? { handled: true, result: result.result }
          : { handled: false };
      },
    });
    lastKnownSandboxId = sandboxExecutor.getSandboxId();
    lastKnownSandboxDependencyProfileHash =
      sandboxExecutor.getDependencyProfileHash();
    sandboxExecutor.configureSkills(availableSkills);
    const sandbox = await sandboxExecutor.createSandbox();

    for (const skillName of existingTurnCheckpoint?.loadedSkillNames ?? []) {
      const preloaded = await skillSandbox.loadSkill(skillName);
      if (preloaded) {
        upsertActiveSkill(activeSkills, preloaded);
      }
    }

    if (invokedSkill) {
      const preloaded = await skillSandbox.loadSkill(invokedSkill.name);
      if (preloaded) {
        upsertActiveSkill(activeSkills, preloaded);
      }
    }

    const userTurnText = buildUserTurnText(
      userInput,
      context.conversationContext,
    );

    if (!getGatewayApiKey()) {
      const providerError =
        "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)";
      return {
        text: `Error: ${providerError}`,
        sandboxId: sandboxExecutor.getSandboxId(),
        sandboxDependencyProfileHash:
          sandboxExecutor.getDependencyProfileHash(),
        diagnostics: {
          outcome: "provider_error",
          modelId: botConfig.modelId,
          assistantMessageCount: 0,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: false,
          errorMessage: providerError,
        },
      };
    }

    timeoutResumeMessages = [];
    pendingMcpAuthorizationPause = undefined;
    const generatedFiles: FileUpload[] = [];
    const replyFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    const mcpAuthSessionIdsByProvider = new Map<string, string>();
    let agent: Agent | undefined;

    mcpToolManager = new McpToolManager(getPluginMcpProviders(), {
      authProviderFactory: async (plugin) => {
        if (
          !sessionConversationId ||
          !sessionId ||
          !context.requester?.userId
        ) {
          return undefined;
        }

        const provider = await createMcpOAuthClientProvider({
          provider: plugin.manifest.name,
          conversationId: sessionConversationId,
          sessionId,
          userId: context.requester.userId,
          userMessage: userInput,
          ...(context.correlation?.channelId
            ? { channelId: context.correlation.channelId }
            : {}),
          ...(context.correlation?.threadTs
            ? { threadTs: context.correlation.threadTs }
            : {}),
          ...(context.toolChannelId
            ? { toolChannelId: context.toolChannelId }
            : {}),
          configuration: configurationValues,
          artifactState: context.artifactState,
        });
        mcpAuthSessionIdsByProvider.set(
          plugin.manifest.name,
          provider.authSessionId,
        );
        return provider;
      },
      onAuthorizationRequired: async (provider) => {
        if (pendingMcpAuthorizationPause) {
          return true;
        }

        const authSessionId = mcpAuthSessionIdsByProvider.get(provider);
        if (!authSessionId || !context.requester?.userId) {
          throw new Error(
            `Missing MCP auth session context for plugin "${provider}"`,
          );
        }

        const latestArtifactState = mergeArtifactsState(
          context.artifactState ?? {},
          artifactStatePatch,
        );
        await patchMcpAuthSession(authSessionId, {
          configuration: { ...configurationValues },
          artifactState: latestArtifactState,
          toolChannelId:
            context.toolChannelId ??
            latestArtifactState.assistantContextChannelId ??
            context.correlation?.channelId,
        });

        const authSession = await getMcpAuthSession(authSessionId);
        if (!authSession?.authorizationUrl) {
          throw new Error(
            `Missing MCP authorization URL for plugin "${provider}"`,
          );
        }

        const delivery = await deliverPrivateMessage({
          channelId: authSession.channelId,
          threadTs: authSession.threadTs,
          userId: authSession.userId,
          text: `<${authSession.authorizationUrl}|Click here to link your ${formatProviderLabel(provider)} MCP access>. Once you've authorized, this thread will continue automatically.`,
        });
        if (!delivery) {
          throw new Error(
            `Unable to deliver MCP authorization link for plugin "${provider}"`,
          );
        }

        pendingMcpAuthorizationPause = new McpAuthorizationPauseError(provider);
        agent?.abort();
        return true;
      },
    });
    const turnMcpToolManager = mcpToolManager;
    const syncResumeState = () => {
      loadedSkillNamesForResume = activeSkills.map((skill) => skill.name);
    };

    setTags({
      conversationId: spanContext.conversationId,
      turnId: spanContext.turnId,
      agentId: spanContext.agentId,
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId,
    });

    const tools = createTools(
      availableSkills,
      {
        getGeneratedFile: (filename) =>
          generatedFiles.find((file) => file.filename === filename),
        onGeneratedArtifactFiles: (files) => {
          generatedFiles.push(...files);
        },
        onGeneratedFiles: (files) => {
          replyFiles.push(...files);
        },
        onArtifactStatePatch: (patch) => {
          Object.assign(artifactStatePatch, patch);
        },
        onToolCallStart: async (toolName, input) => {
          await context.onStatus?.(
            `${formatToolStatusWithInput(toolName, input)}...`,
          );
        },
        onToolCallEnd: async (toolName, input) => {
          await context.onStatus?.(
            `${formatToolResultStatusWithInput(toolName, input)}...`,
          );
        },
        toolOverrides: context.toolOverrides,
        onSkillLoaded: async (loadedSkill) => {
          const resolvedSkill = await skillSandbox.loadSkill(loadedSkill.name);
          const effective = resolvedSkill ?? loadedSkill;
          upsertActiveSkill(activeSkills, effective);
          syncResumeState();
          await turnMcpToolManager.activateForSkill(effective);
          syncResumeState();
          if (pendingMcpAuthorizationPause) {
            // Pi turns thrown tool errors into toolResult isError frames. Once
            // auth pause has been requested, stop here and let the aborted turn
            // park cleanly instead of surfacing a fake loadSkill failure.
            return undefined;
          }
          if (!effective.pluginProvider) {
            return undefined;
          }

          return {
            available_tools: turnMcpToolManager
              .getActiveToolCatalog(activeSkills, {
                provider: effective.pluginProvider,
              })
              .map(toExposedToolSummary),
            tool_search_available: true,
          };
        },
      },
      {
        channelId: context.toolChannelId ?? context.correlation?.channelId,
        messageTs: context.correlation?.messageTs,
        threadTs: context.correlation?.threadTs,
        userText: userInput,
        artifactState: context.artifactState,
        configuration: configurationValues,
        getActiveSkills: () => activeSkills,
        mcpToolManager: turnMcpToolManager,
        sandbox,
      },
    );

    syncResumeState();
    for (const skill of activeSkills) {
      await turnMcpToolManager.activateForSkill(skill);
      syncResumeState();
      if (pendingMcpAuthorizationPause) {
        timeoutResumeMessages = existingTurnCheckpoint?.piMessages ?? [];
        throw pendingMcpAuthorizationPause;
      }
    }
    syncResumeState();

    const activeToolSummaries = turnMcpToolManager
      .getActiveToolCatalog(activeSkills)
      .map(toExposedToolSummary);
    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      activeTools: activeToolSummaries,
      invocation: skillInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState,
      configuration: configurationValues,
      relevantConfigurationKeys: collectRelevantConfigurationKeys(
        activeSkills,
        invokedSkill,
      ),
      runtimeMetadata: getRuntimeMetadata(),
    });

    const userContentParts: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: userTurnText }];

    for (const attachment of context.userAttachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) {
        userContentParts.push({
          type: "image",
          data: attachment.data.toString("base64"),
          mimeType: attachment.mediaType,
        });
      } else {
        userContentParts.push({
          type: "text",
          text: encodeNonImageAttachmentForPrompt(attachment),
        });
      }
    }

    const inputMessagesAttribute = serializeGenAiAttribute([
      {
        role: "system",
        content: [{ type: "text", text: baseInstructions }],
      },
      {
        role: "user",
        content: userContentParts.map((part) => toObservablePromptPart(part)),
      },
    ]);

    const baseAgentTools = createAgentTools(
      tools as Record<string, ToolDefinition<any>>,
      skillSandbox,
      spanContext,
      context.onStatus,
      sandboxExecutor,
      capabilityRuntime,
      {
        onToolCall: (toolName) => {
          toolCalls.push(toolName);
        },
      },
    );

    agent = new Agent({
      getApiKey: () => getGatewayApiKey(),
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: baseAgentTools,
      },
    });
    let hasEmittedText = false;
    let needsSeparator = false;

    const unsubscribe = agent.subscribe((event) => {
      // Track message boundaries so text from consecutive assistant messages
      // is separated by "\n\n", matching final Slack formatting.
      if (event.type === "message_start") {
        if (hasEmittedText) {
          needsSeparator = true;
        }
        return;
      }

      if (event.type !== "message_update") {
        return;
      }

      if (event.assistantMessageEvent.type !== "text_delta") {
        return;
      }

      const deltaText = event.assistantMessageEvent.delta;
      if (!deltaText) {
        return;
      }

      const text = needsSeparator ? "\n\n" + deltaText : deltaText;
      needsSeparator = false;
      hasEmittedText = true;

      Promise.resolve(context.onTextDelta?.(text)).catch((error) => {
        logWarn(
          "streaming_text_delta_error",
          {},
          {
            "error.message":
              error instanceof Error ? error.message : String(error),
          },
          "Failed to deliver text delta to stream",
        );
      });
    });

    let beforeMessageCount = agent.state.messages.length;
    let newMessages: unknown[] = [];

    try {
      if (resumedFromCheckpoint) {
        const didReplace = await maybeReplaceAgentMessages(
          agent,
          existingTurnCheckpoint!.piMessages,
        );
        if (!didReplace) {
          throw new Error(
            "Agent session resume requested but replaceMessages is unavailable",
          );
        }
      }
      beforeMessageCount = agent.state.messages.length;

      await withSpan(
        "ai.generate_assistant_reply",
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult: unknown;
          const promptPromise = resumedFromCheckpoint
            ? runAgentContinuation(agent)
            : agent.prompt({
                role: "user",
                content: userContentParts,
                timestamp: Date.now(),
              });

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let didTimeout = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              didTimeout = true;
              agent.abort();
              reject(new AgentTurnTimeoutError(botConfig.turnTimeoutMs));
            }, botConfig.turnTimeoutMs);
          });

          try {
            promptResult = await Promise.race([promptPromise, timeoutPromise]);
          } catch (error) {
            if (didTimeout) {
              logWarn(
                "agent_turn_timeout",
                {},
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.request.model": botConfig.modelId,
                  "app.ai.turn_timeout_ms": botConfig.turnTimeoutMs,
                },
                "Agent turn timed out and was aborted",
              );
              // The timeout branch wins the race via timeoutPromise, so the
              // agent loop may still be settling its final message state. Wait
              // for promptPromise before snapshotting messages for resume.
              await promptPromise.catch(() => {});
              timeoutResumeMessages = [...(agent.state.messages as unknown[])];
            }
            if (pendingMcpAuthorizationPause) {
              // For non-timeout failures, pi-agent-core only settles
              // promptPromise after it has finished mutating agent.state.
              // By the time we get here, the prompt already settled, so the
              // current message snapshot is final for auth-pause checkpointing.
              timeoutResumeMessages = [...(agent.state.messages as unknown[])];
              throw pendingMcpAuthorizationPause;
            }
            throw error;
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }

          newMessages = agent.state.messages.slice(
            beforeMessageCount,
          ) as unknown[];
          if (pendingMcpAuthorizationPause) {
            timeoutResumeMessages = [...(agent.state.messages as unknown[])];
            throw pendingMcpAuthorizationPause;
          }
          const outputMessages = newMessages.filter(isAssistantMessage);
          const outputMessagesAttribute =
            serializeGenAiAttribute(outputMessages);
          const usageAttributes = extractGenAiUsageAttributes(
            promptResult,
            agent.state,
            ...outputMessages,
          );
          setSpanAttributes({
            ...(outputMessagesAttribute
              ? { "gen_ai.output.messages": outputMessagesAttribute }
              : {}),
            ...usageAttributes,
          });
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": botConfig.modelId,
          ...(inputMessagesAttribute
            ? { "gen_ai.input.messages": inputMessagesAttribute }
            : {}),
        },
      );
    } finally {
      unsubscribe();
    }

    if (pendingMcpAuthorizationPause) {
      throw pendingMcpAuthorizationPause;
    }

    if (canUseTurnSession && sessionConversationId && sessionId) {
      await upsertAgentTurnSessionCheckpoint({
        conversationId: sessionConversationId,
        sessionId,
        sliceId: currentSliceId,
        state: "completed",
        piMessages: agent.state.messages as unknown[],
        loadedSkillNames: activeSkills.map((skill) => skill.name),
      });
    }

    const toolResults = newMessages.filter(isToolResultMessage);

    const assistantMessages = newMessages.filter(isAssistantMessage);

    const primaryText = assistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n\n")
      .trim();

    const toolErrorCount = toolResults.filter(
      (result) => result.isError,
    ).length;
    const explicitChannelPostIntent = isExplicitChannelPostIntent(userInput);
    const successfulToolNames = new Set(
      toolResults
        .filter((result) => !isToolResultError(result))
        .map((result) => normalizeToolNameFromResult(result))
        .filter((value): value is string => Boolean(value)),
    );
    const channelPostPerformed = successfulToolNames.has(
      "slackChannelPostMessage",
    );
    const reactionPerformed = successfulToolNames.has(
      "slackMessageAddReaction",
    );
    const deliveryPlan = buildReplyDeliveryPlan({
      explicitChannelPostIntent,
      channelPostPerformed,
      reactionPerformed,
      hasFiles: replyFiles.length > 0,
      streamingThreadReply: Boolean(context.onTextDelta),
    });
    const deliveryMode: "thread" | "channel_only" = deliveryPlan.mode;
    const ackStrategy: "none" | "reaction" = deliveryPlan.ack;

    if (!primaryText) {
      logWarn(
        "ai_model_response_empty",
        {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          runId: context.correlation?.runId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId,
        },
        {
          "app.ai.tool_results": toolResults.length,
          "app.ai.tool_error_results": toolErrorCount,
          "app.ai.generated_files": generatedFiles.length,
        },
        "Model returned empty text response",
      );
    }

    const lastAssistant = assistantMessages.at(-1) as
      | { stopReason?: unknown; errorMessage?: unknown }
      | undefined;
    const stopReason =
      typeof lastAssistant?.stopReason === "string"
        ? lastAssistant.stopReason
        : undefined;
    const errorMessage =
      typeof lastAssistant?.errorMessage === "string"
        ? lastAssistant.errorMessage
        : undefined;
    const usedPrimaryText = Boolean(primaryText);
    const outcome: AgentTurnDiagnostics["outcome"] = primaryText
      ? stopReason === "error"
        ? "provider_error"
        : "success"
      : "execution_failure";

    const candidateText =
      primaryText || buildExecutionFailureMessage(toolErrorCount);
    const escapedOrRawPayload =
      isExecutionEscapeResponse(candidateText) ||
      isRawToolPayloadResponse(candidateText);
    const resolvedText = escapedOrRawPayload
      ? buildExecutionFailureMessage(toolErrorCount)
      : enforceAttachmentClaimTruth(candidateText, replyFiles.length > 0);
    const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
      ? "execution_failure"
      : outcome;
    if (shouldTrace) {
      logInfo(
        "agent_message_out",
        spanContext,
        {
          "app.message.kind": "assistant_outbound",
          "app.message.length": resolvedText.length,
          "app.message.output": summarizeMessageText(resolvedText),
          "app.ai.outcome": resolvedOutcome,
          "app.ai.assistant_messages": assistantMessages.length,
          ...(stopReason ? { "app.ai.stop_reason": stopReason } : {}),
        },
        "Agent message sent",
      );
    }
    if (escapedOrRawPayload) {
      return {
        text: resolvedText,
        files: replyFiles.length > 0 ? replyFiles : undefined,
        artifactStatePatch:
          Object.keys(artifactStatePatch).length > 0
            ? artifactStatePatch
            : undefined,
        deliveryPlan,
        deliveryMode,
        ackStrategy,
        sandboxId: sandboxExecutor.getSandboxId(),
        sandboxDependencyProfileHash:
          sandboxExecutor.getDependencyProfileHash(),
        diagnostics: {
          outcome: "execution_failure",
          modelId: botConfig.modelId,
          assistantMessageCount: assistantMessages.length,
          toolCalls,
          toolResultCount: toolResults.length,
          toolErrorCount,
          usedPrimaryText,
          stopReason,
          errorMessage,
          providerError: undefined,
        },
      };
    }

    return {
      text: resolvedText,
      files: replyFiles.length > 0 ? replyFiles : undefined,
      artifactStatePatch:
        Object.keys(artifactStatePatch).length > 0
          ? artifactStatePatch
          : undefined,
      deliveryPlan,
      deliveryMode,
      ackStrategy,
      sandboxId: sandboxExecutor.getSandboxId(),
      sandboxDependencyProfileHash: sandboxExecutor.getDependencyProfileHash(),
      diagnostics: {
        outcome,
        modelId: botConfig.modelId,
        assistantMessageCount: assistantMessages.length,
        toolCalls,
        toolResultCount: toolResults.length,
        toolErrorCount,
        usedPrimaryText,
        stopReason,
        errorMessage,
        providerError: undefined,
      },
    };
  } catch (error) {
    if (
      error instanceof McpAuthorizationPauseError &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      const nextSliceId = timeoutResumeSliceId + 1;
      const piMessages = trimTrailingAssistantMessages(timeoutResumeMessages);
      try {
        await upsertAgentTurnSessionCheckpoint({
          conversationId: timeoutResumeConversationId,
          sessionId: timeoutResumeSessionId,
          sliceId: nextSliceId,
          state: "awaiting_resume",
          piMessages,
          loadedSkillNames: loadedSkillNamesForResume,
          resumeReason: "auth",
          resumedFromSliceId: timeoutResumeSliceId,
          errorMessage: error.message,
        });
      } catch (checkpointError) {
        logException(
          checkpointError,
          "agent_turn_auth_resume_checkpoint_failed",
          {
            slackThreadId: context.correlation?.threadId,
            slackUserId: context.correlation?.requesterId,
            slackChannelId: context.correlation?.channelId,
            runId: context.correlation?.runId,
            assistantUserName: context.assistant?.userName,
            modelId: botConfig.modelId,
          },
          {
            "app.ai.resume_conversation_id": timeoutResumeConversationId,
            "app.ai.resume_session_id": timeoutResumeSessionId,
            "app.ai.resume_from_slice_id": timeoutResumeSliceId,
            "app.ai.resume_next_slice_id": nextSliceId,
          },
          "Failed to persist auth checkpoint before retry",
        );
      }
      throw new RetryableTurnError(
        "mcp_auth_resume",
        `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${nextSliceId}`,
      );
    }

    if (
      error instanceof AgentTurnTimeoutError &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      const nextSliceId = timeoutResumeSliceId + 1;
      logException(
        error,
        "agent_turn_timeout_resume_triggered",
        {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          runId: context.correlation?.runId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId,
        },
        {
          "app.ai.turn_timeout_ms": error.timeoutMs,
          "app.ai.resume_conversation_id": timeoutResumeConversationId,
          "app.ai.resume_session_id": timeoutResumeSessionId,
          "app.ai.resume_from_slice_id": timeoutResumeSliceId,
          "app.ai.resume_next_slice_id": nextSliceId,
        },
        "Agent turn timed out and will be resumed",
      );
      try {
        const latestCheckpoint = await getAgentTurnSessionCheckpoint(
          timeoutResumeConversationId,
          timeoutResumeSessionId,
        );
        const piMessages =
          timeoutResumeMessages.length > 0
            ? timeoutResumeMessages
            : (latestCheckpoint?.piMessages ?? []);
        await upsertAgentTurnSessionCheckpoint({
          conversationId: timeoutResumeConversationId,
          sessionId: timeoutResumeSessionId,
          sliceId: nextSliceId,
          state: "awaiting_resume",
          piMessages,
          loadedSkillNames: loadedSkillNamesForResume,
          resumeReason: "timeout",
          resumedFromSliceId: timeoutResumeSliceId,
          errorMessage: error.message,
        });
      } catch (checkpointError) {
        logException(
          checkpointError,
          "agent_turn_timeout_resume_checkpoint_failed",
          {
            slackThreadId: context.correlation?.threadId,
            slackUserId: context.correlation?.requesterId,
            slackChannelId: context.correlation?.channelId,
            runId: context.correlation?.runId,
            assistantUserName: context.assistant?.userName,
            modelId: botConfig.modelId,
          },
          {
            "app.ai.resume_conversation_id": timeoutResumeConversationId,
            "app.ai.resume_session_id": timeoutResumeSessionId,
            "app.ai.resume_from_slice_id": timeoutResumeSliceId,
            "app.ai.resume_next_slice_id": nextSliceId,
          },
          "Failed to persist timeout checkpoint before retry",
        );
      }
      throw new RetryableTurnError(
        "agent_turn_timeout_resume",
        `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${nextSliceId}`,
      );
    }

    if (isRetryableTurnError(error)) {
      throw error;
    }

    logException(
      error,
      "assistant_reply_generation_failed",
      {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        runId: context.correlation?.runId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId,
      },
      {},
      "generateAssistantReply failed",
    );

    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error: ${message}`,
      sandboxId: lastKnownSandboxId,
      sandboxDependencyProfileHash: lastKnownSandboxDependencyProfileHash,
      diagnostics: {
        outcome: "provider_error",
        modelId: botConfig.modelId,
        assistantMessageCount: 0,
        toolCalls: [],
        toolResultCount: 0,
        toolErrorCount: 0,
        usedPrimaryText: false,
        errorMessage: message,
        providerError: error,
      },
    };
  } finally {
    try {
      await mcpToolManager?.close();
    } catch (closeError) {
      logWarn(
        "mcp_tool_manager_close_failed",
        {},
        {
          "error.message":
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
        "Failed to close MCP tool manager",
      );
    }
  }
}
