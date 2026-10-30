import { objectTypeSchema, type ObjectType } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { logInfo } from "@/chat/logging";
import { admitAutomatedTurn } from "@/chat/services/automated-turn-limit";
import { postAutomatedTurnLimitNoticeForConversation } from "@/chat/slack/automated-turn-limit-notice";
import {
  renderTaskBatchInput,
  renderTaskInput,
  type EventDoneBy,
  type TaskBatchEvent,
} from "@/chat/task-input";
import type { ConversationMessageEvent } from "@/chat/state/conversation";
import { joinMailboxText } from "@/chat/task-execution/mailbox-input";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  type AppendAndEnqueueInboundMessageResult,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { Watch } from "@/chat/events/store";
import { eventGuidance } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { EVENT_AUTHOR_ID } from "@/chat/events/actor";
import {
  credentialSubjectSchema,
  type CredentialSubject,
} from "@/chat/credentials/context";
import { verifyTimerWatchCredentialSubject } from "@/chat/credentials/subject";

export const EVENT_WAIT_MS = 30_000;

export interface EventNotification {
  objectType?: ObjectType;
  eventKey: string;
  eventType: string;
  occurredAtMs: number;
  namespace: string;
  identifier: string;
  terminal?: boolean;
  trustedSummary: string;
  data?: Record<string, unknown>;
  untrustedText?: string;
}

const eventTaskFactsSchema = z.object({
  about: z.string().optional(),
  instructions: z.string().min(1),
  guidance: z.string().optional(),
  people: z.array(z.string()).optional(),
  trustedSummary: z.string().optional(),
  verifiedDetails: z.record(z.string(), z.unknown()).optional(),
  externalText: z.string().optional(),
  doneBy: z
    .object({ mention: z.string(), handle: z.string().optional() })
    .optional(),
});

/** Facts for one Watch Event, saved so several Events can share one message. */
export type EventTaskFacts = z.output<typeof eventTaskFactsSchema>;

/**
 * Collect the task facts for one subscribed Event.
 *
 * Keep this short: facts the model cannot reconstruct, plus a one-line handling
 * contract. Stable delivery rules live in runtime and docs, not this prompt.
 */
export function eventTaskFacts(
  subscription: Pick<Watch, "guidance" | "intent" | "label" | "resourceType">,
  event: Pick<
    EventNotification,
    "namespace" | "eventType" | "trustedSummary" | "data" | "untrustedText"
  >,
  /** Mentions resolved from the Event people. */
  people: readonly string[] = [],
  /** Resolved person who did what the Event describes. */
  doneBy?: EventDoneBy,
): EventTaskFacts {
  // Plugin guidance for the event applies to every Watch. Watch guidance comes from
  // the tool that created this Watch and applies only here.
  const guidance = [
    eventGuidance(getEventCatalog(), event.namespace, event.eventType),
    subscription.guidance?.[event.eventType],
  ]
    .filter((text): text is string => Boolean(text?.trim()))
    .join(" ");
  return {
    about: subscription.label,
    instructions: subscription.intent,
    ...(guidance ? { guidance } : undefined),
    ...(people.length > 0 ? { people: [...people] } : undefined),
    trustedSummary: event.trustedSummary,
    ...(event.data ? { verifiedDetails: event.data } : undefined),
    ...(event.untrustedText
      ? { externalText: event.untrustedText }
      : undefined),
    ...(doneBy ? { doneBy } : undefined),
  };
}

/** Resource-event metadata stored on plain mailbox input. */
export type EventMailboxMetadata = {
  kind: "event";
  event: {
    eventKey: string;
    eventType: string;
    namespace: string;
    identifier: string;
    /** Watch that matched the Event. Core Events without a Watch omit it. */
    subscriptionId?: string;
    objectType?: ObjectType;
    /** Omitted on mailbox input created before summaries were stored separately. */
    trustedSummary?: string;
  };
  /** Signed timer creator subject. Verified before the Turn uses it. */
  credentialSubject?: CredentialSubject;
  /**
   * Watch task facts. A batch of several Events uses them to write one
   * message. Input without them keeps its own text.
   */
  task?: EventTaskFacts;
} & Record<string, unknown>;

