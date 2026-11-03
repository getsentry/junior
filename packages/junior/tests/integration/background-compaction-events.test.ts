import { afterEach, describe, expect, it } from "vitest";
import { getConversationEventStore } from "@/chat/db";
import type { HistoryReplacement } from "@/chat/conversations/history";
import { openConversationProjection } from "@/chat/conversations/projection";
import { contextProvenance } from "@/chat/conversations/provenance";
import { closeConversationFixture } from "../fixtures/conversation";

const CONVERSATION_ID = "local:web:background-compaction";

function userMessage(text: string, timestamp: number) {
  return {
    type: "user_message" as const,
    provenance: contextProvenance,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

function compaction(summary: string): HistoryReplacement {
  return {
    createdAtMs: 10,
    data: {
      type: "compaction",
      modelProfile: "standard",
      modelId: "test/model",
      replacementHistory: [{ item: userMessage(summary, 10) }],
    },
  };
}

describe("background compaction events", () => {
  afterEach(closeConversationFixture);

  it("round-trips bookkeeping events without adding model context", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("Remember the blue option.", 1) },
      {
        createdAtMs: 2,
        data: {
          type: "compaction_requested",
          markSeq: 0,
          historyVersion: 0,
          modelProfile: "standard",
          modelId: "test/model",
        },
      },
      {
        createdAtMs: 3,
        data: {
          type: "compaction_prepared",
          markSeq: 0,
          historyVersion: 0,
          modelProfile: "standard",
          modelId: "test/model",
          outcome: "ready",
          summary: "The person picked the blue option.",
        },
      },
      {
        createdAtMs: 4,
        data: {
          type: "compaction_prepared",
          markSeq: 0,
          historyVersion: 0,
          modelProfile: "standard",
          modelId: "test/model",
          outcome: "failed",
          errorType: "timeout",
        },
      },
    ]);

    const history = await events.loadCurrentHistory(CONVERSATION_ID);
    expect(history.slice(1).map((event) => event.data)).toEqual([
      {
        type: "compaction_requested",
        markSeq: 0,
        historyVersion: 0,
        modelProfile: "standard",
        modelId: "test/model",
      },
      {
        type: "compaction_prepared",
        markSeq: 0,
        historyVersion: 0,
        modelProfile: "standard",
        modelId: "test/model",
        outcome: "ready",
        summary: "The person picked the blue option.",
      },
      {
        type: "compaction_prepared",
        markSeq: 0,
        historyVersion: 0,
        modelProfile: "standard",
        modelId: "test/model",
        outcome: "failed",
        errorType: "timeout",
      },
    ]);

    const projection = await openConversationProjection({
      conversationId: CONVERSATION_ID,
    });
    expect(projection.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Remember the blue option." }],
        timestamp: 1,
      },
    ]);
  });

  it("writes nothing when the expected history version is stale", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    await expect(
      events.replaceHistory(CONVERSATION_ID, compaction("Foreground summary.")),
    ).resolves.toEqual({ status: "replaced", historyVersion: 1 });

    // A summary prepared for version 0 must not replace version 1.
    await expect(
      events.replaceHistory(CONVERSATION_ID, compaction("Stale summary."), {
        expectedHistoryVersion: 0,
      }),
    ).resolves.toEqual({ status: "conflict", historyVersion: 1 });
    const afterConflict = await events.loadHistory(CONVERSATION_ID);
    expect(afterConflict).toHaveLength(2);

    await expect(
      events.replaceHistory(CONVERSATION_ID, compaction("Fresh summary."), {
        expectedHistoryVersion: 1,
      }),
    ).resolves.toEqual({ status: "replaced", historyVersion: 2 });
    const projection = await openConversationProjection({
      conversationId: CONVERSATION_ID,
    });
    expect(projection.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Fresh summary." }] },
    ]);
  });
});
