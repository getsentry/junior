import { describe, expect, it } from "vitest";
import type {
  ConversationEvent,
  ConversationEventPage,
  ConversationEventQuery,
  ConversationEventStore,
  HistoryReplacement,
  MessageHistory,
  NewConversationEvent,
} from "@/chat/conversations/history";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";

class MemoryConversationEventStore implements ConversationEventStore {
  readonly history: ConversationEvent[] = [];
  private readonly idempotencyKeys = new Set<string>();

  async append(
    _conversationId: string,
    events: NewConversationEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (
        event.idempotencyKey &&
        this.idempotencyKeys.has(event.idempotencyKey)
      ) {
        continue;
      }
      if (event.idempotencyKey) {
        this.idempotencyKeys.add(event.idempotencyKey);
      }
      this.history.push({
        schemaVersion: 1,
        seq: this.history.length,
        historyVersion: 0,
        ...(event.idempotencyKey
          ? { idempotencyKey: event.idempotencyKey }
          : undefined),
        createdAtMs: event.createdAtMs,
        data: event.data,
      });
    }
  }

  async replaceHistory(
    _conversationId: string,
    _replacement: HistoryReplacement,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async loadLatestStructuredEvent(): Promise<ConversationEvent | undefined> {
    return undefined;
  }

  async loadLatestInstruction(): Promise<ConversationEvent | undefined> {
    return undefined;
  }

  async loadCurrentHistory(): Promise<ConversationEvent[]> {
    return this.history;
  }

  async loadByIdempotencyKey(
    _conversationId: string,
    idempotencyKey: string,
  ): Promise<ConversationEvent | undefined> {
    return this.history.find(
      (event) => event.idempotencyKey === idempotencyKey,
    );
  }

  async loadHistoryContaining(): Promise<ConversationEvent[]> {
    return this.history;
  }

  async loadMessageHistory(): Promise<MessageHistory> {
    return { events: this.history, compaction: undefined, historyFromSeq: 0 };
  }

  async loadHistory(): Promise<ConversationEvent[]> {
    return this.history;
  }

  async query(
    _conversationId: string,
    query: ConversationEventQuery,
  ): Promise<ConversationEventPage> {
    const filtered = this.history.filter((event) => {
      if (query.afterSeq !== undefined && event.seq <= query.afterSeq) {
        return false;
      }
      if (query.beforeSeq !== undefined && event.seq >= query.beforeSeq) {
        return false;
      }
      if (query.types && query.types.length > 0) {
        return query.types.includes(
          event.data.type as (typeof query.types)[number],
        );
      }
      return true;
    });
    const newestFirst = query.afterSeq === undefined;
    const ordered = newestFirst
      ? [...filtered].sort((left, right) => right.seq - left.seq)
      : [...filtered].sort((left, right) => left.seq - right.seq);
    const overflow = ordered.length > query.limit;
    const page = overflow ? ordered.slice(0, query.limit) : ordered;
    const events = newestFirst ? [...page].reverse() : page;
    if (events.length === 0) {
      return { events, hasOlder: false, hasNewer: false };
    }
    const firstSeq = events[0]!.seq;
    const lastSeq = events[events.length - 1]!.seq;
    return {
      events,
      hasOlder: filtered.some((event) => event.seq < firstSeq),
      hasNewer: filtered.some((event) => event.seq > lastSeq),
    };
  }
}

describe("conversation turn lifecycle", () => {
  it("records start retries once with stable correlation", async () => {
    const store = new MemoryConversationEventStore();
    const lifecycle = new ConversationTurnLifecycleService(store);
    const input = {
      conversationId: "local:test:turn",
      createdAtMs: 100,
      inputMessageIds: ["message-1"],
      surface: "internal" as const,
      turnId: "turn-1",
    };

    await lifecycle.start(input);
    await lifecycle.start(input);

    expect(store.history).toEqual([
      expect.objectContaining({
        idempotencyKey: "turn:turn-1:started",
        data: {
          type: "turn_started",
          turnId: "turn-1",
          inputMessageIds: ["message-1"],
          surface: "internal",
        },
      }),
    ]);
  });

  it("keeps the first terminal fact across retries and conflicts", async () => {
    const store = new MemoryConversationEventStore();
    const lifecycle = new ConversationTurnLifecycleService(store);

    await lifecycle.complete({
      conversationId: "local:test:turn",
      createdAtMs: 200,
      outcome: "success",
      turnId: "turn-1",
    });
    await lifecycle.complete({
      conversationId: "local:test:turn",
      createdAtMs: 200,
      outcome: "success",
      turnId: "turn-1",
    });
    await lifecycle.fail({
      conversationId: "local:test:turn",
      createdAtMs: 300,
      failureCode: "delivery_failed",
      turnId: "turn-1",
    });

    expect(store.history).toHaveLength(1);
    expect(store.history[0]).toMatchObject({
      idempotencyKey: "turn:turn-1:terminal",
      data: {
        type: "turn_completed",
        turnId: "turn-1",
        outcome: "success",
      },
    });
  });

  it("surfaces append failures to the owning runtime boundary", async () => {
    const appendError = new Error("event store unavailable");
    const store = new MemoryConversationEventStore();
    let attempts = 0;
    store.append = async () => {
      attempts += 1;
      throw appendError;
    };
    const lifecycle = new ConversationTurnLifecycleService(store);

    await expect(
      lifecycle.start({
        conversationId: "local:test:turn",
        createdAtMs: 100,
        inputMessageIds: ["message-1"],
        surface: "internal",
        turnId: "turn-1",
      }),
    ).rejects.toBe(appendError);
    expect(attempts).toBe(1);
  });
});
