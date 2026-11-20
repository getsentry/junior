import type {
  ConversationEventStore,
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "./history";
import { getConversationEventStore } from "@/chat/db";
import { publishConversationStatus } from "@/chat/conversations/watch-events";
import { isEventInboundMessageId } from "@/chat/events/notification";
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

/** Product-owned inputs for closing one correlated conversation turn. */
export interface CompleteConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  /** `blocked` means a child agent stopped and reported what it needs. */
  outcome: "success" | "no_reply" | "cancelled" | "blocked";
  turnId: string;
}

/** Inputs for failing one correlated conversation turn. */
export interface FailConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  eventId?: string;
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  turnId: string;
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
  /** Delivers each Turn end to the Watches on the Conversation. */
  private readonly watchQueue: () => ConversationWorkQueue;

  constructor(
    events: ConversationEventStore,
    options: { watchQueue: () => ConversationWorkQueue },
  ) {
    this.events = events;
    // Required: a lifecycle without a queue drops Turn ends that Watches
    // must hear.
    this.watchQueue = options.watchQueue;
  }

  private async publish(
    input: { conversationId: string; createdAtMs: number },
    status: Parameters<typeof publishConversationStatus>[1],
    skip?: () => Promise<boolean>,
  ): Promise<void> {
    await publishConversationStatus(input.conversationId, status, {
      nowMs: input.createdAtMs,
      queue: this.watchQueue(),
      ...(skip ? { skip } : undefined),
    });
  }

  /** Record the turn start once after every input message is durable. */
  async start(input: StartConversationTurnInput): Promise<void> {
    await this.events.append(input.conversationId, [
      {
        idempotencyKey: `turn:${input.turnId}:started`,
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
      `turn:${turnId}:started`,
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
   * Publish the stored terminal row of a Turn, not the caller's outcome.
   * Only the first append stores it, so a worker that lost a race publishes
   * the same outcome as the one that won.
   */
  private async publishTerminal(input: {
    conversationId: string;
    createdAtMs: number;
    turnId: string;
  }): Promise<void> {
    const stored = await this.events.loadByIdempotencyKey(
      input.conversationId,
      `turn:${input.turnId}:terminal`,
    );
    if (stored?.data.type === "turn_failed") {
      await this.publish(input, {
        type: "turn_failed",
        failureCode: stored.data.failureCode,
        turnId: input.turnId,
      });
      return;
    }
    if (stored?.data.type !== "turn_completed") return;
    // A Turn that only Watch Events started reports nothing, so a watcher
    // is not woken for each Event that the Conversation itself watches.
    await this.publish(
      input,
      {
        type: "turn_completed",
        outcome: stored.data.outcome,
        turnId: input.turnId,
      },
      async () => {
        const inputs = await this.loadInputMessageIds(
          input.conversationId,
          input.turnId,
        );
        return (
          inputs !== undefined &&
          inputs.length > 0 &&
          inputs.every(isEventInboundMessageId)
        );
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
