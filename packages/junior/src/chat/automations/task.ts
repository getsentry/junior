/**
 * The work of an Automation run. In instruction mode, `text` is the
 * instruction. In skill mode, `skill` names the skill that each run invokes,
 * and `text` is optional context that can be empty.
 */
import * as z from "zod";

/** A skill name, in the form that skill frontmatter allows. */
export const automationSkillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a skill name, such as tpm.");

/** Validate the stored task of either Automation kind. */
export const automationTaskSchema = z
  .object({
    text: z.string(),
    skill: automationSkillNameSchema.optional(),
  })
  .strict();

export type AutomationTask = z.output<typeof automationTaskSchema>;

/** Return true when the task names work: an instruction or a skill. */
export function hasAutomationWork(task: AutomationTask): boolean {
  return task.skill !== undefined || task.text.trim().length > 0;
}

/**
 * Describe the work in one plain text. Title fallback, title generation,
 * cards, and the searchable `instruction` column use it, so a skill-mode
 * Automation shows and finds its skill.
 */
export function automationTaskDescription(task: AutomationTask): string {
  if (!task.skill) return task.text;
  const context = task.text.trim();
  return context
    ? `Run the ${task.skill} skill. ${context}`
    : `Run the ${task.skill} skill.`;
}
