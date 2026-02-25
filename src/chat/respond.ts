import { gateway, stepCountIs } from "ai";
import { generateTextWithTelemetry } from "@/chat/ai";
import type { FileUpload } from "chat";
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
): { name: string; score: number } | null {
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
  return { name: best.name, score: best.score };
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

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {}
): Promise<AssistantReply> {
  try {
    const availableSkills = await discoverSkills();
    const invocation = parseSkillInvocation(messageText);
    const invokedSkill = invocation ? findSkillByName(invocation.skillName, availableSkills) : null;

    if (invocation && !invokedSkill) {
      const skills = availableSkills.map((skill) => `/${skill.name}`).join(", ") || "(none configured)";
      return {
        text: `Unknown skill: /${invocation.skillName}\nAvailable skills: ${skills}`
      };
    }

    const activeSkillNames = invokedSkill ? [invokedSkill.name] : [];
    const activeSkills = await loadSkillsByName(activeSkillNames, availableSkills);
    const userInput = invocation ? invocation.args : messageText;
    const inferredSkill = !invocation ? inferLikelySkill(userInput, availableSkills) : null;
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

    if (invokedSkill?.name) telemetryMetadata.skillName = invokedSkill.name;
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
      modelId: botConfig.modelId,
      skillName: invokedSkill?.name
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
        modelId: botConfig.modelId,
        skillName: invokedSkill?.name
      },
      () =>
        generateTextWithTelemetry({
          model: gateway(botConfig.modelId),
          system: buildSystemPrompt({
            availableSkills,
            activeSkills,
            invocation,
            assistant: context.assistant,
            requester: context.requester,
            chatHistory: context.chatHistory,
            artifactState: context.artifactState
          }),
          messages: [
            {
              role: "user",
              content: userContentParts
            }
          ],
          stopWhen: stepCountIs(50),
          tools: createTools(
            availableSkills,
            {
              onGeneratedFiles: (files) => {
                generatedFiles.push(...files);
              },
              onArtifactStatePatch: (patch) => {
                Object.assign(artifactStatePatch, patch);
              }
            },
            {
              channelId: context.correlation?.channelId,
              threadTs: context.correlation?.threadTs,
              artifactState: context.artifactState
            }
          )
        }, {
          functionId: "generateAssistantReply",
          metadata: telemetryMetadata
        })
    );

    if (!result.text || result.text.trim().length === 0) {
      logWarn("model returned empty text response", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId,
        skillName: invokedSkill?.name
      }, {
        finishReason: result.finishReason,
        steps: result.steps.length,
        sources: result.sources.length,
        toolCalls: result.toolCalls.length,
        toolResults: result.toolResults.length,
        generatedFiles: generatedFiles.length,
        resultFiles: result.files.length,
        responseMessages: result.response.messages.length,
        stepDiagnostics: summarizeStepDiagnostics(result)
      });
    }

    const toolNames = collectToolNames(result);
    const loadedSkillDuringTurn = toolNames.has("load_skill");
    if (!invocation && inferredSkill && !loadedSkillDuringTurn) {
      logWarn("matched skill without load_skill; running enforced retry", {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        workflowRunId: context.correlation?.workflowRunId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId
      }, {
        inferredSkill: inferredSkill.name,
        inferredScore: inferredSkill.score
      });

      const retry = await generateTextWithTelemetry({
        model: gateway(botConfig.modelId),
        system: [
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
        messages: [
          {
            role: "user",
            content: userContentParts
          }
        ],
        stopWhen: stepCountIs(50),
        tools: createTools(
          availableSkills,
          {
            onGeneratedFiles: (files) => {
              generatedFiles.push(...files);
            },
            onArtifactStatePatch: (patch) => {
              Object.assign(artifactStatePatch, patch);
            }
          },
          {
            channelId: context.correlation?.channelId,
            threadTs: context.correlation?.threadTs,
            artifactState: context.artifactState
          }
        )
      }, {
        functionId: "generateAssistantReply.enforced_skill_retry",
        metadata: {
          ...telemetryMetadata,
          enforcedSkill: inferredSkill.name
        }
      });

      if (retry.text && retry.text.trim().length > 0) {
        return {
          text: retry.text,
          files: generatedFiles.length > 0 ? generatedFiles : undefined,
          artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : undefined
        };
      }
    }

    return {
      text: result.text || "I couldn't produce a response.",
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
