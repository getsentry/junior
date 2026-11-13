import { declaredEventKeys, type TaskOutcome } from "@sentry/junior-plugin-api";
import {
  taskOutcomeInputSchema,
  type TaskOutcomeInput,
} from "@/chat/task-outcomes-schema";
import * as z from "zod";
import {
  automationContextToolSchema,
  automationInstructionToolSchema,
} from "@/chat/automations/edit-schema";
import { requireAutomationSkill } from "@/chat/automations/edit-rules";
import {
  automationTaskDescription,
  type AutomationTask,
} from "@/chat/automations/task";
import type { SkillMetadata } from "@/chat/skills";
import { requireAutomationTaskText } from "@/chat/automations/instruction-references";
import {
  requireToolCaller,
  requireToolCreator,
  requireToolDestination,
  type AutomationToolCaller,
  type AutomationToolContext,
} from "@/chat/automations/tool-access";
import {
  automationIdForToolCall,
  automationSkillToolSchema,
  automationToolResult,
  automationToolResultSchema,
  automationTriggerSchema,
  newAutomationTask,
  triggerKind,
  type AutomationTriggerInput,
} from "@/chat/automations/tool-support";
import type { AutomationDestination } from "@/chat/automations/creator";
import type { TaskCandidate } from "@/chat/automations/read";
import { getDb } from "@/chat/db";
import { sameDestination } from "@/chat/destination";
import {
  createEventAutomation,
  getEventAutomation,
} from "@/chat/event-automations/store";
import { requireEventAutomationTrigger } from "@/chat/event-automations/tool-support";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { EventCatalog } from "@/chat/events/catalog";
import { resolveUserTimezone } from "@/chat/identities/timezone";
import { logInfo } from "@/chat/logging";
import { completeText } from "@/chat/core-model";
import {
  compileScheduleIntent,
  scheduleIntentFromTool,
  ScheduleIntentError,
} from "@/chat/scheduled-automations/schedule-intent";
import {
  createScheduledAutomation,
  readScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { scheduledAutomationAttributes } from "@/chat/scheduled-automations/telemetry";
import { getConversationAccess } from "@/chat/scheduled-automations/tool-support";
import { SCHEDULED_AUTOMATION_SYSTEM_ACTOR } from "@/chat/scheduled-automations/types";
import {
  requireSlackChannelMessageScope,
  slackChannelMessageTrigger,
} from "@/chat/slack/channel-message-events";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { resolveTaskOutcomes } from "@/chat/task-outcomes";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { AUTOMATIONS_TOOL_SOURCE } from "@/chat/automations/tool-source";

type NewAutomation = {
  creator: ReturnType<typeof requireToolCreator>;
  credentialMode: "creator" | "system";
  destination: AutomationDestination;
  id: string;
  nowMs: number;
  task: AutomationTask;
  outcomes: TaskOutcome[];
  title: string | undefined;
};

/** Compile a schedule in the timezone that the request or creator uses. */
async function compileSchedule(
  caller: AutomationToolCaller,
  creator: NewAutomation["creator"],
  destination: AutomationDestination,
  trigger: Extract<AutomationTriggerInput, { type: "schedule" }>,
  nowMs: number,
) {
  const timezone =
    trigger.schedule.timezone ??
    (await resolveUserTimezone({
      db: getDb(),
      nowMs,
      slack: {
        teamId: destination.teamId,
        userId: creator.createdBy.slackUserId,
      },
      ...(caller.resolved?.user
        ? { userId: caller.resolved.user.id }
        : undefined),
    }));
  try {
    return compileScheduleIntent({
      defaultTimezone: timezone,
      intent: scheduleIntentFromTool(trigger.schedule),
      nowMs,
    });
  } catch (error) {
    if (error instanceof ScheduleIntentError) {
      throw new ToolInputError(error.message);
    }
    throw error;
  }
}

async function createScheduled(
  context: AutomationToolContext,
  next: NewAutomation,
  compiled: Awaited<ReturnType<typeof compileSchedule>>,
): Promise<TaskCandidate> {
  const { destination, nowMs } = next;
  const task = await createScheduledAutomation(getDb(), {
    id: next.id,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    createdBy: next.creator.createdBy,
    creatorIdentityId: next.creator.identity.id,
    conversationAccess: getConversationAccess(destination, context.visibility),
    credentialMode: next.credentialMode,
    destination,
    executionActor: SCHEDULED_AUTOMATION_SYSTEM_ACTOR,
    nextRunAtMs: compiled.nextRunAtMs,
    originalRequest: context.userText,
    schedule: compiled.schedule,
    status: "active",
    outcomes: next.outcomes,
    task: next.task,
    ...(next.title ? { title: next.title } : undefined),
  });
  logInfo(
    "scheduled_automation.create.completed",
    scheduledAutomationAttributes(task),
  );
  return { kind: "scheduled", task, ownedByViewer: true };
}

async function createEvent(
  context: AutomationToolContext,
  next: NewAutomation,
  trigger: EventAutomation["trigger"],
): Promise<TaskCandidate> {
  const task = await createEventAutomation(
    getDb(),
    requireSlackChannelMessageScope({
      id: next.id,
      destinationVisibility:
        context.visibility === "public" ? "public" : "private",
      createdAtMs: next.nowMs,
      createdBy: next.creator.createdBy,
      creatorIdentityId: next.creator.identity.id,
      credentialMode: next.credentialMode,
      destination: next.destination,
      outcomes: next.outcomes,
      task: next.task,
      ...(next.title ? { title: next.title } : undefined),
      trigger,
    }),
  );
  return { kind: "event", task, ownedByViewer: true };
}

/** Read the Automation that an earlier attempt of this tool call created. */
async function readReplayedAutomation(
  kind: TaskCandidate["kind"],
  id: string,
): Promise<TaskCandidate | undefined> {
  const db = getDb();
  if (kind === "scheduled") {
    const task = await readScheduledAutomation(db, id);
    return task ? { kind, task, ownedByViewer: true } : undefined;
  }
  const task = await getEventAutomation(db, id);
  // A deleted event automation is created again with the same ID.
  return task && task.status !== "deleted"
    ? { kind, task, ownedByViewer: true }
    : undefined;
}

/** Create the tool that stores a scheduled or event Automation. */
export function createAutomationTool(
  context: AutomationToolContext,
  catalog: EventCatalog,
  /** Every discovered skill, listed in the skill input. */
  skills: readonly SkillMetadata[] = [],
) {
  const trigger = automationTriggerSchema(catalog);
  return zodTool({
    exposure: "deferred",
    source: AUTOMATIONS_TOOL_SOURCE,
    permission: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Create a durable automation. It belongs to the channel or DM of this conversation, never a thread. When an installed skill does the work, have the automation run that skill; do not write an instruction that names the skill. Ordinary watch, notify, or tell-me-when requests use watchEvents instead. Store the requested future work; do not perform it or check its service access now unless the user also asks for that. When the trigger is known, create it without redundant confirmation.",
    inputSchema: z
      .object({
        instruction: automationInstructionToolSchema.nullable().optional(),
        skill: automationSkillToolSchema(skills).nullable().optional(),
        context: automationContextToolSchema.nullable().optional(),
        title: z
          .string()
          .trim()
          .min(1)
          .max(SHORT_TITLE_MAX_LENGTH)
          .nullable()
          .describe(
            "Optional short display title. Omit or use null to generate one from the instruction or skill.",
          )
          .optional(),
        trigger: trigger.describe(
          'Use type "schedule" for one-time or recurring work. Use type "event" only when the user explicitly asks for an event automation or durable whenever-this-happens-do-X work; it runs for every matching event.',
        ),
        outcomes: z
          .array(taskOutcomeInputSchema)
          .max(5)
          .describe(
            "Successful work is silent by default: omit this or use an empty list when the Automation acts through tools without a status message. Add send_message only when the user asks for a reminder, notification, post, digest, summary, or other visible result.",
          )
          .optional(),
        credential_mode: z
          .enum(["creator", "system"])
          .nullable()
          .describe(
            "Omit or use null for the system default: runs use your own credentials. Use creator only when the creator asks for their connected credentials to be available to the runs.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        instruction?: string | null;
        skill?: string | null;
        context?: string | null;
        title?: string | null;
        trigger: z.input<typeof trigger>;
        outcomes?: TaskOutcomeInput[];
        credential_mode?: "creator" | "system" | null;
      };
      const prepared = { ...input };
      if (prepared.title == null) {
        delete prepared.title;
      }
      if (prepared.instruction == null) {
        delete prepared.instruction;
      }
      if (prepared.skill == null) {
        delete prepared.skill;
      }
      if (prepared.context == null) {
        delete prepared.context;
      }
      if (prepared.credential_mode === null) {
        delete prepared.credential_mode;
      }
      return prepared;
    },
    outputSchema: automationToolResultSchema,
    async execute(input, options) {
      const kind = triggerKind(input.trigger);
      const destination = requireToolDestination(context);
      const caller = await requireToolCaller(context);
      const creator = requireToolCreator(caller, destination, kind);
      const { createdBy } = creator;
      // prepareArguments removed the nulls.
      const task = newAutomationTask({
        instruction: input.instruction ?? undefined,
        skill: input.skill ?? undefined,
        context: input.context ?? undefined,
      });
      await requireAutomationSkill(task, undefined);
      requireAutomationTaskText(task, {
        creator: createdBy,
      });
      const eventTrigger =
        input.trigger.type === "event"
          ? requireEventAutomationTrigger(
              catalog,
              slackChannelMessageTrigger(
                {
                  ...input.trigger,
                  match: input.trigger.match
                    ? declaredEventKeys(input.trigger.match)
                    : undefined,
                },
                destination.channelId,
              ),
            )
          : undefined;
      const toolCallId = options.toolCallId?.trim();
      if (!toolCallId) {
        throw new Error("Automation creation requires a tool-call identity.");
      }
      const id = automationIdForToolCall({
        kind,
        creatorSlackUserId: createdBy.slackUserId,
        destination,
        toolCallId,
      });
      const requireOwnAutomation = (candidate: TaskCandidate) => {
        if (
          !sameDestination(candidate.task.destination, destination) ||
          candidate.task.createdBy.slackUserId !== createdBy.slackUserId
        ) {
          throw new ToolInputError("Automation operation identity is invalid.");
        }
        return automationToolResult(context.conversationId, candidate, catalog);
      };
      // Replaying a durable tool call returns its original Automation.
      const replayed = await readReplayedAutomation(kind, id);
      if (replayed) return requireOwnAutomation(replayed);
      const nowMs = context.now?.() ?? Date.now();
      const compiled =
        input.trigger.type === "schedule"
          ? await compileSchedule(
              caller,
              creator,
              destination,
              input.trigger,
              nowMs,
            )
          : undefined;
      const next: NewAutomation = {
        creator,
        destination,
        id,
        nowMs,
        task,
        credentialMode: input.credential_mode ?? "system",
        outcomes: await resolveTaskOutcomes(
          input.outcomes,
          destination,
          createdBy.slackUserId,
        ),
        title: await resolveTaskTitle({
          signal: options.signal,
          completeText,
          cost: { conversationId: context.conversationId },
          instruction: automationTaskDescription(task),
          title: input.title,
        }),
      };
      return requireOwnAutomation(
        compiled
          ? await createScheduled(context, next, compiled)
          : await createEvent(context, next, eventTrigger!),
      );
    },
  });
}
