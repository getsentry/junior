import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import type { Sandbox } from "@vercel/sandbox";
import type { SkillMetadata } from "@/chat/skills";

export type LoadSkillResult = {
  ok?: boolean;
  error?: string;
  available_skills?: string[];
  skill_name?: string;
  description?: string;
  skill_dir?: string;
  location?: string;
  instructions?: string;
};

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) {
    return raw;
  }
  const match = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  if (!match) {
    return raw;
  }
  return raw.slice(match[0].length);
}

export async function loadSkillFromSandbox(
  sandbox: Sandbox,
  availableSkills: SkillMetadata[],
  skillName: string
): Promise<LoadSkillResult> {
  const requested = skillName.trim().toLowerCase();
  const skill = availableSkills.find((entry) => entry.name.toLowerCase() === requested);
  if (!skill) {
    return {
      ok: false,
      error: `Unknown skill: ${skillName}`,
      available_skills: availableSkills.map((entry) => entry.name)
    };
  }

  const skillDir = `/workspace/skills/${skill.name}`;
  const skillFilePath = `${skillDir}/SKILL.md`;
  const file = await sandbox.readFileToBuffer({ path: skillFilePath });
  if (!file) {
    throw new Error(`failed to read ${skillFilePath}`);
  }

  return {
    ok: true,
    skill_name: skill.name,
    description: skill.description,
    skill_dir: skillDir,
    location: skillFilePath,
    instructions: stripFrontmatter(file.toString("utf8"))
  };
}

export function createLoadSkillTool(sandbox: Sandbox, availableSkills: SkillMetadata[]) {
  return tool({
    description: "Load a named skill and return its instructions to the reasoning context.",
    inputSchema: Type.Object({
      skill_name: Type.String({
        minLength: 1,
        description: "Skill name to load, without the leading slash."
      })
    }),
    execute: async ({ skill_name }) => {
      return await loadSkillFromSandbox(sandbox, availableSkills, skill_name);
    }
  });
}
