import { objectTypeSchema, type ObjectType } from "@sentry/junior-plugin-api";
import * as z from "zod";
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
import type {
  ConversationMessageEvent,
  ConversationMessageMeta,
} from "@/chat/state/conversation";
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
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { authorLabel, type AuthorTrust } from "@/chat/identities/trust";
import type {
  AgentInstructionActor,
  AgentInstructionInput,
} from "@/chat/agent/types";
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
  /**
   * A trusted author's own text. The Turn shows it as their message, like a
   * chat message, apart from the Event task.
   */
  authorMessage: z
    .object({
      text: z.string().min(1),
      authorId: z.string().optional(),
      authorName: z.string().optional(),
    })
    .optional(),
  /** Label of the Event author when core does not trust them. */
  untrustedAuthor: z.string().optional(),
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
  /** Core's decision for the Event author. */
  author: AuthorTrust = { status: "system" },
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
    ...authorFacts(author, event.untrustedText),
    ...(doneBy ? { doneBy } : undefined),
  };
}

// A trusted author's own text is their message, shown once. Other text,
// such as what they quote, stays external text. An untrusted author's text
// is external text that names them.
function authorFacts(
  author: AuthorTrust,
  untrustedText: string | undefined,
): Pick<EventTaskFacts, "authorMessage" | "externalText" | "untrustedAuthor"> {
  if (author.status === "untrusted") {
    const externalText = [author.text, untrustedText]
      .filter(Boolean)
      .join("\n\n");
    return {
      ...(externalText ? { externalText } : undefined),
      untrustedAuthor: authorLabel(author),
    };
  }
  return {
    ...(author.status === "trusted" && author.text
      ? {
          authorMessage: {
            text: author.text,
            ...(author.actor
              ? { authorId: author.actor.userId }
              : { authorName: authorLabel(author) }),
          },
        }
      : undefined),
    ...(untrustedText ? { externalText: untrustedText } : undefined),
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
 * Write the agent inputs for an Event batch, one prompt content part each.
 *
 * One Event keeps its own text. Several Watch Events become one `<task>`
 * with one group per Watch, so shared instructions appear once. Entries
 * without task facts, such as child agent results, keep their own text as
 * their own inputs after the task. `rendered` replaces the text of an entry
 * by inbound message id, such as a person change to a Review item.
 */
export function renderEventBatchInputs(
  messages: readonly InboundMessage[],
  rendered: ReadonlyMap<string, string> = new Map(),
): AgentInstructionInput[] {
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
      source: metadata.event.namespace,
      trustedSummary: facts.trustedSummary,
      verifiedDetails: facts.verifiedDetails,
      externalText: facts.externalText,
      untrustedAuthor: facts.untrustedAuthor,
      doneBy: facts.doneBy,
    });
  }

  const ownText = (message: InboundMessage) =>
    rendered.get(message.inboundMessageId) ?? message.input.text.trim();
  const taskCount = messages.length - others.length;
  const runtime = (
    taskCount < 2
      ? messages.map(ownText)
      : [
          renderTaskBatchInput({ groups: [...groups.values()] }),
          ...others.map(ownText),
        ]
  )
    .filter(Boolean)
    .map((text) => ({ kind: "runtime" as const, text }));
  // Trusted authors' own text follows the task, as person input. A batch has
  // one author, because Event Messages with different authors never share a
  // Turn.
  const authored = messages.flatMap((message) => {
    const text = readEventTaskFacts(message)?.facts.authorMessage?.text;
    return text ? [{ kind: "person" as const, text }] : [];
  });
  return [...runtime, ...authored];
}

/** Return who wrote the person input of an Event batch, for the prompt. */
export function eventBatchAuthor(
  messages: readonly InboundMessage[],
): AgentInstructionActor | undefined {
  for (const message of messages) {
    const author = readEventTaskFacts(message)?.facts.authorMessage;
    if (author) {
      const { text: _text, ...actor } = author;
      return actor;
    }
  }
  return undefined;
}

