import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveEventTask } from "@/chat/event-tasks/store";
import {
  eventTaskSuccess,
  eventTaskToolResultSchema,
  registeredEventTaskTriggerSchema,
  requireEventTaskSlackContext,
  requireSupportedEventTaskTrigger,
  writableEventTask,
} from "@/chat/event-tasks/tool-support";
import type { EventTask } from "@/chat/event-tasks/types";
import { completeText } from "@/chat/pi/client";
import {
  normalizeEventIdentifier,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { generateShortTitle } from "@/chat/services/short-title";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Return whether an edit changes the task's executable event source. */
function changesEventTaskTrigger(
  current: EventTask["trigger"],
  next: EventTask["trigger"],
): boolean {
  const currentEvents = [...current.events].sort();
  const nextEvents = [...next.events].sort();
  return (
    current.namespace !== next.namespace ||
    current.identifier !== next.identifier ||
    currentEvents.length !== nextEvents.length ||
    currentEvents.some((event, index) => event !== nextEvents[index])
  );
}

/** Create the core tool that updates an event task in this destination. */
export function createUpdateEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
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
      "Update the instruction, registered trigger, or credential use for an event task in this Slack channel or DM. Event tasks created from other threads in the same destination are manageable here.",
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        task: z.string().trim().min(1).max(4000).nullable().optional(),
        trigger: registeredEventTaskTriggerSchema(catalog)
          .nullable()
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
          ReturnType<typeof registeredEventTaskTriggerSchema>
        > | null;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, task, trigger, ...prepared } = input;
      return {
        ...prepared,
        ...(task != null ? { task } : {}),
        ...(trigger != null ? { trigger } : {}),
        ...(credentialMode != null ? { credentialMode } : {}),
      };
    },
    outputSchema: eventTaskToolResultSchema,
    async execute(input) {
      const current = await writableEventTask(context, input.taskId);
      if (input.trigger) {
        requireSupportedEventTaskTrigger(catalog, input.trigger);
      }
      const { actor } = requireEventTaskSlackContext(context);
      const isCreator = actor.userId === current.createdBy.slackUserId;
      if (input.credentialMode === "creator" && !isCreator) {
        throw new ToolInputError(
          "Only the event task creator can enable creator credential use.",
        );
      }
      if (
        input.task === undefined &&
        input.trigger === undefined &&
        input.credentialMode == null
      ) {
        throw new ToolInputError("Event task update requires a change.");
      }
      const nextTrigger = input.trigger
        ? {
            namespace: input.trigger.namespace,
            identifier: normalizeEventIdentifier(
              catalog,
              input.trigger.namespace,
              input.trigger.identifier,
            ),
            resourceType: input.trigger.resourceType,
            label: input.trigger.label,
            events: [...new Set(input.trigger.events)],
          }
        : current.trigger;
      const nextInstruction =
        input.task != null ? input.task : current.task.text;
      const instructionChanged = nextInstruction !== current.task.text;
      const changesExecution =
        instructionChanged ||
        changesEventTaskTrigger(current.trigger, nextTrigger);
      const next: EventTask = {
        ...current,
        credentialMode:
          changesExecution && !isCreator
            ? "system"
            : (input.credentialMode ?? current.credentialMode),
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
      const saved = await saveEventTask(getDb(), next);
      if (!saved) {
        throw new ToolInputError(
          "Event task was not found in this Slack channel or DM.",
        );
      }
      return eventTaskSuccess(saved, catalog);
    },
  });
}
