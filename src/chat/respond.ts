import { gateway, hasToolCall, NoSuchToolError, stepCountIs, ToolLoopAgent, type ToolCallRepairFunction } from "ai";
import type { FileUpload } from "chat";
import { generateObjectWithTelemetry, generateTextWithTelemetry } from "@/chat/ai";
import { botConfig } from "@/chat/config";
import { logException, logWarn, setTags, withSpan } from "@/chat/observability";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { buildSystemPrompt } from "@/chat/prompt";
import {
  discoverSkills
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
  chatHistory?: string;
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

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((token) => token.length >= 3)
  );
}

function inferLikelySkill(
  userInput: string,
  availableSkills: Array<{ name: string; description: string }>
): { name: string; score: number; overlap: number } | null {
  const queryTokens = tokenize(userInput);
  if (queryTokens.size === 0) {
    return null;
  }

  let best: { name: string; score: number; overlap: number } | null = null;
  for (const skill of availableSkills) {
    const skillTokens = tokenize(`${skill.name} ${skill.description}`);
    if (skillTokens.size === 0) continue;

    let overlap = 0;
    for (const token of queryTokens) {
      if (skillTokens.has(token)) overlap += 1;
    }
    const score = overlap / queryTokens.size;
    if (!best || score > best.score) {
      best = { name: skill.name, score, overlap };
    }
  }

  if (!best) return null;
  if (best.overlap < 2 || best.score < 0.2) return null;
  return { name: best.name, score: best.score, overlap: best.overlap };
}

function collectToolNames(result: {
  toolCalls: Array<{ toolName?: string; tool_name?: string; name?: string }>;
  steps: Array<{
    toolCalls: Array<{ toolName?: string; tool_name?: string; name?: string }>;
    toolResults: Array<{ toolName?: string; tool_name?: string; name?: string }>;
  }>;
}): Set<string> {
  const names = new Set<string>();
  const addName = (value?: string) => {
    if (!value) return;
    names.add(value.toLowerCase());
  };

  for (const call of result.toolCalls) {
    addName(call.toolName ?? call.tool_name ?? call.name);
  }
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      addName(call.toolName ?? call.tool_name ?? call.name);
    }
    for (const toolResult of step.toolResults) {
      addName(toolResult.toolName ?? toolResult.tool_name ?? toolResult.name);
    }
  }
  return names;
}

function summarizeStepDiagnostics(result: {
  steps: Array<{
    finishReason: string;
    text: string;
    toolCalls: unknown[];
    toolResults: unknown[];
    content: Array<{ type?: string }>;
  }>;
}): string {
  return result.steps
    .map((step, index) => {
      const contentTypes = step.content.map((part) => part.type ?? "unknown").join(",");
      return [
        `step=${index + 1}`,
        `finish=${step.finishReason}`,
        `text_len=${step.text.length}`,
        `tool_calls=${step.toolCalls.length}`,
        `tool_results=${step.toolResults.length}`,
        `content=${contentTypes || "none"}`
      ].join("|");
    })
    .join(" ; ");
}

