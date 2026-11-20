/** Shared edit rules. Transport access checks run before these rules. */
import { isDeepStrictEqual } from "node:util";
import type { AutomationEditFields } from "./edit-schema";
import { resolveTaskOutcomes } from "@/chat/task-outcomes";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { findAutomationSkill } from "./skill";
import type { AutomationTask } from "./task";

export class AutomationEditError extends ToolInputError {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
    this.name = "AutomationEditError";
  }
}

/**
 * Only the creator can start work with creator credentials. Anyone who can
 * manage the Automation can switch it to system credentials, and then resume
 * it or run it now.
 */
export function requireCredentialStart(
  automation: EventAutomation | ScheduledAutomation,
  isCreator: boolean,
): void {
  if (isCreator || automation.credentialMode !== "creator") return;
  const kind = "schedule" in automation ? "scheduled" : "event";
  throw new AutomationEditError(
    `This ${kind} automation uses its creator's credentials. Only the creator can resume it or run it now. Switch it to system credentials first.`,
    "credentialMode",
  );
}

/** Return true when an edit changes what a run does. */
export function changesAutomationTask(
  current: AutomationTask,
  input: AutomationEditFields,
): boolean {
  return input.task !== undefined && !isDeepStrictEqual(input.task, current);
}

/**
 * Require a newly selected skill to be installed. A kept skill that is gone
 * stays, so other fields can still be saved; its runs block until someone
 * picks another skill.
 */
export async function requireAutomationSkill(
  task: AutomationTask,
  current: AutomationTask | undefined,
): Promise<void> {
  if (task.kind !== "skill") return;
  if (current?.kind === "skill" && current.skill === task.skill) return;
  if (await findAutomationSkill(task.skill)) return;
  throw new AutomationEditError(
    `The skill ${task.skill} is not installed. Choose an installed skill.`,
    "task.skill",
  );
}

/**
 * Apply shared title, task, outcome, and creator credential rules.
 * Anyone who can manage the Automation can change any field except turning on
 * creator credentials. A non-creator change to execution or outcomes switches
 * it to system credentials, so creator credential output stays where the
 * creator approved.
 */
export async function editAutomationFields(
  current: EventAutomation | ScheduledAutomation,
  input: AutomationEditFields,
  isCreator: boolean,
  changesExecution: boolean,
) {
  const kind = "schedule" in current ? "scheduled" : "event";
  if (input.credentialMode === "creator" && !isCreator) {
    throw new AutomationEditError(
      `Only the ${kind} automation creator can enable creator credential use.`,
      "credentialMode",
    );
  }
  let outcomes = current.outcomes;
  if (input.outcomes !== undefined) {
    // Validate all retained Destinations before resolving any new creator DM.
    for (const outcome of input.outcomes) {
      if (
        typeof outcome.destination !== "string" &&
        !current.outcomes.some((stored) => isDeepStrictEqual(stored, outcome))
      ) {
        throw new AutomationEditError(
          "Use the current Destination or the creator for a new message outcome.",
          "outcomes",
        );
      }
    }
    outcomes = [];
    for (const outcome of input.outcomes) {
      if (typeof outcome.destination === "string") {
        outcomes.push(
          ...(await resolveTaskOutcomes(
            [{ action: outcome.action, destination: outcome.destination }],
            current.destination,
            current.createdBy.slackUserId,
          )),
        );
      } else {
        outcomes.push({
          action: outcome.action,
          destination: outcome.destination,
        });
      }
    }
  }
  const task = input.task ?? current.task;
  await requireAutomationSkill(task, current.task);
  const changesOutcomes = !isDeepStrictEqual(outcomes, current.outcomes);
  return {
    title: input.title ?? current.title,
    task,
    credentialMode:
      (changesExecution || changesOutcomes) && !isCreator
        ? ("system" as const)
        : (input.credentialMode ?? current.credentialMode),
    outcomes,
  };
}
