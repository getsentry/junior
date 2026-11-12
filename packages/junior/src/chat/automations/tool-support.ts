/** Shared input and result shapes of the Automation tools. */
import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import { createHash } from "node:crypto";
import * as z from "zod";
import {
  compactEventAutomation,
  compactEventAutomationResultSchema,
  eventAutomationToolResult,
  registeredEventAutomationTriggerChangesSchema,
  registeredEventAutomationTriggerSchema,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { toolScheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import {
  compactTask,
  compactTaskResultSchema,
  scheduleAutomationToolResult,
} from "@/chat/scheduled-automations/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import type { AutomationDestination } from "./creator";
import type { TaskCandidate } from "./read";
import { automationSkillNameSchema, type AutomationTask } from "./task";
import type { SkillMetadata } from "@/chat/skills";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const automationResultSchema = z.discriminatedUnion("type", [
  compactTaskResultSchema,
  compactEventAutomationResultSchema,
]);

/** Validate the result of a tool that changes one Automation. */
export const automationToolResultSchema = juniorToolOutputSchema
  .extend({
    automation: automationResultSchema,
    objectCards: z.array(ownedObjectAnnotationSchema),
  })
  .strict();

/** Validate the result of the Automation search tool. */
export const automationSearchResultSchema = juniorToolOutputSchema
  .extend({
    automations: z.array(automationResultSchema),
    truncated: z.boolean(),
  })
  .strict();

const scheduleTriggerSchema = z
  .object({
    type: z.literal("schedule"),
    schedule: toolScheduleIntentSchema.describe(
      "When the automation runs. The scheduler computes the exact next run from this intent and the server clock.",
    ),
  })
  .strict();

/**
 * Build the trigger input of the create tool: a schedule, or the events of an
 * enabled plugin.
 */
export function automationTriggerSchema(catalog: EventCatalog) {
  return z.discriminatedUnion("type", [
    scheduleTriggerSchema,
    registeredEventAutomationTriggerSchema(catalog).extend({
      type: z.literal("event"),
    }),
  ]);
}

/**
 * Build the trigger input of the update tool. An event trigger changes its
 * filters key by key.
 */
export function automationTriggerChangesSchema(catalog: EventCatalog) {
  return z.discriminatedUnion("type", [
    scheduleTriggerSchema,
    registeredEventAutomationTriggerChangesSchema(catalog).extend({
      type: z.literal("event"),
    }),
  ]);
}

/**
 * Build the skill input of the create and update tools. The description
 * lists every discovered skill, because `<available-skills>` leaves out the
 * ones with `disable-model-invocation`, and an Automation can run those too.
 */
export function automationSkillToolSchema(skills: readonly SkillMetadata[]) {
  const names = skills.map((skill) =>
    skill.disableModelInvocation ? `${skill.name} (manual only)` : skill.name,
  );
  return automationSkillNameSchema.describe(
    `Skill that each run invokes instead of a written instruction. Any installed skill works, including manual-only ones. Installed skills: ${names.length > 0 ? names.join(", ") : "none"}.`,
  );
}

/** Flat task fields of the Automation tools. */
type TaskToolFields = {
  instruction?: string;
  skill?: string;
  /** Null clears the context. Only an update can send it. */
  context?: string | null;
};

/** Map the task fields of a new Automation to its task. */
export function newAutomationTask(input: TaskToolFields): AutomationTask {
  const task = editedAutomationTask(undefined, input);
  if (!task) throw new ToolInputError("Set instruction or skill.");
  return task;
}

/**
 * Map the task fields of an update to the saved task, or undefined when they
 * change nothing. `instruction` switches to an instruction. `skill` switches
 * to a skill and keeps the current context. `context` needs skill mode.
 */
export function editedAutomationTask(
  current: AutomationTask | undefined,
  input: TaskToolFields,
): AutomationTask | undefined {
  const { instruction, skill, context } = input;
  if (instruction !== undefined && skill !== undefined)
    throw new ToolInputError("Set instruction or skill, not both.");
  if (instruction !== undefined) {
    if (context !== undefined)
      throw new ToolInputError(
        "Context goes only with a skill. Put everything in the instruction.",
      );
    return { kind: "instruction", instruction };
  }
  const kept = current?.kind === "skill" ? current : undefined;
  const nextSkill = skill ?? kept?.skill;
  if (nextSkill === undefined) {
    if (context === undefined) return undefined;
    throw new ToolInputError(
      "Context goes only with a skill. Set skill, or change the instruction instead.",
    );
  }
  if (skill === undefined && context === undefined) return undefined;
  const nextContext = context === undefined ? kept?.context : context;
  return {
    kind: "skill",
    skill: nextSkill,
    ...(nextContext ? { context: nextContext } : undefined),
  };
}

/** Automation trigger input after parsing. */
export type AutomationTriggerInput = z.output<
  ReturnType<typeof automationTriggerSchema>
>;

/** Automation trigger changes after parsing. */
export type AutomationTriggerChangesInput = z.output<
  ReturnType<typeof automationTriggerChangesSchema>
>;

/** Return the Automation kind of a trigger input. */
export function triggerKind(
  trigger: Pick<AutomationTriggerInput, "type">,
): TaskCandidate["kind"] {
  return trigger.type === "schedule" ? "scheduled" : "event";
}

/** Project an Automation into the model-facing result shape. */
export function compactAutomation(
  candidate: TaskCandidate,
  catalog: EventCatalog,
) {
  return candidate.kind === "scheduled"
    ? compactTask(candidate.task, candidate.ownedByViewer)
    : compactEventAutomation(candidate.task, catalog, candidate.ownedByViewer);
}

/** Return the result of a tool that changed one Automation, with its card. */
export function automationToolResult(
  conversationId: string,
  candidate: TaskCandidate,
  catalog: EventCatalog,
) {
  return candidate.kind === "scheduled"
    ? scheduleAutomationToolResult(
        conversationId,
        candidate.task,
        candidate.ownedByViewer,
      )
    : eventAutomationToolResult(
        conversationId,
        candidate.task,
        catalog,
        candidate.ownedByViewer,
      );
}

/**
 * Build a retry-stable Automation ID from the creator, Destination, and tool
 * call. A replayed create call gets the same ID.
 */
export function automationIdForToolCall(args: {
  kind: TaskCandidate["kind"];
  creatorSlackUserId: string;
  destination: AutomationDestination;
  toolCallId: string;
}): string {
  const { destination } = args;
  // Keep the IDs that each kind had before the tools merged.
  const key =
    args.kind === "scheduled"
      ? {
          actor: args.creatorSlackUserId,
          channel: destination.channelId,
          operation: args.toolCallId,
          platform: destination.platform,
          team: destination.teamId,
        }
      : {
          actor: args.creatorSlackUserId,
          channel: destination.channelId,
          operation: args.toolCallId,
          team: destination.teamId,
        };
  const digest = createHash("sha256")
    .update(JSON.stringify(key))
    .digest("hex")
    .slice(0, 32);
  return `${args.kind === "scheduled" ? "sched" : "evt"}_${digest}`;
}
