import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import type { Sandbox } from "@vercel/sandbox";
import { sandboxSkillDir } from "@/chat/sandbox/paths";
import { stripFrontmatter } from "@/chat/skill-frontmatter";
import type { Skill, SkillMetadata } from "@/chat/skills";
import type { ExposedToolSummary } from "@/chat/tools/mcp-tool-summary";

export type LoadSkillResult = {
  ok?: boolean;
  error?: string;
  available_skills?: string[];
  skill_name?: string;
  description?: string;
  skill_dir?: string;
  location?: string;
  instructions?: string;
  available_tools?: ExposedToolSummary[];
  tool_search_available?: boolean;
};

export type LoadSkillMetadata = Pick<
  LoadSkillResult,
  "available_tools" | "tool_search_available"
>;

function toLoadedSkill(
  result: LoadSkillResult,
  availableSkills: SkillMetadata[],
): Skill | null {
  if (
    result.ok !== true ||
    typeof result.skill_name !== "string" ||
    typeof result.description !== "string" ||
    typeof result.skill_dir !== "string" ||
    typeof result.instructions !== "string"
  ) {
    return null;
  }

  const metadata =
    availableSkills.find((skill) => skill.name === result.skill_name) ?? null;

  return {
    name: result.skill_name,
    description: result.description,
    skillPath: result.skill_dir,
    ...(metadata?.pluginProvider
      ? { pluginProvider: metadata.pluginProvider }
      : {}),
    ...(metadata?.allowedTools ? { allowedTools: metadata.allowedTools } : {}),
    ...(metadata?.requiresCapabilities
      ? { requiresCapabilities: metadata.requiresCapabilities }
      : {}),
    ...(metadata?.usesConfig ? { usesConfig: metadata.usesConfig } : {}),
    body: result.instructions,
  };
}

export async function loadSkillFromSandbox(
  sandbox: Sandbox,
  availableSkills: SkillMetadata[],
  skillName: string,
): Promise<LoadSkillResult> {
  const requested = skillName.trim().toLowerCase();
  const skill = availableSkills.find(
    (entry) => entry.name.toLowerCase() === requested,
  );
  if (!skill) {
    return {
      ok: false,
      error: `Unknown skill: ${skillName}`,
      available_skills: availableSkills.map((entry) => entry.name),
    };
  }

  const skillDir = sandboxSkillDir(skill.name);
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
    instructions: stripFrontmatter(file.toString("utf8")),
  };
}

export function createLoadSkillTool(
  sandbox: Sandbox,
  availableSkills: SkillMetadata[],
  options?: {
    onSkillLoaded?: (
      skill: Skill,
    ) => void | LoadSkillMetadata | Promise<void | LoadSkillMetadata>;
  },
) {
  return tool({
    description:
      "Load a skill by name so its instructions are available for this turn. When the skill exposes MCP tools, the result includes `available_tools` with exact tool_name values and argument schemas for this turn. Use when a request clearly matches a known skill. Do not use when no skill is relevant.",
    inputSchema: Type.Object({
      skill_name: Type.String({
        minLength: 1,
        description: "Skill name to load, without the leading slash.",
      }),
    }),
    execute: async ({ skill_name }) => {
      const result = await loadSkillFromSandbox(
        sandbox,
        availableSkills,
        skill_name,
      );
      const loadedSkill = toLoadedSkill(result, availableSkills);
      if (loadedSkill) {
        const metadata = await options?.onSkillLoaded?.(loadedSkill);
        if (metadata) {
          Object.assign(result, metadata);
        }
      }
      return result;
    },
  });
}
