import { tool } from "@/chat/tools/definition";
import { z } from "zod";
import { loadSkillsByName, type SkillMetadata } from "@/chat/skills";
import { getSkillSandbox } from "@/chat/skill-sandbox";

export function createLoadSkillTool(availableSkills: SkillMetadata[]) {
  return tool({
    description: "Load a named skill and return its instructions to the reasoning context.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .min(1)
        .describe("Skill name to load, without the leading slash.")
    }),
    execute: async ({ skill_name }, options) => {
      const sandboxResult = getSkillSandbox(options.experimental_context);
      if (sandboxResult.ok) {
        const skill = await sandboxResult.sandbox.loadSkill(skill_name);
        if (!skill) {
          return {
            ok: false,
            error: `Unknown skill: ${skill_name}`,
            available_skills: sandboxResult.sandbox.getAvailableSkills().map((entry) => entry.name)
          };
        }

        return {
          ok: true,
          skill_name: skill.name,
          description: skill.description,
          skill_dir: skill.skillPath,
          location: `${skill.skillPath}/SKILL.md`,
          instructions: skill.body
        };
      }

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
