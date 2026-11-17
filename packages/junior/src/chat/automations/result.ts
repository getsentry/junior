/** Result fields and the card that scheduled and event Automations share. */
import type { ObjectAnnotation, TaskOutcome } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";
import { destinationFilterValue, type AutomationDestination } from "./creator";
import { automationTaskDescription, type AutomationTask } from "./task";

/** Model-facing fields that every Automation result has. */
export const automationResultFieldSchemas = {
  destination: z
    .object({
      id: z.string().min(1),
      channel: z.string().min(1),
      thread: z.string().min(1).nullable(),
    })
    .strict(),
  credential_mode: z.enum(["system", "creator"]),
  is_creator: z.boolean(),
  outcomes: z
    .array(
      z
        .object({
          action: z.literal("send_message"),
          destination: z
            .object({
              channel: z.string().min(1),
              thread: z.string().min(1).nullable(),
            })
            .strict(),
        })
        .strict(),
    )
    .max(5),
  created_by: z
    .object({
      name: z.string().min(1).nullable(),
      username: z.string().min(1).nullable(),
    })
    .strict(),
};

/** Project the fields that every Automation has into its result shape. */
export function automationResultFields(
  task: {
    createdBy: { fullName?: string | undefined; userName?: string | undefined };
    credentialMode: "system" | "creator";
    destination: AutomationDestination;
    outcomes: TaskOutcome[];
  },
  isCreator: boolean,
) {
  return {
    destination: {
      id: destinationFilterValue(task.destination),
      channel: task.destination.channelId,
      thread: null,
    },
    credential_mode: task.credentialMode,
    is_creator: isCreator,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination).map(
      (outcome) => ({
        action: outcome.action,
        destination: {
          channel: outcome.destination.channelId,
          thread: outcome.destination.threadTs ?? null,
        },
      }),
    ),
    created_by: {
      name: task.createdBy.fullName ?? null,
      username: task.createdBy.userName ?? null,
    },
  };
}

/**
 * Build the result of a tool that changed one Automation, with its card. The
 * card shows the saved status of the Automation. An active Automation whose
 * trigger cannot work shows as unavailable.
 */
export async function automationToolResult<
  T extends {
    id: string;
    title: string | null;
    dashboard_url: string | null;
    status: string;
    status_reason: string | null;
  },
>(
  conversationId: string,
  automation: T,
  card: {
    task: AutomationTask;
    fallbackTitle: string;
    trigger: string;
    triggerProblems?: readonly string[] | undefined;
  },
) {
  const description = automationTaskDescription(card.task);
  const title =
    automation.title ?? fallbackShortTitle(description, card.fallbackTitle);
  const problems = card.triggerProblems ?? [];
  const warning = [
    automation.status === "blocked"
      ? (automation.status_reason ?? "This automation is blocked.")
      : undefined,
    automation.status === "completed"
      ? "This automation has completed."
      : undefined,
    problems.length > 0
      ? ["Trigger unavailable.", ...problems].join(" ")
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const annotation: ObjectAnnotation = {
    kind: "object",
    objectType: "automation",
    label: title,
    key: automation.id,
    title,
    url: automation.dashboard_url,
    description,
    status:
      automation.status === "active" && problems.length > 0
        ? "unavailable"
        : automation.status,
    trigger: card.trigger,
    warning: warning || undefined,
  };
  return {
    automation,
    objectCards: await saveObjectAnnotations(conversationId, "junior", [
      annotation,
    ]),
  };
}
