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
        resultFiles: result.files.length
      });
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
