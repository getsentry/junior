/**
 * Owns event matching and durable event-automation dispatch.
 *
 * Each matching automation is independently idempotent. Aggregate failures propagate
 * so the provider can retry the original delivery.
 */
import { createHash } from "node:crypto";
import {
  EVENT_SUMMARY_MAX_LENGTH,
  EVENT_TEXT_MAX_LENGTH,
  eventSchema,
  type ReplyAttribution,
  type Event,
} from "@sentry/junior-plugin-api";
import { dispatchEventAutomation } from "@/chat/agent-dispatch/context";
import { renderTaskInput } from "@/chat/task-input";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";
import { getDb } from "@/chat/db";
import { findMatchingEventAutomations } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { eventGuidance } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";

/** Bind provider delivery identity to one automation's durable dispatch. */
function eventAutomationDispatchKey(
  taskId: string,
  namespace: string,
  eventKey: string,
): string {
  return `event-automation:${createHash("sha256")
    .update(`${taskId}\0${namespace}\0${eventKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

/** Compact destination-visible context for event-automation replies. */
function replyAttribution(task: EventAutomation): ReplyAttribution {
  const detail = oneLine(task.trigger.label).slice(0, 128).trim();
  return detail
    ? { label: "Event automation", detail }
    : { label: "Event automation" };
}

/** Render plain agent input for one matching event automation. */
function eventInput(task: EventAutomation, event: Event): string {
  const guidance = eventGuidance(
    getEventCatalog(),
    event.namespace,
    task.trigger.resourceType,
    event.eventType,
  );
  return renderTaskInput({
    about: task.trigger.label,
    instructions: task.task.text,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    guidance,
    trustedSummary: event.trustedSummary,
    trustedSummaryMaxLength: EVENT_SUMMARY_MAX_LENGTH,
    verifiedDetails: event.data,
    externalText: event.untrustedText,
    externalTextMaxLength: EVENT_TEXT_MAX_LENGTH,
  });
}

/** Match a normalized event and dispatch every matching automation. */
export async function ingestEventAutomations(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    teamId: string;
  },
): Promise<{ dispatched: number }> {
  const event = eventSchema.parse(input);
  const db = getDb();
  const nowMs = options.nowMs ?? Date.now();
  const tasks = await findMatchingEventAutomations(db, event, options.teamId);
  let dispatched = 0;
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      const idempotencyKey = eventAutomationDispatchKey(
        task.id,
        event.namespace,
        event.eventKey,
      );
      const credentialSubject =
        task.credentialMode === "creator"
          ? {
              type: "user" as const,
              userId: task.createdBy.slackUserId,
              allowedWhen: "event-automation" as const,
              taskId: task.id,
            }
          : undefined;
      const dispatch = await dispatchEventAutomation({
        conversationWorkQueue: options.queue,
        nowMs,
        options: {
          idempotencyKey,
          ...(credentialSubject ? { credentialSubject } : undefined),
          destination: task.destination,
          destinationVisibility: task.destinationVisibility,
          input: eventInput(task, event),
          metadata: { eventAutomationId: task.id },
          replyAttribution: replyAttribution(task),
          outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
        },
      });
      if (dispatch.status === "created") {
        dispatched += 1;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Failed to dispatch one or more event automations",
    );
  }
  return { dispatched };
}
