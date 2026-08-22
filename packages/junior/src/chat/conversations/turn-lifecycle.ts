import type {
  ConversationEventStore,
  ConversationTurnFailureCode,
} from "./history";

/** Product-owned inputs for opening one correlated conversation turn. */
export interface StartConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  inputMessageIds: string[];
  surface: "slack" | "api" | "scheduler" | "internal";
  turnId: string;
}

/** Product-owned inputs for closing one correlated conversation turn. */
export interface CompleteConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  outcome: "success" | "no_reply" | "cancelled";
  turnId: string;
}

/** Privacy-safe inputs for failing one correlated conversation turn. */
export interface FailConversationTurnInput {
  conversationId: string;
  createdAtMs: number;
  eventId?: string;
  failureCode: ConversationTurnFailureCode;
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
  constructor(private readonly events: ConversationEventStore) {}

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
        },
      },
    ]);
  }

  /** Record successful or intentional-silence completion once. */
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
  }

  /** Record a classified failure once without accepting raw error details. */
  async fail(input: FailConversationTurnInput): Promise<void> {
    await this.events.append(input.conversationId, [
      {
        idempotencyKey: `turn:${input.turnId}:terminal`,
        createdAtMs: input.createdAtMs,
        data: {
          type: "turn_failed",
          turnId: input.turnId,
          failureCode: input.failureCode,
          ...(input.eventId ? { eventId: input.eventId } : undefined),
        },
      },
    ]);
  }
}
