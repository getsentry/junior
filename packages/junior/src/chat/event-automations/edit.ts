/** Shared event Automation edits. Plugins own event and match validation. */
import { eventAutomationEditSchema } from "@/chat/automations/edit-schema";
import { stableEventMatchKey } from "@sentry/junior-plugin-api";
import {
  AutomationEditError,
  editAutomationFields,
} from "@/chat/automations/edit-rules";
import type { EventCatalog } from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { requireSlackChannelMessageScope } from "@/chat/slack/channel-message-events";
import { requireEventAutomationTrigger } from "./tool-support";
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

/**
 * Edit input. Tools and the dashboard send a trigger with no identifier. Only
 * a restored version passes a saved trigger, which can still have one.
 */
type EventAutomationEditInput = Omit<
  z.output<typeof eventAutomationEditSchema>,
  "trigger"
> & { trigger?: EventAutomation["trigger"] };

/**
 * Build a validated edit while retaining an unchanged, possibly unavailable
 * trigger. A changed trigger replaces the saved one whole, so a saved trigger
 * with an identifier loses it only when the edit names new events or filters.
 */
export async function editEventAutomation(
  current: EventAutomation,
  input: EventAutomationEditInput,
  isCreator: boolean,
  catalog: EventCatalog,
): Promise<EventAutomation> {
  let trigger = current.trigger;
  if (input.trigger !== undefined) {
    // The saved events and filters with no identifier only rename a trigger
    // that has one. Dropping its identifier would make it broader.
    const compared =
      input.trigger.identifier === undefined
        ? {
            ...input.trigger,
            identifier: current.trigger.identifier,
            resourceType: current.trigger.resourceType,
          }
        : input.trigger;
    // An unchanged selector may contain a now-unsupported match field. Keep it.
    if (
      changesEventAutomationTrigger(current.trigger, compared) ||
      current.trigger.resourceType !== compared.resourceType
    ) {
      try {
        trigger = requireEventAutomationTrigger(catalog, input.trigger);
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
  const next: EventAutomation = {
    ...current,
    ...(await editAutomationFields(
      current,
      input,
      isCreator,
      changesExecution,
    )),
    trigger,
  };
  try {
    return requireSlackChannelMessageScope(next);
  } catch (error) {
    if (error instanceof ToolInputError)
      throw new AutomationEditError(error.message, "trigger");
    throw error;
  }
}
