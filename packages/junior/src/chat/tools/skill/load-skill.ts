import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { sandboxSkillDir, sandboxSkillFile } from "@/chat/sandbox/paths";
import {
  loadSkillsByName,
  type Skill,
  type SkillMetadata,
} from "@/chat/skills";

export type LoadSkillResult = {
  ok?: boolean;
  error?: string;
  available_skills?: string[];
  skill_name?: string;
  description?: string;
  skill_dir?: string;
  location?: string;
  instructions?: string;
  mcp_provider?: string;
  available_tool_count?: number;
};

export type LoadSkillMetadata = Pick<
  LoadSkillResult,
  "mcp_provider" | "available_tool_count"
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
    skillPath: metadata?.skillPath ?? result.skill_dir,
    ...(metadata?.pluginProvider
      ? { pluginProvider: metadata.pluginProvider }
      : {}),
    ...(metadata?.allowedTools ? { allowedTools: metadata.allowedTools } : {}),
    body: result.instructions,
  };
}

async function loadSkillFromHost(
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
  const skillFilePath = sandboxSkillFile(skill.name);
  const [loaded] = await loadSkillsByName([skill.name], availableSkills);
  if (!loaded) {
    throw new Error(`failed to load ${skill.name}`);
  }

  return {
    ok: true,
    skill_name: skill.name,
    description: skill.description,
    skill_dir: skillDir,
    location: skillFilePath,
    instructions: loaded.body,
  };
}

/** Create the skill-loading tool that injects skill instructions and activates provider catalogs. */
export function createLoadSkillTool(
  availableSkills: SkillMetadata[],
  options?: {
    onSkillLoaded?: (
      skill: Skill,
    ) => void | LoadSkillMetadata | Promise<void | LoadSkillMetadata>;
  },
) {
  return tool({
    description:
      "Load a skill by name so its instructions and provider tool catalog are available for this turn. When the result includes mcp_provider and available_tool_count, use searchMcpTools to list or search descriptors before callMcpTool. Use when a request clearly matches a known skill.",
    inputSchema: Type.Object({
      skill_name: Type.String({
        minLength: 1,
        description: "Skill name to load, without the leading slash.",
      }),
    }),
    execute: async ({ skill_name }) => {
      const result = await loadSkillFromHost(availableSkills, skill_name);
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
