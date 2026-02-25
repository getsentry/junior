import { gateway, NoSuchToolError, stepCountIs, ToolLoopAgent, type ToolCallRepairFunction } from "ai";
import type { FileUpload } from "chat";
import { z } from "zod";
import { generateObjectWithTelemetry } from "@/chat/ai";
import { botConfig } from "@/chat/config";
import { logException, logInfo, logWarn, setTags, withSpan } from "@/chat/observability";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { buildSystemPrompt } from "@/chat/prompt";
import { SkillSandbox } from "@/chat/skill-sandbox";
import {
  discoverSkills,
  findSkillByName,
  loadSkillsByName,
  parseSkillInvocation
} from "@/chat/skills";
import type { Skill } from "@/chat/skills";
import { createTools } from "@/chat/tools";

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
  onStatus?: (status: string) => void | Promise<void>;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
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
    // Handle common fenced-json model responses.
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
    list_skill_files: "Listing skill resources",
    read_skill_file: "Reading skill resource",
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

function summarizeStepDiagnostics(result: {
  steps?: Array<{
    finishReason?: string;
    text?: string;
    toolCalls?: unknown[];
    toolResults?: unknown[];
    content?: Array<{ type?: string }>;
  }>;
}): string {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return steps
    .map((step, index) => {
      const text = typeof step.text === "string" ? step.text : "";
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
      const content = Array.isArray(step.content) ? step.content : [];
      const contentTypes = content.map((part) => part.type ?? "unknown").join(",");
      return [
        `step=${index + 1}`,
        `finish=${step.finishReason ?? "unknown"}`,
        `text_len=${text.length}`,
        `tool_calls=${toolCalls.length}`,
        `tool_results=${toolResults.length}`,
        `content=${contentTypes || "none"}`
      ].join("|");
    })
    .join(" ; ");
}

function extractFinalAnswerFromInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return extractFinalAnswerFromInput(parsed);
    } catch {
      return trimmed;
    }
  }

  if (!input || typeof input !== "object") return undefined;
  const answer = (input as { answer?: unknown }).answer;
  if (typeof answer !== "string") return undefined;
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractFinalAnswer(result: {
  staticToolCalls?: Array<{ toolName: string; input: unknown }>;
  steps?: Array<{
    staticToolCalls?: Array<{ toolName: string; input: unknown }>;
  }>;
}): string | undefined {
  const fromCall = (call: { toolName: string; input: unknown }): string | undefined => {
    if (call.toolName !== "final_answer") return undefined;
    return extractFinalAnswerFromInput(call.input);
  };

  const staticToolCalls = Array.isArray(result.staticToolCalls) ? result.staticToolCalls : [];
  for (const call of [...staticToolCalls].reverse()) {
    const answer = fromCall(call);
    if (answer) return answer;
  }
  const steps = Array.isArray(result.steps) ? result.steps : [];
  for (const step of [...steps].reverse()) {
    const stepToolCalls = Array.isArray(step.staticToolCalls) ? step.staticToolCalls : [];
    for (const call of [...stepToolCalls].reverse()) {
      const answer = fromCall(call);
      if (answer) return answer;
    }
  }
  return undefined;
}

interface LoopStepLike {
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolResults: Array<{ type?: string; error?: unknown }>;
}

interface LoopGuardState {
  hasNonFinalToolCall: boolean;
  repeatedToolCallStreak: number;
  toolErrorStreak: number;
}

const LOOP_GUARD_REPEAT_TOOL_CALL_STREAK = 2;
const LOOP_GUARD_TOOL_ERROR_STREAK = 2;
const LOOP_GUARD_FORCE_FINAL_AT_STEP = 24;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => a[0].localeCompare(b[0]));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function toolCallSignature(call: { toolName: string; input: unknown }): string {
  return `${call.toolName}:${stableSerialize(call.input)}`;
}

function hasToolError(step: LoopStepLike): boolean {
  if (!Array.isArray(step.toolResults)) return false;
  return step.toolResults.some((result) => result?.type === "tool-error" || result?.error !== undefined);
}