/** Whether mailbox metadata is a plain event wake. */
export function isEventMailboxMetadata(
  value: unknown,
): value is EventMailboxMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "event") {
    return false;
  }
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const fields = event as Record<string, unknown>;
  return (
    typeof fields.eventKey === "string" &&
    typeof fields.eventType === "string" &&
    typeof fields.namespace === "string" &&
    typeof fields.identifier === "string" &&
    (fields.subscriptionId === undefined ||
      typeof fields.subscriptionId === "string") &&
    (fields.objectType === undefined ||
      objectTypeSchema.safeParse(fields.objectType).success) &&
    (fields.trustedSummary === undefined ||
      typeof fields.trustedSummary === "string")
  );
}

/**
 * Return the timer creator subject when every event in the batch carries a
 * valid subject for its own Watch and the same user.
 */
export function timerWatchCredentialSubject(
  conversationId: string,
  messages: readonly InboundMessage[],
): CredentialSubject | undefined {
  let shared: CredentialSubject | undefined;
  for (const message of messages) {
    const metadata = message.input.metadata;
    if (!isEventMailboxMetadata(metadata)) return undefined;
    const parsed = credentialSubjectSchema.safeParse(
      metadata.credentialSubject,
    );
    if (
      !parsed.success ||
      !metadata.event.subscriptionId ||
      !verifyTimerWatchCredentialSubject({
        conversationId,
        subject: parsed.data,
        watchId: metadata.event.subscriptionId,
      }) ||
      (shared && shared.userId !== parsed.data.userId)
    ) {
      return undefined;
    }
    shared ??= parsed.data;
  }
  return shared;
}

/**
 * Read the saved Watch task facts from one Event mailbox entry. Entries
 * without a Watch or saved facts, such as child agent results and input queued
 * before facts were saved, return undefined and keep their own text.
 */
function readEventTaskFacts(
  message: InboundMessage,
):
  | { facts: EventTaskFacts; metadata: EventMailboxMetadata; watchId: string }
  | undefined {
  const metadata = message.input.metadata;
  if (!isEventMailboxMetadata(metadata)) return undefined;
  const watchId = metadata.event.subscriptionId;
  if (!watchId) return undefined;
  const parsed = eventTaskFactsSchema.safeParse(metadata.task);
  return parsed.success ? { facts: parsed.data, metadata, watchId } : undefined;
}

/**
 * Write the agent input for an Event batch.
 *
 * One Event keeps its own text. Several Watch Events become one task message
 * with one group per Watch, so shared instructions appear once. Entries
 * without task facts, such as child agent results, keep their own text after
 * the task message.
 */