function serializeToolResultsForRetry(result: { toolResults: unknown[] }): string {
  let raw = "[]";
  try {
    raw = JSON.stringify(result.toolResults);
  } catch {
    raw = "[unserializable tool results]";
  }

  const maxChars = 12_000;
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}...[truncated]`;
}

function extractFinalAnswer(result: {
  staticToolCalls: Array<{ toolName: string; input: unknown }>;
  steps: Array<{
    staticToolCalls: Array<{ toolName: string; input: unknown }>;
  }>;
}): string | undefined {
  const fromCall = (call: { toolName: string; input: unknown }): string | undefined => {
    if (call.toolName !== "final_answer") return undefined;
    if (!call.input || typeof call.input !== "object") return undefined;
    const answer = (call.input as { answer?: unknown }).answer;
    if (typeof answer !== "string") return undefined;
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  for (const call of [...result.staticToolCalls].reverse()) {
    const answer = fromCall(call);
    if (answer) return answer;
  }
  for (const step of [...result.steps].reverse()) {
    for (const call of [...step.staticToolCalls].reverse()) {
      const answer = fromCall(call);
      if (answer) return answer;
    }
  }
  return undefined;
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const availableSkills = await discoverSkills();
    const activeSkills: Skill[] = [];
    const userInput = messageText;
    const inferredSkill = inferLikelySkill(userInput, availableSkills);
    const userContentParts: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: Buffer; mediaType: string }
      | { type: "file"; data: Buffer; mediaType: string; filename?: string }
    > = [{ type: "text", text: userInput }];

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
          await context.onStatus?.(`Running ${toolName}...`);
        },
        onToolCallEnd: async () => {
          await context.onStatus?.("Analyzing tool results...");
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
        logWarn("tool call repair failed; proceeding without repair", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        }, {
          "app.tool.name": toolCall.toolName,
          "error.message": repairError instanceof Error ? repairError.message : "unknown repair error"
        });
        return null;
      }
    };

    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: null,
      assistant: context.assistant,
      requester: context.requester,
      chatHistory: context.chatHistory,
      artifactState: context.artifactState
    });

    const agent = new ToolLoopAgent({
      model: gateway(botConfig.modelId),
      instructions: baseInstructions,
      tools,
      toolChoice: "required",
      stopWhen: [hasToolCall("final_answer"), stepCountIs(100)],
      experimental_repairToolCall: repairToolCall,
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
        functionId: "generateAssistantReply",
        metadata: telemetryMetadata
      }
    });

    const finalizationAgent = new ToolLoopAgent({
      model: gateway(botConfig.modelId),
      instructions: baseInstructions,
      tools,
      toolChoice: "required",
      activeTools: ["final_answer"],
      stopWhen: [hasToolCall("final_answer"), stepCountIs(5)],
      experimental_repairToolCall: repairToolCall,
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
        functionId: "generateAssistantReply.finalization_agent",
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
          ]
        })
    );

    await context.onStatus?.("Drafting response...");

    let finalResult = result;
    let finalAnswer = extractFinalAnswer(finalResult);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (finalAnswer) break;
      if (finalResult.text && finalResult.text.trim().length > 0) break;
      if (finalResult.finishReason !== "tool-calls") break;

      logWarn("empty text after tool-calls; requesting finalization step", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.retry.attempt": attempt,
        "app.ai.steps": finalResult.steps.length,
        "app.ai.tool_calls": finalResult.toolCalls.length,
        "app.ai.tool_results": finalResult.toolResults.length
      });

      finalResult = await finalizationAgent.generate({
        messages: [
          {
            role: "user",
            content: userContentParts
          },
          {
            role: "user",
            content: [
              "Prior tool results from the previous attempt (JSON):",
              serializeToolResultsForRetry(finalResult),
              "",
              "Using these results, call final_answer with the final user-facing markdown response.",
              "Do not repeat earlier tool calls unless absolutely necessary."
            ].join("\n")
          }
        ]
      });
      await context.onStatus?.("Drafting response...");
      finalAnswer = extractFinalAnswer(finalResult);
    }

    if ((!finalAnswer && !finalResult.text) || (!finalAnswer && finalResult.text.trim().length === 0)) {
      logWarn("empty text after retries; forcing no-tool finalization", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.ai.steps": finalResult.steps.length,
        "app.ai.tool_calls": finalResult.toolCalls.length,
        "app.ai.tool_results": finalResult.toolResults.length
      });

      try {
        const forcedFinalization = await withSpan(
          "ai.generateAssistantReply.forced_finalization",
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
            generateTextWithTelemetry(
              {
                model: gateway(botConfig.modelId),
                prompt: [
                  "You are generating the final user-facing reply for a Slack assistant turn.",
                  "Do not call tools. Do not describe internal reasoning.",
                  "Return only markdown text intended for the user.",
                  "",
                  `Original user message:`,
                  messageText,
                  "",
                  "Tool results from the previous attempt (JSON):",
                  serializeToolResultsForRetry(finalResult)
                ].join("\n")
              },
              {
                functionId: "generateAssistantReply.forced_finalization",
                metadata: telemetryMetadata,
                isEnabled: true,
                recordInputs: true,
                recordOutputs: true
              }
            )
        );

        const forcedText = forcedFinalization.text?.trim();
        if (forcedText && forcedText.length > 0) {
          finalAnswer = forcedText;
        }
      } catch (error) {
        logException(error, "forced no-tool finalization failed", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        });
      }
    }

    if ((!finalAnswer && !finalResult.text) || (!finalAnswer && finalResult.text.trim().length === 0)) {
      logWarn("model returned empty text response", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.ai.steps": finalResult.steps.length,
        "app.ai.sources": finalResult.sources.length,
        "app.ai.tool_calls": finalResult.toolCalls.length,
        "app.ai.tool_results": finalResult.toolResults.length,
        "app.ai.generated_files": generatedFiles.length,
        "app.ai.result_files": finalResult.files.length,
        "app.ai.response_messages": finalResult.response.messages.length,
        "app.ai.step_diagnostics": summarizeStepDiagnostics(finalResult)
      });
    }

    const toolNames = collectToolNames(finalResult);
    const loadedSkillDuringTurn = toolNames.has("load_skill");
    const shouldEnforceSkillRetry =
      inferredSkill &&
      inferredSkill.overlap >= 3 &&
      inferredSkill.score >= 0.45 &&
      !loadedSkillDuringTurn;

    if (shouldEnforceSkillRetry) {
      logWarn("matched skill without load_skill; running enforced retry", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.skill.name": inferredSkill.name,
        "app.skill.score": inferredSkill.score
      });

      const retryAgent = new ToolLoopAgent({
        model: gateway(botConfig.modelId),
        instructions: [
          buildSystemPrompt({
            availableSkills,
            activeSkills: [],
            invocation: null,
            assistant: context.assistant,
            requester: context.requester,
            chatHistory: context.chatHistory,
            artifactState: context.artifactState
          }),
          "## Runtime Skill Enforcement",
          `You must call load_skill with skill_name='${inferredSkill.name}' before answering.`,
          "After loading, follow only that skill's instructions and then provide a final user-visible markdown response."
        ].join("\n\n"),
        tools,
        toolChoice: "required",
        stopWhen: [hasToolCall("final_answer"), stepCountIs(100)],
        experimental_repairToolCall: repairToolCall,
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
          functionId: "generateAssistantReply.enforced_skill_retry",
          metadata: {
            ...telemetryMetadata,
            enforcedSkill: inferredSkill.name
          }
        }
      });

      const retry = await retryAgent.generate({
        messages: [
          {
            role: "user",
            content: userContentParts
          }
        ]
      });
      await context.onStatus?.("Drafting response...");

      const retryAnswer = extractFinalAnswer(retry);
      if (retryAnswer) {
        return {
          text: retryAnswer,
          files: generatedFiles.length > 0 ? generatedFiles : undefined,
          artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
        };
      }

      if (retry.text && retry.text.trim().length > 0) {
        return {
          text: retry.text,
          files: generatedFiles.length > 0 ? generatedFiles : undefined,
          artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
        };
      }
    }

    return {
      text: finalAnswer ?? (finalResult.text || "I couldn't produce a response."),
      files: generatedFiles.length > 0 ? generatedFiles : undefined,
      artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
    };
  } catch (error) {
    logException(error, "generateAssistantReply failed", {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    });

    return {
      text: "I hit an internal error while processing that request. Please try again."
    };
  }
}
