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
} from "@/core/model/request";
import type { ToolDefinition } from "@/core/tool";

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

function testTool(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: {
      type: "object",
      properties: {},
    } as ToolDefinition["parameters"],
    replay: "safe",
    execute: () => Promise.resolve({ content: [] }),
  };
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
      { lifetime: "step", timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [],
      tools: [],
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
      { lifetime: "step", timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [],
      tools: [],
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
      { lifetime: "step", timeoutMs: 100, optional: true },
    );
    const slow = loader(
      "slow",
      (ctx, signal) => {
        timeoutSignal = signal;
        return waitForAbort(ctx, signal);
      },
      { lifetime: "step", timeoutMs: 5, optional: true },
    );
    const values: unknown[] = [];
    const spec = defineModelRequest({
      systemPrompt: [],
      tools: [],
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
      { lifetime: "step", timeoutMs: 100 },
    );
    const slow = loader("memory", waitForAbort, {
      lifetime: "step",
      timeoutMs: 5,
    });

    await expect(
      assembleModelRequest(
        defineModelRequest({
          systemPrompt: [],
          tools: [],
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
          tools: [],
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
      tools: [],
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
    const search = testTool("search");
    const read = testTool("read");
    const write = testTool("write");
    const spec = defineModelRequest({
      systemPrompt: [
        fragment("soul", { format: () => "You are Junior." }),
        fragment("world", { format: () => "You work at Sentry." }),
      ],
      tools: [
        fragment("search", { format: () => [search] }),
        fragment("files", {
          format: () => [read, write],
        }),
      ],
      messages: [
        fragment("first", { format: () => userText("First") }),
        fragment("pair", {
          format: () => [userText("Second"), userText("Third")],
        }),
      ],
      model,
    });

    const { request, newMessages } = await assembleModelRequest(
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
      tools: [search, read, write],
      model: MODEL,
      session: "conversation-1",
    });
  });

  it("runs a deployment loader once for every request of one spec", async () => {
    let loads = 0;
    const soul = loader(
      "soul",
      () => {
        loads += 1;
        return Promise.resolve("You are Junior.");
      },
      { lifetime: "deployment", timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [
        fragment("soul", { loader: soul, format: (text) => text }),
      ],
      tools: [],
      messages: [],
      model,
    });

    const first = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });
    const second = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(loads).toBe(1);
    expect(second.request).toEqual(first.request);
    expect(second.diagnostics.loaders).toEqual([
      { label: "soul", lifetime: "deployment", ms: 0, status: "cached" },
    ]);
  });

  it("loads a deployment loader again after it fails", async () => {
    let loads = 0;
    const soul = loader(
      "soul",
      () => {
        loads += 1;
        return loads === 1
          ? Promise.reject(new Error("ENOENT: SOUL.md"))
          : Promise.resolve("You are Junior.");
      },
      { lifetime: "deployment", timeoutMs: 100 },
    );
    const spec = defineModelRequest({
      systemPrompt: [
        fragment("soul", { loader: soul, format: (text) => text }),
      ],
      tools: [],
      messages: [],
      model,
    });

    await expect(
      assembleModelRequest(spec, CTX, { session: "conversation-1" }),
    ).rejects.toThrow('Loader "soul" failed');
    const retry = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });
    const next = await assembleModelRequest(spec, CTX, {
      session: "conversation-1",
    });

    expect(loads).toBe(2);
    expect(retry.diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "soul", status: "ok" }),
    ]);
    expect(next.diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "soul", status: "cached" }),
    ]);
  });
});