export function renderEventBatchText(
  messages: readonly InboundMessage[],
): string {
  const groups = new Map<
    string,
    {
      about?: string;
      instructions: string;
      people: string[];
      events: TaskBatchEvent[];
    }
  >();
  const others: InboundMessage[] = [];
  for (const message of messages) {
    const saved = readEventTaskFacts(message);
    if (!saved) {
      others.push(message);
      continue;
    }
    const { facts, metadata, watchId } = saved;
    let group = groups.get(watchId);
    if (!group) {
      group = {
        about: facts.about,
        instructions: facts.instructions,
        people: [],
        events: [],
      };
      groups.set(watchId, group);
    }
    for (const person of facts.people ?? []) {
      if (!group.people.includes(person)) group.people.push(person);
    }
    group.events.push({
      eventType: metadata.event.eventType,
      guidance: facts.guidance,
      trustedSummary: facts.trustedSummary,
      verifiedDetails: facts.verifiedDetails,
      externalText: facts.externalText,
      doneBy: facts.doneBy,
    });
  }

  const taskCount = messages.length - others.length;
  if (taskCount < 2) {
    return joinMailboxText(messages);
  }
  return [
    renderTaskBatchInput({ groups: [...groups.values()] }),
    joinMailboxText(others),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * List the Watch Events in a batch for the conversation message. These are the
 * Events that the task message counts, so the list and the count agree.
 */
export function eventBatchMessageEvents(
  messages: readonly InboundMessage[],
): ConversationMessageEvent[] {
  return messages.flatMap((message) => {
    const saved = readEventTaskFacts(message);
    if (!saved) return [];
    const { metadata } = saved;
    const label = saved.facts.about;
    return [
      {
        eventType: metadata.event.eventType,
        ...(label ? { label } : undefined),
        ...(metadata.event.objectType
          ? { objectType: metadata.event.objectType }
          : undefined),
        ...(metadata.event.trustedSummary
          ? { trustedSummary: metadata.event.trustedSummary }
          : undefined),
      },
    ];
  });
}

/** Build plain conversation mailbox input for one matched watch. */
export function createEventInboundMessage(input: {
  event: EventNotification;
  subscription: Pick<Watch, "conversationId" | "credentialSubject" | "id">;
  text: string;
  /** Facts behind `text`, used when several Events share one message. */
  task?: EventTaskFacts;
  receivedAtMs?: number;
}): InboundMessage {
  const metadata: EventMailboxMetadata = {
    kind: "event",
    ...(input.task ? { task: input.task } : undefined),
    ...(input.subscription.credentialSubject
      ? { credentialSubject: input.subscription.credentialSubject }
      : undefined),
    event: {
      eventKey: input.event.eventKey,
      eventType: input.event.eventType,
      namespace: input.event.namespace,
      identifier: input.event.identifier,
      subscriptionId: input.subscription.id,
      trustedSummary: input.event.trustedSummary,
      objectType: input.event.objectType,
    },
  };
  return {
    conversationId: input.subscription.conversationId,
    createdAtMs: input.event.occurredAtMs,
    inboundMessageId: `event:${input.subscription.id}:${input.event.eventKey}`,
    delivery: "defer",
    source: "event",
    receivedAtMs: input.receivedAtMs ?? Date.now(),
    input: {
      text: input.text,
      authorId: EVENT_AUTHOR_ID,
      metadata,
    },
  };
}

/**
 * Enqueue a event as normal conversation mailbox input.
 *
 * The watch only names the conversation. Destination stays on the conversation
 * and is applied when the worker runs. After too many automated Turns with no
 * user Turn, later wakes stay quiet until a user message clears the pause.
 */
export async function enqueueEventNotification(args: {
  /** Resolved person who did what the Event describes. */
  doneBy?: EventDoneBy;
  event: EventNotification;
  /** Mentions resolved from the Event people. */
  people?: readonly string[];
  queue: ConversationWorkQueue;
  subscription: Watch;
  state?: Parameters<typeof appendAndEnqueueInboundMessage>[0]["state"];
}): Promise<AppendAndEnqueueInboundMessageResult> {
  const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
  const decision = await admitAutomatedTurn({
    conversationId: args.subscription.conversationId,
    maxTurns,
    nowMs: args.event.occurredAtMs,
    state: args.state,
  });
  if (decision.status === "paused") {
    logInfo("events.automated_turn_limit.paused", {
      conversationId: args.subscription.conversationId,
      "app.automated_turn_limit.consecutive":
        decision.consecutiveAutomatedTurns,
      "app.automated_turn_limit.max": maxTurns,
      "app.event.event_type": args.event.eventType,
      "app.event.namespace": args.event.namespace,
    });
    if (decision.shouldPostNotice) {
      // Safety net when the Turn that hit the limit could not post a notice.
      await postAutomatedTurnLimitNoticeForConversation({
        conversationId: args.subscription.conversationId,
        maxTurns,
        nowMs: args.event.occurredAtMs,
      });
    }
    // Do not enqueue a Turn. Terminal watches may still complete after this.
    return { status: "duplicate" };
  }

  const task = eventTaskFacts(
    args.subscription,
    args.event,
    args.people,
    args.doneBy,
  );
  return await appendAndEnqueueInboundMessage({
    message: createEventInboundMessage({
      event: args.event,
      subscription: {
        conversationId: args.subscription.conversationId,
        credentialSubject: args.subscription.credentialSubject,
        id: args.subscription.id,
      },
      task,
      text: renderTaskInput(task),
    }),
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}
