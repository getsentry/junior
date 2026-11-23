import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assemblePrompt } from "@/core/prompt/assemble";
import {
  definePromptLayout,
  fragment,
  loader,
  skip,
  type PromptBuildContext,
  type Skip,
} from "@/core/prompt/layout";
import type { UnreadInput } from "@/core/turn/inbox";

const CTX: PromptBuildContext = {
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
function waitForAbort(_ctx: PromptBuildContext, signal: AbortSignal) {
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

describe("assemblePrompt", () => {
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
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: ["first", "second", "third"].map((name) =>
        fragment(name, {
          loader: turnRow,
          format: (row) => userText(`${name} ${row.turnId}`),
        }),
      ),
    });

    const { newMessages, diagnostics } = await assemblePrompt(layout, CTX);

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
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: [
        fragment("memory", {
          loader: memory,
          enabled: (ctx) => ctx.inputs.length > 0,
          format: (text) => userText(text),
        }),
      ],
    });

    const { newMessages, diagnostics } = await assemblePrompt(layout, CTX);

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
    const layout = definePromptLayout({
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
    });

    const { diagnostics } = await assemblePrompt(layout, CTX);

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
      assemblePrompt(
        definePromptLayout({
          systemPrompt: [],
          messages: [fragment("soul", { loader: failing, format: userText })],
        }),
        CTX,
      ),
    ).rejects.toThrow('Loader "soul" failed');
    await expect(
      assemblePrompt(
        definePromptLayout({
          systemPrompt: [],
          messages: [fragment("memory", { loader: slow, format: userText })],
        }),
        CTX,
      ),
    ).rejects.toThrow('Loader "memory" timed out after 5 ms');
  });

  it("reports the reason of a skipped fragment", async () => {
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: [
        fragment("inputs", {
          format: (_value, ctx) =>
            ctx.inputs.length === 0
              ? skip("no unread inputs")
              : userText("Inputs"),
        }),
      ],
    });

    const { diagnostics } = await assemblePrompt(layout, CTX);

    expect(diagnostics.fragments).toEqual([
      {
        name: "inputs",
        field: "messages",
        status: "skipped",
        reason: "no unread inputs",
      },
    ]);
  });

  it("keeps the layout order of the system prompt and the messages", async () => {
    const history: Message[] = [userText("Earlier")];
    const layout = definePromptLayout({
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
    });

    const newMessages = [
      userText("First"),
      userText("Second"),
      userText("Third"),
    ];

    expect(await assemblePrompt(layout, { ...CTX, history })).toEqual({
      systemPrompt: "You are Junior.\n\nYou work at Sentry.",
      messages: [...history, ...newMessages],
      newMessages,
      diagnostics: {
        systemPrompt: [
          { name: "identity", chars: 15 },
          { name: "world", chars: 19 },
        ],
        loaders: [],
        fragments: [
          { name: "first", field: "messages", status: "included" },
          { name: "pair", field: "messages", status: "included" },
        ],
      },
    });
  });

  it("builds the layout of the `definePromptLayout` example", async () => {
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
    const layout = definePromptLayout({
      systemPrompt: [
        { name: "identity", text: "You are Junior, Sentry's Slack bot." },
        { name: "personality", text: soul },
      ],
      messages: [recalled],
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

    const recall = await assemblePrompt(layout, withInput);
    const noInputs = await assemblePrompt(layout, CTX);
    const noMemories = await assemblePrompt(layout, {
      ...withInput,
      turn: { ...CTX.turn, conversationId: "conversation-2" },
    });

    expect(recall).toEqual({
      systemPrompt: "You are Junior, Sentry's Slack bot.\n\nBe direct.",
      messages: [userText("Thomas likes short replies.")],
      newMessages: [userText("Thomas likes short replies.")],
      diagnostics: {
        systemPrompt: [
          { name: "identity", chars: 35 },
          { name: "personality", chars: 10 },
        ],
        loaders: [expect.objectContaining({ label: "memories", status: "ok" })],
        fragments: [
          { name: "recalled-memories", field: "messages", status: "included" },
        ],
      },
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
