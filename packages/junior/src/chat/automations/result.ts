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
 * Save the Annotation of an Automation that a tool changed, and return the
 * tool result. The card reads the Automation live.
 */
export async function saveAutomationCardResult<
  T extends { id: string; title: string | null; url: string | null },
>(
  conversationId: string,
  automation: T,
  card: { task: AutomationTask; fallbackTitle: string },
  action: AnnotatedObject["action"],
) {
  const title =
    automation.title ??
    fallbackShortTitle(
      automationTaskDescription(card.task),
      card.fallbackTitle,
    );
  const annotation: AnnotatedObject = {
    action,
    kind: "object",
    objectType: "automation",
    key: automation.id,
    subject: { id: automation.id, kind: ANNOTATION_SUBJECT_KINDS.automation },
    title,
    url: automation.url,
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
