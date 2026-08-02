import { z } from "zod";
import { getDb } from "@/chat/db";
import { createEventTask, getEventTask } from "@/chat/event-tasks/store";
import {
  buildEventTaskId,
  eventTaskMatchesDestination,
  eventTaskPrincipal,
  eventTaskSuccess,
  eventTaskToolResultSchema,
  eventTaskTriggerSchema,
  requireEventTaskSlackContext,
  requireSupportedEventTaskTrigger,
} from "@/chat/event-tasks/tool-support";
import type { EventTask } from "@/chat/event-tasks/types";
import {
  normalizeEventIdentifier,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create the core tool that stores an event task. */
export function createEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  const trigger = eventTaskTriggerSchema(catalog);
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Create a durable event task that executes the supplied instruction for every matching resource event. Use for whenever-this-happens-do-X automation; ordinary watch, notify, or tell-me-when requests use watchResourceEvents instead. The task remains active for this Slack channel or DM until deleted and may use the creator's connected credentials. Prefer a subscribable tool result when available.",
    inputSchema: z
      .object({
        task: z.string().trim().min(1).max(4000),
        trigger,
        credentialMode: z
          .enum(["creator", "system"])
          .describe(
            "Use creator to make the task creator's connected credentials available, or system when the creator says not to use them. Omit for the creator default.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        task: string;
        trigger: z.input<typeof trigger>;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, ...prepared } = input;
      return credentialMode === "system"
        ? { ...prepared, credentialMode }
        : prepared;
    },
    outputSchema: eventTaskToolResultSchema,
    async execute(input, options) {
      const { actor, destination, source } =
        requireEventTaskSlackContext(context);
      requireSupportedEventTaskTrigger(catalog, input.trigger);
      const id = buildEventTaskId({
        channelId: destination.channelId,
        teamId: destination.teamId,
        toolCallId: options.toolCallId,
        userId: actor.userId,
      });
      const db = getDb();
      const existing = await getEventTask(db, id);
      if (existing) {
        if (
          !eventTaskMatchesDestination(existing, destination) ||
          existing.createdBy.slackUserId !== actor.userId
        ) {
          throw new ToolInputError("Event task operation identity is invalid.");
        }
        return eventTaskSuccess(existing, catalog);
      }
      const task: EventTask = {
        id,
        destinationVisibility: source.visibility,
        createdAtMs: Date.now(),
        createdBy: eventTaskPrincipal(actor),
        credentialMode: input.credentialMode ?? "creator",
        destination,
        task: { text: input.task },
        trigger: {
          namespace: input.trigger.namespace,
          identifier: normalizeEventIdentifier(
            catalog,
            input.trigger.namespace,
            input.trigger.identifier,
          ),
          resourceType: input.trigger.resourceType,
          label: input.trigger.label,
          events: [...new Set(input.trigger.events)],
        },
      };
      return eventTaskSuccess(await createEventTask(db, task), catalog);
    },
  });
}
