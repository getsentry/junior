import { describe, expect, it } from "vitest";
import {
  createForkConversationId,
  forkConversation,
} from "@/chat/conversations/fork";
import {
  commitMessages,
  openConversationProjection,
} from "@/chat/conversations/projection";
import {
  contextProvenance,
  instructionProvenanceFor,
} from "@/chat/conversations/provenance";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";

const SOURCE_ID = "local:web:fork-source-1";
const instructionProvenance = instructionProvenanceFor(undefined);

function userMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistantMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

describe("conversation fork", () => {
  it("creates a private root with agent history through the cutoff", async () => {
    const store = getConversationStore();
    const events = getConversationEventStore();

    await store.recordActivity({
      conversationId: SOURCE_ID,
      nowMs: 1_000,
      source: "web",
      title: "Source thread",
      destination: {
        platform: "local",
        conversationId: SOURCE_ID,
      },
      // Private source must stay private on the fork root.
      visibility: "private",
    });

    const first = userMessage("start here", 1_000);
    const second = assistantMessage("first answer", 1_100);
    const third = userMessage("later branch point", 1_200);
    const fourth = assistantMessage("should not copy", 1_300);

    // Interleave the platform message between history items so a UI
    // fork-from-message cuts after the first assistant reply only.
    await commitMessages({
      conversationId: SOURCE_ID,
      messages: [first, second],
      provenance: [instructionProvenance, contextProvenance],
    });
    await events.append(SOURCE_ID, [
      {
        createdAtMs: 1_150,
        idempotencyKey: "message:msg-cutoff",
        data: {
          type: "message",
          messageId: "msg-cutoff",
          role: "assistant",
          text: "first answer",
        },
      },
    ]);
    await commitMessages({
      conversationId: SOURCE_ID,
      messages: [first, second, third, fourth],
      provenance: [
        instructionProvenance,
        contextProvenance,
        instructionProvenance,
        contextProvenance,
      ],
    });

    const history = await events.loadCurrentHistory(SOURCE_ID);
    const secondSeq = history.find(
      (event) => event.data.type === "assistant_message",
    )?.seq;
    expect(secondSeq).toBeTypeOf("number");

    const forked = await forkConversation({
      sourceConversationId: SOURCE_ID,
      cutoff: { kind: "message", messageId: "msg-cutoff" },
      idempotencyKey: "fork-key-1",
    });

    expect(forked.status).toBe("created");
    expect(forked.conversationId).toBe(
      createForkConversationId({
        sourceConversationId: SOURCE_ID,
        idempotencyKey: "fork-key-1",
      }),
    );
    expect(forked.throughSeq).toBe(secondSeq);
    expect(forked.sourceMessageId).toBe("msg-cutoff");

    const forkRow = await store.get({ conversationId: forked.conversationId });
    expect(forkRow).toMatchObject({
      conversationId: forked.conversationId,
      source: "internal",
      title: "Source thread",
      visibility: "private",
    });
    expect(forkRow?.lineage).toBeUndefined();

    const projection = await openConversationProjection({
      conversationId: forked.conversationId,
    });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "start here" }],
    });
    expect(projection.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
    });

    const forkEvents = await events.loadHistory(forked.conversationId);
    expect(
      forkEvents.some(
        (event) =>
          event.data.type === "structured_event" &&
          event.data.name === "conversation_forked",
      ),
    ).toBe(true);

    const retry = await forkConversation({
      sourceConversationId: SOURCE_ID,
      cutoff: { kind: "message", messageId: "msg-cutoff" },
      idempotencyKey: "fork-key-1",
    });
    expect(retry).toEqual({
      ...forked,
      status: "duplicate",
    });
  });

  it("rejects child conversation forks", async () => {
    const store = getConversationStore();
    const parentId = "local:web:fork-parent-1";
    const childId = "local:web:fork-child-1";

    await store.recordActivity({
      conversationId: parentId,
      nowMs: 1_000,
      source: "web",
      destination: {
        platform: "local",
        conversationId: parentId,
      },
      visibility: "public",
    });
    await store.createChild({
      parentConversationId: parentId,
      childConversationId: childId,
      nowMs: 1_100,
      source: "internal",
    });

    await expect(
      forkConversation({
        sourceConversationId: childId,
        cutoff: { kind: "seq", throughSeq: 0 },
        idempotencyKey: "child-fork",
      }),
    ).rejects.toThrow("Forking child conversations is not supported");
  });
});