/** Return the conversation message entry for one Event input. */
function messageEvent(message: InboundMessage): ConversationMessageEvent[] {
  const metadata = message.input.metadata;
  if (!isEventMailboxMetadata(metadata)) return [];
  const label = readEventTaskFacts(message)?.facts.about;
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
}

/**
 * Return the saved Message fields for the Event inputs of one Turn.
 *
 * A person change to a Review item is not one of the Message's own Events:
 * its record goes to `reviewItemChanges`, and the dashboard shows it as a
 * change row. The Message's own Event is its first Watch Event, the
 * kind the task message counts, or else its first other input, such as an
 * agent result. `events` lists the Watch Events when several arrived. When
 * changes share the Message with one own Event, `events` lists that Event, so
 * a reader can tell it from a Message that only records changes.
 */
export function eventBatchMessageMeta(
  messages: readonly InboundMessage[],
): Pick<
  ConversationMessageMeta,
  | "eventNamespace"
  | "eventObjectType"
  | "eventType"
  | "events"
  | "reviewItemChanges"
  | "trustedSummary"
> {
  const reviewItemChanges = messages.flatMap((message) =>
    message.input.reviewItemChange ? [message.input.reviewItemChange] : [],
  );
  const own = messages.filter((message) => !message.input.reviewItemChange);
  const watched = own.filter((message) => readEventTaskFacts(message));
  const primary = watched[0] ?? own[0];
  const metadata = (primary ?? messages[0])?.input.metadata;
  if (!isEventMailboxMetadata(metadata)) return {};
  const events =
    watched.length > 1
      ? watched.flatMap(messageEvent)
      : reviewItemChanges.length && primary
        ? messageEvent(primary)
        : [];
  return {
    eventType: metadata.event.eventType,
    eventNamespace: metadata.event.namespace,
    eventObjectType: metadata.event.objectType,
    ...(metadata.event.trustedSummary
      ? { trustedSummary: metadata.event.trustedSummary }
      : undefined),
    ...(events.length ? { events } : undefined),
    ...(reviewItemChanges.length ? { reviewItemChanges } : undefined),
  };
}

// A linked trusted author writes the Event Message, like a Slack author. A
// listed bot has no Identity, so it gets its own author id. Batching splits
// Messages whose authors differ. Other Events are written by the system.
function eventMessageAuthor(
  author: AuthorTrust | undefined,
): Pick<InboundMessage["input"], "authorId" | "authorIdentityId"> {
  if (author?.status !== "trusted") {
    return { authorId: EVENT_AUTHOR_ID, authorIdentityId: SYSTEM_IDENTITY_ID };
  }
  if (author.identityId) {
    return { authorId: EVENT_AUTHOR_ID, authorIdentityId: author.identityId };
  }
  return {
    authorId: `${EVENT_AUTHOR_ID}:${author.provider}:${author.handle.toLowerCase()}`,
    authorIdentityId: SYSTEM_IDENTITY_ID,
  };
}

/** Build plain conversation mailbox input for one matched watch. */
export function createEventInboundMessage(input: {
  event: EventNotification;
  subscription: Pick<Watch, "conversationId" | "credentialSubject" | "id">;
  text: string;
  /** Facts behind `text`, used when several Events share one message. */
  task?: EventTaskFacts;
  /** Core's decision for the Event author. */
  author?: AuthorTrust;
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
      ...eventMessageAuthor(input.author),
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
  /** Core's decision for the Event author. */
  author?: AuthorTrust;
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
    args.author,
  );
  return await appendAndEnqueueInboundMessage({
    message: createEventInboundMessage({
      author: args.author,
      event: args.event,
      subscription: {
        conversationId: args.subscription.conversationId,
        credentialSubject: args.subscription.credentialSubject,
        id: args.subscription.id,
      },
      task,
      text: renderTaskInput({
        ...task,
        event: args.event.eventType,
        source: args.event.namespace,
      }),
    }),
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
    state: args.state,
  });
}
