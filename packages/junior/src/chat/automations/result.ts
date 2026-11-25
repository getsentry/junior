/** Result fields and the card that scheduled and event Automations share. */
import type { AnnotatedObject, TaskOutcome } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import {
  ANNOTATION_SUBJECT_KINDS,
  CORE_ANNOTATION_PLUGIN,
} from "@/chat/plugins/annotations";
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
 * Return the status and warning that the card and the Slack details of an
 * Automation show. The status is the saved status, except that an active
 * Automation whose trigger cannot work shows as unavailable. Only a block or
 * a trigger problem gives a warning, like Needs attention in `collection.ts`.
 */
export function automationCardStatus(automation: {
  status: string;
  statusReason?: string | null | undefined;
  triggerProblems?: readonly string[] | undefined;
}): { status: string; warning: string | undefined } {
  const problems = automation.triggerProblems ?? [];
  const warning = [
    automation.status === "blocked"
      ? (automation.statusReason ?? "This automation is blocked.")
      : undefined,
    problems.length > 0
      ? ["Trigger unavailable.", ...problems].join(" ")
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    status:
      automation.status === "active" && problems.length > 0
        ? "unavailable"
        : automation.status,
    warning: warning || undefined,
  };
}

/** Save the card of an Automation that a tool changed, and return the tool result. */
export async function saveAutomationCardResult<
  T extends {
    id: string;
    title: string | null;
    url: string | null;
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
  action: AnnotatedObject["action"],
) {
  const description = automationTaskDescription(card.task);
  const title =
    automation.title ?? fallbackShortTitle(description, card.fallbackTitle);
  const { status, warning } = automationCardStatus({
    status: automation.status,
    statusReason: automation.status_reason,
    triggerProblems: card.triggerProblems,
  });
  const annotation: AnnotatedObject = {
    action,
    kind: "object",
    objectType: "automation",
    label: title,
    key: automation.id,
    subject: { id: automation.id, kind: ANNOTATION_SUBJECT_KINDS.automation },
    title,
    url: automation.url,
    description,
    status,
    trigger: card.trigger,
    // Only the card notes completion. Slack details show it as the status.
    warning:
      warning ??
      (status === "completed" ? "This automation has completed." : undefined),
  };
  return {
    automation,
    objectCards: await saveObjectAnnotations(
      conversationId,
      CORE_ANNOTATION_PLUGIN,
      [annotation],
    ),
  };
}