function computeLoopGuardState(steps: LoopStepLike[]): LoopGuardState {
  const hasNonFinalToolCall = steps.some((step) => step.toolCalls.some((call) => call.toolName !== "final_answer"));

  let repeatedToolCallStreak = 0;
  const trailingNonFinalSignatures = [...steps]
    .reverse()
    .map((step) => {
      const nonFinalCalls = step.toolCalls.filter((call) => call.toolName !== "final_answer");
      if (nonFinalCalls.length !== 1) return null;
      return toolCallSignature(nonFinalCalls[0]);
    });
  const firstSignature = trailingNonFinalSignatures[0];
  if (firstSignature) {
    for (const signature of trailingNonFinalSignatures) {
      if (signature !== firstSignature) break;
      repeatedToolCallStreak += 1;
    }
  }

  let toolErrorStreak = 0;
  for (const step of [...steps].reverse()) {
    if (!hasToolError(step)) break;
    toolErrorStreak += 1;
  }

  return {
    hasNonFinalToolCall,
    repeatedToolCallStreak,
    toolErrorStreak
  };
}

function countToolErrorSteps(result: { steps?: LoopStepLike[] }): number {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return steps.reduce((count, step) => count + (hasToolError(step) ? 1 : 0), 0);
}

function buildExecutionFailureMessage(result: {
  finishReason: string;
  steps: LoopStepLike[];
  toolCalls: unknown[];
  toolResults: unknown[];
}): string {
  const toolErrorSteps = countToolErrorSteps(result);
  if (toolErrorSteps > 0) {
    return "I couldn’t complete this because one or more required tools failed in this turn. I’ve logged the failure details.";
  }

  if (result.finishReason === "tool-calls" && result.toolCalls.length > 0 && result.toolResults.length === 0) {
    return "I couldn’t complete this because the turn ended with unresolved tool calls and no usable tool results.";
  }

  return "I couldn’t complete this request in this turn due to an execution failure. I’ve logged the details for debugging.";
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const availableSkills = await discoverSkills();
    const userInput = messageText;
    const userTurnText = buildUserTurnText(userInput, context.conversationContext);
    const explicitInvocation = parseSkillInvocation(userInput);
    const explicitSkill = explicitInvocation
      ? findSkillByName(explicitInvocation.skillName, availableSkills)
      : null;
    const requiredSkillName = explicitSkill?.name;
    const activeSkills: Skill[] = requiredSkillName
      ? await loadSkillsByName([requiredSkillName], availableSkills)
      : [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);

    if (explicitInvocation && !explicitSkill) {
      return {
        text: formatUnknownSkillMessage(explicitInvocation.skillName, availableSkills)
      };
    }

    const userContentParts: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: Buffer; mediaType: string }
      | { type: "file"; data: Buffer; mediaType: string; filename?: string }
    > = [{ type: "text", text: userTurnText }];

    for (const attachment of context.userAttachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) {
        userContentParts.push({
          type: "image",
          image: attachment.data,
          mediaType: attachment.mediaType
        });
      } else {
        userContentParts.push({
          type: "file",
          data: attachment.data,
          mediaType: attachment.mediaType,
          filename: attachment.filename
        });
      }
    }
    const generatedFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const telemetryMetadata: Record<string, string> = {
      modelId: botConfig.modelId
    };

    if (context.correlation?.threadId) telemetryMetadata.threadId = context.correlation.threadId;
    if (context.correlation?.workflowRunId) telemetryMetadata.workflowRunId = context.correlation.workflowRunId;
    if (context.correlation?.channelId) telemetryMetadata.channelId = context.correlation.channelId;
    if (context.correlation?.requesterId) telemetryMetadata.requesterId = context.correlation.requesterId;

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
    const repairToolCall: ToolCallRepairFunction<typeof tools> = async ({ toolCall, tools, inputSchema, error }) => {
      if (NoSuchToolError.isInstance(error)) {
        return null;
      }

      if (!(toolCall.toolName in tools)) {
        return null;
      }
      const tool = tools[toolCall.toolName as keyof typeof tools];

      try {
        const toolJsonSchema = await inputSchema({ toolName: toolCall.toolName });
        const { object: repairedInput } = await generateObjectWithTelemetry(
          {
            model: gateway(botConfig.modelId),
            schema: tool.inputSchema,
            prompt: [
              `Repair the invalid tool input for tool "${toolCall.toolName}".`,
              "Return only valid JSON arguments that match the tool schema.",
              "",
              "Original invalid tool input:",
              toolCall.input,
              "",
              "Validation error:",
              error.message,
              "",
              "Tool JSON schema:",
              JSON.stringify(toolJsonSchema)
            ].join("\n")
          },
          {
            functionId: "generateAssistantReply.repair_tool_call",
            metadata: {
              ...telemetryMetadata,
              toolName: toolCall.toolName
            }
          }
        );

        return {
          ...toolCall,
          input: JSON.stringify(repairedInput)
        };
      } catch (repairError) {
        logWarn("tool_call_repair_failed", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        }, {
          "app.tool.name": toolCall.toolName,
          "error.message": repairError instanceof Error ? repairError.message : "unknown repair error"
        }, "Tool call repair failed");
        return null;
      }
    };

    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: explicitInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState
    });
    const allToolNames = Object.keys(tools) as Array<keyof typeof tools>;
    const nonFinalToolNames = allToolNames.filter((toolName) => toolName !== "final_answer");
    const finalAnswerOnlyTools = ["final_answer"] as Array<keyof typeof tools>;
    const applySkillToolFilter = (candidateTools: Array<keyof typeof tools>): Array<keyof typeof tools> => {
      const filteredBySkill = skillSandbox.filterToolNames(candidateTools.map((toolName) => String(toolName)));
      if (!filteredBySkill) {
        return candidateTools;
      }

      const allowed = new Set(filteredBySkill);
      const narrowed = candidateTools.filter((toolName) => allowed.has(String(toolName)));
      return narrowed.length > 0 ? narrowed : finalAnswerOnlyTools;
    };
    let loopGuardLogged = false;

    const agent = new ToolLoopAgent({
      model: gateway(botConfig.modelId),
      instructions: baseInstructions,
      tools,
      toolChoice: "auto",
      callOptionsSchema: z.object({
        sandbox: z.custom<SkillSandbox>((value) => value instanceof SkillSandbox)
      }),
      prepareCall: ({ options, ...settings }) => ({
        ...settings,
        experimental_context: options.sandbox
      }),
      stopWhen: [stepCountIs(100)],
      prepareStep: ({ stepNumber, steps }) => {
        const loopState = computeLoopGuardState(steps as LoopStepLike[]);

        if (!loopState.hasNonFinalToolCall && nonFinalToolNames.length > 0) {
          return {
            activeTools: applySkillToolFilter(nonFinalToolNames)
          };
        }

        const shouldForceFinalAnswer =
          loopState.repeatedToolCallStreak >= LOOP_GUARD_REPEAT_TOOL_CALL_STREAK ||
          loopState.toolErrorStreak >= LOOP_GUARD_TOOL_ERROR_STREAK ||
          stepNumber >= LOOP_GUARD_FORCE_FINAL_AT_STEP;

        if (shouldForceFinalAnswer) {
          if (!loopGuardLogged) {
            loopGuardLogged = true;
            logWarn("ai_loop_guard_forced_final_answer", {
              slackThreadId: context.correlation?.threadId,
              slackUserId: context.correlation?.requesterId,
              slackChannelId: context.correlation?.channelId,
              workflowRunId: context.correlation?.workflowRunId,
              assistantUserName: context.assistant?.userName,
              modelId: botConfig.modelId
            }, {
              "app.ai.step_number": stepNumber,
              "app.ai.repeated_tool_call_streak": loopState.repeatedToolCallStreak,
              "app.ai.tool_error_streak": loopState.toolErrorStreak
            }, "Loop guard narrowed to final_answer-only mode");
          }

          return {
            activeTools: finalAnswerOnlyTools
          };
        }

        return {
          activeTools: applySkillToolFilter(allToolNames)
        };
      },
      onStepFinish: (step) => {
        const loopStep = step as LoopStepLike;
        if (!hasToolError(loopStep)) return;

        logInfo("ai_tool_error_step", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        }, {
          "app.ai.step_tool_calls": loopStep.toolCalls.length,
          "app.ai.step_tool_results": loopStep.toolResults.length
        }, "Tool error encountered during agent step");
      },
      experimental_repairToolCall: repairToolCall,
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
        functionId: "generateAssistantReply",
        metadata: telemetryMetadata
      }
    });

    const result = await withSpan(
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
        agent.generate({
          messages: [
            {
              role: "user",
              content: userContentParts
            }
          ],
          options: {
            sandbox: skillSandbox
          }
        })
    );

    await context.onStatus?.("Drafting response...");

    let finalResult = result;
    let finalAnswer = extractFinalAnswer(finalResult);
    const primaryText = finalResult.text?.trim();
    const stepCount = Array.isArray(finalResult.steps) ? finalResult.steps.length : 0;
    const toolCalls = Array.isArray(finalResult.toolCalls) ? finalResult.toolCalls : [];
    const toolResults = Array.isArray(finalResult.toolResults) ? finalResult.toolResults : [];
    const sourceCount = Array.isArray(finalResult.sources) ? finalResult.sources.length : 0;
    const resultFileCount = Array.isArray(finalResult.files) ? finalResult.files.length : 0;
    const responseMessageCount = Array.isArray(finalResult.response?.messages) ? finalResult.response.messages.length : 0;

    if (!finalAnswer && !primaryText) {
      const toolErrorSteps = countToolErrorSteps(finalResult as { steps: LoopStepLike[] });
      logWarn("ai_model_response_empty", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.ai.steps": stepCount,
        "app.ai.tool_calls": toolCalls.length,
        "app.ai.tool_results": toolResults.length,
        "app.ai.tool_error_steps": toolErrorSteps,
        "app.ai.generated_files": generatedFiles.length,
        "app.ai.sources": sourceCount,
        "app.ai.result_files": resultFileCount,
        "app.ai.response_messages": responseMessageCount,
        "app.ai.step_diagnostics": summarizeStepDiagnostics(finalResult)
      }, "Model returned empty text response");

      finalAnswer = buildExecutionFailureMessage({
        finishReason: finalResult.finishReason,
        steps: finalResult.steps as LoopStepLike[],
        toolCalls,
        toolResults
      });
    }

    const resolvedText =
      finalAnswer ??
      primaryText ??
      buildExecutionFailureMessage({
        finishReason: finalResult.finishReason,
        steps: finalResult.steps as LoopStepLike[],
        toolCalls,
        toolResults
      });
    if (isExecutionEscapeResponse(resolvedText)) {
      const failureMessage = buildExecutionFailureMessage({
        finishReason: finalResult.finishReason,
        steps: finalResult.steps as LoopStepLike[],
        toolCalls,
        toolResults
      });
      logWarn("ai_execution_escape_response", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.ai.tool_calls": toolCalls.length,
        "app.ai.tool_results": toolResults.length,
        "app.ai.tool_error_steps": countToolErrorSteps(finalResult as { steps: LoopStepLike[] })
      }, "Resolved text matched execution-escape pattern");

      return {
        text: failureMessage,
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
      };
    }

    if (isRawToolPayloadResponse(resolvedText)) {
      const failureMessage = buildExecutionFailureMessage({
        finishReason: finalResult.finishReason,
        steps: finalResult.steps as LoopStepLike[],
        toolCalls,
        toolResults
      });
      logWarn("ai_raw_tool_payload_response", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.ai.tool_calls": toolCalls.length,
        "app.ai.tool_results": toolResults.length
      }, "Resolved text matched raw tool-payload shape");

      return {
        text: failureMessage,
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
      };
    }

    return {
      text: resolvedText,
      files: generatedFiles.length > 0 ? generatedFiles : undefined,
      artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
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
      text: "I hit an internal error while processing that request. Please try again."
    };
  }
}
