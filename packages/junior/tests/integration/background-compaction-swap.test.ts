import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { compactWithPreparedSummary } from "@/chat/services/context-compaction-swap";
import { closeConversationFixture } from "../fixtures/conversation";

const MODEL_ID = "openai/gpt-5.4";
// Above the compaction threshold of the default 400k token window.
const OVERSIZED_TEXT = "x".repeat(1_600_000);
const LONG_LOG = Array.from(
  { length: 400 },
  (_, index) => `step ${index} checksum ${(index * 7_919).toString(16)}`,
).join("\n");

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

function toolCall(id: string, timestamp: number): PiMessage {
  return {
    ...assistant("", timestamp),
    content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
    stopReason: "toolUse",
  } as PiMessage;
}

function toolResult(
  id: string,
  text: string,
  timestamp: number,
  isError = false,
): PiMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
    timestamp,
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content
      ?.map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

/** Commit an earlier Turn and a prepared summary that covers it. */
async function prepareSummary(
  conversationId: string,
  messages: PiMessage[],
  overrides: { historyVersion?: number; modelProfile?: string } = {},
) {
  const committed = await commitMessages({ conversationId, messages });
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: Date.now(),
      data: {
        type: "compaction_prepared",
        markSeq: committed.committedSeq,
        historyVersion: overrides.historyVersion ?? committed.historyVersion,
        modelProfile: (overrides.modelProfile ?? "standard") as "standard",
        modelId: MODEL_ID,
        outcome: "ready",
        summary: "The person asked for the deploy checksum of build 7421.",
      },
    },
  ]);
  return committed;
}

const firstTurn = [
  user("<current-instruction>Find build 7421.</current-instruction>", 1),
  toolCall("call-1", 2),
  toolResult("call-1", OVERSIZED_TEXT, 3),
  assistant("Found build 7421.", 4),
];

