import { describe, expect, it } from "vitest";
import { commitMessages } from "@/chat/conversations/projection";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { PiMessage } from "@/chat/pi/messages";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const CONVERSATION_ID = "slack:CCOMMIT:1718123456.000000";

function user(text: string, timestamp: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistant(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

describe("commitMessages cursor fencing", () => {
  it("appends only the delta from a fenced base without rewriting message seqs", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);

      const first = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1), assistant("hi", 2)],
        executor: fixture.sql,
      });
      expect(first.committedSeq).toBe(1);
      expect(first.messageSeqs).toEqual([0, 1]);
      expect(first.historyVersion).toBe(0);

      const second = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1), assistant("hi", 2), user("follow up", 3)],
        base: {
          committedSeq: first.committedSeq,
          historyVersion: first.historyVersion,
          messageSeqs: first.messageSeqs,
          messages: first.messages,
          provenance: first.provenance,
        },
        turnContext: {
          turnId: "turn-1",
          contexts: [
            {
              pluginName: "test-plugin",
              kind: "note",
              version: 1,
              content: { text: "context" },
              loadedAtMs: 4,
            },
          ],
        },
        executor: fixture.sql,
      });

      expect(second.committedSeq).toBe(3);
      expect(second.messageSeqs).toEqual([0, 1, 2]);
      expect(second.historyVersion).toBe(0);

      const store = createSqlConversationEventStore(fixture.sql);
      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => [event.seq, event.data.type])).toEqual([
        [0, "user_message"],
        [1, "assistant_message"],
        [2, "user_message"],
        [3, "turn_context"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a stale base when live history diverges from the next commit", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);

      const first = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1)],
        executor: fixture.sql,
      });

      // Concurrent checkpoint wrote a different assistant reply than this
      // caller still wants to commit. Same-prefix races may adopt; rewrites must not.
      await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1), assistant("other path", 2)],
        executor: fixture.sql,
      });

      await expect(
        commitMessages({
          conversationId: CONVERSATION_ID,
          messages: [user("hello", 1), assistant("hi", 2), user("stale", 3)],
          base: {
            committedSeq: first.committedSeq,
            historyVersion: first.historyVersion,
            messageSeqs: first.messageSeqs,
            messages: first.messages,
            provenance: first.provenance,
          },
          executor: fixture.sql,
        }),
      ).rejects.toThrow(/changed before its committed boundary/);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a fenced base when only host-only events advanced the cursor", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);

      const first = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1), assistant("hi", 2)],
        executor: fixture.sql,
      });

      const store = createSqlConversationEventStore(fixture.sql);
      await store.append(CONVERSATION_ID, [
        {
          data: { type: "mcp_provider_connected", provider: "github" },
          createdAtMs: 3,
        },
      ]);

      const second = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [
          user("hello", 1),
          assistant("hi", 2),
          user("follow up", 4),
        ],
        base: {
          committedSeq: first.committedSeq,
          historyVersion: first.historyVersion,
          messageSeqs: first.messageSeqs,
          messages: first.messages,
          provenance: first.provenance,
        },
        executor: fixture.sql,
      });

      expect(second.messageSeqs).toEqual([0, 1, 3]);
      expect(second.committedSeq).toBe(3);
      expect(second.historyVersion).toBe(0);

      const history = await store.loadHistory(CONVERSATION_ID);
      expect(history.map((event) => [event.seq, event.data.type])).toEqual([
        [0, "user_message"],
        [1, "assistant_message"],
        [2, "mcp_provider_connected"],
        [3, "user_message"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("adopts a concurrent same-prefix agent commit past a stale fence base", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);

      const first = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1)],
        executor: fixture.sql,
      });

      // A racing turn_end checkpoint already wrote the tool boundary while the
      // session record still points at the pre-tool fence.
      const concurrent = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [user("hello", 1), assistant("working", 2), user("done", 3)],
        executor: fixture.sql,
      });

      const second = await commitMessages({
        conversationId: CONVERSATION_ID,
        messages: [
          user("hello", 1),
          assistant("working", 2),
          user("done", 3),
        ],
        base: {
          committedSeq: first.committedSeq,
          historyVersion: first.historyVersion,
          messageSeqs: first.messageSeqs,
          messages: first.messages,
          provenance: first.provenance,
        },
        executor: fixture.sql,
      });

      expect(second.messageSeqs).toEqual(concurrent.messageSeqs);
      expect(second.committedSeq).toBe(concurrent.committedSeq);
      expect(second.historyVersion).toBe(concurrent.historyVersion);
    } finally {
      await fixture.close();
    }
  });
});
