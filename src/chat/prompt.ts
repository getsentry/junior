import type { Skill, SkillMetadata, SkillInvocation } from "@/chat/skills";
import { renderActiveSkillsXml, renderSkillsHarnessXml } from "@/chat/skills";

function baseSystemPrompt(): string {
  return [
    "You are shim, a general-purpose helper assistant for Slack.",
    "Be concise, practical, and specific.",
    "Prefer actionable next steps over generic explanations.",
    "If data is missing, ask for the exact identifier you need.",
    "When active skills are provided, follow their instructions before default behavior."
  ].join(" ");
}

export function buildSystemPrompt(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  invocation: SkillInvocation | null;
}): string {
  const { availableSkills, activeSkills, invocation } = params;

  return [
    baseSystemPrompt(),
    "Tooling policy: use load_skill when task-specific instructions are needed; use web_search to discover sources; use web_fetch to inspect specific pages.",
    "If the user enters /<skill-name>, that is always an explicit command to run that skill.",
    renderSkillsHarnessXml(availableSkills),
    renderActiveSkillsXml(activeSkills),
    invocation
      ? `Slash invocation detected for /${invocation.skillName}. Treat this as an explicit skill request.`
      : "No slash skill invocation detected."
  ].join("\n\n");
}
