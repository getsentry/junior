import type { Actor } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import type {
  ConversationEventStore,
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "./history";
import { getConversationEventStore } from "@/chat/db";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import {
  failedTurnUpdate,
  readTurnUpdate,
} from "@/chat/conversations/turn-update";
import { isEventInboundMessageId } from "@/chat/events/inbound-message-id";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

/** Product-owned inputs for opening one correlated conversation turn. */
export interface StartConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  inputMessageIds: string[];
  surface: "slack" | "api" | "scheduler" | "internal";
  /** Highest Message seq known when the Turn built its thread context. */
  threadContextThroughSeq?: number | undefined;
  turnId: string;
}

/** The text of a Turn's answer, and whether it is final text or a note. */
export type TurnAnswerText = { kind: "final_text" | "note"; text: string };

/** Product-owned inputs for closing one correlated conversation turn. */
export interface CompleteConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  /**
   * What a Turn that posted no reply answered: its final text, such as a
   * child agent's reply, or the note of the tool that ended it. The
   * transcript keeps it; only the update reads it.
   */
  answer?: TurnAnswerText | undefined;
  /** `blocked` means a child agent stopped and reported what it needs. */
  outcome: "success" | "no_reply" | "cancelled" | "blocked";
  /**
   * The Actor that the starter's Turn for this Turn's update runs as, by
   * default the Event system Actor.
   */
  reportAs?: Actor | undefined;
  turnId: string;
}

/** Inputs for failing one correlated conversation turn. */
export interface FailConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  eventId?: string;
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  /** What failed, for the update only. It is not stored. */
  failureText?: string | undefined;
  reportAs?: Actor | undefined;
  turnId: string;
}

/** The seq and time of a Turn's `turn_started` event. */
export interface TurnStart {
  seq: number;
  startedAtMs: number;
}

function turnStartedKey(turnId: string): string {
  return `turn:${turnId}:started`;
}

/** Load the `turn_started` event of a Turn, when it started. */
export async function loadTurnStart(
  conversationId: string,
  turnId: string,
): Promise<TurnStart | undefined> {
  const event = await getConversationEventStore().loadByIdempotencyKey(
    conversationId,
    turnStartedKey(turnId),
  );
  return event?.data.type === "turn_started"
    ? { seq: event.seq, startedAtMs: event.createdAtMs }
    : undefined;
}

/** Runtime port for correlated canonical turn lifecycle persistence. */
export interface ConversationTurnLifecycle {
  start(input: StartConversationTurnInput): Promise<void>;
  complete(input: CompleteConversationTurnInput): Promise<void>;
  fail(input: FailConversationTurnInput): Promise<void>;
}

/** Persist correlated turn lifecycle facts with retry-safe terminal exclusion. */
export class ConversationTurnLifecycleService implements ConversationTurnLifecycle {
  private readonly events: ConversationEventStore;
  /** Delivers each Turn end to the starter and the Watches. */
  private readonly watchQueue: () => ConversationWorkQueue;
  private readonly state: StateAdapter | undefined;

  constructor(
    events: ConversationEventStore,
    options: {
      state?: StateAdapter | undefined;
      watchQueue: () => ConversationWorkQueue;
    },
  ) {
    this.events = events;
    // Required: a lifecycle without a queue drops Turn ends that the
    // starter and Watches must hear.
    this.watchQueue = options.watchQueue;
    this.state = options.state;
  }

  /** Record the turn start once after every input message is durable. */
  async start(input: StartConversationTurnInput): Promise<void> {
    await this.events.append(input.conversationId, [
      {
        idempotencyKey: turnStartedKey(input.turnId),
        createdAtMs: input.createdAtMs,
        data: {
          type: "turn_started",
          turnId: input.turnId,
          inputMessageIds: input.inputMessageIds,
          surface: input.surface,
          ...(input.threadContextThroughSeq === undefined
            ? undefined
            : { threadContextThroughSeq: input.threadContextThroughSeq }),
        },
      },
    ]);
  }

  /** Return the input message ids that started a Turn, when it started. */
  async loadInputMessageIds(
    conversationId: string,
    turnId: string,
  ): Promise<string[] | undefined> {
    const event = await this.events.loadByIdempotencyKey(
      conversationId,
      turnStartedKey(turnId),
    );
    return event?.data.type === "turn_started"
      ? event.data.inputMessageIds
      : undefined;
  }

