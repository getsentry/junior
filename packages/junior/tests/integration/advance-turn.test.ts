import { eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { ToolDefinition } from "@/core/tool";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import {
  fragment,
  loader,
  skip,
  type FragmentMessage,
  type PromptLayout,
} from "@/core/prompt/layout";
import type { AdvanceTurnOptions } from "@/core/turn/advance";
import { findUnreadInputs } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { claimTurn, stopTurns } from "@/core/turn/state";
import { juniorConversations, juniorTurns } from "@/db/schema";
import { buildTurnPromptLayouts } from "@/turn-steps/prompt";
import { turnTools } from "@/turn-steps/tools";
import {
  modelCalls,
  setModelReplies,
  systemPromptOf,
} from "../fixtures/ai-emulator";
import type { LocalJuniorSqlFixture } from "../fixtures/sql";
import {
  createAssistantMessage,
  fakeModelClient,
} from "../fixtures/model-stream";
import {
  ACTOR,
  createTurnHarness,
  type TurnHarness,
} from "../fixtures/turn-harness";
import {
  CONVERSATION_ID,
  MAX_ATTEMPTS,
  MODEL,
  messageTurnId,
  stepWith,
  sendCallReply,
  sendTool,
  startTurnEngine,
  storedReply,
  testInputs,
  promptForEveryTurn,
  testPrompt,
  userText,
  type Step,
  type TurnEngine,
} from "../fixtures/turn-engine";

/** A fragment message with context authority. Core sets its timestamp. */
function contextNote(text: string): FragmentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

// A lease that has expired by the next statement.
const EXPIRED_LEASE_MS = 0;

let harness: TurnHarness;
let engine: TurnEngine;
let fixture: LocalJuniorSqlFixture;
let turnId: string;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A step whose model request runs `interrupt`, then waits until the step's
 * signal aborts. The request ends only through the abort.
 */
function interruptedStep(interrupt: () => Promise<unknown>): Step {
  const model = fakeModelClient([
    { type: "text", text: "Too late.", waitFor: "abort" },
  ]);
  return {
    client: {
      complete: async (request, signal) => {
        await interrupt();
        return model.complete(request, signal);
      },
    },
  };
}

/** Waits until a lease check that started after `after` waits on a lock. */
async function blockedLeaseCheck(after?: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // Its own session: a transaction would see one snapshot of
    // pg_stat_activity. Text keeps the microseconds that a Date would drop.
    const [check] = await fixture.sql.queryIsolated<{
      pid: number;
      queryStart: string;
    }>(
      `
        select pid, query_start::text as "queryStart"
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike 'select%from "junior_turns"%'
          and query_start > coalesce($1::timestamptz, '-infinity')
      `,
      [after ?? null],
    );
    if (check) {
      return check;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for a lease check");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The system prompt that core builds from a layout: its sections in order. */
function layoutSystemPrompt(layout: PromptLayout): string {
  return layout.systemPrompt.map((section) => section.text).join("\n\n");
}

/** The step messages that wait for a delivery, for one Turn. */
function pendingSteps(forTurnId: string) {
  return harness.queue
    .pending(TURN_STEP_TOPIC)
    .filter((message) => messageTurnId(message.payload) === forTurnId).length;
}

// The real path: an input goes through scheduleInput, and the host's Turn
// step consumer runs each step from the queue with the host's prompt layout
// of the Turn's platform.
describe("advanceTurn", () => {
  beforeEach(async () => {
    harness = await createTurnHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("commits a step that continues the Turn and sends the next step", async () => {
    const reply = sendCallReply();
    await setModelReplies([reply]);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    expect(pendingSteps(turnId)).toBe(1);
    await expect(modelCalls()).resolves.toMatchObject([{ model: MODEL.id }]);
  });

  it("ends the Turn when the step completes it, and sends nothing", async () => {
    const reply = createAssistantMessage({ type: "text", text: "All done." });
    await setModelReplies([reply]);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    const turn = await harness.turn(turnId);
    expect(turn).toMatchObject({
      state: "completed",
      stepSeq: 1,
      leaseOwner: null,
    });
    expect(turn.endedAt).toBeInstanceOf(Date);
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    expect(pendingSteps(turnId)).toBe(0);
  });

  it("gives a Turn with a Slack Location the slack layout's system prompt", async () => {
    const layouts = await buildTurnPromptLayouts();
    await setModelReplies([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
    await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    const [call] = await modelCalls();
    expect(systemPromptOf(call)).toBe(layoutSystemPrompt(layouts.slack));
    expect(systemPromptOf(call)).not.toBe(layoutSystemPrompt(layouts.local));
  });

  it("gives a Turn with no Location the local layout's system prompt", async () => {
    const layouts = await buildTurnPromptLayouts();
    await harness.engineCtx.executor
      .db()
      .update(juniorConversations)
      .set({ location: null })
      .where(eq(juniorConversations.conversationId, harness.conversationId));
    await setModelReplies([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
    await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    const [call] = await modelCalls();
    expect(systemPromptOf(call)).toBe(layoutSystemPrompt(layouts.local));
  });

  it("gives the model only agent history, not the host's events", async () => {
    await createSqlConversationEventStore(harness.engineCtx.executor).append(
      harness.conversationId,
      [
        {
          data: {
            type: "authorization_completed",
            kind: "mcp",
            provider: "linear",
            actorId: "U123",
            authorizationId: "auth-1",
          },
          idempotencyKey: "authorization_completed:auth-1",
          createdAtMs: Date.now(),
        },
      ],
    );
    await setModelReplies([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
    await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    const [call] = await modelCalls();
    const sent = JSON.stringify(call?.messages);
    expect(sent).toContain("How many Turns?");
    expect(sent).not.toContain("linear");
  });

  it.each(["completed", "cancelled"] as const)(
    "does not run a step of a %s Turn",
    async (state) => {
      const { turnId } = await harness.send({ text: "How many Turns?" });
      if (state === "cancelled") {
        await stopTurns(harness.engineCtx, harness.conversationId);
      } else {
        await harness.engineCtx.executor
          .db()
          .update(juniorTurns)
          .set({ state, endedAt: sql`now()` })
          .where(eq(juniorTurns.id, turnId));
      }
      const before = await harness.turn(turnId);

      await harness.runStep();

      await expect(modelCalls()).resolves.toEqual([]);
      await expect(harness.turn(turnId)).resolves.toEqual(before);
      await expect(harness.history()).resolves.toEqual([]);
      // Only the stop's own message.
      expect(pendingSteps(turnId)).toBe(state === "cancelled" ? 1 : 0);
    },
  );

  it("reads an unread input into the history before the reply", async () => {
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    await setModelReplies([reply]);
    const { turnId, inputId } = await harness.send({
      text: "How many Turns?",
    });

    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    const events = await harness.events();
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `inbox:${inputId}`,
      `step:${turnId}:0:0`,
    ]);
    expect(events[0]!.data).toMatchObject({
      type: "user_message",
      provenance: { authority: "instruction", actor: ACTOR },
    });
    await expect(findUnreadInputs(harness.engineCtx, turnId)).resolves.toEqual(
      [],
    );
  });
});

// The real path with tools: the host's Turn step consumer gives the model
// the test's tools, or the host's own.
describe("advanceTurn with tools", () => {
  /** Starts this test's harness, whose steps give the model `tools`. */
  async function startHarness(
    tools: ToolDefinition[] | AdvanceTurnOptions["tools"],
  ) {
    const started = await createTurnHarness({ tools });
    onTestFinished(() => started.close());
    harness = started;
    return started;
  }

  it("runs the host's systemTime tool for the model", async () => {
    await startHarness(turnTools);
    const call = createAssistantMessage({
      type: "toolCalls",
      calls: [
        { name: "systemTime", arguments: { timezone: "UTC" }, id: "call-1" },
      ],
    });
    const reply = createAssistantMessage({ type: "text", text: "It is noon." });
    await setModelReplies([call, reply]);
    const { turnId: timeTurnId } = await harness.send({
      text: "What time is it?",
    });

    await harness.runUntilIdle();

    await expect(harness.turn(timeTurnId)).resolves.toMatchObject({
      state: "completed",
    });
    const history = await harness.history();
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "systemTime",
        isError: false,
        details: expect.objectContaining({
          timezone: "UTC",
          iso_utc: expect.any(String),
        }),
      }),
    );
    expect(history.at(-1)).toEqual(storedReply(reply));
  });

  it("stops a tool that respects the signal when the Turn is cancelled", async () => {
    let cancelledTurnId = "";
    const send: ToolDefinition = {
      ...sendTool([]),
      execute: async (_args, { signal }) => {
        await stopTurns(harness.engineCtx, harness.conversationId);
        // The tool works until its signal aborts.
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return { content: [{ type: "text", text: "sent" }] };
      },
    };
    await startHarness([send]);
    const reply = sendCallReply();
    await setModelReplies([reply]);
    ({ turnId: cancelledTurnId } = await harness.send({
      text: "How many Turns?",
    }));
    await harness.runStep();

    await harness.runStep();

    await expect(harness.turn(cancelledTurnId)).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 1,
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    // The stop's message. The tool step's own message was delivered.
    expect(pendingSteps(cancelledTurnId)).toBe(1);
  });

  it("runs a tool that must not run twice on the first attempt of its step", async () => {
    const executed: string[] = [];
    await startHarness([sendTool(executed)]);
    await setModelReplies([sendCallReply()]);
    await harness.send({ text: "How many Turns?" });
    await harness.runStep();

    await harness.runStep();

    expect(executed).toEqual(["call-1"]);
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({
        role: "toolResult",
        isError: false,
        content: [{ type: "text", text: "sent" }],
      }),
    ]);
  });

  it("skips that tool when the step runs again after a lost attempt", async () => {
    const executed: string[] = [];
    await startHarness([sendTool(executed)]);
    await setModelReplies([sendCallReply()]);
    const { turnId: toolTurnId } = await harness.send({
      text: "How many Turns?",
    });
    await harness.runStep();
    // An invocation claims the tool step, then dies before it commits.
    await claimTurn(
      { ...harness.engineCtx, owner: "worker-dead", leaseMs: EXPIRED_LEASE_MS },
      toolTurnId,
    );

    await harness.runStep();

    expect(executed).toEqual([]);
    await expect(harness.turn(toolTurnId)).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
      leaseEpoch: 3,
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "toolResult", isError: true }),
    ]);
  });

  it("runs the next step on a redelivery when the send after a continue commit fails", async () => {
    const executed: string[] = [];
    await startHarness([sendTool(executed)]);
    const reply = sendCallReply();
    const done = createAssistantMessage({ type: "text", text: "Sent." });
    await setModelReplies([reply, done]);
    const { turnId: toolTurnId } = await harness.send({
      text: "How many Turns?",
    });
    // Stands in for the process dying after the commit, before the send.
    vi.spyOn(harness.queue, "send").mockRejectedValueOnce(
      new Error("The queue is unreachable"),
    );

    await harness.runStep();

    await expect(harness.turn(toolTurnId)).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
      leaseOwner: null,
    });
    // The step message failed, so the queue keeps it for a redelivery.
    expect(harness.queue.pending(TURN_STEP_TOPIC)).toEqual([
      expect.objectContaining({ deliveryCount: 1 }),
    ]);

    // The queue delivers the same message again.
    await harness.runStep();

    // A first attempt, so the tool that must not run twice runs.
    expect(executed).toEqual(["call-1"]);
    await expect(harness.turn(toolTurnId)).resolves.toMatchObject({
      state: "queued",
      stepSeq: 2,
    });

    await harness.runStep();

    await expect(harness.turn(toolTurnId)).resolves.toMatchObject({
      state: "completed",
      stepSeq: 3,
    });
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      expect.objectContaining({ role: "toolResult", isError: false }),
      storedReply(done),
    ]);
    // The input's message, delivered again, and the tool step's message.
    // Only the tool step's send went out.
    expect(harness.queue.delivered(TURN_STEP_TOPIC)).toEqual([
      expect.objectContaining({ deliveryCount: 2 }),
      expect.objectContaining({ deliveryCount: 1 }),
    ]);
    expect(pendingSteps(toolTurnId)).toBe(0);
  });

  it("reads no inputs in a tool step", async () => {
    const executed: string[] = [];
    await startHarness([sendTool(executed)]);
    const reply = sendCallReply();
    await setModelReplies([reply]);
    const { turnId: toolTurnId } = await harness.send({
      text: "How many Turns?",
    });
    await harness.runStep();
    const { inputId } = await harness.send({ text: "Also send it to Sam." });

    await harness.runStep();

    expect(executed).toEqual(["call-1"]);
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
      expect.objectContaining({ role: "toolResult" }),
    ]);
    await expect(
      findUnreadInputs(harness.engineCtx, toolTurnId),
    ).resolves.toEqual([expect.objectContaining({ inputId })]);
  });
});

