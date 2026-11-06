import { declaredEventKeys } from "@sentry/junior-plugin-api";
import { and, eq, inArray } from "drizzle-orm";
import * as z from "zod";
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
  automationTriggerChangesSchema,
  triggerKind,
  type AutomationTriggerChangesInput,
} from "@/chat/automations/tool-support";
import { resolveDestinationVisibility } from "@/chat/conversations/destination-visibility";
import { getConversationStore, getDb } from "@/chat/db";
import type { AutomationDestination } from "@/chat/automations/creator";
import { sameDestination } from "@/chat/destination";
import { editEventAutomation } from "@/chat/event-automations/edit";
import { changedEventMatch } from "@/chat/event-automations/tool-support";
import { saveEventAutomation } from "@/chat/event-automations/store";
import type { EventCatalog } from "@/chat/events/catalog";
import { logInfo } from "@/chat/logging";
import { editScheduledAutomation } from "@/chat/scheduled-automations/edit";
import { scheduleIntentFromTool } from "@/chat/scheduled-automations/schedule-intent";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { scheduledAutomationAttributes } from "@/chat/scheduled-automations/telemetry";
import { parseSlackTeamId } from "@/chat/slack/ids";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { getConversationAccess } from "@/chat/scheduled-automations/tool-support";
import { moveTaskOutcomes, resolveTaskOutcomes } from "@/chat/task-outcomes";
import { taskOutcomeInputSchema } from "@/chat/task-outcomes-schema";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";

type UpdateInput = {
  title?: string;
  instruction?: string;
  trigger?: AutomationTriggerChangesInput;
  outcomes?: z.output<typeof taskOutcomeInputSchema>[];
  credential_mode?: "creator" | "system";
  destination?: string;
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

/**
 * Resolve where a move goes. "current_conversation" is this Conversation. A
 * channel reference must name a public Slack channel in this workspace, and
 * Junior joins it so the Automation can post there.
 */
async function requireMoveDestination(
  context: AutomationToolContext,
  value: string,
): Promise<{
  destination: AutomationDestination;
  visibility: "public" | "private" | undefined;
}> {
  const here = requireToolDestination(context);
  if (value === "current_conversation") {
    return { destination: here, visibility: context.visibility };
  }
  const teamId = parseSlackTeamId(here.teamId);
  if (!teamId) throw new ToolInputError("Slack workspace is unavailable.");
  const { channelId, channelName } = await resolveSlackChannelRef({
    field: "destination",
    value,
    teamId,
  });
  if (channelId === here.channelId) {
    return { destination: here, visibility: context.visibility };
  }
  const access = await checkSlackChannelReadAccess({
    currentChannelIds: [],
    targetChannelId: channelId,
    teamId,
  });
  if (!access.allowed) {
    throw new ToolInputError(
      access.reason === "private"
        ? "Only a public channel can be named as a destination. To move an automation into a private channel or DM, ask from there."
        : access.error,
    );
  }
  if (access.isMember !== true) {
    const joined = await joinPublicChannelForRead({
      targetChannelId: channelId,
      ...(channelName ? { channelName } : undefined),
    });
    if (!joined.ok) throw new ToolInputError(joined.error);
  }
  const destination: AutomationDestination = {
    platform: "slack",
    teamId,
    channelId,
  };
  // Automation access reads visibility from the Destination directory.
  const name = access.channelName ?? channelName;
  await getConversationStore().recordDestinationVisibility({
    destination,
    ...(name ? { channelName: name } : undefined),
    visibility: "public",
  });
  return { destination, visibility: "public" };
}

/** Edit and save a scheduled Automation, including a move to a new Destination. */
async function updateScheduled(
  context: AutomationToolContext,
  current: Extract<TaskCandidate, { kind: "scheduled" }>,
  input: UpdateInput,
  editor: Editor,
): Promise<TaskCandidate> {
  const { task, ownedByViewer: isCreator } = current;
  const target = input.destination
    ? await requireMoveDestination(context, input.destination)
    : undefined;
  const destination = target?.destination;
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
        (key === "credential_mode" &&
          input.credential_mode === task.credentialMode),
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
        input.trigger?.type === "schedule"
          ? scheduleIntentFromTool(input.trigger.schedule)
          : undefined,
      credentialMode: input.credential_mode,
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
      target?.visibility,
    );
    // Creator credentials stay with work that the creator approved.
    if (!isCreator) next.credentialMode = "system";
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
  const next = await editEventAutomation(
    task,
    {
      title: input.title,
      instruction: input.instruction,
      // The tools cannot set an identifier, so a saved one stays. A filter
      // that is left out keeps its saved value. Another namespace starts a
      // new trigger.
      trigger: trigger
        ? {
            ...trigger,
            ...(trigger.namespace === task.trigger.namespace
              ? {
                  identifier: task.trigger.identifier,
                  resourceType: task.trigger.resourceType,
                }
              : undefined),
            match: changedEventMatch(
              task.trigger,
              trigger.namespace,
              trigger.match ? declaredEventKeys(trigger.match) : undefined,
            ),
          }
        : undefined,
      outcomes: input.outcomes,
      credentialMode: input.credential_mode,
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
  const trigger = automationTriggerChangesSchema(catalog);
  const inputSchema = z
    .object({
      automation_id: z
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
          "Replacement trigger of the same type. For an event trigger, match changes only the filters that it names. Omit or use null to keep the trigger.",
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
      credential_mode: z
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
      destination: slackChannelRefParam
        .nullable()
        .describe(
          'Where to move a scheduled automation. Set "current_conversation" for the channel or DM of this conversation, or name a public Slack channel by id, mention, or known name. Omit to keep its destination.',
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
      "Update the title, instruction, trigger, outcomes, credential use, or status of a scheduled or event automation. Anyone in the workspace can update anything on an automation in a public channel, including its outcomes and destination. Automations in private channels and DMs can be updated from there or by their creator, and only their creator can move them. Only the creator can enable creator credentials. A non-creator who changes the instruction, trigger, outcomes, or destination switches it to system credentials. The trigger type cannot change. Set destination to move a scheduled automation to this conversation or to a public channel.",
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
    async execute({ automation_id, status: requestedStatus, ...fields }) {
      // prepareArguments removed every null.
      const input = fields as UpdateInput;
      const status = requestedStatus ?? undefined;
      const caller = await requireToolCaller(context);
      const current = await requireToolAutomation(caller, automation_id);
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
      if (input.destination && current.kind === "event") {
        throw new ToolInputError(
          "Event automations cannot move. Create a new event automation in this conversation instead.",
        );
      }
      // Anyone can move a public Automation. A private one stays where its
      // creator put it.
      if (
        input.destination &&
        !current.ownedByViewer &&
        (await resolveDestinationVisibility({
          destination: current.task.destination,
        })) !== "public"
      ) {
        throw new ToolInputError(
          "Only the creator can move an automation out of a private channel or DM.",
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
