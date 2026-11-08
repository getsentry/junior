import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentModelRequest } from "@/chat/agent/context-summary";
import { botConfig } from "@/chat/config";
import { getConversationEventStore } from "@/chat/db";
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import {
  processBackgroundCompaction,
  requestBackgroundCompaction,
} from "@/chat/services/background-compaction";
import type { BackgroundCompactionMessage } from "@/chat/services/background-compaction-queue";
import { getAgentBackgroundCompactionMarkTokens } from "@/chat/services/context-budget";
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
          modelId: "test/model",
        },
      },
      {
        createdAtMs: 3,
        data: {
          type: "compaction_prepared",
          markSeq: 0,
          historyVersion: 0,
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
        modelId: "test/model",
      },
      {
        type: "compaction_prepared",
        markSeq: 0,
        historyVersion: 0,
        modelId: "test/model",
        outcome: "ready",
        summary: "The person picked the blue option.",
      },
      {
        type: "compaction_prepared",
        markSeq: 0,
        historyVersion: 0,
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

const MODEL_ID = botConfig.modelId;

function assistant(text: string, input = 0, costUsd = 0): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: MODEL_ID,
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input,
      cost: {
        input: 0,
        output: costUsd,
        cacheRead: 0,
        cacheWrite: 0,
        total: costUsd,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

/** A model stream that answers each call with the next text, at $0.001. */
function replies(texts: string[]): { calls: Context[]; streamFn: StreamFn } {
  const calls: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    const message = assistant(texts[calls.length]!, 0, 0.001);
    calls.push({ ...context, messages: [...context.messages] });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  return { calls, streamFn };
}

/** The live agent at the end of a Turn whose last request had this input. */
function liveAgent(inputSize: number): Agent {
  return new Agent({
    getApiKey: getGatewayApiKey,
    sessionId: CONVERSATION_ID,
    streamFn: () => {
      throw new Error("The Turn is complete");
    },
    initialState: {
      model: resolveGatewayModel(MODEL_ID),
      systemPrompt: "You are Junior.",
      thinkingLevel: "low",
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Look up a record.",
          parameters: Type.Object({ id: Type.String() }),
          execute: async () => ({ content: [], details: undefined }),
        },
      ],
      messages: [assistant("The blue option is ready.", inputSize)],
    },
  });
}

/** Complete a Turn and return the background jobs that it sent. */
async function completeTurn(
  agent: Agent,
): Promise<BackgroundCompactionMessage[]> {
  const sent: BackgroundCompactionMessage[] = [];
  await requestBackgroundCompaction({
    agent,
    conversationId: CONVERSATION_ID,
    conversationPrivacy: "private",
    modelId: MODEL_ID,
    queue: { send: async (message) => void sent.push(message) },
  });
  return sent;
}

async function bookkeeping() {
  const history =
    await getConversationEventStore().loadCurrentHistory(CONVERSATION_ID);
  return history.flatMap((event) =>
    event.data.type === "compaction_requested" ||
    event.data.type === "compaction_prepared"
      ? [event.data]
      : [],
  );
}

describe("background compaction job", () => {
  afterEach(closeConversationFixture);

  it("prepares a summary with the request prefix of the last agent request", async () => {
    const [first] = await getConversationEventStore().append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("Remember the blue option.", 1) },
    ]);
    const mark = getAgentBackgroundCompactionMarkTokens(MODEL_ID);

    await expect(completeTurn(liveAgent(mark - 1))).resolves.toEqual([]);
    const agent = liveAgent(mark);
    const sent = await completeTurn(agent);
    expect(sent).toEqual([
      {
        conversationId: CONVERSATION_ID,
        historyVersion: 0,
        markSeq: first!.seq,
      },
    ]);
    // A later model request waits for the pending request.
    await expect(completeTurn(liveAgent(mark))).resolves.toEqual([]);

    const model = replies(["<summary>The person picked blue.</summary>"]);
    await processBackgroundCompaction(sent[0]!, { streamFn: model.streamFn });

    // The provider reads the same system prompt and tools, so it can read
    // the cached prefix. Only the summary instruction is added.
    const expected = await buildAgentModelRequest(agent, [
      {
        role: "user",
        content: [{ type: "text", text: "Remember the blue option." }],
        timestamp: 1,
      },
    ]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.systemPrompt).toBe(expected.context.systemPrompt);
    expect(JSON.stringify(model.calls[0]!.tools)).toBe(
      JSON.stringify(expected.context.tools),
    );
    expect(model.calls[0]!.messages.slice(0, -1)).toEqual(
      expected.context.messages,
    );
    const request = {
      markSeq: first!.seq,
      historyVersion: 0,
      modelId: MODEL_ID,
    };
    await expect(bookkeeping()).resolves.toEqual([
      { type: "compaction_requested", ...request },
      {
        type: "compaction_prepared",
        ...request,
        costUsd: 0.001,
        outcome: "ready",
        summary: "The person picked blue.",
      },
    ]);

    // A ready summary waits for the compaction threshold.
    await expect(completeTurn(liveAgent(mark))).resolves.toEqual([]);
    // A repeated delivery writes nothing.
    await processBackgroundCompaction(sent[0]!, { streamFn: model.streamFn });
    expect(model.calls).toHaveLength(1);
  });

  it("records a fixed failure label and stops after two failed attempts", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    const mark = getAgentBackgroundCompactionMarkTokens(MODEL_ID);

    const [firstJob] = await completeTurn(liveAgent(mark));
    await processBackgroundCompaction(firstJob!, {
      streamFn: replies(["No tags.", "Still no tags."]).streamFn,
    });
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 2, data: userMessage("Second question.", 2) },
    ]);
    const [secondJob] = await completeTurn(liveAgent(mark));
    await processBackgroundCompaction(secondJob!, {
      streamFn: replies(["No tags.", "Still no tags."]).streamFn,
    });
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 3, data: userMessage("Third question.", 3) },
    ]);

    await expect(completeTurn(liveAgent(mark))).resolves.toEqual([]);
    const prepared = (await bookkeeping()).filter(
      (event) => event.type === "compaction_prepared",
    );
    expect(prepared).toMatchObject([
      { outcome: "failed", errorType: "missing_summary" },
      { outcome: "failed", errorType: "missing_summary" },
    ]);
  });

  it("keeps a ready summary for later Turns below the threshold", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    const mark = getAgentBackgroundCompactionMarkTokens(MODEL_ID);
    const [job] = await completeTurn(liveAgent(mark));
    await processBackgroundCompaction(job!, {
      streamFn: replies(["<summary>Earlier work.</summary>"]).streamFn,
    });

    // Later Turns at the mark stay below the threshold, so the summary is
    // not swapped in yet. They do not pay for another summary.
    for (const [seq, text] of [
      [2, "Second question."],
      [3, "Third question."],
    ] as const) {
      await events.append(CONVERSATION_ID, [
        { createdAtMs: seq, data: userMessage(text, seq) },
      ]);
      await expect(completeTurn(liveAgent(mark))).resolves.toEqual([]);
    }
    expect(
      (await bookkeeping()).filter(
        (event) => event.type === "compaction_requested",
      ),
    ).toHaveLength(1);
  });

  it("writes nothing when the history was replaced before the job ran", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    const [job] = await completeTurn(
      liveAgent(getAgentBackgroundCompactionMarkTokens(MODEL_ID)),
    );
    await events.replaceHistory(CONVERSATION_ID, compaction("Foreground."));

    const model = replies(["<summary>Late.</summary>"]);
    await processBackgroundCompaction(job!, { streamFn: model.streamFn });

    expect(model.calls).toHaveLength(0);
    await expect(bookkeeping()).resolves.toEqual([]);
  });

  it("writes nothing when the history is replaced during the summary call", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    const [job] = await completeTurn(
      liveAgent(getAgentBackgroundCompactionMarkTokens(MODEL_ID)),
    );
    const model = replies(["<summary>Late.</summary>"]);
    const streamFn: StreamFn = async (...args) => {
      await events.replaceHistory(CONVERSATION_ID, compaction("Foreground."));
      return await model.streamFn(...args);
    };

    await processBackgroundCompaction(job!, { streamFn });

    expect(model.calls).toHaveLength(1);
    await expect(bookkeeping()).resolves.toEqual([]);
  });

  it("summarizes the replacement history when it keeps older messages", async () => {
    const events = getConversationEventStore();
    const [first] = await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("Remember the blue option.", 1) },
    ]);
    // The replacement keeps the first message, so that message keeps the
    // seq of its source event, which is older than the replacement event.
    await events.replaceHistory(CONVERSATION_ID, {
      createdAtMs: 10,
      data: {
        type: "compaction",
        modelId: MODEL_ID,
        replacementHistory: [
          {
            item: userMessage("Remember the blue option.", 1),
            sourceEventSeq: first!.seq,
          },
        ],
      },
    });
    const [replacement] = await events.loadCurrentHistory(CONVERSATION_ID);

    const [job] = await completeTurn(
      liveAgent(getAgentBackgroundCompactionMarkTokens(MODEL_ID)),
    );
    expect(job).toEqual({
      conversationId: CONVERSATION_ID,
      historyVersion: 1,
      markSeq: replacement!.seq,
    });
    const model = replies(["<summary>The person picked blue.</summary>"]);
    await processBackgroundCompaction(job!, { streamFn: model.streamFn });

    expect(model.calls[0]!.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Remember the blue option." }],
    });
    await expect(bookkeeping()).resolves.toMatchObject([
      { type: "compaction_requested" },
      { type: "compaction_prepared", outcome: "ready" },
    ]);
  });
});
