import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  sandboxSkillDir,
  sandboxSkillFile,
  sandboxSkillPathResolution,
} from "@/chat/sandbox/paths";
import { skillReferences } from "@/chat/skill-references";
import {
  loadSkillsByName,
  type Skill,
  type SkillMetadata,
} from "@/chat/skills";

export type LoadSkillResult = {
  skill_name?: string;
  description?: string;
  skill_dir?: string;
  working_directory?: string;
  location?: string;
  path_resolution?: string;
  instructions?: string;
  loadable_skills?: string[];
} & Record<string, unknown>;

function toLoadedSkill(
  result: LoadSkillResult,
  availableSkills: SkillMetadata[],
): Skill | null {
  if (
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
      : undefined),
    ...(metadata?.allowedTools
      ? { allowedTools: metadata.allowedTools }
      : undefined),
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
    throw new ToolInputError(
      `Unknown skill: ${skillName}. Available skills: ${availableSkills
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }

  const skillDir = sandboxSkillDir(skill.name);
  const skillFilePath = sandboxSkillFile(skill.name);
  const [loaded] = await loadSkillsByName([skill.name], availableSkills);
  if (!loaded) {
    throw new Error(`failed to load ${skill.name}`);
  }

  return {
    skill_name: skill.name,
    description: skill.description,
    skill_dir: skillDir,
    working_directory: skillDir,
    location: skillFilePath,
    path_resolution: sandboxSkillPathResolution(skill.name),
    instructions: loaded.body,
  };
}

/**
 * Create the tool that loads skill instructions for the current turn.
 *
 * @runBuilt loadSkill
 */
export function createLoadSkillTool(
  availableSkills: SkillMetadata[],
  options?: {
    onSkillLoaded?: ((skill: Skill) => void | Promise<void>) | undefined;
  },
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Load a skill by name for this turn. The result includes working_directory; resolve skill paths there and run skill-owned bash commands from there or with absolute paths. When the skill instructions name an MCP provider, use searchMcpTools before callMcpTool. Use when a request clearly matches a known skill.",
    inputSchema: z.object({
      skill_name: z
        .string()
        .min(1)
        .describe("Skill name to load, without the leading `$`."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ skill_name }) => {
      const result = await loadSkillFromHost(availableSkills, skill_name);
      const loadedSkill = toLoadedSkill(result, availableSkills);
      if (loadedSkill) {
        await options?.onSkillLoaded?.(loadedSkill);
      }
      // `availableSkills` holds the manual-only skills that this skill
      // references, but `<available-skills>` leaves them out, so name them
      // here.
      const loadable = skillReferences(
        result.instructions ?? "",
        availableSkills,
      ).filter(
        (name) =>
          name !== result.skill_name &&
          availableSkills.some(
            (skill) => skill.name === name && skill.disableModelInvocation,
          ),
      );
      return loadable.length > 0
        ? { ...result, loadable_skills: loadable }
        : result;
    },
  });
}
