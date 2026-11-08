import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { renderCompactionSummary } from "@/chat/services/context-compaction";
import { compactWithPreparedSummary } from "@/chat/services/context-compaction-swap";
import { closeConversationFixture } from "../fixtures/conversation";

const MODEL_ID = "openai/gpt-5.4";
// Above the compaction threshold of the default 400k token window.
const OVERSIZED_TEXT = "x".repeat(1_600_000);
// Above the 360k threshold, below the 380k input limit.
const NEAR_LIMIT_TEXT = "x".repeat(1_480_000);
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
  overrides: { historyVersion?: number } = {},
) {
  const committed = await commitMessages({ conversationId, messages });
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: Date.now(),
      data: {
        type: "compaction_prepared",
        markSeq: committed.committedSeq,
        historyVersion: overrides.historyVersion ?? committed.historyVersion,
        modelId: MODEL_ID,
        outcome: "ready",
        summary: "The person asked for the deploy checksum of build 7421.",
      },
    },
  ]);
  return committed;
}

/** Commit history and a background summary request that is still running. */
async function requestSummary(
  conversationId: string,
  messages: PiMessage[],
  requestedAtMs = Date.now(),
) {
  const committed = await commitMessages({ conversationId, messages });
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: requestedAtMs,
      data: {
        type: "compaction_requested",
        markSeq: committed.committedSeq,
        historyVersion: committed.historyVersion,
        modelId: MODEL_ID,
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
const nearLimitTurn = [
  firstTurn[0]!,
  firstTurn[1]!,
  toolResult("call-1", NEAR_LIMIT_TEXT, 3),
  firstTurn[3]!,
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
      // A checkpoint can add context after the latest Turn's results.
      user("<runtime-turn-context>\nNew context.\n</runtime-turn-context>", 11),
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
    const instruction = user(
      "<current-instruction>Check the deploy.</current-instruction>",
      5,
    );
    // The model call that made this tool call saw the whole history. Its
    // usage does not count toward the replacement, which drops that history.
    const turn = [
      instruction,
      {
        ...toolCall("call-2", 6),
        usage: { input: 400_000, output: 20, totalTokens: 400_020 },
      } as PiMessage,
      toolResult("call-2", "ok", 7),
    ];
    await commitMessages({ conversationId, messages: [...firstTurn, ...turn] });
    const summarize = vi.fn(async () => "Unused.");
    const args = {
      conversationId,
      mode: "active" as const,
      modelId: MODEL_ID,
      piMessages: [...firstTurn, ...turn],
    };

    const below = await compactWithPreparedSummary(
      { ...args, piMessages: [instruction] },
      summarize,
    );
    expect(below.compacted).toBe(false);

    const result = await compactWithPreparedSummary(args, summarize);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.compacted).toBe(true);
    expect(result.piMessages!.slice(-3)).toEqual(turn);

    // The next execution slice starts from the swapped history. The kept
    // tool call still holds usage of the old history, so it must not count.
    const next = await compactWithPreparedSummary(
      { ...args, mode: "blocking", piMessages: result.piMessages! },
      summarize,
    );
    expect(next.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("keeps the history at Turn start below the threshold", async () => {
    const conversationId = "local:web:swap-turn-start-below";
    const earlier = [
      user("<current-instruction>Find build 7421.</current-instruction>", 1),
      assistant("Found build 7421.", 2),
    ];
    await prepareSummary(conversationId, earlier);
    const afterMark = [
      user(
        "<current-instruction>Read the deploy log.</current-instruction>",
        3,
      ),
      assistant("Read it.", 4),
    ];
    const committed = await commitMessages({
      conversationId,
      messages: [...earlier, ...afterMark],
    });
    const prompt = user(
      "<current-instruction>What was the checksum?</current-instruction>",
      5,
    );
    const summarize = vi.fn(async () => "Unused.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        pendingMessages: [
          { message: prompt, provenance: { authority: "instruction" } },
        ],
        piMessages: [...earlier, ...afterMark],
      },
      summarize,
    );

    // A swap here would only rewrite the provider's prompt cache.
    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    const events = getConversationEventStore();
    expect(await events.loadCurrentHistoryVersion(conversationId)).toBe(
      committed.historyVersion,
    );
    expect(
      (await loadConversationProjection({ conversationId })).messages,
    ).toEqual([...earlier, ...afterMark]);
  });

  it("defers to a running summary below the input limit, at Turn start and between model calls", async () => {
    const conversationId = "local:web:swap-defer";
    const committed = await requestSummary(conversationId, nearLimitTurn);
    const prompt = user(
      "<current-instruction>What was the checksum?</current-instruction>",
      5,
    );
    const summarize = vi.fn(async () => "Unused.");
    const args = {
      conversationId,
      modelId: MODEL_ID,
      piMessages: nearLimitTurn,
    };

    const turnStart = await compactWithPreparedSummary(
      {
        ...args,
        mode: "blocking",
        pendingMessages: [
          { message: prompt, provenance: { authority: "instruction" } },
        ],
      },
      summarize,
    );
    const between = await compactWithPreparedSummary(
      { ...args, mode: "active" },
      summarize,
    );

    // The next model call still fits, so the Turn goes on with the full
    // history until the summary is ready.
    expect(turnStart).toEqual({ compacted: false, reason: "deferred" });
    expect(between).toEqual({ compacted: false, reason: "deferred" });
    expect(summarize).not.toHaveBeenCalled();
    expect(
      await getConversationEventStore().loadCurrentHistoryVersion(
        conversationId,
      ),
    ).toBe(committed.historyVersion);
  });

  it("waits at the input limit for a running summary and swaps it in", async () => {
    const conversationId = "local:web:swap-wait";
    const committed = await requestSummary(conversationId, firstTurn);
    const ready = sleep(200).then(() =>
      getConversationEventStore().append(conversationId, [
        {
          createdAtMs: Date.now(),
          data: {
            type: "compaction_prepared",
            markSeq: committed.committedSeq,
            historyVersion: committed.historyVersion,
            modelId: MODEL_ID,
            outcome: "ready",
            summary: "The person asked for the deploy checksum of build 7421.",
          },
        },
      ]),
    );
    const summarize = vi.fn(async () => "Unused.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "active",
        modelId: MODEL_ID,
        piMessages: firstTurn,
      },
      summarize,
    );
    await ready;

    expect(summarize).not.toHaveBeenCalled();
    expect(result.compacted).toBe(true);
    expect(result.piMessages!.map(textOf).join("\n")).toContain(
      "deploy checksum of build 7421",
    );
  });

  it("writes nothing when another replacement commits during the wait", async () => {
    const conversationId = "local:web:swap-wait-replaced";
    const committed = await requestSummary(conversationId, firstTurn);
    const events = getConversationEventStore();
    const replaced = sleep(200).then(() =>
      events.replaceHistory(conversationId, {
        createdAtMs: Date.now(),
        data: {
          type: "compaction",
          modelId: MODEL_ID,
          summary: "Other Turn.",
          replacementHistory: [],
        },
      }),
    );
    const summarize = vi.fn(async () => "Stale fallback.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "active",
        modelId: MODEL_ID,
        piMessages: firstTurn,
      },
      summarize,
    );
    await replaced;

    expect(result).toEqual({ compacted: false, reason: "history_conflict" });
    expect(summarize).not.toHaveBeenCalled();
    expect(await events.loadCurrentHistoryVersion(conversationId)).toBe(
      committed.historyVersion + 1,
    );
  });

  it("runs the blocking summary when the wait for a running summary ends", async () => {
    const conversationId = "local:web:swap-wait-timeout";
    // The wait counts from the request, so less than a second is left.
    await requestSummary(conversationId, firstTurn, Date.now() - 44_500);
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "active",
        modelId: MODEL_ID,
        piMessages: firstTurn,
      },
      summarize,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.piMessages!.map(textOf).join("\n")).toContain(
      "Fresh summary.",
    );
  });

  it("runs the blocking summary at once for a stale request below the input limit", async () => {
    const conversationId = "local:web:swap-stale-request";
    await requestSummary(conversationId, nearLimitTurn, Date.now() - 46_000);
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        piMessages: nearLimitTurn,
      },
      summarize,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.compacted).toBe(true);
  });

  it("discards a summary of an older History version and runs the blocking compaction", async () => {
    const conversationId = "local:web:swap-discard-99";
    await prepareSummary(conversationId, firstTurn, { historyVersion: 99 });
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        piMessages: firstTurn,
      },
      summarize,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.compacted).toBe(true);
    expect(result.piMessages!.map(textOf).join("\n")).toContain(
      "Fresh summary.",
    );
  });

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

  it("counts the system prompt and tools toward the target", async () => {
    const conversationId = "local:web:swap-request-overhead";
    await prepareSummary(conversationId, firstTurn);
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "blocking",
        modelId: MODEL_ID,
        piMessages: firstTurn,
        // Above the 288k target of the default 400k token window.
        requestOverheadTokens: 300_000,
      },
      summarize,
    );

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.compacted).toBe(true);
  });

  it("skips a summary when the kept context alone stays above the target", async () => {
    const conversationId = "local:web:compaction-kept-over-target";
    // Turn context that every replacement keeps, above the 288k target.
    const turn = [
      user(`<thread-context>${"t".repeat(1_200_000)}</thread-context>`, 1),
      user("<current-instruction>Check the deploy.</current-instruction>", 1),
      {
        ...toolCall("call-1", 2),
        usage: { input: 370_000, output: 20, totalTokens: 370_020 },
      } as PiMessage,
      toolResult("call-1", "ok", 3),
    ];
    await commitMessages({ conversationId, messages: turn });
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      { conversationId, mode: "active", modelId: MODEL_ID, piMessages: turn },
      summarize,
    );

    expect(result).toEqual({ compacted: false, reason: "over_target" });
    expect(summarize).not.toHaveBeenCalled();
    expect(
      (await loadConversationProjection({ conversationId })).messages,
    ).toEqual(turn);
  });

  it("compacts again only at the input limit when the last compaction stayed above the threshold", async () => {
    const conversationId = "local:web:compaction-last-over-threshold";
    const summaryAt = Date.now();
    const history = (inputTokens: number) => [
      user("<current-instruction>Check the deploy.</current-instruction>", 1),
      user(renderCompactionSummary("Earlier work."), summaryAt),
      // The first model call after the summary measured the replacement.
      {
        ...toolCall("call-1", summaryAt + 1),
        usage: { input: inputTokens, output: 20, totalTokens: inputTokens },
      } as PiMessage,
      toolResult("call-1", "ok", summaryAt + 2),
    ];
    await commitMessages({ conversationId, messages: history(370_000) });
    const summarize = vi.fn(async () => "Fresh summary.");
    const args = { conversationId, mode: "active" as const, modelId: MODEL_ID };

    const skipped = await compactWithPreparedSummary(
      { ...args, piMessages: history(370_000) },
      summarize,
    );
    expect(skipped).toEqual({ compacted: false, reason: "over_target" });
    expect(summarize).not.toHaveBeenCalled();

    const atLimit = await compactWithPreparedSummary(
      { ...args, piMessages: history(381_000) },
      summarize,
    );
    expect(atLimit.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("compacts above the threshold after a swap that kept agent history", async () => {
    const conversationId = "local:web:compaction-after-swap";
    const summaryAt = Date.now();
    // A swap keeps agent history from before its summary. A full compaction
    // can still drop it, so the first model call after the swap is no floor.
    const history = [
      user("<current-instruction>Check the deploy.</current-instruction>", 1),
      user(renderCompactionSummary("Earlier work."), summaryAt),
      toolCall("call-1", 2),
      toolResult("call-1", "carried", 3),
      {
        ...toolCall("call-2", summaryAt + 1),
        usage: { input: 370_000, output: 20, totalTokens: 370_020 },
      } as PiMessage,
      toolResult("call-2", "ok", summaryAt + 2),
    ];
    await commitMessages({ conversationId, messages: history });
    const summarize = vi.fn(async () => "Fresh summary.");

    const result = await compactWithPreparedSummary(
      {
        conversationId,
        mode: "active",
        modelId: MODEL_ID,
        piMessages: history,
      },
      summarize,
    );

    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
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
