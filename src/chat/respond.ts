import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logException, logWarn, setTags, withSpan } from "@/chat/observability";
import { buildSystemPrompt } from "@/chat/prompt";
import { SkillSandbox } from "@/chat/skill-sandbox";
import { discoverSkills, findSkillByName, parseSkillInvocation, type Skill } from "@/chat/skills";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { VercelSandboxToolExecutor } from "@/chat/sandbox/vercel";

export interface ReplyRequestContext {
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
    threadTs?: string;
    requesterId?: string;
  };
  conversationContext?: string;
  artifactState?: ThreadArtifactsState;
  userAttachments?: Array<{
    data: Buffer;
    mediaType: string;
    filename?: string;
  }>;
  sandbox?: {
    sandboxId?: string;
  };
  onStatus?: (status: string) => void | Promise<void>;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
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
  usedFinalAnswer: boolean;
  usedPrimaryText: boolean;
}

const AGENT_TURN_TIMEOUT_MS = 120_000;
const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;

function formatUnknownSkillMessage(requestedSkill: string, availableSkills: Array<{ name: string }>): string {
  const available = availableSkills.map((skill) => `/${skill.name}`).join(", ");
  return [
    `Unknown skill: /${requestedSkill}`,
    available ? `Available skills: ${available}` : "No skills are currently available."
  ].join("\n");
}

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
    load_skill: "Loading skill instructions",
    system_time: "Reading current system time",
    bash: "Running shell command in sandbox",
    web_search: "Searching public sources",
    web_fetch: "Reading source pages",
    slack_canvas_create: "Creating detailed brief",
    slack_canvas_update: "Updating detailed brief",
    slack_list_create: "Creating tracking list",
    slack_list_add_items: "Updating tracking list",
    slack_list_update_item: "Updating tracking list",
    image_generate: "Generating image",
    final_answer: "Drafting response"
  };

  if (known[toolName]) {
    return known[toolName];
  }

  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Running ${readable}` : "Running tool";
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

function finalAnswerFromToolDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const answer = (details as { answer?: unknown }).answer;
  if (typeof answer !== "string") return undefined;
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "assistant";
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  onStatus?: (status: string) => void | Promise<void>,
  sandboxExecutor?: VercelSandboxToolExecutor,
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
    execute: async (_toolCallId, params) => {
      hooks?.onToolCall?.(toolName);
      const toolStartedAt = Date.now();
      logWarn(
        "agent_tool_call_start",
        {},
        {
          "gen_ai.system": "vercel-ai-gateway",
          "gen_ai.operation.name": "tool_call",
          "app.ai.tool_name": toolName
        },
        "Agent tool call started"
      );
      await onStatus?.(`${formatToolStatus(toolName)}...`);
      if (!Value.Check(toolDef.inputSchema, params)) {
        const details = [...Value.Errors(toolDef.inputSchema, params)]
          .slice(0, 3)
          .map((entry) => `${entry.path || "/"}: ${entry.message}`)
          .join("; ");
        const validationMessage = details.length > 0 ? details : "Invalid tool input";
        logWarn(
          "agent_tool_call_invalid_input",
          {},
          {
            "gen_ai.system": "vercel-ai-gateway",
            "gen_ai.operation.name": "tool_call",
            "app.ai.tool_name": toolName,
            "app.ai.tool_duration_ms": Date.now() - toolStartedAt
          },
          "Agent tool call input validation failed"
        );
        logException(
          new Error(validationMessage),
          "agent_tool_call_invalid_input_exception",
          {},
          {
            "gen_ai.system": "vercel-ai-gateway",
            "gen_ai.operation.name": "tool_call",
            "app.ai.tool_name": toolName,
            "app.ai.tool_duration_ms": Date.now() - toolStartedAt
          },
          "Agent tool call input validation failed with exception"
        );
        throw new Error(validationMessage);
      }
      const parsed = params as Record<string, unknown>;

      try {
        if (typeof toolDef.execute !== "function") {
          const answer = toolName === "final_answer" ? String((parsed.answer as string | undefined) ?? "") : "";
          await onStatus?.("Reviewing tool results...");
          logWarn(
            "agent_tool_call_end",
            {},
            {
              "gen_ai.system": "vercel-ai-gateway",
              "gen_ai.operation.name": "tool_call",
              "app.ai.tool_name": toolName,
              "app.ai.tool_duration_ms": Date.now() - toolStartedAt
            },
            "Agent tool call finished"
          );
          return {
            content: answer ? [{ type: "text", text: answer }] : [{ type: "text", text: "ok" }],
            details: toolName === "final_answer" ? { answer } : { ok: true }
          };
        }

        const result = sandboxExecutor?.canExecute(toolName)
          ? await sandboxExecutor.execute({
              toolName,
              input: parsed
            })
          : await toolDef.execute(parsed as never, {
              experimental_context: sandbox
            });
        const resultDetails =
          sandboxExecutor?.canExecute(toolName) && result && typeof result === "object" && "result" in result
            ? (result as { result: unknown }).result
            : result;

        await onStatus?.("Reviewing tool results...");
        logWarn(
          "agent_tool_call_end",
          {},
          {
            "gen_ai.system": "vercel-ai-gateway",
            "gen_ai.operation.name": "tool_call",
            "app.ai.tool_name": toolName,
            "app.ai.tool_duration_ms": Date.now() - toolStartedAt
          },
          "Agent tool call finished"
        );
        return {
          content: [{ type: "text", text: toToolContentText(resultDetails) }],
          details: resultDetails
        };
      } catch (error) {
        logException(
          error,
          "agent_tool_call_failed",
          {},
          {
            "gen_ai.system": "vercel-ai-gateway",
            "gen_ai.operation.name": "tool_call",
            "app.ai.tool_name": toolName,
            "app.ai.tool_duration_ms": Date.now() - toolStartedAt
          },
          "Agent tool call failed"
        );
        throw error;
      }
    }
  }));
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const sandboxExecutor = new VercelSandboxToolExecutor({
      sandboxId: context.sandbox?.sandboxId,
      traceContext: {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }
    });

    const availableSkills = await discoverSkills();
    sandboxExecutor.configureSkills(availableSkills);
    const sandbox = await sandboxExecutor.createSandbox();
    const userInput = messageText;
    const explicitInvocation = parseSkillInvocation(userInput);
    const explicitSkill = explicitInvocation
      ? findSkillByName(explicitInvocation.skillName, availableSkills)
      : null;
    const activeSkills: Skill[] = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);

    if (explicitInvocation && !explicitSkill) {
      return {
        text: formatUnknownSkillMessage(explicitInvocation.skillName, availableSkills),
        sandboxId: sandboxExecutor.getSandboxId(),
        diagnostics: {
          outcome: "execution_failure",
          modelId: botConfig.modelId,
          assistantMessageCount: 0,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedFinalAnswer: false,
          usedPrimaryText: false
        }
      };
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
          usedFinalAnswer: false,
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
        onToolCallStart: async (toolName) => {
          await context.onStatus?.(`${formatToolStatus(toolName)}...`);
        },
        onToolCallEnd: async () => {
          await context.onStatus?.("Reviewing tool results...");
        },
        onSkillLoaded: (loadedSkill) => {
          const existing = activeSkills.find((skill) => skill.name === loadedSkill.name);
          if (existing) {
            existing.body = loadedSkill.body;
            existing.description = loadedSkill.description;
            existing.skillPath = loadedSkill.skillPath;
            existing.allowedTools = loadedSkill.allowedTools;
            return;
          }
          activeSkills.push(loadedSkill);
        }
      },
      {
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        artifactState: context.artifactState,
        sandbox
      }
    );

    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: explicitInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState
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

    const agent = new Agent({
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: createAgentTools(
          tools as Record<string, ToolDefinition<any>>,
          skillSandbox,
          context.onStatus,
          sandboxExecutor,
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

    const beforeMessageCount = agent.state.messages.length;
    logWarn(
      "agent_turn_start",
      {},
      {
        "gen_ai.system": "vercel-ai-gateway",
        "gen_ai.operation.name": "agent_turn",
        "gen_ai.request.model": botConfig.modelId
      },
      "Agent turn started"
    );

    await withSpan(
      "ai.generate_assistant_reply",
      "gen_ai.generate_text",
      {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      },
      async () => {
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
          await Promise.race([promptPromise, timeoutPromise]);
        } catch (error) {
          if (didTimeout) {
            logWarn(
              "agent_turn_timeout",
              {},
              {
                "gen_ai.system": "vercel-ai-gateway",
                "gen_ai.operation.name": "agent_turn",
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
      }
    );

    await context.onStatus?.("Drafting response...");

    const newMessages = agent.state.messages.slice(beforeMessageCount) as unknown[];
    const toolResults = newMessages.filter(isToolResultMessage);

    let finalAnswer: string | undefined;
    for (const message of [...toolResults].reverse()) {
      if (message.toolName !== "final_answer") continue;
      finalAnswer = finalAnswerFromToolDetails(message.details);
      if (finalAnswer) break;
    }
    const hadExtractedFinalAnswer = Boolean(finalAnswer);

    const assistantMessages = newMessages.filter(isAssistantMessage);

    const primaryText = assistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n")
      .trim();

    const toolErrorCount = toolResults.filter((result) => result.isError).length;
    logWarn(
      "agent_turn_activity",
      {},
      {
        "gen_ai.system": "vercel-ai-gateway",
        "gen_ai.operation.name": "agent_turn",
        "gen_ai.request.model": botConfig.modelId,
        "app.ai.assistant_messages": assistantMessages.length,
        "app.ai.tool_results": toolResults.length,
        "app.ai.tool_error_results": toolErrorCount,
        "app.ai.tool_call_count": toolCalls.length
      },
      "Agent turn activity captured"
    );

    if (!finalAnswer && !primaryText) {
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

      finalAnswer = buildExecutionFailureMessage(toolErrorCount);
    }

    const lastAssistant = assistantMessages.at(-1) as { stopReason?: unknown; errorMessage?: unknown } | undefined;
    const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : undefined;
    const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined;
    const usedFinalAnswer = hadExtractedFinalAnswer;
    const usedPrimaryText = Boolean(primaryText);
    const outcome: AgentTurnDiagnostics["outcome"] =
      finalAnswer || primaryText
        ? (stopReason === "error" ? "provider_error" : "success")
        : "execution_failure";

    const resolvedText = finalAnswer ?? primaryText ?? buildExecutionFailureMessage(toolErrorCount);
    if (isExecutionEscapeResponse(resolvedText) || isRawToolPayloadResponse(resolvedText)) {
      return {
        text: buildExecutionFailureMessage(toolErrorCount),
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined,
        sandboxId: sandboxExecutor.getSandboxId(),
        diagnostics: {
          outcome: "execution_failure",
          modelId: botConfig.modelId,
          assistantMessageCount: assistantMessages.length,
          toolCalls,
          toolResultCount: toolResults.length,
          toolErrorCount,
          usedFinalAnswer,
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
      sandboxId: sandboxExecutor.getSandboxId(),
      diagnostics: {
        outcome,
        modelId: botConfig.modelId,
        assistantMessageCount: assistantMessages.length,
        toolCalls,
        toolResultCount: toolResults.length,
        toolErrorCount,
        usedFinalAnswer,
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
        usedFinalAnswer: false,
        usedPrimaryText: false,
        errorMessage: message,
        providerError: error
      }
    };
  }
}
