import { generateText, gateway, stepCountIs } from "ai";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { captureException, setTags, withSpan } from "@/chat/observability";
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
    requesterId?: string;
  };
  chatHistory?: string;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
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
    const generatedFiles: FileUpload[] = [];
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
        generateText({
          model: gateway(botConfig.modelId),
          system: buildSystemPrompt({
            availableSkills,
            activeSkills,
            invocation,
            assistant: context.assistant,
            requester: context.requester,
            chatHistory: context.chatHistory
          }),
          prompt: userInput,
          stopWhen: stepCountIs(12),
          experimental_telemetry: {
            isEnabled: true,
            functionId: "generateAssistantReply",
            recordInputs: true,
            recordOutputs: true,
            metadata: telemetryMetadata
          },
          tools: createTools(availableSkills, {
            onGeneratedFiles: (files) => {
              generatedFiles.push(...files);
            }
          })
        })
    );

    return {
      text: result.text || "I couldn't produce a response.",
      files: generatedFiles.length > 0 ? generatedFiles : undefined
    };
  } catch (error) {
    captureException(error, {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    });

    console.error("[junior] generateAssistantReply failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      text: "I hit an internal error while processing that request. Please try again."
    };
  }
}
