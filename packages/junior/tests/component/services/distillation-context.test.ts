import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { closeDb, getConversationEventStore } from "@/chat/db";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { compactWithDistillations } from "@/chat/distillation/context";

function user(text: string, timestamp: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistant(text: string, timestamp: number): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("Conversation distillation context", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("uses a priced observation while retaining recent work and the new instruction's author", async () => {
    const conversationId = "local:distillation:priced-context";
    const actor = { platform: "web" as const, userId: "user-one" };
    const first = [
      user("Inspect the old result.", 1),
      assistant(`Old result: ${"x".repeat(80_000)}`, 2),
    ];
    await commitMessages({
      conversationId,
      messages: first,
      newMessageProvenance: { authority: "instruction", actor },
    });
    const firstProjection = await loadConversationProjection({
      conversationId,
    });
    const throughSeq = firstProjection.seqs.at(-1)!;
    const store = getConversationEventStore();
    await store.append(
      conversationId,
      [
        {
          createdAtMs: 3,
          data: {
            type: "distillation",
            generation: 0,
            sourceHistoryVersion: 0,
            fromSeq: firstProjection.seqs[0]!,
            throughSeq,
            observations: "The old result was inspected.",
            modelId: "openai/gpt-6-luna",
            costUsd: 0.0001,
          },
        },
      ],
      { activity: "preserve" },
    );
    const recent = [
      user("Keep the current plan.", 4),
      assistant("Plan: verify the next request.", 5),
    ];
    await commitMessages({
      conversationId,
      messages: [...first, ...recent],
      newMessageProvenance: { authority: "instruction", actor },
    });
    await commitMessages({
      conversationId,
      messages: [...first, ...recent, user("Finish the new request.", 6)],
      newMessageProvenance: { authority: "instruction", actor },
    });
    const projection = await loadConversationProjection({ conversationId });
    const pendingInstruction = {
      message: projection.messages.at(-1)!,
      provenance: projection.provenance.at(-1)!,
    };
    const args = {
      conversationId,
      modelId: "anthropic/claude-opus-5.5",
      modelProfile: "handoff" as const,
      messages: projection.messages.slice(0, -1),
      pendingInstruction,
    };
    await expect(
      compactWithDistillations({
        ...args,
        pendingInstruction: {
          ...pendingInstruction,
          provenance: { authority: "context" },
        },
      }),
    ).resolves.toBeUndefined();
    const replacement = await compactWithDistillations(args);
    expect(replacement).toBeDefined();
    const events = await store.loadCurrentHistory(conversationId);
    const compaction = events.find((event) => event.data.type === "compaction");
    expect(compaction?.data).toMatchObject({
      details: { reason: "distillation", throughSeq, priced: true },
      summary: expect.stringContaining('authority="evidence-only"'),
    });
    if (compaction?.data.type !== "compaction")
      throw new Error("No distillation history replacement");
    expect(compaction.data.replacementHistory[0]?.item).toMatchObject({
      type: "user_message",
      provenance: { authority: "context" },
    });
    expect(compaction.data.replacementHistory.at(-1)).toMatchObject({
      sourceEventSeq: projection.seqs.at(-1),
      item: {
        type: "user_message",
        provenance: { authority: "instruction", actor },
      },
    });
    expect(JSON.stringify(replacement)).toContain("Keep the current plan.");
    expect(JSON.stringify(replacement)).toContain("Finish the new request.");
    expect(JSON.stringify(replacement)).not.toContain("Old result:");
    expect(
      (await loadConversationProjection({ conversationId })).messages,
    ).toEqual(replacement);
  });
});
