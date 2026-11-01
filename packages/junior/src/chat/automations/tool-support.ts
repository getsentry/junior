/** Shared input and result shapes of the Automation tools. */
import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compactEventAutomation,
  compactEventAutomationResultSchema,
  eventAutomationToolResult,
  registeredEventAutomationTriggerSchema,
} from "@/chat/event-automations/tool-support";
import type { EventCatalog } from "@/chat/events/catalog";
import { scheduleIntentSchema } from "@/chat/scheduled-automations/schedule-intent";
import {
  compactTask,
  compactTaskResultSchema,
  scheduleAutomationToolResult,
} from "@/chat/scheduled-automations/tool-support";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import type { AutomationDestination } from "./creator";
import type { TaskCandidate } from "./read";

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

/**
 * Build the trigger input of the create and update tools: a schedule, or the
 * events of an enabled plugin.
 */
export function automationTriggerSchema(catalog: EventCatalog) {
  return z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("schedule"),
        schedule: scheduleIntentSchema.describe(
          "When the automation runs. The scheduler computes the exact next run from this intent and the server clock.",
        ),
      })
      .strict(),
    registeredEventAutomationTriggerSchema(catalog).extend({
      type: z.literal("event"),
    }),
  ]);
}

/** Automation trigger input after parsing. */
export type AutomationTriggerInput = z.output<
  ReturnType<typeof automationTriggerSchema>
>;

/** Return the Automation kind of a trigger input. */
export function triggerKind(
  trigger: AutomationTriggerInput,
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
