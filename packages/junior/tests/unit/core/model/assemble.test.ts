import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assembleModelRequest } from "@/core/model/assemble";
import type { ModelSettings } from "@/core/model/client";
import {
  defineModelRequest,
  fragment,
  loader,
  skip,
  type ModelRequestContext,
  type Skip,
} from "@/core/model/request";
import type { UnreadInput } from "@/core/turn/inbox";

const MODEL: ModelSettings = {
  id: "anthropic/claude-sonnet-4.5",
  reasoning: "low",
  privacy: "public",
};
const model = fragment("model", { format: () => MODEL });
const CTX: ModelRequestContext = {
  turn: {
    turnId: "turn-1",
    leaseEpoch: 1,
    conversationId: "conversation-1",
    stepSeq: 1,
    attempts: 1,
  },
  history: [],
  inputs: [],
};

function userText(content: string): UserMessage {
  return { role: "user", content, timestamp: 0 };
}

/** A load that ends only when core aborts its signal. */
function waitForAbort(_ctx: ModelRequestContext, signal: AbortSignal) {
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

describe("assembleModelRequest", () => {
  it("runs a loader once for the fragments that share it", async () => {
    let loads = 0;
    const turnRow = loader(
      "turn-row",
      (ctx) => {
        loads += 1;
        return Promise.resolve({ turnId: ctx.turn.turnId });
      },
      { timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [],
      messages: ["first", "second", "third"].map((name) =>
        fragment(name, {
          loader: turnRow,
          format: (row) => userText(`${name} ${row.turnId}`),
        }),
      ),
      model,
    });

    const { newMessages, diagnostics } = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(loads).toBe(1);
    expect(newMessages).toEqual([
      userText("first turn-1"),
      userText("second turn-1"),
      userText("third turn-1"),
    ]);
    expect(diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "turn-row", status: "ok" }),
    ]);
  });

  it("does not run the loader of a disabled fragment", async () => {
    let loads = 0;
    const memory = loader(
      "memory",
      () => {
        loads += 1;
        return Promise.resolve("Thomas likes short replies.");
      },
      { timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [],
      messages: [
        fragment("memory", {
          loader: memory,
          enabled: (ctx) => ctx.inputs.length > 0,
          format: (text) => userText(text),
        }),
      ],
      model,
    });

    const { newMessages, diagnostics } = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(loads).toBe(0);
    expect(newMessages).toEqual([]);
    expect(diagnostics.loaders).toEqual([]);
    expect(diagnostics.fragments).toContainEqual({
      name: "memory",
      field: "messages",
      status: "disabled",
    });
  });

  it("gives `undefined` for an optional loader that fails or times out", async () => {
    let timeoutSignal: AbortSignal | undefined;
    const failing = loader(
      "failing",
      () => Promise.reject(new Error("The memory store is down")),
      { timeoutMs: 100, optional: true },
    );
    const slow = loader(
      "slow",
      (ctx, signal) => {
        timeoutSignal = signal;
        return waitForAbort(ctx, signal);
      },
      { timeoutMs: 5, optional: true },
    );
    const values: unknown[] = [];
    const spec = defineModelRequest({
      systemPrompt: [],
      messages: [failing, slow].map((source) =>
        fragment(source.label, {
          loader: source,
          format: (value) => {
            values.push(value);
            return skip("no value");
          },
        }),
      ),
      model,
    });

    const { diagnostics } = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(values).toEqual([undefined, undefined]);
    expect(timeoutSignal?.aborted).toBe(true);
    expect(diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "failing", status: "failed" }),
      expect.objectContaining({ label: "slow", status: "timed_out" }),
    ]);
  });

  it("throws an error that names a required loader that fails or times out", async () => {
    const failing = loader(
      "soul",
      () => Promise.reject(new Error("ENOENT: SOUL.md")),
      { timeoutMs: 100 },
    );
    const slow = loader("memory", waitForAbort, { timeoutMs: 5 });

    await expect(
      assembleModelRequest(
        defineModelRequest({
          systemPrompt: [],
          messages: [fragment("soul", { loader: failing, format: userText })],
          model,
        }),
        CTX,
        { session: "conversation-1" },
      ),
    ).rejects.toThrow('Loader "soul" failed');
    await expect(
      assembleModelRequest(
        defineModelRequest({
          systemPrompt: [],
          messages: [fragment("memory", { loader: slow, format: userText })],
          model,
        }),
        CTX,
        { session: "conversation-1" },
      ),
    ).rejects.toThrow('Loader "memory" timed out after 5 ms');
  });

  it("reports the reason of a skipped fragment", async () => {
    const spec = defineModelRequest({
      systemPrompt: [],
      messages: [
        fragment("inputs", {
          format: (_value, ctx) =>
            ctx.inputs.length === 0
              ? skip("no unread inputs")
              : userText("Inputs"),
        }),
      ],
      model,
    });

    const { diagnostics } = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(diagnostics.fragments).toEqual([
      {
        name: "inputs",
        field: "messages",
        status: "skipped",
        reason: "no unread inputs",
      },
      { name: "model", field: "model", status: "included" },
    ]);
  });

  it("keeps the layout order within each field", async () => {
    const history: Message[] = [userText("Earlier")];
    const spec = defineModelRequest({
      systemPrompt: [
        { name: "identity", text: "You are Junior." },
        { name: "world", text: "You work at Sentry." },
      ],
      messages: [
        fragment("first", { format: () => userText("First") }),
        fragment("pair", {
          format: () => [userText("Second"), userText("Third")],
        }),
      ],
      model,
    });

    const { request, newMessages, diagnostics } = await assembleModelRequest(
      spec,
      { ...CTX, history },
      { session: "conversation-1" },
    );

    expect(newMessages).toEqual([
      userText("First"),
      userText("Second"),
      userText("Third"),
    ]);
    expect(request).toEqual({
      systemPrompt: "You are Junior.\n\nYou work at Sentry.",
      messages: [...history, ...newMessages],
      model: MODEL,
      session: "conversation-1",
    });
    expect(diagnostics).toEqual({
      systemPrompt: [
        { name: "identity", chars: 15 },
        { name: "world", chars: 19 },
      ],
      loaders: [],
      fragments: [
        { name: "first", field: "messages", status: "included" },
        { name: "pair", field: "messages", status: "included" },
        { name: "model", field: "model", status: "included" },
      ],
    });
  });

  it("builds the layout of the `defineModelRequest` example", async () => {
    // The example's code, with a fake memory store and SOUL.md text.
    const soul = "Be direct.";
    const memoryStore = {
      recall: (conversationId: string, _signal: AbortSignal) =>
        Promise.resolve(
          conversationId === "conversation-1"
            ? ["Thomas likes short replies."]
            : [],
        ),
    };
    const memories = loader(
      "memories",
      (ctx, signal) => memoryStore.recall(ctx.turn.conversationId, signal),
      { timeoutMs: 2_000, optional: true },
    );
    const recalled = fragment("recalled-memories", {
      loader: memories,
      // Recall only for a step that has new inputs.
      enabled: (ctx) => ctx.inputs.length > 0,
      format: (notes): Message | Skip =>
        notes && notes.length > 0
          ? { role: "user", content: notes.join("\n"), timestamp: 0 }
          : skip("no memories"),
    });
    const settings: ModelSettings = {
      id: "anthropic/claude-sonnet-4.5",
      reasoning: "low",
      privacy: "public",
    };
    const spec = defineModelRequest({
      systemPrompt: [
        { name: "identity", text: "You are Junior, Sentry's Slack bot." },
        { name: "personality", text: soul },
      ],
      messages: [recalled],
      model: fragment("model", { format: () => settings }),
    });
    const input: UnreadInput = {
      inputId: "input-1",
      actorIdentityId: "identity-1",
      payload: {},
      sentAt: new Date(0),
      traceContext: null,
      attemptedAt: null,
    };
    const withInput = { ...CTX, inputs: [input] };

    const recall = await assembleModelRequest(spec, withInput, {
      session: "conversation-1",
    });
    const noInputs = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });
    const noMemories = await assembleModelRequest(
      spec,
      { ...withInput, turn: { ...CTX.turn, conversationId: "conversation-2" } },
      { session: "conversation-2" },
    );

    expect(recall.request).toEqual({
      systemPrompt: "You are Junior, Sentry's Slack bot.\n\nBe direct.",
      messages: [userText("Thomas likes short replies.")],
      model: settings,
      session: "conversation-1",
    });
    expect(noInputs.diagnostics.fragments[0]).toEqual({
      name: "recalled-memories",
      field: "messages",
      status: "disabled",
    });
    expect(noMemories.diagnostics.fragments[0]).toEqual({
      name: "recalled-memories",
      field: "messages",
      status: "skipped",
      reason: "no memories",
    });
  });
});
