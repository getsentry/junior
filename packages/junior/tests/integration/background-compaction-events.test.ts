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
import { defaultModelId } from "@/chat/model-profile";
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

const MODEL_ID = defaultModelId(botConfig);

function assistant(text: string, input = 0): AssistantMessage {
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

/** A model stream that answers each call with the next text. */
function replies(texts: string[]): { calls: Context[]; streamFn: StreamFn } {
  const calls: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    const message = assistant(texts[calls.length]!);
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

/**
 * Complete a Turn. The default start is before every event, so no ready
 * summary was passed over at its start.
 */
async function completeTurn(
  agent: Agent,
  turnStartedAtMs = 0,
): Promise<BackgroundCompactionMessage[]> {
  const sent: BackgroundCompactionMessage[] = [];
  await requestBackgroundCompaction({
    agent,
    conversationId: CONVERSATION_ID,
    conversationPrivacy: "private",
    modelId: MODEL_ID,
    modelProfile: botConfig.defaultProfile,
    queue: { send: async (message) => void sent.push(message) },
    turnStartedAtMs,
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
      modelProfile: botConfig.defaultProfile,
      modelId: MODEL_ID,
    };
    await expect(bookkeeping()).resolves.toEqual([
      { type: "compaction_requested", ...request },
      {
        type: "compaction_prepared",
        ...request,
        outcome: "ready",
        summary: "The person picked blue.",
      },
    ]);

    // A summary that became ready during the Turn waits for the next Turn.
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

  it("requests again when a Turn started after a ready summary and did not swap it in", async () => {
    const events = getConversationEventStore();
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 1, data: userMessage("First question.", 1) },
    ]);
    const mark = getAgentBackgroundCompactionMarkTokens(MODEL_ID);
    const ready = async (job: BackgroundCompactionMessage | undefined) =>
      await processBackgroundCompaction(job!, {
        streamFn: replies(["<summary>Earlier work.</summary>"]).streamFn,
      });

    await ready((await completeTurn(liveAgent(mark)))[0]);
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 2, data: userMessage("Second question.", 2) },
    ]);
    // The History version is the same, so this Turn discarded the summary,
    // for example because the history after its mark is too large now.
    const [second] = await completeTurn(liveAgent(mark), Date.now());
    expect(second).toBeDefined();
    await ready(second);
    await events.append(CONVERSATION_ID, [
      { createdAtMs: 3, data: userMessage("Third question.", 3) },
    ]);

    // Two passed-over summaries reach the attempt limit.
    await expect(completeTurn(liveAgent(mark), Date.now())).resolves.toEqual(
      [],
    );
    expect(
      (await bookkeeping()).filter(
        (event) => event.type === "compaction_requested",
      ),
    ).toHaveLength(2);
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
});
