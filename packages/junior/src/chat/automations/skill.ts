/**
 * Skills that an Automation can run. Any discovered skill can run, also a
 * skill with `disable-model-invocation`, because the Automation names it.
 */
import { discoverSkills, type SkillMetadata } from "@/chat/skills";

/** Find an installed skill by name. */
export async function findAutomationSkill(
  name: string,
): Promise<SkillMetadata | undefined> {
  return (await discoverSkills()).find((skill) => skill.name === name);
}

/** Say why an Automation whose skill is gone cannot run. */
export function missingAutomationSkillReason(name: string): string {
  return `The skill ${name} is no longer installed. Choose another skill or switch to an instruction.`;
}
