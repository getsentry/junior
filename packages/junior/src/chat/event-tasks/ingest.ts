/**
 * Owns resource-event matching and durable event-task dispatch.
 *
 * Each matching task is independently idempotent. Aggregate failures propagate
 * so the provider can retry the original delivery.
 */
import { createHash } from "node:crypto";
import {
  RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
  RESOURCE_EVENT_TEXT_MAX_LENGTH,
  resourceEventSchema,
  type ReplyAttribution,
  type ResourceEvent,
} from "@sentry/junior-plugin-api";
import { dispatchEventTask } from "@/chat/agent-dispatch/context";
import { botConfig } from "@/chat/config";
import { renderTaskInput } from "@/chat/task-input";
import { getDb } from "@/chat/db";
import { findMatchingEventTasks } from "@/chat/event-tasks/store";
import type { EventTask } from "@/chat/event-tasks/types";
import { logInfo } from "@/chat/logging";
import { admitAutomatedTurn } from "@/chat/services/automated-turn-limit";
import { postAutomatedTurnLimitNoticeForDestination } from "@/chat/slack/automated-turn-limit-notice";
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
  return renderTaskInput({
    about: task.trigger.label,
    instructions: task.task.text,
    guidance,
    trustedSummary: event.trustedSummary,
    trustedSummaryMaxLength: RESOURCE_EVENT_SUMMARY_MAX_LENGTH,
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
  const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
  const noticedDestinations = new Set<string>();
  for (const task of tasks) {
    try {
      const decision = await admitAutomatedTurn({
        maxTurns,
        nowMs,
        scope: { kind: "destination", destination: task.destination },
      });
      if (decision.status === "paused") {
        const destinationId = `${task.destination.teamId}:${task.destination.channelId}`;
        logInfo("event_tasks.automated_turn_limit.paused", {
          "app.automated_turn_limit.consecutive":
            decision.consecutiveAutomatedTurns,
          "app.automated_turn_limit.max": maxTurns,
          "app.event_task.id": task.id,
          "app.resource_event.event_type": event.eventType,
          "app.resource_event.namespace": event.namespace,
          "app.slack.channel_id": task.destination.channelId,
          "app.slack.team_id": task.destination.teamId,
        });
        if (
          decision.shouldPostNotice &&
          !noticedDestinations.has(destinationId)
        ) {
          // Safety net when the Turn that hit the limit could not post a notice.
          // Only mark the destination after a successful post so a failed claim
          // clear can still retry on the next matching task in this ingest.
          const posted = await postAutomatedTurnLimitNoticeForDestination({
            destination: task.destination,
            maxTurns,
            nowMs,
            resumeIn: "channel",
            scope: { kind: "destination", destination: task.destination },
          });
          if (posted) {
            noticedDestinations.add(destinationId);
          }
        }
        continue;
      }
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
