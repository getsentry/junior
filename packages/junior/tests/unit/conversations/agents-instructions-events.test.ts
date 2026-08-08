import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEvent,
  ConversationEventPage,
  ConversationEventQuery,
  ConversationEventStore,
  HistoryReplacement,
  MessageHistory,
  NewConversationEvent,
} from "@/chat/conversations/history";

const store = {
  history: [] as ConversationEvent[],
  idempotencyKeys: new Set<string>(),
};

function resetStore() {
  store.history = [];
  store.idempotencyKeys = new Set();
}

const memoryStore: ConversationEventStore = {
  async append(_conversationId, events: NewConversationEvent[]) {
    for (const event of events) {
      if (
        event.idempotencyKey &&
        store.idempotencyKeys.has(event.idempotencyKey)
      ) {
        continue;
      }
      if (event.idempotencyKey) {
        store.idempotencyKeys.add(event.idempotencyKey);
      }
      store.history.push({
        schemaVersion: 1,
        seq: store.history.length + 1,
        historyVersion: 0,
        ...(event.idempotencyKey
          ? { idempotencyKey: event.idempotencyKey }
          : {}),
        createdAtMs: event.createdAtMs,
        data: event.data,
      });
    }
  },
  async replaceHistory(
    _conversationId: string,
    _replacement: HistoryReplacement,
  ): Promise<void> {
    throw new Error("not implemented");
  },
  async loadLatestInstruction(): Promise<ConversationEvent | undefined> {
    return undefined;
  },
  async loadCurrentHistory(): Promise<ConversationEvent[]> {
    return store.history;
  },
  async loadByIdempotencyKey(
    _conversationId: string,
    idempotencyKey: string,
  ): Promise<ConversationEvent | undefined> {
    return store.history.find(
      (event) => event.idempotencyKey === idempotencyKey,
    );
  },
  async loadHistoryContaining(): Promise<ConversationEvent[]> {
    return store.history;
  },
  async loadMessageHistory(): Promise<MessageHistory> {
    return { events: store.history, compaction: undefined, historyFromSeq: 0 };
  },
  async loadHistory(): Promise<ConversationEvent[]> {
    return store.history;
  },
  async query(
    _conversationId: string,
    query: ConversationEventQuery,
  ): Promise<ConversationEventPage> {
    const filtered = store.history.filter((event) => {
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
  },
};

vi.mock("@/chat/db", () => ({
  getConversationEventStore: () => memoryStore,
  getSqlExecutor: () => {
    throw new Error("sql unused");
  },
}));

import {
  loadLatestAgentsInstructionsState,
  recordAgentsInstructionsUpdated,
} from "@/chat/conversations/projection";

const source = {
  content: "# Agent Instructions\n\nUse pnpm.",
  path: "/vercel/sandbox/junior/AGENTS.md",
};

describe("agents instructions durable events", () => {
  beforeEach(() => {
    resetStore();
  });

  it("skips repeated loads of the same active fingerprint", async () => {
    await recordAgentsInstructionsUpdated({
      action: "loaded",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "abc",
      sources: [source],
      textBytes: 32,
      turnId: "turn-1",
    });
    await recordAgentsInstructionsUpdated({
      action: "loaded",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "abc",
      sources: [source],
      textBytes: 32,
      turnId: "turn-2",
    });

    expect(store.history).toHaveLength(1);
    expect(store.history[0]?.data).toMatchObject({
      type: "structured_event",
      name: "agents_instructions_updated",
      content: { action: "loaded", fingerprint: "abc" },
    });
  });

  it("records clear then reload as distinct transitions", async () => {
    await recordAgentsInstructionsUpdated({
      action: "loaded",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "abc",
      sources: [source],
      turnId: "turn-1",
    });
    await recordAgentsInstructionsUpdated({
      action: "cleared",
      conversationId: "conv-1",
      fingerprint: "cleared",
      sources: [],
      turnId: "turn-1",
    });
    await recordAgentsInstructionsUpdated({
      action: "loaded",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "abc",
      sources: [source],
      turnId: "turn-1",
    });
    await recordAgentsInstructionsUpdated({
      action: "cleared",
      conversationId: "conv-1",
      fingerprint: "cleared",
      sources: [],
      turnId: "turn-1",
    });

    expect(store.history.map((event) => event.data)).toMatchObject([
      { content: { action: "loaded", fingerprint: "abc" } },
      { content: { action: "cleared", fingerprint: "cleared" } },
      { content: { action: "loaded", fingerprint: "abc" } },
      { content: { action: "cleared", fingerprint: "cleared" } },
    ]);
    expect(
      new Set(store.history.map((event) => event.idempotencyKey)).size,
    ).toBe(4);
  });

  it("loads the latest durable agents state", async () => {
    await recordAgentsInstructionsUpdated({
      action: "loaded",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "abc",
      sources: [source],
      turnId: "turn-1",
    });
    await recordAgentsInstructionsUpdated({
      action: "replaced",
      conversationId: "conv-1",
      directory: "/vercel/sandbox/junior",
      fingerprint: "def",
      sources: [{ ...source, content: "Use bun." }],
      turnId: "turn-2",
    });

    await expect(
      loadLatestAgentsInstructionsState({ conversationId: "conv-1" }),
    ).resolves.toEqual({
      action: "replaced",
      directory: "/vercel/sandbox/junior",
      fingerprint: "def",
      seq: 2,
    });
  });
});
