import { gateway, hasToolCall, NoSuchToolError, stepCountIs, ToolLoopAgent, type ToolCallRepairFunction } from "ai";
import type { FileUpload } from "chat";
import { z } from "zod";
import { generateObjectWithTelemetry, generateTextWithTelemetry } from "@/chat/ai";
import { botConfig } from "@/chat/config";
import { logException, logWarn, setTags, withSpan } from "@/chat/observability";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { buildSystemPrompt } from "@/chat/prompt";
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

const completionOutcomeClassificationSchema = z.object({
  outcome: z.enum(["completed", "continue", "blocked"]).describe("Execution outcome classification."),
  confidence: z.number().min(0).max(1).optional().describe("Classifier confidence from 0 to 1."),
  reason: z.string().max(200).optional().describe("Short reason for this classification."),
  blocking_question: z
    .string()
    .max(240)
    .optional()
    .describe("One concrete question to ask the user when outcome is blocked."),
  missing_input: z
    .string()
    .max(120)
    .optional()
    .describe("Short name for the missing required input when outcome is blocked.")
});

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

function hasToolResults(result: { toolResults: unknown[] }): boolean {
  return Array.isArray(result.toolResults) && result.toolResults.length > 0;
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

type CompletionOutcome = "completed" | "continue" | "blocked";

interface CompletionOutcomeDecision {
  outcome: CompletionOutcome;
  confidence?: number;
  reason: string;
  blockingQuestion?: string;
  missingInput?: string;
}

async function classifyCompletionOutcome(args: {
  candidateText: string;
  userTurnText: string;
  requiredSkillName?: string;
  telemetryMetadata: Record<string, string>;
  context: ReplyRequestContext;
}): Promise<CompletionOutcomeDecision> {
  const candidate = args.candidateText.trim();
  if (!candidate) {
    return {
      outcome: "continue",
      reason: "empty response"
    };
  }
  if (isExecutionEscapeResponse(candidate)) {
    return {
      outcome: "continue",
      reason: "execution deferred or tool-access disclaimer"
    };
  }

  try {
    const classifierSystem = [
      "You are classifying an assistant response outcome for an autonomous execution loop.",
      "Use exactly one outcome:",
      "- completed: the task was completed in this turn.",
      "- continue: the response is incomplete and execution should continue autonomously without asking the user.",
      "- blocked: progress is blocked by a required missing input that cannot be discovered via available tools.",
      "Only use blocked for true hard blockers.",
      "Return strict JSON with keys: outcome, confidence, reason, blocking_question, missing_input.",
      "Include blocking_question only when outcome is blocked. It must be one concise, concrete question."
    ].join("\n");

    const result = await generateObjectWithTelemetry(
      {
        model: gateway(botConfig.routerModelId),
        schema: completionOutcomeClassificationSchema,
        temperature: 0,
        maxOutputTokens: 80,
        system: classifierSystem,
        prompt: [
          "<user-request>",
          args.userTurnText,
          "</user-request>",
          "",
          args.requiredSkillName ? `Active slash skill: /${args.requiredSkillName}` : "No active slash skill.",
          "",
          "<candidate-response>",
          candidate,
          "</candidate-response>"
        ].join("\n")
      },
      {
        functionId: "generateAssistantReply.classify_completion_outcome",
        metadata: {
          ...args.telemetryMetadata,
          routerModelId: botConfig.routerModelId
        },
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true
      }
    );

    const parsed = completionOutcomeClassificationSchema.parse(result.object);
    const blockingQuestion = parsed.blocking_question?.trim();
    const missingInput = parsed.missing_input?.trim();
    if (parsed.outcome === "blocked") {
      if (isExecutionEscapeResponse(candidate) || (blockingQuestion && isExecutionEscapeResponse(blockingQuestion))) {
        return {
          outcome: "continue",
          confidence: parsed.confidence,
          reason: "blocked classification rejected due execution-deferral pattern"
        };
      }
      if (missingInput && /\b(permission|confirmation|proceed|re-invocation|tag)\b/i.test(missingInput)) {
        return {
          outcome: "continue",
          confidence: parsed.confidence,
          reason: "blocked classification rejected due non-blocking permission request"
        };
      }
    }

    return {
      outcome: parsed.outcome,
      confidence: parsed.confidence,
      reason: parsed.reason?.trim() || "llm classifier",
      blockingQuestion,
      missingInput
    };
  } catch (error) {
    logWarn("ai_completion_classifier_failed", {
      slackThreadId: args.context.correlation?.threadId,
      slackUserId: args.context.correlation?.requesterId,
      slackChannelId: args.context.correlation?.channelId,
      workflowRunId: args.context.correlation?.workflowRunId,
      assistantUserName: args.context.assistant?.userName,
      modelId: botConfig.routerModelId
    }, {
      "error.message": error instanceof Error ? error.message : String(error)
    }, "Completion outcome classifier failed");

    return {
      outcome: "continue",
      reason: "classifier failed"
    };
  }
}

function toBlockedQuestion(decision: CompletionOutcomeDecision, fallbackText: string): string {
  const explicit = decision.blockingQuestion?.trim();
  if (explicit && !isExecutionEscapeResponse(explicit)) {
    return explicit;
  }

  const fallback = fallbackText.trim();
  if (fallback.endsWith("?") && !isExecutionEscapeResponse(fallback)) {
    return fallback;
  }

  return "I need one required input to continue. What should I use?";
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

      logWarn("ai_finalization_retry_requested", {
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
      }, "Empty text after tool calls; requesting finalization");

      const finalizationRetryContext = hasToolResults(finalResult)
        ? [
            "Tool results from the previous attempt (JSON):",
            serializeToolResultsForRetry(finalResult),
            "",
            "Use these results to produce the final answer."
          ]
        : [
            "No tool results were produced in the previous attempt.",
            "Run the required tools now before final_answer."
          ];

      finalResult = await finalizationAgent.generate({
        messages: [
          {
            role: "user",
            content: userContentParts
          },
          {
            role: "user",
            content: [
              ...finalizationRetryContext,
              "",
              "Do not ask the user to re-run, re-tag, or confirm to proceed.",
              "",
              "Call final_answer with the final user-facing markdown response.",
              "Do not repeat earlier tool calls unless absolutely necessary."
            ].join("\n")
          }
        ]
      });
      await context.onStatus?.("Drafting response...");
      finalAnswer = extractFinalAnswer(finalResult);
    }

    if ((!finalAnswer && !finalResult.text) || (!finalAnswer && finalResult.text.trim().length === 0)) {
      logWarn("ai_finalization_forced", {
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
      }, "Empty text after retries; forcing no-tool finalization");

      try {
        const forcedFinalizationToolSection = hasToolResults(finalResult)
          ? [
              "Tool results from the previous attempt (JSON):",
              serializeToolResultsForRetry(finalResult)
            ]
          : [
              "No tool results were produced in the previous attempt.",
              "If required, reason from available thread context only."
            ];

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
                  "Original user turn content:",
                  userTurnText,
                  "",
                  ...forcedFinalizationToolSection
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
        logException(error, "ai_finalization_forced_failed", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        }, {}, "Forced no-tool finalization failed");
      }
    }

    if ((!finalAnswer && !finalResult.text) || (!finalAnswer && finalResult.text.trim().length === 0)) {
      logWarn("ai_model_response_empty", {
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
      }, "Model returned empty text response");
    }

    const candidateText = finalAnswer ?? finalResult.text ?? "";
    const initialOutcome = await classifyCompletionOutcome({
      candidateText,
      userTurnText,
      requiredSkillName,
      telemetryMetadata,
      context
    });

    if (initialOutcome.outcome === "blocked") {
      logWarn("ai_completion_blocked", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.completion.reason": initialOutcome.reason,
        "app.completion.confidence": initialOutcome.confidence,
        "app.completion.missing_input": initialOutcome.missingInput ?? ""
      }, "Completion blocked by missing required input");

      return {
        text: toBlockedQuestion(initialOutcome, candidateText),
        files: generatedFiles.length > 0 ? generatedFiles : undefined,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
      };
    }

    if (initialOutcome.outcome === "continue") {
      logWarn("ai_completion_auto_continue", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.ai.finish_reason": finalResult.finishReason,
        "app.completion.reason": initialOutcome.reason,
        "app.completion.confidence": initialOutcome.confidence
      }, "Completion incomplete; continuing autonomously");

      const completionRetryAgent = new ToolLoopAgent({
        model: gateway(botConfig.modelId),
        instructions: [
          buildSystemPrompt({
            availableSkills,
            activeSkills,
            invocation: explicitInvocation,
            assistant: context.assistant,
            requester: context.requester,
            artifactState: context.artifactState
          }),
          "## Runtime Completion Retry",
          "- Complete the user's requested task in this turn using tools as needed.",
          "- Do not ask for permission, confirmation, or more time unless there is a hard blocker.",
          "- Never claim you lack access to tools in this turn; run available tools now.",
          "- Never ask the user to re-tag, re-invoke, or retry for a clear request.",
          "- Do not output status updates about intended future work.",
          requiredSkillName
            ? `- A slash-invoked skill is active: /${requiredSkillName}. Follow that skill's instructions first.`
            : "- If a skill clearly applies, load it before finalizing.",
          "- Call final_answer with the completed user-facing markdown output."
        ].join("\n"),
        tools,
        toolChoice: "required",
        stopWhen: [hasToolCall("final_answer"), stepCountIs(100)],
        experimental_repairToolCall: repairToolCall,
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
          functionId: "generateAssistantReply.completion_retry",
          metadata: telemetryMetadata
        }
      });

      let retryResult = finalResult;
      let retryText = candidateText;
      let lastOutcome: CompletionOutcomeDecision = initialOutcome;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const completionRetryToolSection = hasToolResults(retryResult)
          ? [
              "Tool results so far (JSON):",
              serializeToolResultsForRetry(retryResult)
            ]
          : [
              "No tool results are available yet.",
              "Run the required tools now before final_answer."
            ];

        const completionRetry = await completionRetryAgent.generate({
          messages: [
            {
              role: "user",
              content: userContentParts
            },
            {
              role: "user",
              content: [
                "Previous attempt was incomplete.",
                "Complete the task now and provide the final answer directly.",
                "Continue autonomously unless there is a true hard blocker.",
                "Do not ask the user to proceed, re-tag, or start a fresh invocation.",
                "",
                ...completionRetryToolSection,
                "",
                "Previous assistant output that was not acceptable:",
                retryText
              ].join("\n")
            }
          ]
        });

        const completionAnswer = extractFinalAnswer(completionRetry) ?? completionRetry.text?.trim();
        if (!completionAnswer) {
          retryResult = completionRetry;
          retryText = completionRetry.text?.trim() ?? "";
          continue;
        }

        const retryOutcome = await classifyCompletionOutcome({
          candidateText: completionAnswer,
          userTurnText,
          requiredSkillName,
          telemetryMetadata,
          context
        });

        if (retryOutcome.outcome === "completed") {
          return {
            text: completionAnswer,
            files: generatedFiles.length > 0 ? generatedFiles : undefined,
            artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
          };
        }

        if (retryOutcome.outcome === "blocked") {
          logWarn("ai_completion_blocked_after_retry", {
            slackThreadId: context.correlation?.threadId,
            slackUserId: context.correlation?.requesterId,
            slackChannelId: context.correlation?.channelId,
            workflowRunId: context.correlation?.workflowRunId,
            assistantUserName: context.assistant?.userName,
            modelId: botConfig.modelId
          }, {
            "app.retry.attempt": attempt,
            "app.completion.reason": retryOutcome.reason,
            "app.completion.confidence": retryOutcome.confidence,
            "app.completion.missing_input": retryOutcome.missingInput ?? ""
          }, "Completion became blocked during retry");

          return {
            text: toBlockedQuestion(retryOutcome, completionAnswer),
            files: generatedFiles.length > 0 ? generatedFiles : undefined,
            artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
          };
        }

        logWarn("ai_completion_retry_still_incomplete", {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        }, {
          "app.retry.attempt": attempt,
          "app.completion.reason": retryOutcome.reason,
          "app.completion.confidence": retryOutcome.confidence
        }, "Completion retry remained incomplete");

        lastOutcome = retryOutcome;
        retryResult = completionRetry;
        retryText = completionAnswer;
      }

      logWarn("ai_completion_retry_exhausted", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        "app.completion.reason": lastOutcome.reason,
        "app.completion.confidence": lastOutcome.confidence
      }, "Completion retries exhausted without terminal completion");

      const exhaustedAnswerFromRetry = extractFinalAnswer(retryResult);
      const exhaustedAnswer = exhaustedAnswerFromRetry ?? (retryText.trim() || retryResult.text?.trim());
      if (exhaustedAnswer && exhaustedAnswer.length > 0 && !isExecutionEscapeResponse(exhaustedAnswer)) {
        return {
          text: exhaustedAnswer,
          files: generatedFiles.length > 0 ? generatedFiles : undefined,
          artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
        };
      }
    }

    const resolvedText = finalAnswer ?? (finalResult.text || "I couldn't produce a response.");
    if (isExecutionEscapeResponse(resolvedText)) {
      return {
        text: "I hit an internal issue while executing that request and could not complete it in this turn. Please retry the same request.",
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
