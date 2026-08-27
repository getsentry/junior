/**
 * Owns resource-event matching and durable event-task dispatch.
 *
 * Each matching task is independently idempotent. Aggregate failures propagate
 * so the provider can retry the original delivery.
 */
import { createHash } from "node:crypto";
import {
  createSlackSource,
  RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
  RESOURCE_EVENT_TEXT_MAX_LENGTH,
  resourceEventSchema,
  type ReplyAttribution,
  type ResourceEvent,
} from "@sentry/junior-plugin-api";
import { dispatchEventTask } from "@/chat/agent-dispatch/context";
import { renderAutomatedTaskInput } from "@/chat/automated-task-input";
import { getDb } from "@/chat/db";
import { findMatchingEventTasks } from "@/chat/event-tasks/store";
import type { EventTask } from "@/chat/event-tasks/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { resourceEventGuidance } from "@/chat/resource-events/catalog";
import { getResourceEventCatalog } from "@/chat/resource-events/runtime-catalog";

/** Bind provider delivery identity to one task's durable dispatch. */
function eventTaskDispatchKey(
  taskId: string,
  namespace: string,
  eventKey: string,
): string {
  return `event-task:${createHash("sha256")
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

/** Compact destination-visible context for event-task replies. */
function replyAttribution(task: EventTask): ReplyAttribution {
  const detail = oneLine(task.trigger.label).slice(0, 128).trim();
  return detail ? { label: "Event task", detail } : { label: "Event task" };
}

/** Render plain agent input for one matching event task. */
function eventInput(task: EventTask, event: ResourceEvent): string {
  const guidance = resourceEventGuidance(
    getResourceEventCatalog(),
    event.namespace,
    task.trigger.resourceType,
    event.eventType,
  );
  return renderAutomatedTaskInput({
    kind: "automated_update",
    about: task.trigger.label,
    instructions: task.task.text,
    guidance,
    summary: event.trustedSummary,
    summaryMaxLength: RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
    verifiedDetails: event.data,
    externalText: event.untrustedText,
    externalTextMaxLength: RESOURCE_EVENT_TEXT_MAX_LENGTH,
  });
}

/** Match a normalized resource event and dispatch every matching task. */
export async function ingestEventTasks(
  input: unknown,
  options: {
    nowMs?: number;
    queue: ConversationWorkQueue;
    teamId: string;
  },
): Promise<{ dispatched: number }> {
  const event = resourceEventSchema.parse(input);
  const db = getDb();
  const nowMs = options.nowMs ?? Date.now();
  const tasks = await findMatchingEventTasks(db, event, options.teamId);
  let dispatched = 0;
  const errors: unknown[] = [];
  // TODO(core): Add an observable circuit breaker for sustained unique-event
  // feedback loops once overflow semantics are defined; never silently drop.
  for (const task of tasks) {
    try {
      const idempotencyKey = eventTaskDispatchKey(
        task.id,
        event.namespace,
        event.eventKey,
      );
      const credentialSubject =
        task.credentialMode === "creator"
          ? {
              type: "user" as const,
              userId: task.createdBy.slackUserId,
              allowedWhen: "event-task" as const,
              taskId: task.id,
            }
          : undefined;
      const dispatch = await dispatchEventTask({
        conversationWorkQueue: options.queue,
        nowMs,
        options: {
          idempotencyKey,
          ...(credentialSubject ? { credentialSubject } : undefined),
          destination: task.destination,
          destinationVisibility: task.destinationVisibility,
          input: eventInput(task, event),
          metadata: { eventTaskId: task.id },
          replyAttribution: replyAttribution(task),
          source: createSlackSource({
            teamId: task.destination.teamId,
            channelId: task.destination.channelId,
            visibility: task.destinationVisibility,
          }),
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
      "Failed to dispatch one or more event tasks",
    );
  }
  return { dispatched };
}