describe("background compaction swap", () => {
  afterEach(closeConversationFixture);

  it("swaps a ready summary at Turn start and trims old tool results", async () => {
    const conversationId = "local:web:swap-turn-start";
    await prepareSummary(conversationId, firstTurn);
    // Two Turns after the mark: the first one's results get trimmed, the
    // latest one's stay whole.
    const afterMark = [
      user(
        "<current-instruction>Read the deploy log.</current-instruction>",
        5,
      ),
      toolCall("call-2", 6),
      toolResult("call-2", LONG_LOG, 7),
      toolResult("call-3", `failed: ${"e".repeat(3_000)}`, 7, true),
      assistant("Read it.", 8),
      user(
        "<current-instruction>And the rollback log?</current-instruction>",
        9,
      ),
      toolCall("call-4", 10),
      toolResult("call-4", LONG_LOG, 11),
      assistant("Read that too.", 12),
    ];
    const committed = await commitMessages({
      conversationId,
      messages: [...firstTurn, ...afterMark],
    });
    const prompt = user(
      "<current-instruction>What was the checksum?</current-instruction>",
      13,
    );
    const summarize = vi.fn(async () => "Unused.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        modelProfile: "standard",
        pendingMessages: [
          { message: prompt, provenance: { authority: "instruction" } },
        ],
        piMessages: [...firstTurn, ...afterMark],
      },
      summarize,
    );

    expect(summarize).not.toHaveBeenCalled();
    expect(result.compacted).toBe(true);
    const messages = result.piMessages!;
    const texts = messages.map(textOf);
    expect(texts[0]).toBe(
      "<current-instruction>Find build 7421.</current-instruction>",
    );
    expect(texts[1]).toContain("deploy checksum of build 7421");
    expect(texts.join("\n")).not.toContain(OVERSIZED_TEXT.slice(0, 100));
    // Everything after the mark follows the summary, then the new prompt.
    expect(messages.slice(2, -1).map((message) => message.role)).toEqual(
      afterMark.map((message) => message.role),
    );
    expect(messages.at(-1)).toEqual(prompt);

    const oldResultSeq = committed.messageSeqs[firstTurn.length + 2]!;
    expect(texts[4]).toContain(
      `[Tool result cleared to save context: bash, ${LONG_LOG.length.toLocaleString("en-US")} chars. Full result: readConversationEvent({ seq: ${oldResultSeq} })`,
    );
    expect(texts[4]).toContain(LONG_LOG.slice(0, 500));
    expect(texts[4]).toContain(LONG_LOG.slice(-500));
    // Error results up to the cap and the latest Turn's results stay whole.
    expect(texts[5]).toBe(`failed: ${"e".repeat(3_000)}`);
    expect(texts[9]).toBe(LONG_LOG);
    // Every tool call keeps its paired result.
    expect(
      messages
        .filter((message) => message.role === "toolResult")
        .map((message) => (message as { toolCallId: string }).toolCallId),
    ).toEqual(["call-2", "call-3", "call-4"]);

    const projection = await loadConversationProjection({ conversationId });
    expect(projection.messages).toEqual(messages);
    expect(projection.seqs[4]).toBe(oldResultSeq);

    // A later commit, such as a resumed Turn, appends to the swapped history.
    const reply = assistant("The checksum is in the deploy log.", 14);
    await commitMessages({ conversationId, messages: [...messages, reply] });
    expect(
      (await loadConversationProjection({ conversationId })).messages,
    ).toEqual([...messages, reply]);
  });

  it("swaps between model calls only above the threshold, without a summary call", async () => {
    const conversationId = "local:web:swap-active";
    await prepareSummary(conversationId, firstTurn);
    const turn = [
      user("<current-instruction>Check the deploy.</current-instruction>", 5),
      toolCall("call-2", 6),
      toolResult("call-2", "ok", 7),
    ];
    await commitMessages({ conversationId, messages: [...firstTurn, ...turn] });
    const summarize = vi.fn(async () => "Unused.");
    const args = {
      conversationId,
      mode: "active" as const,
      modelId: MODEL_ID,
      modelProfile: "standard" as const,
      piMessages: [...firstTurn, ...turn],
    };

    const below = await compactWithPreparedSummary(
      { ...args, piMessages: turn },
      summarize,
    );
    expect(below.compacted).toBe(false);

    const result = await compactWithPreparedSummary(args, summarize);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.compacted).toBe(true);
    expect(result.piMessages!.slice(-3)).toEqual(turn);
  });

  it.for([
    {
      reason: "an older History version",
      overrides: { historyVersion: 99 },
    },
    {
      reason: "another Model profile",
      overrides: { modelProfile: "fast" },
    },
  ])(
    "discards a summary of $reason and runs the blocking compaction",
    async ({ overrides }) => {
      const conversationId = `local:web:swap-discard-${overrides.historyVersion ?? overrides.modelProfile}`;
      await prepareSummary(conversationId, firstTurn, overrides);
      const summarize = vi.fn(async () => "Fresh summary.");

      const result = await compactWithPreparedSummary(
        {
          conversationId,
          mode: "blocking",
          modelId: MODEL_ID,
          modelProfile: "standard",
          piMessages: firstTurn,
        },
        summarize,
      );

      expect(summarize).toHaveBeenCalledOnce();
      expect(result.compacted).toBe(true);
      expect(result.piMessages!.map(textOf).join("\n")).toContain(
        "Fresh summary.",
      );
    },
  );

  it("discards a summary when the kept history stays above the target", async () => {
    const conversationId = "local:web:swap-over-target";
    await prepareSummary(conversationId, firstTurn.slice(0, 1));
    await commitMessages({ conversationId, messages: firstTurn });
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        modelProfile: "standard",
        piMessages: firstTurn,
      },
      summarize,
    );

    // The oversized result is after the mark, and it is in the latest Turn.
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.piMessages!.map(textOf).join("\n")).toContain(
      "Fresh summary.",
    );
  });

  it("discards a summary when another replacement commits first", async () => {
    const conversationId = "local:web:swap-conflict";
    const committed = await prepareSummary(conversationId, firstTurn);
    const events = getConversationEventStore();
    const replaceHistory = events.replaceHistory.bind(events);
    // Another Turn replaces the history between the check and the write.
    const spy = vi
      .spyOn(events, "replaceHistory")
      .mockImplementationOnce(async (id, replacement, options) => {
        await replaceHistory(id, {
          createdAtMs: Date.now(),
          data: {
            type: "compaction",
            modelProfile: "standard",
            modelId: MODEL_ID,
            summary: "Other Turn.",
            replacementHistory: [],
          },
        });
        return await replaceHistory(id, replacement, options);
      });

    // Oversized history, so a blocking fallback would summarize and write.
    const summarize = vi.fn(async () => "Stale fallback.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        modelProfile: "standard",
        piMessages: firstTurn,
      },
      summarize,
    );
    spy.mockRestore();

    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(await events.loadCurrentHistoryVersion(conversationId)).toBe(
      committed.historyVersion + 1,
    );
  });
});
