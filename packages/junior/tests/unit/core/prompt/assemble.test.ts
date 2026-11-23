import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assemblePrompt } from "@/core/prompt/assemble";
import {
  definePromptLayout,
  fragment,
  inputs,
  loader,
  skip,
  type Fragment,
  type FragmentMessage,
  type InputPrompt,
  type PromptBuildContext,
  type PromptLayout,
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

// The clock at assembly, and the send time of the test input.
const STEP_TIME = 1_750_000_000_000;
const INPUT_TIME = 1_000;

/** A message as a fragment gives it, without a timestamp. */
function note(content: string): Omit<UserMessage, "timestamp"> {
  return { role: "user", content };
}

/** A message as the prompt has it, with the timestamp that core set. */
function userText(content: string, timestamp = STEP_TIME): UserMessage {
  return { role: "user", content, timestamp };
}

const INPUT: UnreadInput = {
  inputId: "input-1",
  actorIdentityId: "identity-1",
  payload: { text: "How many Turns?" },
  sentAt: new Date(INPUT_TIME),
  traceContext: null,
  attemptedAt: null,
};

function formatInput(input: UnreadInput): InputPrompt {
  return {
    message: note(String(input.payload["text"])),
    provenance: { authority: "instruction" },
  };
}

/** `messages` with the inputs fragment after them, which a layout needs. */
function withInputs(
  messages: Fragment<FragmentMessage | FragmentMessage[]>[],
): Fragment<FragmentMessage | FragmentMessage[]>[] {
  return [...messages, inputs({ format: formatInput })];
}

/** The diagnostics entry of the inputs fragment. */
const INPUTS_INCLUDED = {
  name: "inputs",
  field: "messages",
  status: "included",
} as const;

/** Builds a prompt for a step whose signal does not abort. */
function assemble(layout: PromptLayout, ctx: PromptBuildContext) {
  return assemblePrompt(layout, ctx, { signal: new AbortController().signal });
}

/** A load that ends only when core aborts its signal. */
function waitForAbort(_ctx: PromptBuildContext, signal: AbortSignal) {
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

describe("assemblePrompt", () => {
  beforeEach(() => {
    // Only the clock: the loader timeouts still run on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(STEP_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the loaders at the same time", async () => {
    const started = new Set<string>();
    let release = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each load waits until both have started. If they ran one after the
    // other, the first would wait for its whole timeout and fail the step.
    const waitForBoth = (label: string) =>
      loader(
        label,
        async () => {
          started.add(label);
          if (started.size === 2) {
            release();
          }
          await bothStarted;
          return label;
        },
        { timeoutMs: 1_000 },
      );
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: withInputs(
        ["first", "second"].map((label) =>
          fragment(label, { loader: waitForBoth(label), format: note }),
        ),
      ),
    });

    const { messages, diagnostics } = await assemble(layout, CTX);

    expect(messages).toEqual([userText("first"), userText("second")]);
    expect(diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "first", status: "ok" }),
      expect.objectContaining({ label: "second", status: "ok" }),
    ]);
  });

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
      messages: withInputs(
        ["first", "second", "third"].map((name) =>
          fragment(name, {
            loader: turnRow,
            format: (row) => note(`${name} ${row.turnId}`),
          }),
        ),
      ),
    });

    const { messages, diagnostics } = await assemble(layout, CTX);

    expect(loads).toBe(1);
    expect(messages).toEqual([
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
      messages: withInputs([
        fragment("memory", {
          loader: memory,
          enabled: (ctx) => ctx.inputs.length > 0,
          format: (text) => note(text),
        }),
      ]),
    });

    const { newMessages, diagnostics } = await assemble(layout, CTX);

    expect(loads).toBe(0);
    expect(newMessages).toEqual([]);
    expect(diagnostics.loaders).toEqual([]);
    expect(diagnostics.fragments).toContainEqual({
      name: "memory",
      field: "messages",
      status: "disabled",
    });
  });

  it("runs a shared loader once when one of its fragments is disabled", async () => {
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
      messages: withInputs([
        fragment("off", {
          loader: memory,
          enabled: () => false,
          format: note,
        }),
        fragment("on", { loader: memory, format: note }),
      ]),
    });

    const { messages, diagnostics } = await assemble(layout, CTX);

    expect(loads).toBe(1);
    expect(messages).toEqual([userText("Thomas likes short replies.")]);
    expect(diagnostics).toEqual({
      systemPrompt: [],
      loaders: [expect.objectContaining({ label: "memory", status: "ok" })],
      fragments: [
        { name: "off", field: "messages", status: "disabled" },
        { name: "on", field: "messages", status: "included" },
        INPUTS_INCLUDED,
      ],
    });
  });

  it("drops the value of a load that ends after its timeout", async () => {
    let resolveLate = (_value: string) => {};
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    let loads = 0;
    // The first load ignores its signal and ends after the timeout.
    const slow = loader(
      "slow",
      () => {
        loads += 1;
        return loads === 1 ? late : Promise.resolve("Fresh value");
      },
      { timeoutMs: 5, optional: true },
    );
    const values: unknown[] = [];
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: withInputs([
        fragment("slow", {
          loader: slow,
          format: (value) => {
            values.push(value);
            return skip("not checked");
          },
        }),
      ]),
    });

    const first = await assemble(layout, CTX);
    resolveLate("Late value");
    await late;
    await assemble(layout, CTX);

    expect(first.diagnostics.loaders).toEqual([
      expect.objectContaining({ label: "slow", status: "timed_out" }),
    ]);
    // The late value reaches no fragment, in its request or the next one.
    expect(values).toEqual([undefined, "Fresh value"]);
  });

  it("throws an error that names a fragment whose format throws", async () => {
    const cause = new Error("The turn row has no id");
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: withInputs([
        fragment("turn", {
          format: () => {
            throw cause;
          },
        }),
      ]),
    });

    const result = assemble(layout, CTX);

    await expect(result).rejects.toThrow('Fragment "turn" failed');
    await expect(result).rejects.toMatchObject({ cause });
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
      messages: withInputs(
        [failing, slow].map((source) =>
          fragment(source.label, {
            loader: source,
            format: (value) => {
              values.push(value);
              return skip("no value");
            },
          }),
        ),
      ),
    });

    const { diagnostics } = await assemble(layout, CTX);

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
      assemble(
        definePromptLayout({
          systemPrompt: [],
          messages: withInputs([
            fragment("soul", { loader: failing, format: note }),
          ]),
        }),
        CTX,
      ),
    ).rejects.toThrow('Loader "soul" failed');
    await expect(
      assemble(
        definePromptLayout({
          systemPrompt: [],
          messages: withInputs([
            fragment("memory", { loader: slow, format: note }),
          ]),
        }),
        CTX,
      ),
    ).rejects.toThrow('Loader "memory" timed out after 5 ms');
  });

  it("reports the reason of a skipped fragment", async () => {
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: withInputs([
        fragment("summary", {
          format: (_value, ctx) =>
            ctx.inputs.length === 0 ? skip("no unread inputs") : note("Inputs"),
        }),
      ]),
    });

    const { diagnostics } = await assemble(layout, CTX);

    expect(diagnostics.fragments).toEqual([
      {
        name: "summary",
        field: "messages",
        status: "skipped",
        reason: "no unread inputs",
      },
      INPUTS_INCLUDED,
    ]);
  });

  it("gives fragment messages one step time and inputs their send time", async () => {
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: [
        fragment("first", {
          format: () => {
            // A later clock must not reach the next fragment's message.
            vi.setSystemTime(STEP_TIME + 60_000);
            return note("First");
          },
        }),
        inputs({ format: formatInput }),
        fragment("second", { format: () => note("Second") }),
      ],
    });

    const { newMessages } = await assemble(layout, {
      ...CTX,
      inputs: [INPUT],
    });

    expect(newMessages.map(({ message }) => message.timestamp)).toEqual([
      STEP_TIME,
      INPUT_TIME,
      STEP_TIME,
    ]);
  });

  it("keeps the layout order of the system prompt and the messages", async () => {
    const history: Message[] = [userText("Earlier", 0)];
    const layout = definePromptLayout({
      systemPrompt: [
        { name: "identity", text: "You are Junior." },
        { name: "world", text: "You work at Sentry." },
      ],
      messages: [
        fragment("first", { format: () => note("First") }),
        inputs({ format: formatInput }),
        fragment("pair", {
          format: () => [note("Second"), note("Third")],
        }),
      ],
    });

    expect(
      await assemble(layout, { ...CTX, history, inputs: [INPUT] }),
    ).toEqual({
      systemPrompt: "You are Junior.\n\nYou work at Sentry.",
      messages: [
        ...history,
        userText("First"),
        userText("How many Turns?", INPUT_TIME),
        userText("Second"),
        userText("Third"),
      ],
      newMessages: [
        { source: "fragment", fragment: "first", message: userText("First") },
        {
          source: "input",
          inputId: "input-1",
          message: userText("How many Turns?", INPUT_TIME),
          provenance: { authority: "instruction" },
        },
        { source: "fragment", fragment: "pair", message: userText("Second") },
        { source: "fragment", fragment: "pair", message: userText("Third") },
      ],
      diagnostics: {
        systemPrompt: [
          { name: "identity", chars: 15 },
          { name: "world", chars: 19 },
        ],
        loaders: [],
        fragments: [
          { name: "first", field: "messages", status: "included" },
          INPUTS_INCLUDED,
          { name: "pair", field: "messages", status: "included" },
        ],
      },
    });
  });

  it("aborts each load when the step's signal aborts", async () => {
    let loadSignal: AbortSignal | undefined;
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const memory = loader(
      "memory",
      (ctx, signal) => {
        loadSignal = signal;
        markStarted();
        return waitForAbort(ctx, signal);
      },
      { timeoutMs: 60_000, optional: true },
    );
    const layout = definePromptLayout({
      systemPrompt: [],
      messages: withInputs([
        fragment("memory", { loader: memory, format: () => skip("unused") }),
      ]),
    });
    const step = new AbortController();
    const stopped = new Error("The Turn was cancelled or taken over");

    const result = assemblePrompt(layout, CTX, { signal: step.signal });
    await started;
    step.abort(stopped);

    await expect(result).rejects.toBe(stopped);
    expect(loadSignal?.aborted).toBe(true);
    expect(loadSignal?.reason).toBe(stopped);
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
      format: (notes): FragmentMessage | Skip =>
        notes && notes.length > 0
          ? { role: "user", content: notes.join("\n") }
          : skip("no memories"),
    });
    const layout = definePromptLayout({
      systemPrompt: [
        { name: "identity", text: "You are Junior, Sentry's Slack bot." },
        { name: "personality", text: soul },
      ],
      messages: [
        recalled,
        inputs({
          format: (input) => ({
            message: { role: "user", content: String(input.payload["text"]) },
            provenance: { authority: "instruction" },
          }),
        }),
      ],
    });
    const withInput = { ...CTX, inputs: [INPUT] };

    const recall = await assemble(layout, withInput);
    const noInputs = await assemble(layout, CTX);
    const noMemories = await assemble(layout, {
      ...withInput,
      turn: { ...CTX.turn, conversationId: "conversation-2" },
    });

    expect(recall).toEqual({
      systemPrompt: "You are Junior, Sentry's Slack bot.\n\nBe direct.",
      messages: [
        userText("Thomas likes short replies."),
        userText("How many Turns?", INPUT_TIME),
      ],
      newMessages: [
        {
          source: "fragment",
          fragment: "recalled-memories",
          message: userText("Thomas likes short replies."),
        },
        {
          source: "input",
          inputId: "input-1",
          message: userText("How many Turns?", INPUT_TIME),
          provenance: { authority: "instruction" },
        },
      ],
      diagnostics: {
        systemPrompt: [
          { name: "identity", chars: 35 },
          { name: "personality", chars: 10 },
        ],
        loaders: [expect.objectContaining({ label: "memories", status: "ok" })],
        fragments: [
          { name: "recalled-memories", field: "messages", status: "included" },
          INPUTS_INCLUDED,
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
