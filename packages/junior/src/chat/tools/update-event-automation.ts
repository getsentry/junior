import { stableEventMatchKey } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveEventAutomation } from "@/chat/event-automations/store";
import {
  eventAutomationSuccess,
  eventAutomationToolResultSchema,
  registeredEventAutomationTriggerSchema,
  requireEventAutomationSlackContext,
  requireSupportedEventAutomationTrigger,
  writableEventAutomation,
} from "@/chat/event-automations/tool-support";
import type { EventAutomation } from "@/chat/event-automations/types";
import { completeText } from "@/chat/pi/client";
import {
  normalizeCatalogEventIdentifier,
  type EventCatalog,
} from "@/chat/events/catalog";
import { generateShortTitle } from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  resolveTaskOutcomes,
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Return whether an edit changes the task's executable event source. */
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

/** Create the core tool that updates an event automation. */
export function createUpdateEventAutomationTool(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Update the instruction, registered trigger, or credential use for an event automation.",
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        task: z.string().trim().min(1).max(4000).nullable().optional(),
        trigger: registeredEventAutomationTriggerSchema(catalog)
          .nullable()
          .optional(),
        outcomes: z
          .array(taskOutcomeInputSchema)
          .max(5)
          .nullable()
          .describe(
            "Replacement messages to send after successful work. Use an empty list to send nothing. Omit or use null to leave unchanged.",
          )
          .optional(),
        credentialMode: z
          .enum(["system", "creator"])
          .nullable()
          .describe(
            "Set creator to make the task's original creator credentials available, or system to disable them. Creator always means the task's createdBy actor, never the current requester. Only that original creator may enable creator mode. Omit or use null to leave unchanged.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        taskId: string;
        task?: string | null;
        trigger?: z.input<
          ReturnType<typeof registeredEventAutomationTriggerSchema>
        > | null;
        outcomes?: TaskOutcomeInput[] | null;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, outcomes, task, trigger, ...prepared } = input;
      return {
        ...prepared,
        ...(task != null ? { task } : undefined),
        ...(trigger != null ? { trigger } : undefined),
        ...(outcomes != null ? { outcomes } : undefined),
        ...(credentialMode != null ? { credentialMode } : undefined),
      };
    },
    outputSchema: eventAutomationToolResultSchema,
    async execute(input) {
      const current = await writableEventAutomation(context, input.taskId);
      const match = input.trigger
        ? requireSupportedEventAutomationTrigger(catalog, input.trigger)
        : undefined;
      const { actor } = requireEventAutomationSlackContext(context);
      const isCreator = actor.userId === current.createdBy.slackUserId;
      if (input.credentialMode === "creator" && !isCreator) {
        throw new ToolInputError(
          "Only the event automation creator can enable creator credential use.",
        );
      }
      // TODO(dcramer): Allow public Automation members to change outcomes after
      // shared policy or the web UI can authorize the new Destination safely.
      if (input.outcomes != null && !isCreator) {
        throw new ToolInputError(
          "Only the event automation creator can change message destinations.",
        );
      }
      if (
        input.task === undefined &&
        input.trigger === undefined &&
        input.outcomes == null &&
        input.credentialMode == null
      ) {
        throw new ToolInputError("Event automation update requires a change.");
      }
      const nextTrigger = input.trigger
        ? {
            namespace: input.trigger.namespace,
            identifier: normalizeCatalogEventIdentifier(
              catalog,
              input.trigger.namespace,
              input.trigger.identifier,
            ),
            resourceType: input.trigger.resourceType,
            label: input.trigger.label,
            events: [...new Set(input.trigger.events)],
            ...(match ? { match } : undefined),
          }
        : current.trigger;
      const nextInstruction =
        input.task != null ? input.task : current.task.text;
      const instructionChanged = nextInstruction !== current.task.text;
      const changesExecution =
        instructionChanged ||
        changesEventAutomationTrigger(current.trigger, nextTrigger);
      const next: EventAutomation = {
        ...current,
        credentialMode:
          changesExecution && !isCreator
            ? "system"
            : (input.credentialMode ?? current.credentialMode),
        outcomes:
          input.outcomes == null
            ? current.outcomes
            : await resolveTaskOutcomes(
                input.outcomes,
                current.destination,
                current.createdBy.slackUserId,
              ),
        task: { text: nextInstruction },
        trigger: nextTrigger,
      };
      if (instructionChanged) {
        const title = await generateShortTitle({
          completeText,
          kind: "task",
          sourceText: nextInstruction,
        });
        if (title) next.title = title;
        else delete next.title;
      }
      const saved = await saveEventAutomation(getDb(), next);
      if (!saved) {
        throw new ToolInputError("Event automation was not found.");
      }
      return eventAutomationSuccess(saved, catalog);
    },
  });
}
