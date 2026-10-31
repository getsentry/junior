import {
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes-schema";
import {
  automationTitleSchema,
  automationInstructionToolSchema,
} from "@/chat/automations/edit-schema";
import { requireRequesterMention } from "@/chat/automations/requester-mention";
import { changeAutomationLifecycle } from "@/chat/automations/edit";
import { automationRevision } from "@/chat/automations/revision";
import {
  requireToolAutomation,
  slackToolViewer,
} from "@/chat/automations/tool-access";
import { editEventAutomation } from "@/chat/event-automations/edit";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { saveEventAutomation } from "@/chat/event-automations/store";
import {
  eventAutomationToolResult,
  eventAutomationToolResultSchema,
  registeredEventAutomationTriggerSchema,
  requireEventAutomationSlackContext,
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
      "Update the instruction, registered trigger, credential use, or status of an event automation. Anyone in the workspace can update an automation in a public channel. Automations in private channels and DMs can be updated from there or by their creator. A non-creator who changes the instruction or trigger switches it to system credentials.",
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
        status: z
          .enum(["active", "paused"])
          .nullable()
          .describe(
            "Set active to resume a paused or blocked automation, or paused to stop it. When it uses its creator's credentials, only the creator can resume it. Omit or use null to leave unchanged.",
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
        status?: "active" | "paused" | null;
      };
      const {
        credentialMode,
        outcomes,
        instruction,
        trigger,
        status,
        ...prepared
      } = input;
      return {
        ...prepared,
        ...(instruction != null ? { instruction } : undefined),
        ...(trigger != null ? { trigger } : undefined),
        ...(outcomes != null ? { outcomes } : undefined),
        ...(credentialMode != null ? { credentialMode } : undefined),
        ...(status != null ? { status } : undefined),
      };
    },
    outputSchema: eventAutomationToolResultSchema,
    async execute(input) {
      const { actor, destination } =
        requireEventAutomationSlackContext(context);
      const candidate = await requireToolAutomation(
        slackToolViewer(await context.resolveActorIdentity?.(), destination),
        "event",
        input.automationId,
      );
      const { task: current, ownedByViewer: isCreator } = candidate;
      const edits =
        input.title !== undefined ||
        input.instruction !== undefined ||
        input.trigger !== undefined ||
        input.outcomes != null ||
        input.credentialMode != null;
      if (!edits && input.status == null) {
        throw new ToolInputError("Event automation update requires a change.");
      }
      if (
        input.instruction != null &&
        input.instruction !== current.task.text
      ) {
        requireRequesterMention(input.instruction, actor);
      }
      let saved = current;
      if (edits) {
        const next = await editEventAutomation(
          current,
          {
            title: input.title,
            instruction: input.instruction ?? undefined,
            // An omitted identifier or resource type keeps the saved one.
            // Only an explicit null makes the trigger run for every resource.
            trigger: input.trigger
              ? {
                  ...input.trigger,
                  identifier:
                    input.trigger.identifier === undefined
                      ? current.trigger.identifier
                      : (input.trigger.identifier ?? undefined),
                  resourceType:
                    input.trigger.resourceType === undefined
                      ? current.trigger.resourceType
                      : (input.trigger.resourceType ?? undefined),
                }
              : undefined,
            outcomes: input.outcomes ?? undefined,
            credentialMode: input.credentialMode ?? undefined,
          },
          isCreator,
          catalog,
        );
        const edited = await saveEventAutomation(
          getDb(),
          next,
          automationRevision(current),
          {
            slackUserId: actor.userId,
            ...(actor.fullName ? { fullName: actor.fullName } : undefined),
            ...(actor.userName ? { userName: actor.userName } : undefined),
          },
        );
        if (!edited) {
          throw new ToolInputError("Event automation was not found.");
        }
        saved = edited;
      }
      if (input.status != null) {
        const changed = await changeAutomationLifecycle(
          { ...candidate, task: saved },
          {
            action: input.status === "paused" ? "pause" : "resume",
            revision: automationRevision(saved),
          },
        );
        saved = changed.task as typeof saved;
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