// These cases need a fault, a timing or a layout that no edge can give, so
// they run one step at a time with a test step: model settings that throw,
// a layout with fragments around the inputs, an input or a change to the
// Turn while the model request runs, or a model request that ends only
// through its abort.
describe("advanceTurn with a test step", () => {
  beforeEach(async () => {
    engine = await startTurnEngine();
    ({ fixture, turnId } = engine);
  });

  afterEach(async () => {
    await engine.close();
  });

  /** A layout with a fragment message before the inputs and one after them. */
  function promptAroundInputs() {
    return promptForEveryTurn(
      testPrompt([
        fragment("before", { format: () => contextNote("Before the inputs.") }),
        testInputs(),
        fragment("after", { format: () => contextNote("After the inputs.") }),
      ]),
    );
  }

  async function eventKeys() {
    const events = await loadEvents();
    return events.map((event) => event.idempotencyKey);
  }

  function loadEvents() {
    return createSqlConversationEventStore(fixture.sql).loadCurrentHistory(
      CONVERSATION_ID,
    );
  }

  it("writes the layout's messages around the inputs in layout order", async () => {
    const inputId = await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });

    const [unread] = await findUnreadInputs(engine.engineCtx, turnId);
    const stepStart = Date.now();
    await engine.advance({
      ...stepWith([reply]),
      prompt: promptAroundInputs(),
    });
    const stepEnd = Date.now();

    await expect(engine.loadHistory()).resolves.toEqual([
      userText("Before the inputs."),
      userText("How many Turns?"),
      userText("After the inputs."),
      storedReply(reply),
    ]);
    const events = await loadEvents();
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      `prompt:${turnId}:0:0`,
      `inbox:${inputId}`,
      `prompt:${turnId}:0:2`,
      `step:${turnId}:0:0`,
    ]);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ provenance: { authority: "context" } }),
      expect.objectContaining({
        provenance: { authority: "instruction", actor: ACTOR },
      }),
      expect.objectContaining({ provenance: { authority: "context" } }),
      expect.anything(),
    ]);
    // Both fragment messages get the one time of the step, and the input
    // keeps its send time.
    const [before, input, after] = events;
    expect(before?.createdAtMs).toBeGreaterThanOrEqual(stepStart);
    expect(before?.createdAtMs).toBeLessThanOrEqual(stepEnd);
    expect(after?.createdAtMs).toBe(before?.createdAtMs);
    expect(input?.createdAtMs).toBe(unread?.sentAt.getTime());
  });

  it("writes a step's fragment messages once when its message is delivered again", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    const prompt = promptAroundInputs();
    await engine.advance({ ...stepWith([reply]), prompt });
    const written = await eventKeys();

    // The queue delivers the same message again after the step committed.
    await engine.advance({ ...stepWith([reply]), prompt });

    await expect(eventKeys()).resolves.toEqual(written);
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("Before the inputs."),
      userText("How many Turns?"),
      userText("After the inputs."),
      storedReply(reply),
    ]);
  });

  it("builds each step's tools from every input of the Turn and closes them after the step", async () => {
    const first = await engine.addTestInput("How many Turns?");
    const second = await engine.addTestInput("Also send it to Sam.");
    const executed: string[] = [];
    const built: string[][] = [];
    let closed = 0;
    const tools = (_turn: unknown, inputs: Array<{ inputId: string }>) => {
      built.push(inputs.map((input) => input.inputId));
      return Promise.resolve({
        definitions: [sendTool(executed)],
        close: () => {
          closed += 1;
        },
      });
    };

    await engine.advance({ ...stepWith([sendCallReply()]), tools });
    // The tool step: the history has read both inputs by now.
    await engine.advance({ ...stepWith([]), tools });

    expect(executed).toEqual(["call-1"]);
    expect(built).toEqual([
      [first, second],
      [first, second],
    ]);
    expect(closed).toBe(2);
  });

  it("adds no fragment or input messages in a tool step", async () => {
    await engine.addTestInput("How many Turns?");
    const executed: string[] = [];
    const prompt = promptAroundInputs();
    const reply = sendCallReply();
    await engine.advance({
      ...stepWith([reply], [sendTool(executed)]),
      prompt,
    });
    const inputId = await engine.addTestInput("Also send it to Sam.");
    const load = vi.fn(() => Promise.resolve("Thomas likes short replies."));
    const memory = loader("memory", load, { timeoutMs: 1_000 });
    const modelSettings = vi.fn(() => Promise.resolve(MODEL));
    const pickPrompt = vi.fn(
      promptForEveryTurn(
        testPrompt([
          fragment("memory", { loader: memory, format: () => skip("unused") }),
          testInputs(),
        ]),
      ),
    );

    await engine.advance({
      ...stepWith([], [sendTool(executed)]),
      prompt: pickPrompt,
      modelSettings,
    });

    expect(executed).toEqual(["call-1"]);
    // A tool step picks no prompt layout, so the host reads no Location. It
    // builds no prompt and reads no model settings.
    expect(pickPrompt).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(modelSettings).not.toHaveBeenCalled();
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("Before the inputs."),
      userText("How many Turns?"),
      userText("After the inputs."),
      storedReply(reply),
      expect.objectContaining({ role: "toolResult", isError: false }),
    ]);
    await expect(findUnreadInputs(engine.engineCtx, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId }),
    ]);
  });

  it("stops the step when the Turn is cancelled during it, and writes nothing", async () => {
    await engine.advance(
      interruptedStep(() => stopTurns(engine.engineCtx, CONVERSATION_ID)),
    );

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "cancelled",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    // Only the stop's own message.
    expect(engine.sentStepMessages()).toBe(1);
  });

  it("writes nothing when the model request throws its own error after a cancel", async () => {
    const model = fakeModelClient([
      { type: "text", text: "Too late.", waitFor: "abort" },
    ]);

    await engine.advance({
      client: {
        complete: async (request, signal) => {
          await stopTurns(engine.engineCtx, CONVERSATION_ID);
          await model.complete(request, signal);
          throw new Error("The connection closed");
        },
      },
    });

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "cancelled",
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    // Only the stop's own message.
    expect(engine.sentStepMessages()).toBe(1);
  });

  it("stops the step when another invocation takes over the Turn during it, and writes nothing", async () => {
    // The lease of this invocation has expired, so a redelivery claims it.
    const step = interruptedStep(() =>
      claimTurn({ ...engine.engineCtx, owner: "worker-b" }, turnId),
    );

    await engine.advance(step, EXPIRED_LEASE_MS);

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "running",
      leaseOwner: "worker-b",
      leaseEpoch: 2,
      stepSeq: 0,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    expect(engine.sentStepMessages()).toBe(0);
  });

  it("goes on with the step when a lease check fails", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "All done." });
    const step = stepWith([reply]);
    let abortedAfterFailedCheck: boolean | undefined;
    const failingCheck: Step = {
      ...step,
      client: {
        complete: async (request, signal) => {
          // Injected fault: a lease check fails. A table lock holds the
          // check, and the test cancels its query.
          await fixture.sql.transaction(async () => {
            await fixture.sql.execute(
              "LOCK TABLE junior_turns IN ACCESS EXCLUSIVE MODE",
            );
            const failed = await blockedLeaseCheck();
            await fixture.sql.query("select pg_cancel_backend($1)", [
              failed.pid,
            ]);
            // Checks do not overlap, so a later check means the failed one
            // has ended.
            await blockedLeaseCheck(failed.queryStart);
          });
          abortedAfterFailedCheck = signal.aborted;
          return step.client.complete(request, signal);
        },
      },
    };

    await engine.advance(failingCheck);

    expect(abortedAfterFailedCheck).toBe(false);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
      stepSeq: 1,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
  });

  it("queues the Turn again when the invocation throws, so the retry runs the step at once", async () => {
    await engine.addTestInput("How many Turns?");
    const failure = new Error("The model settings could not be read");

    await expect(
      engine.advance({ modelSettings: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 0,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const reply = sendCallReply();
    const retry = vi.fn(() => Promise.resolve(MODEL));
    await engine.advance({ ...stepWith([reply]), modelSettings: retry });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({ stepSeq: 0, attempts: 2 }),
    );
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
  });

  it("fails the Turn when every try of a step throws, and runs it no more", async () => {
    const failure = new Error("The model settings could not be read");
    const modelSettings = vi.fn(() => Promise.reject(failure));
    // Each try queues the Turn again, as the queue's redelivery would find it.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(engine.advance({ modelSettings })).rejects.toBe(failure);
    }

    await engine.advance({ modelSettings });

    expect(modelSettings).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "failed",
      endReason: "attempts_exhausted",
      failureCode: "agent_run_failed",
      failureReason: null,
      failureEventId: null,
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(engine.loadHistory()).resolves.toEqual([]);
    expect(engine.sentStepMessages()).toBe(0);
  });

  it("commits a step that succeeds on its last try, and resets the attempts", async () => {
    await engine.addTestInput("How many Turns?");
    const failure = new Error("The model settings could not be read");
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(
        engine.advance({ modelSettings: () => Promise.reject(failure) }),
      ).rejects.toBe(failure);
    }
    const reply = sendCallReply();
    const last = vi.fn(() => Promise.resolve(MODEL));

    await engine.advance({ ...stepWith([reply]), modelSettings: last });

    expect(last).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_ATTEMPTS }),
    );
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "queued",
      stepSeq: 1,
      attempts: 0,
    });
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    expect(engine.sentStepMessages()).toBe(1);
  });

  it.each([
    ["cancelled", () => stopTurns(engine.engineCtx, CONVERSATION_ID)],
    [
      "taken over",
      () => claimTurn({ ...engine.engineCtx, owner: "worker-b" }, turnId),
    ],
  ])(
    "leaves a Turn that was %s alone when the invocation throws",
    async (_change, interrupt) => {
      let changed: Awaited<ReturnType<TurnEngine["readTurn"]>> | undefined;
      const failure = new Error("The model settings could not be read");
      const modelSettings = async () => {
        await interrupt();
        changed = await engine.readTurn();
        throw failure;
      };

      // The lease of this invocation has expired, so a redelivery can claim it.
      await expect(
        engine.advance({ modelSettings }, EXPIRED_LEASE_MS),
      ).rejects.toBe(failure);

      await expect(engine.readTurn()).resolves.toEqual(changed);
      await expect(engine.loadHistory()).resolves.toEqual([]);
    },
  );

  it("continues a completed Turn when an input arrives during the step, and sends the next step", async () => {
    await engine.addTestInput("How many Turns?");
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    const step = stepWith([reply]);
    let lateInputId: string | undefined;

    await engine.advance({
      ...step,
      client: {
        complete: async (request, signal) => {
          lateInputId = await engine.addTestInput("And how many failed?");
          return step.client.complete(request, signal);
        },
      },
    });

    const turn = await engine.readTurn();
    expect(turn).toMatchObject({ state: "queued", stepSeq: 1 });
    expect(turn.endedAt).toBeNull();
    await expect(engine.loadHistory()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
    await expect(findUnreadInputs(engine.engineCtx, turnId)).resolves.toEqual([
      expect.objectContaining({ inputId: lateInputId }),
    ]);
    expect(engine.sentStepMessages()).toBe(1);
  });
});
