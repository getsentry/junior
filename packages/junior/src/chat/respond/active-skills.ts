import type { Skill } from "@/chat/skills";

/** Upsert a skill into the active skills list by name. */
export function upsertActiveSkill(activeSkills: Skill[], next: Skill): void {
  const existing = activeSkills.find((skill) => skill.name === next.name);
  if (existing) {
    existing.body = next.body;
    existing.description = next.description;
    existing.skillPath = next.skillPath;
    existing.allowedTools = next.allowedTools;
    existing.pluginProvider = next.pluginProvider;
    return;
  }

  activeSkills.push(next);
}
