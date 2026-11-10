/**
 * The work of an Automation run. An Automation runs either a written
 * instruction or a skill. A skill can have context: what the Automation
 * needs beyond the skill.
 */
import * as z from "zod";

/** A skill name, in the form that skill frontmatter allows. */
export const automationSkillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a skill name, such as tpm.");

/** Text of an instruction or a context, trimmed and not empty. */
export const automationTaskTextSchema = z
  .string()
  .trim()
  .min(1, "Write at least one word.")
  .max(4000);

/** Validate the stored task of either Automation kind. */
export const automationTaskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("instruction"),
      instruction: automationTaskTextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("skill"),
      skill: automationSkillNameSchema,
      /** Absent when the skill needs nothing more. */
      context: automationTaskTextSchema.optional(),
    })
    .strict(),
]);

export type AutomationTask = z.output<typeof automationTaskSchema>;

/** Return the written text of a task: its instruction or its context. */
export function automationTaskText(task: AutomationTask): string | undefined {
  return task.kind === "instruction" ? task.instruction : task.context;
}

/**
 * Describe the work in one plain text for title fallback, title generation,
 * and cards, so a skill-mode Automation shows its skill. Do not store it.
 */
export function automationTaskDescription(task: AutomationTask): string {
  if (task.kind === "instruction") return task.instruction;
  return task.context
    ? `Run the ${task.skill} skill. ${task.context}`
    : `Run the ${task.skill} skill.`;
}

/** Return the `instruction` and `skill` columns of a task. One is null. */
export function automationTaskColumns(task: AutomationTask) {
  return task.kind === "instruction"
    ? { instruction: task.instruction, skill: null }
    : { instruction: null, skill: task.skill };
}
