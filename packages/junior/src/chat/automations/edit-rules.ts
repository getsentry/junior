/** Shared edit rules. Transport access checks run before these rules. */
import { isDeepStrictEqual } from "node:util";
import type { AutomationEditFields } from "./edit-schema";
import { resolveTaskOutcomes } from "@/chat/task-outcomes";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";

export class AutomationEditError extends ToolInputError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AutomationEditError";
  }
}

/** Apply shared title, instruction, outcome, and creator credential rules. */
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
  if (input.outcomes !== undefined && !isCreator) {
    throw new AutomationEditError(
      `Only the ${kind} automation creator can change message destinations.`,
      "outcomes",
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
  return {
    title: input.title ?? current.title,
    task: { text: input.instruction ?? current.task.text },
    credentialMode:
      changesExecution && !isCreator
        ? ("system" as const)
        : (input.credentialMode ?? current.credentialMode),
    outcomes,
  };
}
