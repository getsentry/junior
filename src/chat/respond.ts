import { generateText, gateway, stepCountIs } from "ai";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
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

    const result = await generateText({
      model: gateway(botConfig.modelId),
      system: buildSystemPrompt({
        availableSkills,
        activeSkills,
        invocation,
        assistant: context.assistant,
        requester: context.requester
      }),
      prompt: userInput,
      stopWhen: stepCountIs(12),
      tools: createTools(availableSkills, {
        onGeneratedFiles: (files) => {
          generatedFiles.push(...files);
        }
      })
    });

    return {
      text: result.text || "I couldn't produce a response.",
      files: generatedFiles.length > 0 ? generatedFiles : undefined
    };
  } catch (error) {
    console.error("[junior] generateAssistantReply failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      text: "I hit an internal error while processing that request. Please try again."
    };
  }
}
