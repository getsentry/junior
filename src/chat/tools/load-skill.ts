import { tool } from "ai";
import { z } from "zod";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";

export function createLoadSkillTool(availableSkills: SkillMetadata[]) {
  return tool({
    description: "Load a named skill and return its instructions to the reasoning context.",
    inputSchema: z.object({
      skill_name: z.string().min(1)
    }),
    execute: async ({ skill_name }) => {
      const meta = findSkillByName(skill_name, availableSkills);
      if (!meta) {
        return {
          ok: false,
          error: `Unknown skill: ${skill_name}`,
          available_skills: availableSkills.map((skill) => skill.name)
        };
      }

      const [skill] = await loadSkillsByName([meta.name], availableSkills);

      return {
        ok: true,
        skill_name: skill.name,
        description: skill.description,
        location: `${skill.skillPath}/SKILL.md`,
        instructions: skill.body
      };
    }
  });
}
