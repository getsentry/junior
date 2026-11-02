import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  automationEditor,
  changeAutomationLifecycle,
} from "@/chat/automations/edit";
import {
  automationInstructionToolSchema,
  automationTitleSchema,
} from "@/chat/automations/edit-schema";
import type { TaskCandidate } from "@/chat/automations/read";
import { requireInstructionReferences } from "@/chat/automations/instruction-references";
import { automationRevision } from "@/chat/automations/revision";
import {
  requireToolAutomation,
  requireToolCaller,
  requireToolDestination,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationToolResult,
  automationToolResultSchema,
  scheduleTriggerSchema,
  triggerKind,
} from "@/chat/automations/tool-support";
import { registeredEventAutomationTriggerSchema } from "@/chat/event-automations/tool-support";
import { eventMatchSchema, type EventMatch } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { sameDestination } from "@/chat/destination";
import { editEventAutomation } from "@/chat/event-automations/edit";
import { saveEventAutomation } from "@/chat/event-automations/store";
import type { EventCatalog } from "@/chat/events/catalog";
import { logInfo } from "@/chat/logging";
import { editScheduledAutomation } from "@/chat/scheduled-automations/edit";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { scheduledAutomationAttributes } from "@/chat/scheduled-automations/telemetry";
import { getConversationAccess } from "@/chat/scheduled-automations/tool-support";
import { moveTaskOutcomes, resolveTaskOutcomes } from "@/chat/task-outcomes";
import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";

/**
 * Filter changes for an event trigger update. A value sets the filter, and
 * null removes it. A filter that is not named keeps its saved value, so an
 * update cannot make a trigger broader by leaving a filter out.
 */
const matchChangesSchema = z
  .record(z.string(), z.union([eventMatchSchema.valueType, z.null()]))
  .describe(
    "Filter changes. A value sets the filter, null removes it, and a filter that is left out keeps its saved value. Use the matchFields of the resource type. A single value must equal the event data. A list means the event value may be any one entry.",
  );

/** Build the trigger input of the update tool. */
function updateTriggerSchema(catalog: EventCatalog) {
  return z.discriminatedUnion("type", [
    scheduleTriggerSchema,
    registeredEventAutomationTriggerSchema(catalog).extend({
      type: z.literal("event"),
      match: matchChangesSchema.optional(),
    }),
  ]);
}

/** Apply filter changes to the saved filters, key by key. */
function changedMatch(
  saved: EventMatch | undefined,
  changes: z.output<typeof matchChangesSchema> | undefined,
): EventMatch | undefined {
  if (changes === undefined) return saved;
  const match: EventMatch = { ...saved };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete match[key];
    else match[key] = value;
  }
  return Object.keys(match).length > 0 ? match : undefined;
}

type UpdateInput = {
  title?: string;
  instruction?: string;
  trigger?: z.output<ReturnType<typeof updateTriggerSchema>>;
  outcomes?: z.output<typeof taskOutcomeInputSchema>[];
  credentialMode?: "creator" | "system";
  destination?: "current_conversation";
};

type Editor = ReturnType<typeof automationEditor>;

