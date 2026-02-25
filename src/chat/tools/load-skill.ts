import { tool } from "ai";
import { z } from "zod";
import { loadSkillsByName, type SkillMetadata } from "@/chat/skills";

export function createLoadSkillTool(availableSkills: SkillMetadata[]) {
  return tool({
    description: "Load a named skill and return its instructions to the reasoning context.",
    inputSchema: z.object({
      skill_name: z.string().min(1)
    }),
    execute: async ({ skill_name }) => {
      const requested = skill_name.trim().toLowerCase();
      const meta =
        availableSkills.find((skill) => skill.name.toLowerCase() === requested) ?? null;
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
        skill_dir: skill.skillPath,
        location: `${skill.skillPath}/SKILL.md`,
        instructions: skill.body
      };
    }
  });
}
