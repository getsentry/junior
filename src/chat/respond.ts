import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { extractGenAiUsageAttributes, serializeGenAiAttribute } from "@/chat/gen-ai-attributes";
import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  setTags,
  withSpan,
  type ObservabilityContext
} from "@/chat/observability";
import { buildSystemPrompt } from "@/chat/prompt";
import { createSkillCapabilityRuntime, getUserTokenStore } from "@/chat/capabilities/factory";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { isExplicitChannelPostIntent } from "@/chat/channel-intent";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { buildReplyDeliveryPlan, type ReplyDeliveryPlan } from "@/chat/delivery/plan";
import { SkillSandbox } from "@/chat/skill-sandbox";
import { discoverSkills, findSkillByName, parseSkillInvocation, type Skill } from "@/chat/skills";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import { GEN_AI_PROVIDER_NAME, getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { createSandboxExecutor, type SandboxExecutor } from "@/chat/sandbox/sandbox";
import {
  compactStatusFilename,
  compactStatusPath,
  compactStatusText,
  extractStatusUrlDomain
} from "@/chat/status-format";

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
    threadId?: string;
    workflowRunId?: string;
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

const AGENT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;

function isExecutionDeferralResponse(text: string): boolean {
  return /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
    text
  );
}

function isToolAccessDisclaimerResponse(text: string): boolean {
  return /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
    text
  );
}

function isExecutionEscapeResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return isExecutionDeferralResponse(trimmed) || isToolAccessDisclaimerResponse(trimmed);
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
  if (type === "tool_use" || type === "tool_call" || type === "tool_result" || type === "tool_error") return true;

  const hasToolName = typeof record.toolName === "string" || typeof record.name === "string";
  const hasToolInput =
    Object.prototype.hasOwnProperty.call(record, "input") || Object.prototype.hasOwnProperty.call(record, "args");
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
    bash: "Running shell command in sandbox",
    readFile: "Reading file in sandbox",
    writeFile: "Writing file in sandbox",
    webSearch: "Searching public sources",
    webFetch: "Reading source pages",
    slackChannelPostMessage: "Posting message to channel",
    slackMessageAddReaction: "Adding emoji reaction",
    slackChannelListMembers: "Listing channel members",
    slackChannelListMessages: "Listing channel messages",
    slackCanvasCreate: "Creating detailed brief",
    slackCanvasUpdate: "Updating detailed brief",
    slackListCreate: "Creating tracking list",
    slackListAddItems: "Updating tracking list",
    slackListUpdateItem: "Updating tracking list",
    imageGenerate: "Generating image"
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Running ${readable}` : "Running tool";
}

function formatToolStatusWithInput(toolName: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const path = obj ? compactStatusPath(obj.path) : undefined;
  const filename = obj ? compactStatusFilename(obj.path) : undefined;
  const query = obj ? compactStatusText(obj.query, 70) : undefined;
  const domain = obj ? extractStatusUrlDomain(obj.url) : undefined;
  const skillName = obj ? compactStatusText(obj.skill_name ?? obj.skillName, 40) : undefined;

  if (filename && toolName === "readFile") {
    return `Reading file ${filename}`;
  }
  if (path && toolName === "writeFile") {
    return `Writing file ${path}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loading skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Searching web for "${query}"`;
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
    bash: "Analyzing command output",
    readFile: "Analyzing file contents",
    writeFile: "Saving file update",
    webSearch: "Reviewing search results",
    webFetch: "Reviewing page content",
    slackChannelPostMessage: "Posted message to channel",
    slackMessageAddReaction: "Added emoji reaction",
    slackChannelListMembers: "Reviewed channel members",
    slackChannelListMessages: "Reviewed channel messages",
    slackCanvasCreate: "Preparing canvas response",
    slackCanvasUpdate: "Preparing canvas update",
    slackListCreate: "Preparing list update",
    slackListAddItems: "Preparing list update",
    slackListUpdateItem: "Preparing list update",
    imageGenerate: "Preparing generated image"
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Reviewing ${readable} result` : "Reviewing tool result";
}

