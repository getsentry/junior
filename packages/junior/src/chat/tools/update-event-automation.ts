import {
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes-schema";
import {
  automationTitleSchema,
  automationInstructionToolSchema,
} from "@/chat/automations/edit-schema";
import { automationRevision } from "@/chat/automations/revision";
import { editEventAutomation } from "@/chat/event-automations/edit";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveEventAutomation } from "@/chat/event-automations/store";
import {
  eventAutomationToolResult,
  eventAutomationToolResultSchema,
  registeredEventAutomationTriggerSchema,
  requireEventAutomationSlackContext,
  writableEventAutomation,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

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
        automationId: z.string().min(1),
        title: automationTitleSchema.optional(),
        instruction: automationInstructionToolSchema.nullable().optional(),
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
        automationId: string;
        instruction?: string | null;
        trigger?: z.input<
          ReturnType<typeof registeredEventAutomationTriggerSchema>
        > | null;
        outcomes?: TaskOutcomeInput[] | null;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, outcomes, instruction, trigger, ...prepared } =
        input;
      return {
        ...prepared,
        ...(instruction != null ? { instruction } : undefined),
        ...(trigger != null ? { trigger } : undefined),
        ...(outcomes != null ? { outcomes } : undefined),
        ...(credentialMode != null ? { credentialMode } : undefined),
      };
    },
    outputSchema: eventAutomationToolResultSchema,
    async execute(input) {
      const current = await writableEventAutomation(
        context,
        input.automationId,
      );
      const { actor } = requireEventAutomationSlackContext(context);
      const isCreator = actor.userId === current.createdBy.slackUserId;
      if (
        input.title === undefined &&
        input.instruction === undefined &&
        input.trigger === undefined &&
        input.outcomes == null &&
        input.credentialMode == null
      ) {
        throw new ToolInputError("Event automation update requires a change.");
      }
      const next = await editEventAutomation(
        current,
        {
          title: input.title,
          instruction: input.instruction ?? undefined,
          trigger: input.trigger ?? undefined,
          outcomes: input.outcomes ?? undefined,
          credentialMode: input.credentialMode ?? undefined,
        },
        isCreator,
        catalog,
      );
      const saved = await saveEventAutomation(
        getDb(),
        next,
        automationRevision(current),
        {
          slackUserId: actor.userId,
          ...(actor.fullName ? { fullName: actor.fullName } : undefined),
          ...(actor.userName ? { userName: actor.userName } : undefined),
        },
      );
      if (!saved) {
        throw new ToolInputError("Event automation was not found.");
      }
      return eventAutomationToolResult(
        context.conversationId,
        saved,
        catalog,
        actor.userId,
      );
    },
  });
}
