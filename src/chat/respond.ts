import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logException, logWarn, setTags, withSpan } from "@/chat/observability";
import { buildSystemPrompt } from "@/chat/prompt";
import { SkillSandbox } from "@/chat/skill-sandbox";
import { discoverSkills, findSkillByName, loadSkillsByName, parseSkillInvocation, type Skill } from "@/chat/skills";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { isVercelSandboxEnabled, VercelSandboxToolExecutor } from "@/chat/sandbox/vercel";

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
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usedFinalAnswer: boolean;
  usedPrimaryText: boolean;
}

interface LoadedSkillForSteering {
  instructions: string;
  location: string;
  name: string;
  skillDir: string;
}

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

function buildSkillSteeringBlock(skill: LoadedSkillForSteering, args?: string): string {
  const skillBlock = [
    `<skill name="${skill.name}" location="${skill.location}">`,
    `References are relative to ${skill.skillDir}.`,
    "",
    skill.instructions.trim(),
    "</skill>"
  ].join("\n");

  const trimmedArgs = args?.trim();
  return trimmedArgs ? `${skillBlock}\n\n${trimmedArgs}` : skillBlock;
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
  tools: Record<string, ToolDefinition>,
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
    parameters: Type.Any(),
    execute: async (_toolCallId, params) => {
      hooks?.onToolCall?.(toolName);
      await onStatus?.(`${formatToolStatus(toolName)}...`);
      const parsed = toolDef.inputSchema.safeParse(params);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      if (typeof toolDef.execute !== "function") {
        const answer = toolName === "final_answer" ? String((parsed.data as { answer?: string }).answer ?? "") : "";
        await onStatus?.("Reviewing tool results...");
        return {
          content: answer ? [{ type: "text", text: answer }] : [{ type: "text", text: "ok" }],
          details: toolName === "final_answer" ? { answer } : { ok: true }
        };
      }

      const result = sandboxExecutor?.canExecute(toolName)
        ? await sandboxExecutor.execute({
            toolName,
            input: parsed.data
          })
        : await toolDef.execute(parsed.data, {
            experimental_context: sandbox
          });

      const normalizedResult =
        sandboxExecutor?.canExecute(toolName) && result && typeof result === "object" && "result" in result
          ? (result as { result: unknown; generatedFiles?: Array<{ dataBase64: string; filename: string; mimeType: string }>; artifactStatePatch?: Partial<ThreadArtifactsState> })
          : null;
      if (normalizedResult?.generatedFiles && normalizedResult.generatedFiles.length > 0) {
        hooks?.onGeneratedFiles?.(
          normalizedResult.generatedFiles.map((file) => ({
            data: Buffer.from(file.dataBase64, "base64"),
            filename: file.filename,
            mimeType: file.mimeType
          }))
        );
      }
      if (normalizedResult?.artifactStatePatch && Object.keys(normalizedResult.artifactStatePatch).length > 0) {
        hooks?.onArtifactStatePatch?.(normalizedResult.artifactStatePatch);
      }

      await onStatus?.("Reviewing tool results...");
      return {
        content: [{ type: "text", text: toToolContentText(normalizedResult ? normalizedResult.result : result) }],
        details: normalizedResult ? normalizedResult.result : result
      };
    }
  }));
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const sandboxExecutor: VercelSandboxToolExecutor = isVercelSandboxEnabled()
      ? new VercelSandboxToolExecutor({ sandboxId: context.sandbox?.sandboxId })
      : new VercelSandboxToolExecutor();

    const availableSkills = await discoverSkills();
    sandboxExecutor.configureSkills(availableSkills);
    let userInput = messageText;
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

    if (explicitInvocation && explicitSkill) {
      let loadedForSteering: LoadedSkillForSteering | null = null;

      if (sandboxExecutor.canExecute("load_skill")) {
        const envelope = await sandboxExecutor.execute<{
          ok?: boolean;
          skill_name?: string;
          location?: string;
          skill_dir?: string;
          instructions?: string;
        }>({
          toolName: "load_skill",
          input: { skill_name: explicitSkill.name }
        });
        const result = envelope.result;
        if (
          result &&
          typeof result === "object" &&
          (result as { ok?: unknown }).ok === true &&
          typeof (result as { skill_name?: unknown }).skill_name === "string" &&
          typeof (result as { location?: unknown }).location === "string" &&
          typeof (result as { skill_dir?: unknown }).skill_dir === "string" &&
          typeof (result as { instructions?: unknown }).instructions === "string"
        ) {
          loadedForSteering = {
            name: (result as { skill_name: string }).skill_name,
            location: (result as { location: string }).location,
            skillDir: (result as { skill_dir: string }).skill_dir,
            instructions: (result as { instructions: string }).instructions
          };
        }
      } else {
        const [skill] = await loadSkillsByName([explicitSkill.name], availableSkills);
        if (skill) {
          loadedForSteering = {
            name: skill.name,
            location: `${skill.skillPath}/SKILL.md`,
            skillDir: skill.skillPath,
            instructions: skill.body
          };
        }
      }

      if (loadedForSteering) {
        userInput = buildSkillSteeringBlock(loadedForSteering, explicitInvocation.args);
      }
    }

    const userTurnText = buildUserTurnText(userInput, context.conversationContext);

    if (!getGatewayApiKey()) {
      return {
        text: "I hit an internal error while processing that request. Please try again.",
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
          errorMessage: "AI_GATEWAY_API_KEY is missing"
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
        }
      },
      {
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        artifactState: context.artifactState
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
          text: `Attached file: ${attachment.filename ?? "unnamed"} (${attachment.mediaType}).`
        });
      }
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: createAgentTools(
          tools as Record<string, ToolDefinition>,
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

    await withSpan(
      "ai.generateAssistantReply",
      "ai.generate_text",
      {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      },
      () =>
        agent.prompt({
          role: "user",
          content: userContentParts,
          timestamp: Date.now()
        })
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

    const primaryText = [...assistantMessages]
      .reverse()
      .map((message) => extractAssistantText(message))
      .join("\n")
      .trim();

    const toolErrorCount = toolResults.filter((result) => result.isError).length;

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
          errorMessage
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
        errorMessage
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

    return {
      text: "I hit an internal error while processing that request. Please try again.",
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
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    };
  }
}