function formatToolResultStatusWithInput(toolName: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const path = obj ? compactStatusPath(obj.path) : undefined;
  const filename = obj ? compactStatusFilename(obj.path) : undefined;
  const query = obj ? compactStatusText(obj.query, 70) : undefined;
  const domain = obj ? extractStatusUrlDomain(obj.url) : undefined;
  const skillName = obj ? compactStatusText(obj.skill_name ?? obj.skillName, 40) : undefined;

  if (filename && toolName === "readFile") {
    return `Reviewed file ${filename}`;
  }
  if (path && toolName === "writeFile") {
    return `Saved file ${path}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loaded skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Reviewed web results for "${query}"`;
  }
  if (domain && toolName === "webFetch") {
    return `Reviewed page from ${domain}`;
  }
  return formatToolResultStatus(toolName);
}

function toObservablePromptPart(
  part: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
): Record<string, unknown> {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text
    };
  }

  return {
    type: "image",
    mimeType: part.mimeType,
    data: `[omitted:${part.data.length}]`
  };
}

function buildUserTurnText(userInput: string, conversationContext?: string): string {
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
    "</thread-conversation-context>"
  ].join("\n");
}

function encodeNonImageAttachmentForPrompt(attachment: {
  data: Buffer;
  mediaType: string;
  filename?: string;
}): string {
  const base64 = attachment.data.toString("base64");
  const wasTruncated = base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS;
  const encodedPayload = wasTruncated ? `${base64.slice(0, MAX_INLINE_ATTACHMENT_BASE64_CHARS)}...` : base64;

  return [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
    "encoding: base64",
    `truncated: ${wasTruncated ? "true" : "false"}`,
    "<data_base64>",
    encodedPayload,
    "</data_base64>",
    "</attachment>"
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

function isToolResultMessage(value: unknown): value is ToolResultMessage<any> {
  return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "toolResult";
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
  return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "assistant";
}

function extractAssistantText(message: AssistantMessage): string {
  const content = (message as { content?: Array<{ type?: unknown; text?: unknown }> }).content ?? [];
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function collectRelevantConfigurationKeys(
  activeSkills: Array<{ usesConfig?: string[] }>,
  explicitSkill?: { usesConfig?: string[] } | null
): string[] {
  const keys = new Set<string>();
  for (const skill of [...activeSkills, ...(explicitSkill ? [explicitSkill] : [])]) {
    for (const key of skill.usesConfig ?? []) {
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  spanContext: ObservabilityContext,
  onStatus?: (status: string) => void | Promise<void>,
  sandboxExecutor?: SandboxExecutor,
  capabilityRuntime?: SkillCapabilityRuntime,
  hooks?: {
    onGeneratedFiles?: (files: FileUpload[]) => void;
    onArtifactStatePatch?: (patch: Partial<ThreadArtifactsState>) => void;
    onToolCall?: (toolName: string) => void;
  }
): AgentTool[] {
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    execute: async (toolCallId: unknown, params: unknown) => {
      const normalizedToolCallId = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
      const toolArgumentsAttribute = serializeGenAiAttribute(params);
      hooks?.onToolCall?.(toolName);
      const toolStartedAt = Date.now();
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
            const validationMessage = details.length > 0 ? details : "Invalid tool input";
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "error.type": "tool_input_validation_error"
            });
            setSpanStatus("error");
            logWarn(
              "agent_tool_call_invalid_input",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {}),
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call input validation failed"
            );
            logException(
              new Error(validationMessage),
              "agent_tool_call_invalid_input_exception",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {}),
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call input validation failed with exception"
            );
            throw new Error(validationMessage);
          }
          const parsed = params as Record<string, unknown>;

          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails = { ok: true };
              const durationMs = Date.now() - toolStartedAt;
              const toolResultAttribute = serializeGenAiAttribute(resultDetails);
              setSpanAttributes({
                "app.ai.tool_duration_ms": durationMs,
                "app.ai.tool_outcome": "success",
                ...(toolResultAttribute ? { "gen_ai.tool.call.result": toolResultAttribute } : {})
              });
              setSpanStatus("ok");
              await onStatus?.(`${formatToolResultStatusWithInput(toolName, parsed)}...`);
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails
              };
            }

            const injectedHeaders =
              toolName === "bash" ? capabilityRuntime?.getTurnHeaderTransforms() : undefined;
            const injectedEnv =
              toolName === "bash" ? capabilityRuntime?.getTurnEnv() : undefined;
            const bashCommand =
              toolName === "bash" && typeof parsed.command === "string" ? parsed.command.trim() : "";
            const isCustomBashCommand = toolName === "bash" && /^jr-rpc(?:\s|$)/.test(bashCommand);
            const shouldLogCredentialInjection =
              toolName === "bash" && !isCustomBashCommand && Boolean(injectedHeaders && injectedHeaders.length > 0);
            if (shouldLogCredentialInjection) {
              const headerDomains = (injectedHeaders ?? []).map((transform) => transform.domain);
              logInfo(
                "credential_inject_start",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name,
                  "app.credential.delivery": "header_transform",
                  "app.credential.header_domains": headerDomains
                },
                "Injecting scoped credential headers for sandbox command"
              );
            }

            const hasBashCredentials = injectedHeaders || injectedEnv;
            const result =
              sandboxExecutor?.canExecute(toolName)
                ? await sandboxExecutor.execute({
                    toolName,
                    input:
                      toolName === "bash" && hasBashCredentials
                        ? {
                            ...parsed,
                            ...(injectedHeaders ? { headerTransforms: injectedHeaders } : {}),
                            ...(injectedEnv ? { env: injectedEnv } : {})
                          }
                        : parsed
                  })
                : await toolDef.execute(parsed as never, {
                    experimental_context: sandbox
                  });
            const resultDetails =
              sandboxExecutor?.canExecute(toolName) && result && typeof result === "object" && "result" in result
                ? (result as { result: unknown }).result
                : result;
            if (shouldLogCredentialInjection) {
              logInfo(
                "credential_inject_cleanup",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name
                },
                "Scoped credential header injection completed"
              );
            }

            const durationMs = Date.now() - toolStartedAt;
            const toolResultAttribute = serializeGenAiAttribute(resultDetails);
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "success",
              ...(toolResultAttribute ? { "gen_ai.tool.call.result": toolResultAttribute } : {})
            });
            setSpanStatus("ok");
            await onStatus?.(`${formatToolResultStatusWithInput(toolName, parsed)}...`);
            return {
              content: [{ type: "text", text: toToolContentText(resultDetails) }],
              details: resultDetails
            };
          } catch (error) {
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "error",
              "error.type": error instanceof Error ? error.name : "tool_execution_error"
            });
            setSpanStatus("error");
            logException(
              error,
              "agent_tool_call_failed",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...(normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {}),
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call failed"
            );
            throw error;
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          ...(normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {}),
          ...(toolArgumentsAttribute ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute } : {})
        }
      );
    }
  }));
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const spanContext: ObservabilityContext = {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    };

    const availableSkills = await discoverSkills({ additionalRoots: context.skillDirs });
    const configurationValues: Record<string, unknown> = {
      ...(context.configuration ?? {})
    };
    const userInput = messageText;
    const explicitInvocation = parseSkillInvocation(userInput, availableSkills);
    const explicitSkill = explicitInvocation
      ? findSkillByName(explicitInvocation.skillName, availableSkills)
      : null;
    const activeSkills: Skill[] = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);
    const capabilityRuntime = createSkillCapabilityRuntime({
      invocationArgs: explicitInvocation?.args,
      requesterId: context.requester?.userId,
      resolveConfiguration: async (key) => configurationValues[key]
    });
    const sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      traceContext: spanContext,
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
          }
        });
        return result.handled
          ? { handled: true, result: result.result }
          : { handled: false };
      }
    });
    sandboxExecutor.configureSkills(availableSkills);
    const sandbox = await sandboxExecutor.createSandbox();

    if (explicitSkill) {
      const preloaded = await skillSandbox.loadSkill(explicitSkill.name);
      if (preloaded) {
        activeSkills.push(preloaded);
      }
    }

    const userTurnText = buildUserTurnText(userInput, context.conversationContext);

    if (!getGatewayApiKey()) {
      const providerError = "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)";
      return {
        text: `Error: ${providerError}`,
        sandboxId: sandboxExecutor.getSandboxId(),
        diagnostics: {
          outcome: "provider_error",
          modelId: botConfig.modelId,
          assistantMessageCount: 0,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: false,
          errorMessage: providerError
        }
      };
    }

    const generatedFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];

    setTags({
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    });

    const tools = createTools(
      availableSkills,
      {
        onGeneratedFiles: (files) => {
          generatedFiles.push(...files);
        },
        onArtifactStatePatch: (patch) => {
          Object.assign(artifactStatePatch, patch);
        },
        onToolCallStart: async (toolName, input) => {
          await context.onStatus?.(`${formatToolStatusWithInput(toolName, input)}...`);
        },
        onToolCallEnd: async (toolName, input) => {
          await context.onStatus?.(`${formatToolResultStatusWithInput(toolName, input)}...`);
        },
        onSkillLoaded: async (loadedSkill) => {
          const resolvedSkill = await skillSandbox.loadSkill(loadedSkill.name);
          const effective = resolvedSkill ?? loadedSkill;
          const existing = activeSkills.find((skill) => skill.name === effective.name);
          if (existing) {
            existing.body = effective.body;
            existing.description = effective.description;
            existing.skillPath = effective.skillPath;
            existing.allowedTools = effective.allowedTools;
            existing.requiresCapabilities = effective.requiresCapabilities;
            existing.usesConfig = effective.usesConfig;
            return;
          }
          activeSkills.push(effective);
        }
      },
      {
        channelId: context.toolChannelId ?? context.correlation?.channelId,
        messageTs: context.correlation?.messageTs,
        threadTs: context.correlation?.threadTs,
        userText: userInput,
        artifactState: context.artifactState,
        configuration: configurationValues,
        sandbox
      }
    );
    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: explicitInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState,
      configuration: configurationValues,
      relevantConfigurationKeys: collectRelevantConfigurationKeys(activeSkills, explicitSkill)
    });

    const userContentParts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: userTurnText }
    ];

    for (const attachment of context.userAttachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) {
        userContentParts.push({
          type: "image",
          data: attachment.data.toString("base64"),
          mimeType: attachment.mediaType
        });
      } else {
        userContentParts.push({
          type: "text",
          text: encodeNonImageAttachmentForPrompt(attachment)
        });
      }
    }

    const inputMessagesAttribute = serializeGenAiAttribute([
      {
        role: "system",
        content: [{ type: "text", text: baseInstructions }]
      },
      {
        role: "user",
        content: userContentParts.map((part) => toObservablePromptPart(part))
      }
    ]);

    const agent = new Agent({
      getApiKey: () => getGatewayApiKey(),
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: createAgentTools(
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
            onGeneratedFiles: (files) => generatedFiles.push(...files),
            onArtifactStatePatch: (patch) => Object.assign(artifactStatePatch, patch)
          }
        )
      }
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
          { "error.message": error instanceof Error ? error.message : String(error) },
          "Failed to deliver text delta to stream"
        );
      });
    });

    const beforeMessageCount = agent.state.messages.length;
    let newMessages: unknown[] = [];

    try {
      await withSpan(
        "ai.generate_assistant_reply",
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult: unknown;
          const promptPromise = agent.prompt({
            role: "user",
            content: userContentParts,
            timestamp: Date.now()
          });

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let didTimeout = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              didTimeout = true;
              agent.abort();
              reject(new Error(`Agent turn timed out after ${AGENT_TURN_TIMEOUT_MS}ms`));
            }, AGENT_TURN_TIMEOUT_MS);
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
                  "app.ai.turn_timeout_ms": AGENT_TURN_TIMEOUT_MS
                },
                "Agent turn timed out and was aborted"
              );
              await promptPromise.catch(() => {});
            }
            throw error;
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }

          newMessages = agent.state.messages.slice(beforeMessageCount) as unknown[];
          const outputMessages = newMessages.filter(isAssistantMessage);
          const outputMessagesAttribute = serializeGenAiAttribute(outputMessages);
          const usageAttributes = extractGenAiUsageAttributes(promptResult, agent.state, ...outputMessages);
          setSpanAttributes({
            ...(outputMessagesAttribute ? { "gen_ai.output.messages": outputMessagesAttribute } : {}),
            ...usageAttributes
          });
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": botConfig.modelId,
          ...(inputMessagesAttribute ? { "gen_ai.input.messages": inputMessagesAttribute } : {})
        }
      );
    } finally {
      unsubscribe();
    }

    const toolResults = newMessages.filter(isToolResultMessage);

    const assistantMessages = newMessages.filter(isAssistantMessage);

    const primaryText = assistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n\n")
      .trim();

    const toolErrorCount = toolResults.filter((result) => result.isError).length;
    const explicitChannelPostIntent = isExplicitChannelPostIntent(userInput);
    const successfulToolNames = new Set(
      toolResults
        .filter((result) => !isToolResultError(result))
        .map((result) => normalizeToolNameFromResult(result))
        .filter((value): value is string => Boolean(value))
    );
    const channelPostPerformed = successfulToolNames.has("slackChannelPostMessage");
    const reactionPerformed = successfulToolNames.has("slackMessageAddReaction");
    const deliveryPlan = buildReplyDeliveryPlan({
      explicitChannelPostIntent,
      channelPostPerformed,
      reactionPerformed,
      hasFiles: generatedFiles.length > 0,
      streamingThreadReply: Boolean(context.onTextDelta)
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
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        },
        {
          "app.ai.tool_results": toolResults.length,
          "app.ai.tool_error_results": toolErrorCount,
          "app.ai.generated_files": generatedFiles.length
        },
        "Model returned empty text response"
      );
    }

    const lastAssistant = assistantMessages.at(-1) as { stopReason?: unknown; errorMessage?: unknown } | undefined;
    const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : undefined;
    const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined;
    const usedPrimaryText = Boolean(primaryText);
    const outcome: AgentTurnDiagnostics["outcome"] =
      primaryText ? (stopReason === "error" ? "provider_error" : "success") : "execution_failure";

    const resolvedText = primaryText || buildExecutionFailureMessage(toolErrorCount);
    if (isExecutionEscapeResponse(resolvedText) || isRawToolPayloadResponse(resolvedText)) {
      return {
        text: buildExecutionFailureMessage(toolErrorCount),
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined,
        deliveryPlan,
        deliveryMode,
        ackStrategy,
        sandboxId: sandboxExecutor.getSandboxId(),
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
          providerError: undefined
        }
      };
    }

    return {
      text: resolvedText,
      files: generatedFiles.length > 0 ? generatedFiles : undefined,
      artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined,
      deliveryPlan,
      deliveryMode,
      ackStrategy,
      sandboxId: sandboxExecutor.getSandboxId(),
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
        providerError: undefined
      }
    };
  } catch (error) {
    logException(error, "assistant_reply_generation_failed", {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    }, {}, "generateAssistantReply failed");

    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error: ${message}`,
      sandboxId: undefined,
      diagnostics: {
        outcome: "provider_error",
        modelId: botConfig.modelId,
        assistantMessageCount: 0,
        toolCalls: [],
        toolResultCount: 0,
        toolErrorCount: 0,
        usedPrimaryText: false,
        errorMessage: message,
        providerError: error
      }
    };
  }
}
