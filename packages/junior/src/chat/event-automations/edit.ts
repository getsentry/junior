/** Shared event Automation edits. Plugins own event and match validation. */
import { eventAutomationEditSchema } from "@/chat/automations/edit-schema";
import { stableEventMatchKey } from "@sentry/junior-plugin-api";
import {
  AutomationEditError,
  editAutomationFields,
} from "@/chat/automations/edit-rules";
import {
  requireEventIdentifier,
  type EventCatalog,
} from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { requireSupportedEventAutomationTrigger } from "./tool-support";
import type { EventAutomation } from "./types";
import type { z } from "zod";

function changesEventAutomationTrigger(
  current: EventAutomation["trigger"],
  next: EventAutomation["trigger"],
): boolean {
  const currentEvents = [...current.events].sort();
  const nextEvents = [...next.events].sort();
  return (
    current.namespace !== next.namespace ||
    current.identifier !== next.identifier ||
    currentEvents.length !== nextEvents.length ||
    currentEvents.some((event, index) => event !== nextEvents[index]) ||
    stableEventMatchKey(current.match) !== stableEventMatchKey(next.match)
  );
}

/** Build a validated edit while retaining an unchanged, possibly unavailable trigger. */
export async function editEventAutomation(
  current: EventAutomation,
  input: z.output<typeof eventAutomationEditSchema>,
  isCreator: boolean,
  catalog: EventCatalog,
): Promise<EventAutomation> {
  let trigger = current.trigger;
  if (input.trigger !== undefined) {
    // An unchanged selector may contain a now-unsupported match field. Keep it.
    if (
      changesEventAutomationTrigger(current.trigger, input.trigger) ||
      current.trigger.resourceType !== input.trigger.resourceType
    ) {
      try {
        const match = requireSupportedEventAutomationTrigger(
          catalog,
          input.trigger,
        );
        trigger = {
          ...input.trigger,
          identifier: requireEventIdentifier(catalog, input.trigger),
          events: [...new Set(input.trigger.events)],
          match,
        };
      } catch (error) {
        if (error instanceof ToolInputError)
          throw new AutomationEditError(error.message, "trigger");
        throw error;
      }
    } else {
      trigger = { ...current.trigger, label: input.trigger.label };
    }
  }
  const changesExecution =
    (input.instruction !== undefined &&
      input.instruction !== current.task.text) ||
    changesEventAutomationTrigger(current.trigger, trigger);
  return {
    ...current,
    ...(await editAutomationFields(
      current,
      input,
      isCreator,
      changesExecution,
    )),
    trigger,
  };
}