/** Reject a move while an occurrence is pending or running. */
async function requireNoIncompleteRun(automationId: string): Promise<void> {
  const incompleteRuns = await getDb()
    .select({ id: juniorAutomationRuns.id })
    .from(juniorAutomationRuns)
    .where(
      and(
        eq(juniorAutomationRuns.automationId, automationId),
        inArray(juniorAutomationRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  if (incompleteRuns.length > 0) {
    throw new ToolInputError(
      "Scheduled automation cannot be moved while an occurrence is already running. Try again after the current run finishes.",
    );
  }
}

/** Edit and save a scheduled Automation, including a move to this Conversation. */
async function updateScheduled(
  context: AutomationToolContext,
  current: Extract<TaskCandidate, { kind: "scheduled" }>,
  input: UpdateInput,
  editor: Editor,
): Promise<TaskCandidate> {
  const { task, ownedByViewer: isCreator } = current;
  const destination = input.destination
    ? requireToolDestination(context)
    : undefined;
  const moving =
    destination !== undefined &&
    !sameDestination(task.destination, destination);
  // A move that already landed, with no other change, is a no-op success.
  if (
    destination &&
    !moving &&
    Object.keys(input).every(
      (key) =>
        key === "destination" ||
        (key === "credentialMode" &&
          input.credentialMode === task.credentialMode),
    )
  ) {
    return current;
  }
  if (moving) await requireNoIncompleteRun(task.id);
  const next = await editScheduledAutomation(
    task,
    {
      title: input.title,
      instruction: input.instruction,
      schedule:
        input.trigger?.type === "schedule" ? input.trigger.schedule : undefined,
      credentialMode: input.credentialMode,
      // A move resolves outcomes against the new Destination below.
      outcomes: moving ? undefined : input.outcomes,
    },
    isCreator,
    context.now?.() ?? Date.now(),
  );
  if (moving) {
    next.destination = destination;
    next.conversationAccess = getConversationAccess(
      destination,
      context.visibility,
    );
    next.outcomes =
      input.outcomes === undefined
        ? moveTaskOutcomes(task.outcomes, task.destination, destination)
        : await resolveTaskOutcomes(
            input.outcomes,
            destination,
            task.createdBy.slackUserId,
          );
  }
  const saved = await saveScheduledAutomation(
    getDb(),
    next,
    automationRevision(task),
    editor,
  );
  if (moving) {
    logInfo(
      "scheduled_automation.move.completed",
      scheduledAutomationAttributes(saved),
    );
  }
  return { ...current, task: saved };
}

/** Edit and save an event Automation. */
async function updateEvent(
  current: Extract<TaskCandidate, { kind: "event" }>,
  input: UpdateInput,
  editor: Editor,
  catalog: EventCatalog,
): Promise<TaskCandidate> {
  const { task } = current;
  const trigger = input.trigger?.type === "event" ? input.trigger : undefined;
  // A trigger edit names no identifier, so it would drop a saved one and make
  // the trigger broader. Such a trigger stays until an upgrade turns it into
  // filters, or the dashboard replaces it whole.
  if (trigger && task.trigger.identifier !== undefined) {
    throw new ToolInputError(
      "This event automation still targets one resource by identifier, so its trigger cannot change here yet. Change its other fields, replace the trigger in the dashboard, or delete it and create a new one with filters.",
    );
  }
  const next = await editEventAutomation(
    task,
    {
      title: input.title,
      instruction: input.instruction,
      // An omitted filter keeps the saved one, so a trigger cannot get
      // broader by omission. Only an explicit null drops a filter.
      trigger: trigger
        ? {
            namespace: trigger.namespace,
            label: trigger.label,
            events: trigger.events,
            match: changedMatch(task.trigger.match, trigger.match),
          }
        : undefined,
      outcomes: input.outcomes,
      credentialMode: input.credentialMode,
    },
    current.ownedByViewer,
    catalog,
  );
  const saved = await saveEventAutomation(
    getDb(),
    next,
    automationRevision(task),
    editor,
  );
  if (!saved) throw new ToolInputError("Automation was not found.");
  return { ...current, task: saved };
}

/** Create the tool that edits, pauses, resumes, or moves one Automation. */
export function createUpdateAutomationTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
) {
  const trigger = updateTriggerSchema(catalog);
  const inputSchema = z
    .object({
      automationId: z
        .string()
        .min(1)
        .describe(
          "ID of the automation, from searchAutomations or its dashboard URL.",
        ),
      title: automationTitleSchema.optional(),
      instruction: automationInstructionToolSchema.nullable().optional(),
      trigger: trigger
        .nullable()
        .describe(
          "Replacement trigger of the same type. An event trigger has no identifier, and its match changes only the filters that it names. An event automation whose trigger still has an identifier keeps that trigger until an upgrade turns it into filters; you can change its other fields now. Omit or use null to keep the trigger.",
        )
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
          "Set creator to make the automation creator's credentials available, or system to disable them. Creator always means the automation's createdBy actor, never the current requester. Only that creator may enable creator mode. Omit or use null to leave unchanged.",
        )
        .optional(),
      status: z
        .enum(["active", "paused"])
        .nullable()
        .describe(
          "Set active to resume a paused or blocked automation, or paused to stop it. When it uses its creator's credentials, only the creator can resume it. Omit or use null to leave unchanged.",
        )
        .optional(),
      destination: z
        .literal("current_conversation")
        .nullable()
        .describe(
          'Set to "current_conversation" to move the creator\'s scheduled automation into the channel or DM of this conversation. Omit to keep its destination.',
        )
        .optional(),
    })
    .strict();
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
      'Update the title, instruction, trigger, outcomes, credential use, or status of a scheduled or event automation. Anyone in the workspace can update an automation in a public channel. Automations in private channels and DMs can be updated from there or by their creator. Only the creator can enable creator credentials, change outcomes, or move it. A non-creator who changes the instruction or trigger switches it to system credentials. The trigger type cannot change. Set destination to "current_conversation" to move a scheduled automation to the channel or DM of this conversation.',
    inputSchema,
    prepareArguments(args) {
      // Null means omitted.
      return Object.fromEntries(
        Object.entries(args as Record<string, unknown>).filter(
          ([, value]) => value != null,
        ),
      ) as z.input<typeof inputSchema>;
    },
    outputSchema: automationToolResultSchema,
    async execute({ automationId, status: requestedStatus, ...fields }) {
      // prepareArguments removed every null.
      const input = fields as UpdateInput;
      const status = requestedStatus ?? undefined;
      const caller = await requireToolCaller(context);
      const current = await requireToolAutomation(caller, automationId);
      if (input.trigger && triggerKind(input.trigger) !== current.kind) {
        throw new ToolInputError(
          `This automation runs on ${current.kind === "scheduled" ? "a schedule" : "events"}. The trigger type cannot change. Create a new automation instead.`,
        );
      }
      if (Object.keys(input).length === 0 && status === undefined) {
        throw new ToolInputError("Automation update requires a change.");
      }
      if (current.kind === "scheduled" && current.task.status === "completed") {
        throw new ToolInputError(
          "Completed scheduled automations cannot be updated. Create a new automation instead.",
        );
      }
      if (input.destination && !current.ownedByViewer) {
        throw new ToolInputError(
          "Only the automation creator can move this automation.",
        );
      }
      if (input.destination && current.kind === "event") {
        throw new ToolInputError(
          "Event automations cannot move. Create a new event automation in this conversation instead.",
        );
      }
      const editor = automationEditor(caller.viewer, current);
      if (
        input.instruction !== undefined &&
        input.instruction !== current.task.task.text
      ) {
        requireInstructionReferences(input.instruction, {
          creator: current.task.createdBy,
          destinationChannelId: current.task.destination.channelId,
          requester: editor,
          previousInstruction: current.task.task.text,
        });
      }
      let saved = current;
      if (Object.keys(input).length > 0) {
        saved =
          current.kind === "scheduled"
            ? await updateScheduled(context, current, input, editor)
            : await updateEvent(current, input, editor, catalog);
      }
      // Setting the current status again changes nothing.
      if (status !== undefined && status !== saved.task.status) {
        saved = await changeAutomationLifecycle(saved, {
          action: status === "paused" ? "pause" : "resume",
          revision: automationRevision(saved.task),
        });
      }
      return automationToolResult(context.conversationId, saved, catalog);
    },
  });
}