  /** Record a completion that is not a failure once. */
  async complete(input: CompleteConversationTurnInput): Promise<void> {
    await this.events.append(input.conversationId, [
      {
        idempotencyKey: `turn:${input.turnId}:terminal`,
        createdAtMs: input.createdAtMs,
        data: {
          type: "turn_completed",
          turnId: input.turnId,
          outcome: input.outcome,
        },
      },
    ]);
    await this.publishTerminal(input);
  }

  /** Record a classified failure once. Do not store raw error text. */
  async fail(input: FailConversationTurnInput): Promise<void> {
    await this.events.append(input.conversationId, [
      {
        idempotencyKey: `turn:${input.turnId}:terminal`,
        createdAtMs: input.createdAtMs,
        data: {
          type: "turn_failed",
          turnId: input.turnId,
          failureCode: input.failureCode,
          ...(input.failureReason
            ? { failureReason: input.failureReason }
            : undefined),
          ...(input.eventId ? { eventId: input.eventId } : undefined),
        },
      },
    ]);
    await this.publishTerminal(input);
  }

  /**
   * Publish the agent update of a Turn from its stored terminal row, not the
   * caller's outcome. Only the first append stores it, so a worker that lost
   * a race publishes the same update as the one that won. A starter that
   * does not hear it fails the caller, so the Turn retries.
   */
  private async publishTerminal(input: {
    conversationId: string;
    createdAtMs: number;
    answer?: TurnAnswerText | undefined;
    failureText?: string | undefined;
    reportAs?: Actor | undefined;
    turnId: string;
  }): Promise<void> {
    const options = {
      nowMs: input.createdAtMs,
      queue: this.watchQueue(),
      ...(input.reportAs ? { starter: input.reportAs } : undefined),
      state: this.state,
    };
    const stored = await this.events.loadByIdempotencyKey(
      input.conversationId,
      `turn:${input.turnId}:terminal`,
    );
    if (stored?.data.type === "turn_failed") {
      const { failureCode } = stored.data;
      await publishAgentUpdate(
        input.conversationId,
        { type: "turn_failed", turnId: input.turnId },
        {
          ...options,
          update: async () => failedTurnUpdate(failureCode, input.failureText),
        },
      );
      return;
    }
    if (stored?.data.type !== "turn_completed") return;
    const { outcome } = stored.data;
    const terminalSeq = stored.seq;
    let eventOnly: Promise<boolean> | undefined;
    // A Turn that only Watch Events started, such as GitHub feedback.
    const startedByEventsOnly = () =>
      (eventOnly ??= this.loadInputMessageIds(
        input.conversationId,
        input.turnId,
      ).then(
        (inputs) =>
          inputs !== undefined &&
          inputs.length > 0 &&
          inputs.every(isEventInboundMessageId),
      ));
    await publishAgentUpdate(
      input.conversationId,
      { type: "turn", turnId: input.turnId },
      {
        ...options,
        // A Watch skips a Turn that only Watch Events started, so a watcher
        // is not woken for each Event that the Conversation itself watches.
        skip: startedByEventsOnly,
        update: async () => {
          // Final text wakes the agents that wait on it, as a reply does.
          if (outcome === "no_reply" && input.answer?.kind === "final_text") {
            return { status: "done", text: input.answer.text };
          }
          const start = await this.events.loadByIdempotencyKey(
            input.conversationId,
            turnStartedKey(input.turnId),
          );
          return await readTurnUpdate(this.events, {
            conversationId: input.conversationId,
            outcome,
            // A Turn ended before it started holds none of its own events.
            startSeq: start?.seq ?? terminalSeq,
            terminalSeq,
            turnId: input.turnId,
            ...(input.answer ? { answerText: input.answer.text } : undefined),
          });
        },
      },
    );
  }
}

/** Return the Turn lifecycle that records Conversation events. */
export function getTurnLifecycle(): ConversationTurnLifecycleService {
  return new ConversationTurnLifecycleService(getConversationEventStore(), {
    watchQueue: getVercelConversationWorkQueue,
  });
}
