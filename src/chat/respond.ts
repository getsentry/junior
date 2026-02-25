import { generateText, gateway, stepCountIs } from "ai";
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

export async function generateAssistantReply(messageText: string, context: ReplyRequestContext = {}): Promise<string> {
  try {
    const availableSkills = await discoverSkills();
    const invocation = parseSkillInvocation(messageText);
    const invokedSkill = invocation ? findSkillByName(invocation.skillName, availableSkills) : null;

    if (invocation && !invokedSkill) {
      const skills = availableSkills.map((skill) => `/${skill.name}`).join(", ") || "(none configured)";
      return `Unknown skill: /${invocation.skillName}\nAvailable skills: ${skills}`;
    }

    const activeSkillNames = invokedSkill ? [invokedSkill.name] : [];
    const activeSkills = await loadSkillsByName(activeSkillNames, availableSkills);
    const userInput = invocation ? invocation.args : messageText;

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
      tools: createTools(availableSkills)
    });

    return result.text || "I couldn't produce a response.";
  } catch (error) {
    console.error("[shim] generateAssistantReply failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return "I hit an internal error while processing that request. Please try again.";
  }
}
